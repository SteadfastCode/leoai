const mongoose = require('mongoose');

const chunkSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true },
    url: { type: String, required: true },
    content: { type: String, required: true },
    embedding: { type: [Number], required: true },
    source: { type: String, enum: ['scraped', 'owner_reply', 'manual', 'upload', 'unanswered_qa'], default: 'scraped' },
    label:    { type: String }, // display name — tab label in chunk viewer; derived from H2(s) in chunk
    pageH1:   { type: String }, // page-level H1 heading (same for all chunks on a page)
    sectionH2:{ type: String }, // primary H2 section this chunk belongs to (null for intro/pre-H2 content)
    chunkIndex: { type: Number }, // position within page — used for sibling-range narrowing in tree retrieval
    sourceUrls: { type: [String], default: [] }, // contributing page URLs — single-URL chunks have [url]; group chunks list all member pages
  },
  { timestamps: true }
);

chunkSchema.index({ domain: 1 });

const Chunk = mongoose.model('Chunk', chunkSchema);

// Sources a scrape is allowed to delete. Everything else is human-authored or
// human-derived and must survive a rescrape.
//
// Lives on the model so every destructive path shares one definition. This drifted once
// already: the list was spelled out inline in routes/scrape.js and services/leoRefresh.js
// never filtered by source at all, so the nightly job deleted owner replies and
// unanswered_qa chunks for any changed URL.
//
// Derived from the enum so a new source is preserved by default. Over-preserving leaves a
// stale chunk you can delete; over-deleting destroys owner-authored content permanently.
Chunk.DESTROYABLE_SOURCES = ['scraped'];
Chunk.PRESERVED_SOURCES = chunkSchema
  .path('source')
  .enumValues.filter((s) => !Chunk.DESTROYABLE_SOURCES.includes(s));

module.exports = Chunk;
