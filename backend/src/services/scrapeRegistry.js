// Active-scrape registry — the one place that knows a crawl is in flight (LEO-078).
//
// `GET /scrape/active` used to read a Map private to routes/scrape.js, written
// only by that file's own manual scrape and rescrape handlers. services/
// leoRefresh.js could not reach it, so for the whole of a nightly rescrape —
// minutes for a small site, ~7 for a 534-page shop — the endpoint answered `[]`.
// Two things read it and both were lied to: the dashboard showed no crawl
// running, and the routine's own merge gate (`deferIf: GET /scrape/active
// non-empty`, see "Blackout" in ops/leo-nightly/RUNBOOK.md) let a merge trigger
// a Railway redeploy mid-crawl. Progressive per-URL saves mean chunks are never
// absent, but the container dies with a partial snapshot, no `scrape_complete`,
// and a `lastScrapedAt` that was never written.
//
// So the Map moves here and BOTH callers write it. `source` ('manual' |
// 'leorefresh') rides alongside the existing { url, name, startedAt, mode }, so
// a reader can tell an owner-triggered crawl from the unattended one.
//
// Deliberately in-process. Railway runs ONE instance, so a module-level Map is
// the whole truth; a Mongo-backed registry is a separate decision with its own
// staleness problem (who clears an entry whose process died?) and is out of
// scope here. A restart therefore forgets an in-flight crawl — the same
// blindness the old Map had, unchanged by this item.
//
// `begin` on a domain already registered KEEPS the existing entry rather than
// replacing it. `startedAt` must stay the moment the crawl that is actually
// running started, and `end(domain)` is a single delete: if a second begin
// overwrote, whichever crawl finished first would clear the entry while the
// other was still mid-flight — the exact blindness this file exists to remove.
// Refusing to START that second crawl is a separate decision, and is not made
// here.
//
// Debug tiers — SCRAPE_REGISTRY_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per begin and per end, naming the domain AND the
//                   source that made the change, plus a folded duplicate begin
//                   and an end for a domain that was never registered
//   normal          adds how many crawls are registered after the change
//   verbose         adds the entry's url, mode and startedAt
// This runs away from a human, so the light tier always says WHO changed the
// registry, not just that it changed.
//
// Unit- and route-tested in backend/test/scrape-registry.test.js.

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.SCRAPE_REGISTRY_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[ScrapeRegistry] ${message}`);
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// domain → { url, name, startedAt, mode, source }
const active = new Map();

/**
 * Register a crawl as in flight.
 *
 * Returns the entry now held for this domain — which is the EXISTING one when
 * the domain was already registered (see header). `startedAt` is stamped here
 * so every reader of the registry sees one clock. An absent `source` means
 * 'manual', the only writer before this item; anything else is recorded as
 * given rather than relabelled.
 */
function begin(domain, info = {}) {
  if (!domain) return null;

  const source = info.source || 'manual';
  const existing = active.get(domain);
  if (existing) {
    debug('light', `${domain}: begin from ${source} folded into the crawl already registered by ${existing.source} at ${existing.startedAt.toISOString()}`);
    return existing;
  }

  const entry = {
    url: info.url || null,
    name: info.name || null,
    startedAt: new Date(),
    mode: info.mode || null,
    source,
  };
  active.set(domain, entry);

  debug('light', `${domain}: crawl registered by ${source} (mode ${entry.mode || 'unknown'})`);
  debug('normal', `${active.size} crawl(s) registered`);
  debug('verbose', `${domain}: url=${entry.url} startedAt=${entry.startedAt.toISOString()}`);
  return entry;
}

/**
 * Clear a domain's entry. A domain that is not registered is a no-op — callers
 * invoke this from a `finally`, and a throw before `begin` must not become a
 * second failure. Returns whether an entry was actually removed.
 */
function end(domain) {
  const entry = domain ? active.get(domain) : null;
  if (!entry) {
    debug('light', `${domain || '(no domain)'}: end ignored — no crawl was registered`);
    return false;
  }

  active.delete(domain);
  debug('light', `${domain}: crawl cleared, registered by ${entry.source}, ran ${formatDuration(Date.now() - entry.startedAt.getTime())}`);
  debug('normal', `${active.size} crawl(s) still registered`);
  return true;
}

/**
 * Every crawl in flight, each with its domain folded in — the `GET
 * /scrape/active` response body. Shape is the old route's, plus `source`.
 */
function list() {
  return [...active.entries()].map(([domain, info]) => ({ domain, ...info }));
}

/** Whether a crawl is registered for this domain right now. */
function isActive(domain) {
  return !!domain && active.has(domain);
}

module.exports = { begin, end, list, isActive };
