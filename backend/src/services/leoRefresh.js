const cron = require('node-cron');
const Entity = require('../models/Entity');
const Chunk = require('../models/Chunk');
const ScrapedPage = require('../models/ScrapedPage');
const Conversation = require('../models/Conversation');
const { rescrapeSite } = require('./scraper');
const { makeBroadcastIo } = require('../utils/broadcastIo');
const { sendHandoffFollowUpNotification } = require('./notifications');
const { reminderDue } = require('./handoff');

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function isDueNow(entity, nowUtcHour) {
  if (entity.leoRefreshHour !== nowUtcHour) return false;
  if (entity.leoRefreshFrequency === 'weekly') {
    if (!entity.leoRefreshLastRun) return true;
    return Date.now() - entity.leoRefreshLastRun.getTime() >= SIX_DAYS_MS;
  }
  return true; // daily
}

async function runRefreshForEntity(entity, io) {
  const domain = entity.domain;
  const url = `https://${domain}`;
  console.log(`[LeoRefresh] Starting rescrape for ${domain}`);

  try {
    const storedPages = await ScrapedPage.find({ domain });
    const opts = { io: makeBroadcastIo(io, domain), domain, crawlSettings: entity.crawlSettings || {} };
    const result = await rescrapeSite(url, storedPages, opts);

    if (result.embeddedChunks.length > 0) {
      // Insert BEFORE delete, and never delete a preserved source.
      //
      // This previously ran deleteMany then insertMany with no source filter, so every
      // nightly refresh destroyed manual, upload, owner_reply and unanswered_qa chunks for
      // any changed URL — and left a window where a changed page had no chunks at all if
      // the process died between the two calls (a Railway redeploy is enough).
      //
      // Mirrors the per-URL pattern in routes/scrape.js: insert first, then delete only
      // scraped chunks for those URLs, excluding the ids just written.
      const inserted = await Chunk.insertMany(result.embeddedChunks.map((c) => ({ ...c, domain })));
      const insertedIds = inserted.map((d) => d._id);
      await Chunk.deleteMany({
        domain,
        url: { $in: result.changedUrls },
        source: { $nin: Chunk.PRESERVED_SOURCES },
        _id: { $nin: insertedIds },
      });

      for (const { url: pageUrl, hash, priority } of result.pageHashUpdates) {
        await ScrapedPage.findOneAndUpdate(
          { domain, url: pageUrl },
          { contentHash: hash, priority, lastScrapedAt: new Date(), lastChangedAt: new Date() },
          { upsert: true }
        );
      }
    }

    if (result.unchangedUrls.length > 0) {
      await ScrapedPage.updateMany(
        { domain, url: { $in: result.unchangedUrls } },
        { lastScrapedAt: new Date() }
      );
    }

    await Entity.findOneAndUpdate({ domain }, { lastScrapedAt: new Date(), leoRefreshLastRun: new Date() });

    const summary = {
      success: true,
      mode: 'rescrape',
      source: 'leorefresh',
      pagesChecked: result.changedUrls.length + result.unchangedUrls.length,
      pagesChanged: result.changedUrls.length,
      pagesUnchanged: result.unchangedUrls.length,
      chunksUpdated: result.embeddedChunks.length,
      durationMs: result.durationMs,
      durationFormatted: formatDuration(result.durationMs),
    };

    io.to(`domain:${domain}`).emit('scrape_complete', summary);
    console.log(`[LeoRefresh] Done ${domain} — ${summary.pagesChanged} pages changed in ${summary.durationFormatted}`);
  } catch (err) {
    console.error(`[LeoRefresh] Failed for ${domain}:`, err.message);
    io.to(`domain:${domain}`).emit('scrape_complete', { success: false, source: 'leorefresh', error: err.message });
  }
}

async function runHourlyTick(io) {
  const nowUtcHour = new Date().getUTCHours();
  const entities = await Entity.find({ leoRefreshEnabled: true });
  const due = entities.filter((e) => isDueNow(e, nowUtcHour));

  if (due.length === 0) return;

  console.log(`[LeoRefresh] ${due.length} entities due at UTC hour ${nowUtcHour}`);

  // Sequential — Puppeteer + embedding is resource-intensive; no parallel runs
  for (const entity of due) {
    await runRefreshForEntity(entity, io);
  }

  console.log('[LeoRefresh] Tick complete');
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
  });

  console.log('[LeoRefresh] Scheduler started — checks every hour for entities due to refresh');
}

module.exports = { startLeoRefreshScheduler };
