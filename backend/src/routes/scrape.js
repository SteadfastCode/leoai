const express = require('express');
const router = express.Router();
const Entity = require('../models/Entity');
const Chunk = require('../models/Chunk');
const ScrapedPage = require('../models/ScrapedPage');
const ScrapeSnapshot = require('../models/ScrapeSnapshot');
const ArchivedChunk = require('../models/ArchivedChunk');
const { scrapeSite, rescrapeSite } = require('../services/scraper');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const { makeBroadcastIo } = require('../utils/broadcastIo');
const logger = require('../services/logger');

const MAX_SNAPSHOTS_PER_DOMAIN = 10;

// In-memory tracking of currently active scrapes
// domain → { url, name, startedAt, mode }
const activeScrapes = new Map();

// Create a snapshot of current scraped chunks before a destructive operation.
// mode: 'full'|'force' archives all scraped chunks; 'rescrape' archives only affected URLs.
// Prunes oldest snapshots if count exceeds MAX_SNAPSHOTS_PER_DOMAIN.
async function createSnapshot(domain, mode, affectedUrls = null) {
  const query = { domain, source: { $nin: ['manual', 'upload', 'owner_reply'] } };
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

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// GET /scrape/active — superadmin only, returns currently running scrapes
router.get('/active', requireAuth(), (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  res.json([...activeScrapes.entries()].map(([domain, info]) => ({ domain, ...info })));
});

// GET /scrape/pages — superadmin only, paginated scraped page records for a domain
router.get('/pages', requireAuth(), async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { domain, page = 1, limit = 50, search = '' } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain is required' });

  const filter = { domain };
  if (search) filter.url = { $regex: search, $options: 'i' };

  const [pages, total, entity] = await Promise.all([
    ScrapedPage.find(filter)
      .sort({ url: 1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('url priority usedPuppeteer chunkCount lastScrapedAt lastChangedAt -_id'),
    ScrapedPage.countDocuments(filter),
    Entity.findOne({ domain }).select('lastScrapedAt name -_id'),
  ]);

  res.json({ pages, total, page: Number(page), limit: Number(limit), lastScrapedAt: entity?.lastScrapedAt, entityName: entity?.name });
});

// GET /scrape/snapshots — list snapshots for a domain (superadmin only)
router.get('/snapshots', requireAuth(), async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain is required' });
  const snapshots = await ScrapeSnapshot.find({ domain }).sort({ createdAt: -1 }).select('-affectedUrls');
  res.json(snapshots);
});

// GET /scrape/snapshots/:id/chunks — chunks for a specific snapshot + URL (superadmin only)
router.get('/snapshots/:id/chunks', requireAuth(), async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { url } = req.query;
  const filter = { snapshotId: req.params.id };
  if (url) filter.url = url;
  const chunks = await ArchivedChunk.find(filter).select('-embedding').sort({ chunkIndex: 1 });
  res.json(chunks);
});

// POST /scrape/snapshots/:id/restore — restore a snapshot (superadmin only)
// If url query param is provided, restores only that page's chunks. Otherwise restores all.
router.post('/snapshots/:id/restore', requireAuth(), async (req, res) => {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const { url } = req.query;

  const snapshot = await ScrapeSnapshot.findById(req.params.id);
  if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });

  const filter = { snapshotId: snapshot._id };
  if (url) filter.url = url;

  const archived = await ArchivedChunk.find(filter).lean();
  if (archived.length === 0) return res.status(404).json({ error: 'No archived chunks found' });

  const domain = snapshot.domain;
  const urlsToRestore = [...new Set(archived.map(c => c.url))];

  // Replace current chunks for the affected URLs
  await Chunk.deleteMany({ domain, url: { $in: urlsToRestore }, source: { $nin: ['manual', 'upload', 'owner_reply'] } });
  await Chunk.insertMany(archived.map(({ _id, snapshotId, __v, createdAt, updatedAt, ...c }) => c));

  res.json({ restored: archived.length, urls: urlsToRestore.length });
});

