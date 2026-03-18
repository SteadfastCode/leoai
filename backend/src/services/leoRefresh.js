const cron = require('node-cron');
const Entity = require('../models/Entity');
const Chunk = require('../models/Chunk');
const ScrapedPage = require('../models/ScrapedPage');
const { rescrapeSite } = require('./scraper');

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

async function runRefreshForEntity(entity, io) {
  const domain = entity.domain;
  const url = `https://${domain}`;
  console.log(`[LeoRefresh] Starting rescrape for ${domain}`);

  try {
    const storedPages = await ScrapedPage.find({ domain });
    const opts = { io, domain };
    const result = await rescrapeSite(url, storedPages, opts);

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
    }

    if (result.unchangedUrls.length > 0) {
      await ScrapedPage.updateMany(
        { domain, url: { $in: result.unchangedUrls } },
        { lastScrapedAt: new Date() }
      );
    }

    await Entity.findOneAndUpdate({ domain }, { lastScrapedAt: new Date() });

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

async function runAllRefreshes(io) {
  const entities = await Entity.find({ leoRefreshEnabled: true });
  if (entities.length === 0) {
    console.log('[LeoRefresh] No entities with LeoRefresh enabled — skipping');
    return;
  }

  console.log(`[LeoRefresh] Running for ${entities.length} entities`);

  // Sequential — Puppeteer + embedding is resource-intensive; no parallel runs
  for (const entity of entities) {
    await runRefreshForEntity(entity, io);
  }

  console.log('[LeoRefresh] All done');
}

function startLeoRefreshScheduler(io) {
  // Daily at 3:00 AM UTC
  cron.schedule('0 3 * * *', () => {
    console.log('[LeoRefresh] Cron triggered');
    runAllRefreshes(io).catch((err) => console.error('[LeoRefresh] Unexpected error:', err));
  });

  console.log('[LeoRefresh] Scheduler started — runs daily at 3:00 AM UTC');
}

module.exports = { startLeoRefreshScheduler };
