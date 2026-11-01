// LeoRefresh — the hourly scheduler tick (daily/weekly re-scrape per entity),
// plus the handoff follow-up, digest and retention ticks that ride the same cron.
//
// The due calculation (LEO-077). `isDueNow` used to be a bare equality on the
// UTC hour, and its only caller is one `cron.schedule('0 * * * *')` fire. Miss
// that single fire — a container restart spanning the hour, and Railway
// redeploys on every merge — and a `daily` entity waited another 24 hours, a
// `weekly` one another 7 days, with nothing logged and nothing emitted. So the
// predicate now has a catch-up arm, the same shape as `digestDue` in
// unansweredDigest.js: due when the scheduled hour matches, OR when
// leoRefreshLastRun is older than a catch-up window, and never inside an
// elapsed-gap guard that makes a second run in the same period impossible.
//
// Consequence, deliberately accepted: a caught-up refresh starts OUTSIDE the
// entity's chosen hour, once, and a run of back-to-back misses drifts by the
// difference between the catch-up window and the period (2h/day) until the
// scheduled hour comes back within reach. Roughly-on-time beats silently
// skipped; double-crawling an entity is the one thing the guard will not allow.
//
// An entity that has NEVER refreshed is not caught up — it has missed nothing,
// and a crawl the instant LeoRefresh is switched on is not what the hour
// setting means. It waits for its scheduled hour.
//
// `isDueNow` / `refreshDecision` are pure (no DB, no clock of their own) so the
// whole matrix is unit-testable directly — see backend/test/leo-refresh-due.test.js.
//
// Debug tiers — LEO_REFRESH_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per entity decision, naming the REASON it was
//                   taken or held — hour match, catch-up after N hours, gap
//                   guard, disabled — and every re-entrancy skip
//   normal          adds the tick-level counts (enabled vs due)
//   verbose         adds the raw schedule + last-run stamp each decision read
// This runs away from a human, so the light tier always says the SOURCE of a
// refresh, not just that one started.

const cron = require('node-cron');
const Entity = require('../models/Entity');
const ScrapedPage = require('../models/ScrapedPage');
const Conversation = require('../models/Conversation');
const { rescrapeSite } = require('./scraper');
const { persistRescrapeResult } = require('./scrapePersist');
const scrapeRegistry = require('./scrapeRegistry');
const { makeBroadcastIo } = require('../utils/broadcastIo');
const { sendHandoffFollowUpNotification } = require('./notifications');
const { reminderDue } = require('./handoff');
const { runUnansweredDigestTick } = require('./unansweredDigest');
const { runWeeklyDigestTick } = require('./weeklyDigest');
const { runRetentionSweepTick } = require('./retention');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Mirrors the Entity model default, used when leoRefreshHour is absent or junk.
const DEFAULT_HOUR_UTC = 3;

// Elapsed-time guards, deliberately under the nominal period so a tick landing
// a little early (clock skew) still refreshes, while a replayed fire inside the
// same scheduled hour — or a catch-up immediately after a real run — is always
// inside the guard and can never double-crawl. The schedule is UTC throughout.
const DAILY_MIN_GAP_MS = 20 * HOUR_MS;
const WEEKLY_MIN_GAP_MS = 6 * DAY_MS;

// How stale leoRefreshLastRun must be before a tick in ANY hour takes the
// refresh, because the scheduled hour was evidently missed. Set past the period
// (26h / 8d) so a healthy entity is always claimed by its own hour first and
// the catch-up arm only ever fires after something actually went wrong.
const DAILY_CATCHUP_MS = 26 * HOUR_MS;
const WEEKLY_CATCHUP_MS = 8 * DAY_MS;

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.LEO_REFRESH_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[LeoRefresh] ${message}`);
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Gaps in this file are hours-to-days, so one rounded unit is the readable form.
function formatGap(ms) {
  const hours = ms / HOUR_MS;
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00 UTC`;
}

