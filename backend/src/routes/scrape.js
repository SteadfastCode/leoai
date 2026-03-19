const express = require('express');
const router = express.Router();
const Entity = require('../models/Entity');
const Chunk = require('../models/Chunk');
const ScrapedPage = require('../models/ScrapedPage');
const { scrapeSite, rescrapeSite } = require('../services/scraper');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const { makeBroadcastIo } = require('../utils/broadcastIo');

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

router.post('/', requireAuth(), async (req, res) => {
  const { domain, url, name, timezone, rescrape } = req.body;

  // Superadmins can crawl any domain. Owners can only rescrape their own domain.
  if (!isSuperAdmin(req.user)) {
    const hasMembership = req.user.memberships?.some((m) => m.entityDomain === domain);
    if (!hasMembership) return res.status(403).json({ error: 'Forbidden' });
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
    const isRescrape = rescrape && storedPages.length > 0;
    const mode = isRescrape ? 'rescrape' : 'full';

    activeScrapes.set(domain, { url, name, startedAt: new Date(), mode });

    if (isRescrape) {
      result = await rescrapeSite(url, storedPages, opts);

      if (result.embeddedChunks.length > 0) {
        await Chunk.deleteMany({ domain, url: { $in: result.changedUrls } });
        await Chunk.insertMany(result.embeddedChunks.map((c) => ({ ...c, domain })));

        for (const { url: pageUrl, hash, priority } of result.pageHashUpdates) {
          await ScrapedPage.findOneAndUpdate(
            { domain, url: pageUrl },
            { contentHash: hash, priority, lastScrapedAt: new Date(), lastChangedAt: new Date() },
            { upsert: true }
          );
        }

        if (result.unchangedUrls.length > 0) {
          await ScrapedPage.updateMany(
            { domain, url: { $in: result.unchangedUrls } },
            { lastScrapedAt: new Date() }
          );
        }
      }

      const summary = {
        success: true,
        mode: 'rescrape',
        pagesChecked: result.changedUrls.length + result.unchangedUrls.length,
        pagesChanged: result.changedUrls.length,
        pagesUnchanged: result.unchangedUrls.length,
        chunksUpdated: result.embeddedChunks.length,
        durationMs: result.durationMs,
        durationFormatted: formatDuration(result.durationMs),
      };

      activeScrapes.delete(domain);
      broadcastedIo.to(`domain:${domain}`).emit('scrape_complete', summary);
      res.json(summary);
    } else {
      const { chunks, durationMs } = await scrapeSite(url, opts);

      await Chunk.deleteMany({ domain });
      await ScrapedPage.deleteMany({ domain });

      if (chunks.length > 0) {
        await Chunk.insertMany(chunks.map((c) => ({ ...c, domain })));
      }

      const urlChunkMap = new Map();
      for (const chunk of chunks) {
        if (!urlChunkMap.has(chunk.url)) urlChunkMap.set(chunk.url, []);
        urlChunkMap.get(chunk.url).push(chunk.content);
      }

      const crypto = require('crypto');
      const pageRecords = [...urlChunkMap.entries()].map(([pageUrl, contents]) => ({
        domain,
        url: pageUrl,
        contentHash: crypto.createHash('sha256').update(contents.join('')).digest('hex'),
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
        pagesScraped: urlChunkMap.size,
        chunksStored: chunks.length,
        durationMs,
        durationFormatted: formatDuration(durationMs),
      };

      activeScrapes.delete(domain);
      broadcastedIo.to(`domain:${domain}`).emit('scrape_complete', summary);
      res.json(summary);
    }
  } catch (err) {
    activeScrapes.delete(domain);
    console.error('Scrape error:', err);
    res.status(500).json({ error: 'Scrape failed', details: err.message });
  }
});

module.exports = router;
