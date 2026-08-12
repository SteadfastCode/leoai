const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getRecentLogs } = require('../services/consoleBuf');
const Chunk = require('../models/Chunk');
const Entity = require('../models/Entity');
const Conversation = require('../models/Conversation');
const { buildFleetRows } = require('../services/fleet');
const { recordAudit } = require('../services/audit');
const AuditLog = require('../models/AuditLog');
const Log = require('../models/Log');
const { embedQuery } = require('../services/embeddings');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const ApiKey = require('../models/ApiKey');

// ---------------------------------------------------------------------------
// Auth — accepts either a valid superadmin JWT or a valid X-API-Key header
// ---------------------------------------------------------------------------

// The X-API-Key branch now lives in requireAuth (middleware/auth.js), which resolves a
// valid key to a superadmin principal — so this is just "authenticate, then require
// superadmin" and works identically for a key or a JWT.
function requireAdminAuth(req, res, next) {
  return requireAuth()(req, res, () => {
    if (!isSuperAdmin(req.user)) return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

router.use(requireAdminAuth);

// ---------------------------------------------------------------------------
// GET /api/admin/logs
// ---------------------------------------------------------------------------

router.get('/logs', async (req, res) => {
  // mode=history reads the persisted Log collection (30-day TTL); everything
  // else falls through to the original in-memory live-buffer path, unchanged.
  if (req.query.mode === 'history') {
    try {
      const page = Math.max(Number(req.query.page) || 1, 1);
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const filter = {};
      if (req.query.level === 'error') filter.level = 'error';
      else if (req.query.level === 'warn') filter.level = { $in: ['warn', 'error'] };
      if (req.query.search) {
        const escaped = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        filter.message = { $regex: escaped, $options: 'i' };
      }
      const [logs, total] = await Promise.all([
        Log.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Log.countDocuments(filter),
      ]);
      return res.json({ logs, total, page, limit });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  const { level } = req.query;
  let logs = getRecentLogs().reverse();
  if (level === 'error') logs = logs.filter(e => e.level === 'error');
  else if (level === 'warn') logs = logs.filter(e => e.level !== 'info');
  res.json({ logs });
});

// ---------------------------------------------------------------------------
// GET /api/admin/fleet
// One row per entity: plan/quota, crawl freshness, KB and conversation volume.
// A single Entity.find() plus exactly two $match-scoped grouped aggregates —
// never a per-entity query. Row shaping lives in services/fleet.js.
// ---------------------------------------------------------------------------

router.get('/fleet', async (req, res) => {
  try {
    const entities = await Entity.find().lean();
    const domains = entities.map((e) => e.domain);

    const [chunkGroups, conversationGroups] = await Promise.all([
      Chunk.aggregate([
        { $match: { domain: { $in: domains } } },
        { $group: { _id: '$domain', chunkCount: { $sum: 1 } } },
      ]),
      Conversation.aggregate([
        { $match: { domain: { $in: domains } } },
        {
          $group: {
            _id: '$domain',
            conversationCount: { $sum: 1 },
            totalMessages: { $sum: { $size: { $ifNull: ['$messages', []] } } },
            lastActiveAt: { $max: '$lastActiveAt' },
          },
        },
      ]),
    ]);

    res.json({ rows: buildFleetRows(entities, chunkGroups, conversationGroups) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
// GET /api/admin/audit-log
// Read-only. There is intentionally no write/update/delete route — the trail
// is append-only and only services/audit.js writes to it.
// ---------------------------------------------------------------------------

router.get('/audit-log', async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.domain) filter.domain = req.query.domain;

    const [entries, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({ entries, total, page, limit });
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
    recordAudit(req, 'api_key.create', { details: { label: key.label } });
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
    recordAudit(req, 'api_key.revoke', { details: { label: key.label } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
