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
    lastScrapedAt: { type: Date, default: Date.now },
    lastChangedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

scrapedPageSchema.index({ domain: 1, url: 1 }, { unique: true });

module.exports = mongoose.model('ScrapedPage', scrapedPageSchema);
