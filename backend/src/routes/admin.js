const express = require('express');
const router = express.Router();
const { getRecentLogs } = require('../services/consoleBuf');
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

module.exports = router;
