// Chunk/ScrapedPage persistence for scrape results (LEO-027).
//
// Extracted from routes/scrape.js so the HTTP route and the nightly LeoRefresh
// job write the database through exactly one code path. They had drifted:
// leoRefresh.js ignored thinGroupChunks/thinGroupUrls entirely (group chunks
// were never refreshed by the nightly job) and never called createSnapshot, so
// a bad nightly run had no restore path.
//
// rescrapeSite() itself is untouched — this module only consumes its result.

const Chunk = require('../models/Chunk');
const Entity = require('../models/Entity');
const ScrapedPage = require('../models/ScrapedPage');
const ScrapeSnapshot = require('../models/ScrapeSnapshot');
const ArchivedChunk = require('../models/ArchivedChunk');
const { REASONS } = require('./fetchFailure');
const { summariseRobots } = require('./robots');
const { sweepChunks, mergeSweep, logSweep } = require('./scanSweep');
const { planRetirement, applyRetirement } = require('./pageRetire');

const MAX_SNAPSHOTS_PER_DOMAIN = 10;

// Debug tiers — LAST_SCRAPE_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per run naming the loss counts and where they were
//                   stored, and one per list that had to be truncated
//   normal          adds the keys actually copied off the summary
//   verbose         adds one line per stored not-learned URL
const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.LAST_SCRAPE_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[LastScrape] ${message}`);
}

// Chunk sources a scrape may never delete — defined once on the model, see Chunk.js.
const { PRESERVED_SOURCES } = Chunk;

// Create a snapshot of current scraped chunks before a destructive operation.
// mode: 'full'|'force' archives all scraped chunks; 'rescrape' archives only affected URLs.
// Prunes oldest snapshots if count exceeds MAX_SNAPSHOTS_PER_DOMAIN.
async function createSnapshot(domain, mode, affectedUrls = null) {
  const query = { domain, source: { $nin: PRESERVED_SOURCES } };
  if (affectedUrls) query.url = { $in: affectedUrls };

  const chunksToArchive = await Chunk.find(query).lean();
  if (chunksToArchive.length === 0) return null;

  const snapshot = await ScrapeSnapshot.create({
    domain,
    mode,
    chunkCount: chunksToArchive.length,
    pageCount: new Set(chunksToArchive.map(c => c.url)).size,
    affectedUrls: affectedUrls ?? [...new Set(chunksToArchive.map(c => c.url))],
  });

  await ArchivedChunk.insertMany(
    chunksToArchive.map(({ _id, __v, createdAt, updatedAt, ...c }) => ({ ...c, snapshotId: snapshot._id }))
  );

  // Prune oldest snapshots for this domain
  const allSnapshots = await ScrapeSnapshot.find({ domain }).sort({ createdAt: 1 });
  if (allSnapshots.length > MAX_SNAPSHOTS_PER_DOMAIN) {
    const toDelete = allSnapshots.slice(0, allSnapshots.length - MAX_SNAPSHOTS_PER_DOMAIN);
    const toDeleteIds = toDelete.map(s => s._id);
    await ArchivedChunk.deleteMany({ snapshotId: { $in: toDeleteIds } });
    await ScrapeSnapshot.deleteMany({ _id: { $in: toDeleteIds } });
  }

  return snapshot;
}

// Shape a crawl's raw failure list for the summary, the snapshot and the owner (LEO-056).
//
// scrapeSite/rescrapeSite only COLLECT — scraper.js is restricted to small diffs —
// so every assumption the dashboard is allowed to make is established here:
//   * one entry per URL, since the same URL can be pushed twice in a run (fetched
//     empty on one pass, failed on a retry of a link to it from another page);
//   * a reason outside the known set falls back to fetch_error rather than
//     reaching the UI as an unlabelled chip;
//   * status is a positive number or null — never 0, which would render as a
//     plausible-looking HTTP code.
// A bare string is accepted too, so this can shape skippedUrls (LEO-019, strings)
// with an explicit reason when a caller wants the two lists merged.
function shapeFailedUrls(failedUrls = [], defaultReason = 'fetch_error') {
  const byUrl = new Map();
  for (const entry of Array.isArray(failedUrls) ? failedUrls : []) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (!url || byUrl.has(url)) continue;
    const reason = REASONS.includes(entry?.reason) ? entry.reason : defaultReason;
    const raw = Number(typeof entry === 'string' ? NaN : entry?.status);
    byUrl.set(url, { url, reason, status: Number.isFinite(raw) && raw > 0 ? raw : null });
  }
  return [...byUrl.values()];
}

// Record the run's not-learned URLs on its snapshot, so "which pages did this
// scrape lose?" survives the run that produced it.
//
// Best-effort on purpose: a snapshot is null when there was nothing to archive
// (a first-ever scrape), and a failed write here must never fail a scrape that
// stored real chunks. Returns the shaped list either way, so the caller can put
// it in the summary whether or not it was persisted.
async function recordFailedUrls(snapshotId, failedUrls = []) {
  const shaped = shapeFailedUrls(failedUrls);
  if (!snapshotId || shaped.length === 0) return shaped;
  try {
    await ScrapeSnapshot.updateOne({ _id: snapshotId }, { failedUrls: shaped });
  } catch (err) {
    console.warn(`Could not record ${shaped.length} failed URL(s) on snapshot ${snapshotId}: ${err.message}`);
  }
  return shaped;
}

// Shape a crawl's raw robots.txt evidence for the summary and the snapshot (LEO-071).
//
// Same division of labour as shapeFailedUrls above: scrapeSite/rescrapeSite only
// COLLECT, because services/scraper.js is restricted to small diffs, so every
// assumption the dashboard is allowed to make is established here:
//   * one entry per URL — the same URL is pushed twice in a run when two pages
//     link to it and both batches reach the gate before either is marked visited;
//   * strings only, non-strings and blanks dropped, so the field stays writable
//     to a plain [String] on ScrapeSnapshot;
//   * order preserved, so the list reads in crawl order like affectedUrls does.
function shapeRobotsDisallowed(urls = []) {
  const seen = new Set();
  for (const entry of Array.isArray(urls) ? urls : []) {
    if (typeof entry !== 'string') continue;
    const url = entry.trim();
    if (url) seen.add(url);
  }
  return [...seen];
}

// Record what robots.txt would have excluded on the run's snapshot, and log the
// per-host summary.
//
// Best-effort for exactly the reasons recordFailedUrls is: a snapshot is null on
// a first-ever scrape (nothing to archive), and a failed write here must never
// fail a scrape that stored real chunks. Returns the shaped list either way so
// the caller can report it whether or not it was persisted.
async function recordRobotsDisallowed(snapshotId, urls = [], domain = '') {
  const shaped = shapeRobotsDisallowed(urls);
  summariseRobots(shaped, domain);
  if (!snapshotId || shaped.length === 0) return shaped;
  try {
    await ScrapeSnapshot.updateOne({ _id: snapshotId }, { robotsDisallowed: shaped });
  } catch (err) {
    console.warn(`Could not record ${shaped.length} robots-disallowed URL(s) on snapshot ${snapshotId}: ${err.message}`);
  }
  return shaped;
}

// Keys copied verbatim off a scrape_complete summary onto Entity.lastScrape, so
// a stored run renders through exactly the dashboard code a live one takes. The
// two loss lists are handled separately below (they are re-shaped and capped).
const SUMMARY_KEYS = ['mode', 'pagesScraped', 'pagesChanged', 'chunksStored', 'chunksUpdated', 'durationMs'];

// A crawl can lose up to MAX_PAGES URLs, and GET /api/dashboard/entities returns
// every entity document in full — so the STORED lists are capped while the
// socket payload stays whole. An owner acts on the first screenful; the run's
// snapshot (when it has one) still holds the complete record.
const MAX_STORED_URLS = 200;

// Store the run's own summary on the Entity (LEO-115).
//
// Unconditional, and that is the entire point of the item: LEO-056's copies hang
// off the run's ScrapeSnapshot, and createSnapshot returns null whenever there
// was nothing to archive — a first-ever full scrape and a rescrape in which
// nothing changed both persisted nothing, which is exactly when an owner most
// wants to know what was missed. The snapshot writes above are unchanged; this
// is a second, always-written copy that a non-superadmin view can read.
//
// Every list is written even when empty, so a clean run clears the previous
// run's losses rather than leaving them to read as current.
//
// Best-effort for the same reason recordFailedUrls is: a failed write here must
// never fail a scrape that stored real chunks. Returns what was stored, or null.
async function recordLastScrape(domain, summary = {}) {
  const cap = (list, label) => {
    if (list.length <= MAX_STORED_URLS) return list;
    debug('light', `${domain}: ${label} capped at ${MAX_STORED_URLS} of ${list.length} for storage (source: this run's summary, which carried all of them)`);
    return list.slice(0, MAX_STORED_URLS);
  };

  const lastScrape = { at: new Date() };
  for (const key of SUMMARY_KEYS) {
    if (summary[key] !== undefined) lastScrape[key] = summary[key];
  }
  lastScrape.failedUrls = cap(shapeFailedUrls(summary.failedUrls), 'failedUrls');
  // skippedUrls (LEO-019) and robotsDisallowed (LEO-071) are both plain URL
  // lists, so they take the same string shaper.
  lastScrape.skippedUrls = cap(shapeRobotsDisallowed(summary.skippedUrls), 'skippedUrls');
  lastScrape.robotsDisallowed = cap(shapeRobotsDisallowed(summary.robotsDisallowed), 'robotsDisallowed');

  const mode = lastScrape.mode || 'unknown';
  try {
    const updated = await Entity.findOneAndUpdate({ domain }, { lastScrape });
    if (!updated) {
      debug('light', `${domain}: no entity row — the ${mode} run's summary was not stored`);
      return null;
    }
    debug('light', `${domain}: stored the ${mode} run's summary on entity.lastScrape — ${lastScrape.failedUrls.length} not learned, ${lastScrape.skippedUrls.length} embed-skipped, ${lastScrape.robotsDisallowed.length} robots-disallowed (source: this run's scrape_complete summary)`);
    debug('normal', `  ${domain}: keys ${Object.keys(lastScrape).join(', ')}`);
    for (const f of lastScrape.failedUrls) {
      debug('verbose', `  ${domain}: not learned ${f.url} — ${f.reason}${f.status ? ` (HTTP ${f.status})` : ''}`);
    }
    return lastScrape;
  } catch (err) {
    console.warn(`Could not store the ${mode} run's summary on ${domain}: ${err.message}`);
    return null;
  }
}

