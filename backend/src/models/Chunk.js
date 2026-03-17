const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },
    url: { type: String, required: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    source: { type: String, enum: ['scraped', 'owner_reply'], default: 'scraped' },
  },
  { timestamps: true }
);

chunkSchema.index({ domain: 1 });

module.exports = mongoose.model('Chunk', chunkSchema);
