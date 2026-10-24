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
const ScrapedPage = require('../models/ScrapedPage');
const ScrapeSnapshot = require('../models/ScrapeSnapshot');
const ArchivedChunk = require('../models/ArchivedChunk');
const { REASONS } = require('./fetchFailure');
const { summariseRobots } = require('./robots');
const { sweepChunks, mergeSweep, logSweep } = require('./scanSweep');

const MAX_SNAPSHOTS_PER_DOMAIN = 10;

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

  const hasNormalChanges = embeddedChunks.length > 0;
  const hasThinChanges   = thinGroupChunks.length > 0;
  let snapshot = null;

  if (hasNormalChanges || hasThinChanges) {
    // Snapshot first — before any mutations so a restore is always possible
    snapshot = await createSnapshot(domain, 'rescrape', [...changedUrls, ...thinGroupUrls]);
    await recordFailedUrls(snapshot?._id, failedUrls);

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
    for (const { url: pageUrl, hash, priority, usedPuppeteer, hasVariants, contentChanged } of pageHashUpdates) {
      // Embedding failed for this page — leave its old chunks AND its old contentHash
      // intact so the next rescrape retries. Only bump lastScrapedAt to record we looked.
      if (skippedUrls.has(pageUrl)) {
        await ScrapedPage.updateOne({ domain, url: pageUrl }, { lastScrapedAt: new Date() });
        emitPageSaved(io, domain, pageUrl);
        continue;
      }

      const chunks = normalByUrl.get(pageUrl) || [];
      await replaceChunksForUrl(domain, pageUrl, chunks);

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
      const thinByUrl = groupByUrl(thinGroupChunks);
      for (const groupUrl of thinGroupUrls) {
        await replaceChunksForUrl(domain, groupUrl, thinByUrl.get(groupUrl) || []);
        emitPageSaved(io, domain, groupUrl);
      }
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

  return {
    snapshotId: snapshot ? snapshot._id : null,
    pagesChanged: changedUrls.length + thinGroupUrls.length,
    pagesUnchanged: unchangedUrls.length,
    chunksUpdated: embeddedChunks.length + thinGroupChunks.length,
    failedUrls,
    robotsDisallowed,
  };
}

module.exports = {
  createSnapshot,
  persistRescrapeResult,
  replaceChunksForUrl,
  tallyChunkCounts,
  shapeFailedUrls,
  recordFailedUrls,
  shapeRobotsDisallowed,
  recordRobotsDisallowed,
  MAX_SNAPSHOTS_PER_DOMAIN,
};
