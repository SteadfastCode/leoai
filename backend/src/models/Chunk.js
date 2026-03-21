const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },
    url: { type: String, required: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    source: { type: String, enum: ['scraped', 'owner_reply', 'manual', 'upload'], default: 'scraped' },
    label: { type: String }, // human-readable name for manual/upload entries
    chunkIndex: { type: Number }, // position within page — populated by scraper; used for sibling-range narrowing once semantic chunking lands
  },
  { timestamps: true }
);

chunkSchema.index({ domain: 1 });

module.exports = mongoose.model('Chunk', chunkSchema);
