const express = require('express');
const router = express.Router();
const { getRecentLogs } = require('../services/consoleBuf');
const Chunk = require('../models/Chunk');
const { embedQuery } = require('../services/embeddings');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');

function superadminOnly(req, res, next) {
  if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
  next();
}

router.use(requireAuth(), superadminOnly);

// GET /api/admin/logs
// Returns recent entries from the in-memory circular buffer (last ~500 lines).
// Client-side level filter applied here to keep payload small.
router.get('/logs', (req, res) => {
  const { level } = req.query;
  let logs = getRecentLogs().reverse(); // newest first for history load
  if (level === 'error') logs = logs.filter(e => e.level === 'error');
  else if (level === 'warn') logs = logs.filter(e => e.level !== 'info');
  res.json({ logs });
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