// null means "never refreshed" — which includes an unreadable stamp: a decision
// made from a NaN would compare false against every window and wedge the entity
// out of the schedule entirely, the exact failure this item exists to fix.
function lastRunMs(entity) {
  const raw = entity?.leoRefreshLastRun;
  if (!raw) return null;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Why this entity is (or is not) due right now: `{ due, reason, detail }`.
 * Pure — `now` is injected, nothing is read from the DB. `reason` is a stable
 * slug for logs and tests; `detail` is the human half of the light-tier line.
 */
function refreshDecision(entity, now = Date.now()) {
  const e = entity || {};
  if (!e.leoRefreshEnabled) {
    return { due: false, reason: 'disabled', detail: 'LeoRefresh is off for this entity' };
  }

  const hour = Number.isInteger(e.leoRefreshHour) && e.leoRefreshHour >= 0 && e.leoRefreshHour <= 23
    ? e.leoRefreshHour
    : DEFAULT_HOUR_UTC;
  const weekly = e.leoRefreshFrequency === 'weekly';
  const gapMs = weekly ? WEEKLY_MIN_GAP_MS : DAILY_MIN_GAP_MS;
  const catchUpMs = weekly ? WEEKLY_CATCHUP_MS : DAILY_CATCHUP_MS;

  const nowHour = new Date(now).getUTCHours();
  const onSchedule = nowHour === hour;
  const last = lastRunMs(e);

  if (last === null) {
    return onSchedule
      ? { due: true, reason: 'first-run', detail: `never refreshed, and ${formatHour(nowHour)} is its scheduled hour` }
      : { due: false, reason: 'awaiting-first-slot', detail: `never refreshed; holding for ${formatHour(hour)} (now ${formatHour(nowHour)})` };
  }

  const elapsed = now - last;
  if (elapsed < 0) {
    return { due: false, reason: 'future-stamp', detail: `last run is stamped ${formatGap(-elapsed)} in the future (clock skew) — holding off rather than risk a double crawl` };
  }
  if (elapsed < gapMs) {
    return { due: false, reason: 'gap-guard', detail: `last run ${formatGap(elapsed)} ago, inside the ${formatGap(gapMs)} ${weekly ? 'weekly' : 'daily'} gap guard` };
  }
  if (onSchedule) {
    return { due: true, reason: 'hour-match', detail: `${formatHour(nowHour)} is its scheduled hour; last run ${formatGap(elapsed)} ago` };
  }
  if (elapsed >= catchUpMs) {
    return { due: true, reason: 'catch-up', detail: `catch-up after ${formatGap(elapsed)} — its ${formatHour(hour)} slot was missed and the ${formatGap(catchUpMs)} window has passed` };
  }
  return { due: false, reason: 'off-schedule', detail: `${formatHour(nowHour)} is not its ${formatHour(hour)} slot, and last run ${formatGap(elapsed)} ago is inside the ${formatGap(catchUpMs)} catch-up window` };
}

/** Boolean half of refreshDecision. `now` is injected so this stays testable. */
function isDueNow(entity, now = Date.now()) {
  return refreshDecision(entity, now).due;
}

async function runRefreshForEntity(entity, io) {
  const domain = entity.domain;
  const url = `https://${domain}`;
  console.log(`[LeoRefresh] Starting rescrape for ${domain}`);

  // Make this crawl visible on GET /scrape/active for as long as it runs
  // (LEO-078). Before this, the endpoint only ever saw a manual scrape, so the
  // dashboard showed no crawl in flight and the routine's merge gate let a
  // deploy restart the container mid-rescrape. Cleared in `finally`, so a
  // thrown rescrape can never wedge the gate shut.
  scrapeRegistry.begin(domain, { url, name: entity.name, mode: 'rescrape', source: 'leorefresh' });

  try {
    const storedPages = await ScrapedPage.find({ domain });
    const broadcastedIo = makeBroadcastIo(io, domain);
    const opts = { io: broadcastedIo, domain, crawlSettings: entity.crawlSettings || {} };
    const result = await rescrapeSite(url, storedPages, opts);

    // Single shared persistence path with routes/scrape.js (LEO-027). Before the
    // extraction this branch ignored thin group chunks entirely and never wrote a
    // ScrapeSnapshot, so a bad nightly refresh had no restore path.
    const { pagesChanged, chunksUpdated, failedUrls, robotsDisallowed } = await persistRescrapeResult({
      domain,
      result,
      io: broadcastedIo,
    });

    await Entity.findOneAndUpdate({ domain }, { lastScrapedAt: new Date(), leoRefreshLastRun: new Date() });

    const summary = {
      success: true,
      mode: 'rescrape',
      source: 'leorefresh',
      pagesChecked: result.changedUrls.length + result.unchangedUrls.length,
      pagesChanged,
      pagesUnchanged: result.unchangedUrls.length,
      chunksUpdated,
      // The dashboard's "Not learned" section reads these off scrape_complete, so a
      // nightly refresh reports its lost URLs exactly as a manual rescrape does (LEO-056).
      skippedUrls: result.skippedUrls || [],
      failedUrls,
      // What robots.txt would have excluded (LEO-071). Reported, not acted on —
      // unless this entity has crawlSettings.honorRobots on.
      robotsDisallowed,
      durationMs: result.durationMs,
      durationFormatted: formatDuration(result.durationMs),
    };

    io.to(`domain:${domain}`).emit('scrape_complete', summary);
    const lost = (summary.failedUrls?.length || 0) + (summary.skippedUrls?.length || 0);
    console.log(`[LeoRefresh] Done ${domain} — ${summary.pagesChanged} pages changed in ${summary.durationFormatted}${lost ? `, ${lost} not learned` : ''}`);
  } catch (err) {
    console.error(`[LeoRefresh] Failed for ${domain}:`, err.message);
    io.to(`domain:${domain}`).emit('scrape_complete', { success: false, source: 'leorefresh', error: err.message });
  } finally {
    scrapeRegistry.end(domain);
  }
}

// In-process re-entrancy flag. The cron fires on the hour and a crawl can
// outlast one: the sequential loop below only prevents parallel runs WITHIN a
// tick, so without this the next fire would start a second Puppeteer +
// embedding pass over the same entity while the first was still mid-flight.
// One process, one tick — a second container would need a DB lock, which is
// out of scope here (Railway runs one).
let tickInFlight = false;

async function runHourlyTick(io, now = Date.now()) {
  if (tickInFlight) {
    debug('light', 'tick skipped — re-entrancy: the previous tick is still running');
    return { ran: false, reason: 'in-flight', due: 0 };
  }

  tickInFlight = true;
  try {
    const nowUtcHour = new Date(now).getUTCHours();
    const entities = await Entity.find({ leoRefreshEnabled: true });

    const due = [];
    for (const entity of entities) {
      const decision = refreshDecision(entity, now);
      debug('light', `${entity.domain}: ${decision.due ? 'due' : 'not due'} — ${decision.reason}: ${decision.detail}`);
      debug('verbose', `${entity.domain}: frequency=${entity.leoRefreshFrequency || 'daily'} hour=${entity.leoRefreshHour ?? DEFAULT_HOUR_UTC} lastRun=${entity.leoRefreshLastRun ? new Date(entity.leoRefreshLastRun).toISOString() : 'never'}`);
      if (decision.due) due.push(entity);
    }

    debug('normal', `${entities.length} enabled, ${due.length} due at UTC hour ${nowUtcHour}`);
    if (due.length === 0) return { ran: true, reason: 'none-due', due: 0 };

    console.log(`[LeoRefresh] ${due.length} entities due at UTC hour ${nowUtcHour}`);

    // Sequential — Puppeteer + embedding is resource-intensive; no parallel runs
    for (const entity of due) {
      await runRefreshForEntity(entity, io);
    }

    console.log('[LeoRefresh] Tick complete');
    return { ran: true, reason: 'refreshed', due: due.length };
  } finally {
    tickInFlight = false;
  }
}

async function runHandoffFollowUpTick() {
  // Find conversations with an unresolved handoff that have already been notified once
  // (lastHandoffNotifiedAt set) and are overdue for a follow-up.
  const pendingConvos = await Conversation.find({
    handoffPending: true,
    lastHandoffNotifiedAt: { $ne: null, $exists: true },
  }).lean();

  if (!pendingConvos.length) return;

  // Group by domain so we fetch each entity once
  const domainMap = new Map();
  for (const c of pendingConvos) {
    if (!domainMap.has(c.domain)) domainMap.set(c.domain, []);
    domainMap.get(c.domain).push(c);
  }

  for (const [domain, convos] of domainMap) {
    const entity = await Entity.findOne({ domain }).lean();
    if (!entity) continue;

    for (const convo of convos) {
      if (!reminderDue(entity, convo)) continue;

      // Atomic update to prevent duplicate sends on concurrent runs; the
      // reminder counter increments in the same operation so the cap can
      // never be outrun by concurrent ticks.
      const updated = await Conversation.findOneAndUpdate(
        { _id: convo._id, lastHandoffNotifiedAt: convo.lastHandoffNotifiedAt },
        { $set: { lastHandoffNotifiedAt: new Date() }, $inc: { handoffReminderCount: 1 } }
      );
      if (!updated) continue; // another process beat us to it

      console.log(`[HandoffFollowUp] Sending reminder for ${domain}, conversation ${convo._id}`);
      sendHandoffFollowUpNotification({
        entity,
        conversationId: convo._id,
        sessionToken: convo.sessionToken,
        pendingQuestions: (convo.pendingQuestions || []).map((q) => q.text),
      }).catch((err) => console.error(`[HandoffFollowUp] Notification failed for ${domain}:`, err.message));
    }
  }
}

function startLeoRefreshScheduler(io) {
  // Run at the top of every hour, check which entities are due
  cron.schedule('0 * * * *', () => {
    console.log('[LeoRefresh] Hourly tick');
    runHourlyTick(io).catch((err) => console.error('[LeoRefresh] Unexpected error:', err));
    runHandoffFollowUpTick().catch((err) => console.error('[HandoffFollowUp] Unexpected error:', err));
    runUnansweredDigestTick().catch((err) => console.error('[UnansweredDigest] Unexpected error:', err));
    // Weekly inside, no-op unless an entity's own day+hour matches (LEO-042)
    runWeeklyDigestTick().catch((err) => console.error('[WeeklyDigest] Unexpected error:', err));
    // Daily inside, no-op in every other hour (LEO-043)
    runRetentionSweepTick().catch((err) => console.error('[Retention] Unexpected error:', err));
  });

  console.log('[LeoRefresh] Scheduler started — checks every hour for entities due to refresh');
}

module.exports = {
  startLeoRefreshScheduler,
  runHourlyTick,
  isDueNow,
  refreshDecision,
  DAILY_MIN_GAP_MS,
  WEEKLY_MIN_GAP_MS,
  DAILY_CATCHUP_MS,
  WEEKLY_CATCHUP_MS,
};
