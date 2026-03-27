const mongoose = require('mongoose');

// Tracks per-page scrape state for smart rescraping (hash-based diffing)
const scrapedPageSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, index: true },
    url: { type: String, required: true },
    contentHash: { type: String, required: true },
    priority:     { type: String, enum: ['high', 'normal'], default: 'normal' },
    usedPuppeteer:{ type: Boolean, default: false },
    chunkCount:   { type: Number, default: 0 },
    lastScrapedAt: { type: Date, default: Date.now },
    lastChangedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

scrapedPageSchema.index({ domain: 1, url: 1 }, { unique: true });

module.exports = mongoose.model('ScrapedPage', scrapedPageSchema);
