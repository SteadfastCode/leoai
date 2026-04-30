const express = require('express');
const router = express.Router();
const Log = require('../models/Log');
const Chunk = require('../models/Chunk');
const { embedQuery } = require('../services/embeddings');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');

function superadminOnly(req, res, next) {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

router.use(requireAuth(), superadminOnly);

// GET /api/admin/logs
router.get('/logs', async (req, res) => {
  try {
    const { level, source, domain, page = 1 } = req.query;
    const PAGE_SIZE = 50;
    const filter = {};
    if (level)  filter.level  = level;
    if (source) filter.source = source;
    if (domain) filter.domain = domain;

    const [logs, total] = await Promise.all([
      Log.find(filter).sort({ createdAt: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
      Log.countDocuments(filter),
    ]);

    res.json({ logs, total, page: Number(page), pages: Math.ceil(total / PAGE_SIZE) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/search?domain=&query=&threshold=&limit=
// Run RAG retrieval and return raw scored chunks (for MCP search_chunks tool)
router.get('/search', async (req, res) => {
  try {
    const { domain, query } = req.query;
    const threshold = req.query.threshold ? Number(req.query.threshold) : 0.5;
    const limit = Math.min(Number(req.query.limit) || 20, 50);

    if (!domain || !query) {
      return res.status(400).json({ error: 'domain and query are required' });
    }

    const queryEmbedding = await embedQuery(query);

    const chunks = await Chunk.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: 100,
          limit,
          filter: { domain },
        },
      },
      {
        $project: {
          content: 1,
          url: 1,
          source: 1,
          chunkIndex: 1,
          label: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]);

    const results = chunks.filter(c => c.score >= threshold);
    res.json({ results, total: results.length, topScore: results[0]?.score ?? 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
