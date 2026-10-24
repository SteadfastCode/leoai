const mongoose = require('mongoose');

// One URL the run never learned (LEO-056). Optional and additive — a snapshot
// written before this field existed simply has an empty array.
// reason: 'fetch_error' | 'http_error' | 'empty_after_render' — left as a plain
// String rather than an enum so an older backend reading a newer snapshot, or a
// future reason, can never make an existing document fail validation on save.
const failedUrlSchema = new mongoose.Schema(
  {
    url:    { type: String },
    reason: { type: String },
    status: { type: Number, default: null },
  },
  { _id: false }
);

// Metadata record for a scrape backup snapshot.
// Actual archived chunks live in ArchivedChunk, referenced by snapshotId.
const scrapeSnapshotSchema = new mongoose.Schema(
  {
    domain:       { type: String, required: true, index: true },
    mode:         { type: String, enum: ['full', 'force', 'rescrape'], required: true },
    chunkCount:   { type: Number, default: 0 },
    pageCount:    { type: Number, default: 0 },
    affectedUrls: { type: [String], default: [] }, // all URLs for full/force; changed URLs for rescrape
    failedUrls:   { type: [failedUrlSchema], default: [] }, // URLs the crawl never learned (LEO-056)
    // URLs robots.txt would have disallowed (LEO-071). Optional and additive, in
    // the same shape as failedUrls above: a snapshot written before this field
    // existed simply has an empty array. Plain [String] with no required and no
    // unique — the same URL legitimately appears across runs and across domains.
    robotsDisallowed: { type: [String], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScrapeSnapshot', scrapeSnapshotSchema);
