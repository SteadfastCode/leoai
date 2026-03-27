const mongoose = require('mongoose');

// Archived copy of a chunk at the time of a scrape snapshot.
// Embeddings are stored so restoration is one-click with no re-embedding cost.
// ~2KB per chunk; 1000-chunk site × 10 snapshots ≈ 20MB — acceptable for MongoDB.
const archivedChunkSchema = new mongoose.Schema(
  {
    snapshotId: { type: mongoose.Schema.Types.ObjectId, ref: 'ScrapeSnapshot', required: true, index: true },
    domain:     { type: String, required: true },
    url:        { type: String, required: true },
    content:    { type: String, required: true },
    embedding:  { type: [Number] },
    source:     { type: String },
    label:      { type: String },
    pageH1:     { type: String },
    sectionH2:  { type: String },
    chunkIndex: { type: Number },
  },
  { timestamps: true }
);

archivedChunkSchema.index({ snapshotId: 1, url: 1 });

module.exports = mongoose.model('ArchivedChunk', archivedChunkSchema);