// Tally how many chunks each page URL contributed to (LEO-028).
//
// A group chunk (multi-URL chunking for thin pages) carries the GROUP url on
// `chunk.url` and lists its member pages in `sourceUrls`. Counting by
// `chunk.url` alone therefore writes `chunkCount: 0` back to every thin page
// folded into a group, and Page Explorer reports it as having produced
// nothing — exactly the failure multi-URL chunking exists to fix.
//
// Each URL is credited at most once per chunk: single-URL chunks have
// `sourceUrls: [url]`, so a naive sum would double-count them.
function tallyChunkCounts(chunks, into = {}) {
  for (const chunk of chunks) {
    for (const url of new Set([chunk.url, ...(chunk.sourceUrls || [])])) {
      if (!url) continue;
      into[url] = (into[url] || 0) + 1;
    }
  }
  return into;
}

function groupByUrl(chunks) {
  const byUrl = new Map();
  for (const chunk of chunks) {
    if (!byUrl.has(chunk.url)) byUrl.set(chunk.url, []);
    byUrl.get(chunk.url).push(chunk);
  }
  return byUrl;
}

// io is optional (LeoRefresh may run before any socket is attached, and tests pass none).
function emitPageSaved(io, domain, url) {
  try {
    io?.to?.(`domain:${domain}`)?.emit?.('scrape_page_saved', { url });
  } catch (_) {
    // A broadcast failure must never abort a persistence run.
  }
}

