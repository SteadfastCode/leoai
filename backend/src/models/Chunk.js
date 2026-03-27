const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },
    url: { type: String, required: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    source: { type: String, enum: ['scraped', 'owner_reply', 'manual', 'upload'], default: 'scraped' },
    label:    { type: String }, // display name — tab label in chunk viewer; derived from H2(s) in chunk
    pageH1:   { type: String }, // page-level H1 heading (same for all chunks on a page)
    sectionH2:{ type: String }, // primary H2 section this chunk belongs to (null for intro/pre-H2 content)
    chunkIndex: { type: Number }, // position within page — used for sibling-range narrowing in tree retrieval
    sourceUrls: { type: [String], default: [] }, // contributing page URLs — single-URL chunks have [url]; group chunks list all member pages
  },
  { timestamps: true }
);

chunkSchema.index({ domain: 1 });

module.exports = mongoose.model('Chunk', chunkSchema);
