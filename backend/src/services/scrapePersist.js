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

  const hasNormalChanges = embeddedChunks.length > 0;
  const hasThinChanges   = thinGroupChunks.length > 0;
  let snapshot = null;

  if (hasNormalChanges || hasThinChanges) {
    // Snapshot first — before any mutations so a restore is always possible
    snapshot = await createSnapshot(domain, 'rescrape', [...changedUrls, ...thinGroupUrls]);

    // Counted across BOTH chunk sets so a thin page folded into a group chunk is
    // credited on its own ScrapedPage row rather than written back as zero.
    const chunkCountByUrl = tallyChunkCounts([...embeddedChunks, ...thinGroupChunks]);

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
  };
}

module.exports = {
  createSnapshot,
  persistRescrapeResult,
  replaceChunksForUrl,
  tallyChunkCounts,
  MAX_SNAPSHOTS_PER_DOMAIN,
};
