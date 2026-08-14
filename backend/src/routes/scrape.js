const express = require('express');
const router = express.Router();
const Entity = require('../models/Entity');
const Chunk = require('../models/Chunk');
const ScrapedPage = require('../models/ScrapedPage');
const ScrapeSnapshot = require('../models/ScrapeSnapshot');
const ArchivedChunk = require('../models/ArchivedChunk');
const { scrapeSite, rescrapeSite } = require('../services/scraper');
const { createSnapshot, persistRescrapeResult, tallyChunkCounts } = require('../services/scrapePersist');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const { makeBroadcastIo } = require('../utils/broadcastIo');
const logger = require('../services/logger');
const { recordAudit } = require('../services/audit');

// Chunk sources a scrape may never delete — defined once on the model, see Chunk.js.
const { PRESERVED_SOURCES } = Chunk;

// In-memory tracking of currently active scrapes
// domain → { url, name, startedAt, mode }
const activeScrapes = new Map();

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
      .select('url priority usedPuppeteer hasVariants chunkCount lastScrapedAt lastChangedAt -_id'),
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
  await Chunk.deleteMany({ domain, url: { $in: urlsToRestore }, source: { $nin: PRESERVED_SOURCES } });
  await Chunk.insertMany(archived.map(({ _id, snapshotId, __v, createdAt, updatedAt, ...c }) => c));

  recordAudit(req, 'snapshot.restore', {
    domain,
    details: { snapshotId: req.params.id, restoredChunks: archived.length, url: url || null },
  });

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
  const entity = await Entity.findOne({ domain }).lean();
  const opts = { io: broadcastedIo, domain, crawlSettings: entity?.crawlSettings || {} };

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
      recordAudit(req, 'scrape.force', { domain, details: { url } });
      await createSnapshot(domain, 'force');
      await Chunk.deleteMany({ domain, source: { $nin: PRESERVED_SOURCES } });
      await ScrapedPage.deleteMany({ domain });
    }

    if (isRescrape) {
      result = await rescrapeSite(url, storedPages, opts);

      // Snapshot + per-URL insert-before-delete + ScrapedPage upserts.
      // Shared with LeoRefresh — see services/scrapePersist.js.
      const { pagesChanged } = await persistRescrapeResult({ domain, result, io: broadcastedIo });

      const summary = {
        success: true,
        mode: 'rescrape',
        pagesChecked: result.changedUrls.length + result.unchangedUrls.length,
        pagesChanged,
        pagesUnchanged: result.unchangedUrls.length,
        chunksUpdated: result.embeddedChunks.length + result.thinGroupChunks.length,
        skippedUrls: result.skippedUrls || [],
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
      await Chunk.deleteMany({ domain, source: { $nin: PRESERVED_SOURCES } });
      await ScrapedPage.deleteMany({ domain });

      let totalChunks = 0;
      const chunkCountByUrl = {};

      const { pageData, durationMs, skippedUrls } = await scrapeSite(url, {
        ...opts,
        // onChunks receives (chunks, pageRecords) — pageRecords present for non-thin pages only
        onChunks: async (batchChunks, pageRecords = []) => {
          await Chunk.insertMany(batchChunks.map(c => ({ ...c, domain })));
          totalChunks += batchChunks.length;
          // Credits every URL in a group chunk's sourceUrls, not just the group URL.
          tallyChunkCounts(batchChunks, chunkCountByUrl);
          // Upsert ScrapedPage records progressively for non-thin pages
          if (pageRecords.length > 0) {
            await Promise.all(pageRecords.map(p =>
              ScrapedPage.findOneAndUpdate(
                { domain, url: p.url },
                { contentHash: p.hash, priority: p.priority, usedPuppeteer: !!p.usedPuppeteer, hasVariants: !!p.hasVariants, lastScrapedAt: new Date(), lastChangedAt: new Date(), chunkCount: chunkCountByUrl[p.url] || 0 },
                { upsert: true }
              )
            ));
            broadcastedIo.to(`domain:${domain}`).emit('scrape_page_saved', { count: pageRecords.length });
          }
        },
      });

      // Final pass: upsert ScrapedPage for ALL pages via bulkWrite.
      // Non-thin pages were already upserted in onChunks — this is idempotent for them.
      // Thin pages and any zero-chunk pages are picked up here for the first time.
      if (pageData.length > 0) {
        await ScrapedPage.bulkWrite(
          pageData.map(({ url: pageUrl, hash, usedPuppeteer, hasVariants }) => ({
            updateOne: {
              filter: { domain, url: pageUrl },
              update: { $set: { contentHash: hash, usedPuppeteer: !!usedPuppeteer, hasVariants: !!hasVariants, lastScrapedAt: new Date(), lastChangedAt: new Date(), chunkCount: chunkCountByUrl[pageUrl] || 0 } },
              upsert: true,
            },
          }))
        );
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
        skippedUrls: skippedUrls || [],
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
