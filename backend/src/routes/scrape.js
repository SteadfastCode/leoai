const express = require('express');
const router = express.Router();
const Entity = require('../models/Entity');
const Chunk = require('../models/Chunk');
const ScrapedPage = require('../models/ScrapedPage');
const { scrapeSite, rescrapeSite } = require('../services/scraper');

router.post('/', async (req, res) => {
  const { domain, url, name, timezone, rescrape } = req.body;

  if (!domain || !url || !name) {
    return res.status(400).json({ error: 'domain, url, and name are required' });
  }

  try {
    let result;
    const storedPages = await ScrapedPage.find({ domain });
    const isRescrape = rescrape && storedPages.length > 0;

    if (isRescrape) {
      // Smart rescrape — only re-embed changed pages
      result = await rescrapeSite(url, storedPages);

      if (result.embeddedChunks.length > 0) {
        // Remove stale chunks for changed pages only
        await Chunk.deleteMany({ domain, url: { $in: result.changedUrls } });
        await Chunk.insertMany(result.embeddedChunks.map((c) => ({ ...c, domain })));

        // Update page hashes
        for (const { url: pageUrl, hash, priority } of result.pageHashUpdates) {
          await ScrapedPage.findOneAndUpdate(
            { domain, url: pageUrl },
            { contentHash: hash, priority, lastScrapedAt: new Date(), lastChangedAt: new Date() },
            { upsert: true }
          );
        }

        // Update lastScrapedAt for unchanged pages
        if (result.unchangedUrls.length > 0) {
          await ScrapedPage.updateMany(
            { domain, url: { $in: result.unchangedUrls } },
            { lastScrapedAt: new Date() }
          );
        }
      }

      res.json({
        success: true,
        mode: 'rescrape',
        pagesChecked: result.changedUrls.length + result.unchangedUrls.length,
        pagesChanged: result.changedUrls.length,
        pagesUnchanged: result.unchangedUrls.length,
        chunksUpdated: result.embeddedChunks.length,
      });
    } else {
      // Full scrape — crawl everything, embed everything
      const chunks = await scrapeSite(url);

      await Chunk.deleteMany({ domain });
      await ScrapedPage.deleteMany({ domain });

      if (chunks.length > 0) {
        await Chunk.insertMany(chunks.map((c) => ({ ...c, domain })));

        // Build page hash records from scraped chunks
        const pageMap = new Map();
        for (const chunk of chunks) {
          if (!pageMap.has(chunk.url)) {
            pageMap.set(chunk.url, chunk);
          }
        }
      }

      // Store page hashes — re-fetch from scraper output isn't ideal here,
      // so we store a hash of all chunk content per URL as a proxy
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

      // Upsert entity record
      await Entity.findOneAndUpdate(
        { domain },
        { name, timezone: timezone || 'America/New_York', lastScrapedAt: new Date() },
        { upsert: true, new: true }
      );

      res.json({
        success: true,
        mode: 'full',
        pagesScraped: urlChunkMap.size,
        chunksStored: chunks.length,
      });
    }
  } catch (err) {
    console.error('Scrape error:', err);
    res.status(500).json({ error: 'Scrape failed', details: err.message });
  }
});

module.exports = router;
