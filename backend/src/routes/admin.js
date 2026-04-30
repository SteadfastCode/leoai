const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getRecentLogs } = require('../services/consoleBuf');
const Chunk = require('../models/Chunk');
const { embedQuery } = require('../services/embeddings');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const ApiKey = require('../models/ApiKey');

// ---------------------------------------------------------------------------
// Auth — accepts either a valid superadmin JWT or a valid X-API-Key header
// ---------------------------------------------------------------------------

async function requireAdminAuth(req, res, next) {
  const rawKey = req.headers['x-api-key'];
  if (rawKey) {
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const key = await ApiKey.findOne({ keyHash }).catch(() => null);
    if (!key) return res.status(401).json({ error: 'Invalid API key' });
    ApiKey.updateOne({ _id: key._id }, { lastUsedAt: new Date() }).catch(() => {});
    req.apiKey = key;
    return next();
  }

  return requireAuth()(req, res, () => {
    if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

router.use(requireAdminAuth);

// ---------------------------------------------------------------------------
// GET /api/admin/logs
// ---------------------------------------------------------------------------

router.get('/logs', (req, res) => {
  const { level } = req.query;
  let logs = getRecentLogs().reverse();
  if (level === 'error') logs = logs.filter(e => e.level === 'error');
  else if (level === 'warn') logs = logs.filter(e => e.level !== 'info');
  res.json({ logs });
});

// ---------------------------------------------------------------------------
// GET /api/admin/search
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// API Keys — list / create / revoke
// API key requests can't manage keys (prevents escalation via stolen key)
// ---------------------------------------------------------------------------

function jwtSuperadminOnly(req, res, next) {
  if (req.apiKey) return res.status(403).json({ error: 'API key management requires dashboard login' });
  next();
}

// GET /api/admin/api-keys
router.get('/api-keys', jwtSuperadminOnly, async (req, res) => {
  try {
    const keys = await ApiKey.find().select('-keyHash').sort({ createdAt: -1 });
    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/api-keys
router.post('/api-keys', jwtSuperadminOnly, async (req, res) => {
  const { label = '' } = req.body;
  try {
    const rawKey = 'leoai_' + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const key = await ApiKey.create({ keyHash, label: label.trim(), scope: 'mcp' });
    res.status(201).json({
      key: {
        _id: key._id,
        label: key.label,
        scope: key.scope,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
      },
      rawKey,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/api-keys/:id
router.delete('/api-keys/:id', jwtSuperadminOnly, async (req, res) => {
  try {
    const key = await ApiKey.findByIdAndDelete(req.params.id);
    if (!key) return res.status(404).json({ error: 'API key not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
