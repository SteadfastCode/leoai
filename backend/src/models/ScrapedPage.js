const mongoose = require('mongoose');

// Tracks per-page scrape state for smart rescraping (hash-based diffing)
const scrapedPageSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    url: { type: String, required: true },
    contentHash: { type: String, required: true },
    priority:     { type: String, enum: ['high', 'normal'], default: 'normal' },
    usedPuppeteer:{ type: Boolean, default: false },
    hasVariants:  { type: Boolean, default: false },
    chunkCount:   { type: Number, default: 0 },
    // Report-only LeoScan findings for this page's chunks (LEO-060): rule
    // names, never the matched text. Rewritten on every crawl, so a page
    // that stops tripping clears itself on the next pass.
    scanRules:    { type: [String], default: [] },
    // Consecutive crawls that did NOT reach this page (LEO-138). Reset to 0 by
    // any crawl that reaches it or that fails to fetch it for a reason other
    // than 404/410; at services/pageRetire.MAX_MISSES the page and its scraped
    // chunks are retired. Absent on every row written before LEO-138, which the
    // default reads as "never missed" — the right starting point.
    missedCrawls: { type: Number, default: 0 },
    lastScrapedAt: { type: Date, default: Date.now },
    lastChangedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

scrapedPageSchema.index({ domain: 1, url: 1 }, { unique: true });

module.exports = mongoose.model('ScrapedPage', scrapedPageSchema);