// Insert new chunks FIRST (no gap where the page has none), then delete the old
// ones, excluding the ids just written so the delete can never touch them.
// Preserved sources (manual, upload, owner_reply, unanswered_qa) are never deleted.
async function replaceChunksForUrl(domain, pageUrl, chunks) {
  if (chunks.length === 0) return 0;
  const inserted = await Chunk.insertMany(chunks.map(c => ({ ...c, domain })));
  const insertedIds = inserted.map(d => d._id);
  await Chunk.deleteMany({
    domain,
    url: pageUrl,
    source: { $nin: PRESERVED_SOURCES },
    _id: { $nin: insertedIds },
  });
  return inserted.length;
}

// Delete a URL's scraped chunks without writing any back (LEO-138).
//
// A deliberately separate, opt-in function rather than dropping the
// `chunks.length === 0` early return above. replaceChunksForUrl is called for
// synthetic group URLs too, and a group that produced nothing this run may still
// have members whose own fetch merely came back empty — so "no chunks" is only
// SAFE to read as "delete what is there" where the caller has established that
// the page itself was fetched successfully. That judgement belongs at the call
// site, not inside the shared helper.
//
// Preserved sources (manual, upload, owner_reply, unanswered_qa) are never
// deleted, exactly as in replaceChunksForUrl.
async function clearChunksForUrl(domain, pageUrl) {
  const res = await Chunk.deleteMany({
    domain,
    url: pageUrl,
    source: { $nin: PRESERVED_SOURCES },
  });
  const deleted = res?.deletedCount || 0;
  if (deleted > 0) {
    debug('light', `${domain}: cleared ${deleted} chunk(s) at ${pageUrl} — source: the page was fetched successfully this run and produced none`);
  }
  return deleted;
}