router.post('/', requireAuth(), async (req, res) => {
  const { domain, url, name, timezone, rescrape, force } = req.body;

  // Superadmins can crawl any domain. Owners can only rescrape their own domain.
  if (!isSuperAdmin(req.user)) {
    const hasMembership = req.user.memberships?.some((m) => m.entityDomain === domain);
    if (!hasMembership) return res.status(403).json({ error: 'Forbidden' });
    if (force) return res.status(403).json({ error: 'Force rescrape requires superadmin' });
  }

  if (!domain || !url || !name) {
    return res.status(400).json({ error: 'domain, url, and name are required' });
  }

  const io = req.app.get('io');
  const broadcastedIo = makeBroadcastIo(io, domain);
  const opts = { io: broadcastedIo, domain };

  try {
    let result;
    const storedPages = await ScrapedPage.find({ domain });
    // force=true: wipe all scraped chunks and re-embed from scratch (SA only)
    // rescrape=true: smart hash-diff, only re-embed changed pages
    const isForce    = force && isSuperAdmin(req.user);
    const isRescrape = !isForce && rescrape && storedPages.length > 0;
    const mode = isForce ? 'force' : isRescrape ? 'rescrape' : 'full';

    activeScrapes.set(domain, { url, name, startedAt: new Date(), mode });

    if (isForce) {
      // Force rescrape: same as full scrape but triggered on an existing entity.
      // Snapshot current chunks before wiping so they can be restored.
      await createSnapshot(domain, 'force');
      await Chunk.deleteMany({ domain, source: { $nin: ['manual', 'upload', 'owner_reply'] } });
      await ScrapedPage.deleteMany({ domain });
    }

    if (isRescrape) {
      result = await rescrapeSite(url, storedPages, opts);

      const hasNormalChanges = result.embeddedChunks.length > 0;
      const hasThinChanges   = result.thinGroupChunks.length > 0;

      if (hasNormalChanges || hasThinChanges) {
        // Snapshot affected chunks before deletion:
        // changedUrls = normal changed pages; thinGroupUrls = group parent URLs being replaced
        const allAffectedUrls = [...result.changedUrls, ...result.thinGroupUrls];
        await createSnapshot(domain, 'rescrape', allAffectedUrls);

        // Delete old normal chunks for changed pages
        if (result.changedUrls.length > 0) {
          await Chunk.deleteMany({ domain, url: { $in: result.changedUrls }, source: { $nin: ['manual', 'upload', 'owner_reply'] } });
        }

        // Delete old thin group chunks being replaced — only when we have new chunks to insert
        if (hasThinChanges && result.thinGroupUrls.length > 0) {
          await Chunk.deleteMany({ domain, url: { $in: result.thinGroupUrls }, source: { $nin: ['manual', 'upload', 'owner_reply'] } });
        }

        const insertedChunks = [...result.embeddedChunks, ...result.thinGroupChunks].map((c) => ({ ...c, domain }));
        await Chunk.insertMany(insertedChunks);

        // Count chunks per URL (normal pages only — group chunks have groupUrl, not individual page URLs)
        const chunkCountByUrl = result.embeddedChunks.reduce((acc, c) => {
          acc[c.url] = (acc[c.url] || 0) + 1;
          return acc;
        }, {});

        for (const { url: pageUrl, hash, priority, usedPuppeteer, contentChanged } of result.pageHashUpdates) {
          const update = { contentHash: hash, priority, usedPuppeteer: !!usedPuppeteer, lastScrapedAt: new Date(), chunkCount: chunkCountByUrl[pageUrl] ?? 0 };
          if (contentChanged) update.lastChangedAt = new Date();
          await ScrapedPage.findOneAndUpdate({ domain, url: pageUrl }, update, { upsert: true });
        }

        if (result.unchangedUrls.length > 0) {
          await ScrapedPage.updateMany(
            { domain, url: { $in: result.unchangedUrls } },
            { lastScrapedAt: new Date() }
          );
        }
      }

      const pagesChanged = result.changedUrls.length + result.thinGroupUrls.length;
      const summary = {
        success: true,
        mode: 'rescrape',
        pagesChecked: result.changedUrls.length + result.unchangedUrls.length,
        pagesChanged,
        pagesUnchanged: result.unchangedUrls.length,
        chunksUpdated: result.embeddedChunks.length + result.thinGroupChunks.length,
        durationMs: result.durationMs,
        durationFormatted: formatDuration(result.durationMs),
      };

      activeScrapes.delete(domain);
      broadcastedIo.to(`domain:${domain}`).emit('scrape_complete', summary);
      res.json(summary);
    } else {
      // Snapshot existing scraped chunks before wiping (full scrape is destructive)
      await createSnapshot(domain, 'full');

      // Delete only scraped chunks — preserve manual, upload, and owner_reply chunks.
      await Chunk.deleteMany({ domain, source: { $nin: ['manual', 'upload', 'owner_reply'] } });
      await ScrapedPage.deleteMany({ domain });

      let totalChunks = 0;
      // Track chunk counts per URL across all batches for ScrapedPage.chunkCount
      const chunkCountByUrl = {};

      const { pageData, durationMs } = await scrapeSite(url, {
        ...opts,
        onChunks: async (batchChunks) => {
          const toInsert = batchChunks.map((c) => ({ ...c, domain }));
          await Chunk.insertMany(toInsert);
          totalChunks += batchChunks.length;
          for (const c of batchChunks) {
            chunkCountByUrl[c.url] = (chunkCountByUrl[c.url] || 0) + 1;
          }
        },
      });

      // Build ScrapedPage records from crawled page data
      const pageRecords = pageData.map(({ url: pageUrl, hash, usedPuppeteer }) => ({
        domain,
        url: pageUrl,
        contentHash: hash,
        usedPuppeteer: !!usedPuppeteer,
        chunkCount: chunkCountByUrl[pageUrl] ?? 0,
        lastScrapedAt: new Date(),
        lastChangedAt: new Date(),
      }));

      if (pageRecords.length > 0) {
        await ScrapedPage.insertMany(pageRecords);
      }

      await Entity.findOneAndUpdate(
        { domain },
        { name, timezone: timezone || 'America/New_York', lastScrapedAt: new Date() },
        { upsert: true, new: true }
      );

      const summary = {
        success: true,
        mode: 'full',
        pagesScraped: pageData.length,
        chunksStored: totalChunks,
        durationMs,
        durationFormatted: formatDuration(durationMs),
      };

      activeScrapes.delete(domain);
      broadcastedIo.to(`domain:${domain}`).emit('scrape_complete', summary);
      res.json(summary);
    }
  } catch (err) {
    activeScrapes.delete(domain);
    logger.error('scrape', err.message, { stack: err.stack }, domain);
    res.status(500).json({ error: 'Scrape failed', details: err.message });
  }
});

module.exports = router;
