const express = require('express');
const router = express.Router();
const Log = require('../models/Log');
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

module.exports = router;