// Persist a rescrapeSite() result. Snapshot first (so a restore is always
// possible), then per-URL insert-before-delete for normal chunks and thin
// group chunks, then touch lastScrapedAt on the unchanged pages.
async function persistRescrapeResult({ domain, result, io = null }) {
  const embeddedChunks  = result.embeddedChunks  || [];
  const thinGroupChunks = result.thinGroupChunks || [];
  const thinGroupUrls   = result.thinGroupUrls   || [];
  const pageHashUpdates = result.pageHashUpdates || [];
  const changedUrls     = result.changedUrls     || [];
  const unchangedUrls   = result.unchangedUrls   || [];
  // URLs whose embedding failed this run (LEO-019). rescrapeSite still lists them
  // in pageHashUpdates carrying the NEW content hash — but their chunks were never
  // re-embedded. Writing the new hash here would mark the page "current" while its
  // stored chunks are stale, and the next rescrape would see the hash unchanged and
  // never retry — locking the stale content in permanently. Skip the hash bump for
  // these so the change is re-detected next run.
  const skippedUrls = new Set(result.skippedUrls || []);
  // URLs that never produced text this run (LEO-056) — collected raw by the crawl,
  // shaped here, and reported in the summary beside skippedUrls.
  const failedUrls = shapeFailedUrls(result.failedUrls);
  // URLs robots.txt disallowed this run (LEO-071). Recorded whether or not they
  // were skipped — with crawlSettings.honorRobots off they WERE fetched, which is
  // the whole point of shipping the evidence before the enforcement.
  const robotsDisallowed = shapeRobotsDisallowed(result.robotsDisallowed);

  // URLs whose page fetch produced nothing this run (LEO-056/LEO-138). A page in
  // here keeps whatever it already had: "the fetch failed" and "the page is now
  // empty" must never be persisted the same way.
  const failedUrlSet = new Set(failedUrls.map((f) => f.url));

  const hasNormalChanges = embeddedChunks.length > 0;
  const hasThinChanges   = thinGroupChunks.length > 0;
  let snapshot = null;

  // Dead-page retirement (LEO-138), decided BEFORE anything is written: the rows
  // are read while they still carry the previous run's miss counters, and the
  // URLs it wants to retire go into the snapshot below so the chunks it deletes
  // are archived with the rest of the run's losses.
  const storedPages = await ScrapedPage.find({ domain }, 'url missedCrawls').lean();
  const retirement = planRetirement({ storedPages, result, domain });
  const retiredUrls = retirement.retire.map((r) => r.url);

  // Hoisted out of the change block below: a rescrape in which nothing changed
  // can still retire a page the site has deleted, and that deletion needs a
  // restore path exactly as much as a content change does.
  if (hasNormalChanges || hasThinChanges || retiredUrls.length > 0) {
    // Snapshot first — before any mutations so a restore is always possible
    snapshot = await createSnapshot(domain, 'rescrape', [...changedUrls, ...thinGroupUrls, ...retiredUrls]);
    await recordFailedUrls(snapshot?._id, failedUrls);
  }

  if (hasNormalChanges || hasThinChanges) {
    // Counted across BOTH chunk sets so a thin page folded into a group chunk is
    // credited on its own ScrapedPage row rather than written back as zero.
    const chunkCountByUrl = tallyChunkCounts([...embeddedChunks, ...thinGroupChunks]);

    // Report-only LeoScan sweep (LEO-060). Rule names only, computed from the
    // chunks that are about to be written and recorded beside them — it never
    // decides whether a chunk is written, so the persistence below is identical
    // whether or not anything tripped.
    const scanRulesByUrl = mergeSweep({}, sweepChunks([...embeddedChunks, ...thinGroupChunks]));
    logSweep(domain, scanRulesByUrl, embeddedChunks.length + thinGroupChunks.length);

    const normalByUrl = groupByUrl(embeddedChunks);
    // A group chunk is keyed by its GROUP url, and since LEO-137 made every stored
    // URL canonical that url can be IDENTICAL to a normal page's: the group for
    // thin top-level pages is the site root, and the site root is the home page.
    // Both sets must therefore reach replaceChunksForUrl in ONE call — it deletes
    // everything at that url except the ids it just inserted, so two calls meant
    // the second silently deleted what the first had written. Pre-LEO-137 this
    // could already happen whenever a listing page was queued with its trailing
    // slash ('/staff/' as both a page and a group); it was just rarer.
    const thinByUrl = groupByUrl(thinGroupChunks);
    const chunksForUrl = (u) => [...(normalByUrl.get(u) || []), ...(thinByUrl.get(u) || [])];
    // Every URL the loop below owns, changed or embed-skipped. The sweep-verdict
    // pass further down covers the pages this run looked at that it never reaches.
    const hashUpdateUrls = new Set(pageHashUpdates.map((p) => p.url));
    for (const { url: pageUrl, hash, priority, usedPuppeteer, hasVariants, contentChanged } of pageHashUpdates) {
      // Embedding failed for this page — leave its old chunks AND its old contentHash
      // intact so the next rescrape retries. Only bump lastScrapedAt to record we looked.
      if (skippedUrls.has(pageUrl)) {
        await ScrapedPage.updateOne({ domain, url: pageUrl }, { lastScrapedAt: new Date() });
        emitPageSaved(io, domain, pageUrl);
        continue;
      }

      // A page that fetched fine and produced NOTHING this run (LEO-138): it went
      // thin, so its content now lives in a group chunk filed under the group
      // URL, or its paragraphs all deduped away against another changed page.
      // Either way its old chunks are no longer what the page says, and
      // replaceChunksForUrl returns early on an empty list — so they used to
      // survive, and a thin page's text was in the corpus twice. Excluded: a
      // page in failedUrls, whose fetch is why it produced nothing.
      const chunks = chunksForUrl(pageUrl);
      if (chunks.length === 0 && !failedUrlSet.has(pageUrl)) {
        await clearChunksForUrl(domain, pageUrl);
      } else {
        await replaceChunksForUrl(domain, pageUrl, chunks);
      }

      const update = {
        contentHash: hash,
        priority,
        usedPuppeteer: !!usedPuppeteer,
        lastScrapedAt: new Date(),
        chunkCount: chunkCountByUrl[pageUrl] || 0,
        // Always written, including as [] — a page that stops tripping clears itself.
        scanRules: scanRulesByUrl[pageUrl] || [],
      };
      // rescrapeSite does not report hasVariants on pageHashUpdates. Writing
      // `!!undefined` would clear the flag on every rescrape of a variant page,
      // so only write it when the caller actually supplied a value.
      if (hasVariants !== undefined) update.hasVariants = !!hasVariants;
      if (contentChanged) update.lastChangedAt = new Date();

      await ScrapedPage.findOneAndUpdate({ domain, url: pageUrl }, update, { upsert: true });
      emitPageSaved(io, domain, pageUrl);
    }

    // Thin group chunks: same insert-before-delete pattern, keyed by group URL
    if (hasThinChanges) {
      for (const groupUrl of thinGroupUrls) {
        // Written above already, in the same call as that URL's own chunks. A URL
        // in skippedUrls took the `continue` up there and wrote nothing at all —
        // skipping it here too leaves its old chunks AND its old hash intact, so
        // the next rescrape retries the whole URL rather than half of it.
        if (hashUpdateUrls.has(groupUrl)) {
          debug('normal', `${domain}: ${groupUrl} group chunks written with the page's own — source: canonical group URL equals a page URL`);
          continue;
        }
        await replaceChunksForUrl(domain, groupUrl, thinByUrl.get(groupUrl) || []);
        emitPageSaved(io, domain, groupUrl);
      }
    }

    // The sweep's verdict for every page it LOOKED at, not only the changed ones (LEO-116).
    //
    // sweepChunks credits a group chunk to every URL in its sourceUrls, so a thin
    // page folded into a group is flagged — but a thin page only reaches
    // pageHashUpdates when its OWN text changed. A group rebuilt because a
    // SIBLING changed therefore computed a finding for every unchanged member and
    // threw it away: those URLs take the unchangedUrls updateMany below, which
    // writes lastScrapedAt and nothing else, so the row kept whatever it already
    // had — nothing, for any page last crawled before LEO-060 — and no chip
    // appeared in Page Explorer until a full or forced scrape. The full-scrape
    // path never had the gap: its final bulkWrite writes scanRules for every page.
    //
    // The pages this run looked at are the keys of chunkCountByUrl:
    // tallyChunkCounts credits chunk.url plus every sourceUrls entry, which is the
    // same rule urlsFor() applies inside the sweep, so the two sets agree by
    // construction. A page that contributed no chunk this run was NOT looked at —
    // its content was never re-read, so the rules already on its row are still the
    // truth and blanking them would drop a live finding.
    //
    // No upsert: a synthetic group URL need not have a ScrapedPage row at all, and
    // recording a finding must never mint one.
    const sweptUrls = Object.keys(chunkCountByUrl).filter((u) => !hashUpdateUrls.has(u));
    const sweptFlagged = sweptUrls.filter((u) => (scanRulesByUrl[u] || []).length > 0);
    const sweptCleared = sweptUrls.filter((u) => (scanRulesByUrl[u] || []).length === 0);

    for (const url of sweptFlagged) {
      await ScrapedPage.updateOne({ domain, url }, { scanRules: scanRulesByUrl[url] });
    }
    if (sweptCleared.length > 0) {
      // Written as [] on purpose — a page that stops tripping clears itself.
      await ScrapedPage.updateMany({ domain, url: { $in: sweptCleared } }, { scanRules: [] });
    }

    if (sweptFlagged.length > 0) {
      debug('light', `${domain}: scan verdict written to ${sweptUrls.length} page row(s) outside pageHashUpdates, ${sweptFlagged.length} of them flagged — source: this run's group chunks, whose sourceUrls credit members whose own text did not change`);
      for (const url of sweptFlagged) debug('verbose', `  ${domain}: ${url} — ${scanRulesByUrl[url].join(', ')}`);
    } else if (sweptUrls.length > 0) {
      debug('normal', `${domain}: cleared the scan verdict on ${sweptCleared.length} page row(s) outside pageHashUpdates — source: this run's group chunks, which tripped nothing`);
    }
  }

  // Outside the block above on purpose: a rescrape where nothing changed takes no
  // snapshot, and the robots summary for the hosts it crawled is still worth logging.
  await recordRobotsDisallowed(snapshot?._id, robotsDisallowed, domain);

  if (unchangedUrls.length > 0) {
    await ScrapedPage.updateMany(
      { domain, url: { $in: unchangedUrls } },
      { lastScrapedAt: new Date() }
    );
  }

  // Last, and after the snapshot above archived what it deletes (LEO-138).
  const retired = await applyRetirement(domain, retirement);

  const out = {
    snapshotId: snapshot ? snapshot._id : null,
    pagesChanged: changedUrls.length + thinGroupUrls.length,
    pagesUnchanged: unchangedUrls.length,
    chunksUpdated: embeddedChunks.length + thinGroupChunks.length,
    failedUrls,
    robotsDisallowed,
    // Added, never replacing a field: the dashboard's existing reads are untouched.
    pagesRetired: retired.pages,
    chunksRetired: retired.chunks,
    retireSkipped: retired.skipped,
  };

  // Outside every branch above, unconditionally (LEO-115): a rescrape in which
  // nothing changed takes no snapshot, and its loss lists are exactly the ones
  // that used to be dropped. Shared with LeoRefresh, so a 3am refresh records
  // its summary the same way a manual rescrape does.
  await recordLastScrape(domain, {
    mode: 'rescrape',
    pagesChanged: out.pagesChanged,
    chunksUpdated: out.chunksUpdated,
    skippedUrls: [...skippedUrls],
    failedUrls,
    robotsDisallowed,
    durationMs: result.durationMs,
  });

  return out;
}

module.exports = {
  createSnapshot,
  persistRescrapeResult,
  replaceChunksForUrl,
  clearChunksForUrl,
  tallyChunkCounts,
  shapeFailedUrls,
  recordFailedUrls,
  shapeRobotsDisallowed,
  recordRobotsDisallowed,
  recordLastScrape,
  MAX_SNAPSHOTS_PER_DOMAIN,
  MAX_STORED_URLS,
};
