const mongoose = require('mongoose');

// Metadata record for a scrape backup snapshot.
// Actual archived chunks live in ArchivedChunk, referenced by snapshotId.
const scrapeSnapshotSchema = new mongoose.Schema(
  {
    domain:       { type: String, required: true, index: true },
    mode:         { type: String, enum: ['full', 'force', 'rescrape'], required: true },
    chunkCount:   { type: Number, default: 0 },
    pageCount:    { type: Number, default: 0 },
    affectedUrls: { type: [String], default: [] }, // all URLs for full/force; changed URLs for rescrape
  },
  { timestamps: true }
);

module.exports = mongoose.model('ScrapeSnapshot', scrapeSnapshotSchema);
