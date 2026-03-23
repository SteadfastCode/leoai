const express = require('express');
const router = express.Router();
const Code = require('../models/Code');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');

function sa(req, res) {
  if (!isSuperAdmin(req.user)) { res.status(403).json({ error: 'Forbidden' }); return false; }
  return true;
}

// GET /api/codes — list all codes (superadmin)
router.get('/', requireAuth(), async (req, res) => {
  if (!sa(req, res)) return;
  const { type } = req.query;
  const filter = type ? { type } : {};
  const codes = await Code.find(filter).sort({ createdAt: -1 }).select('-usedBy');
  res.json(codes);
});

// GET /api/codes/:id — single code with usedBy log (superadmin)
router.get('/:id', requireAuth(), async (req, res) => {
  if (!sa(req, res)) return;
  const code = await Code.findById(req.params.id);
  if (!code) return res.status(404).json({ error: 'Not found' });
  res.json(code);
});

// POST /api/codes — create a code (superadmin)
router.post('/', requireAuth(), async (req, res) => {
  if (!sa(req, res)) return;
  const { code, type, description, maxUses, expiresAt } = req.body;
  if (!code || !type) return res.status(400).json({ error: 'code and type are required' });
  try {
    const created = await Code.create({ code, type, description, maxUses: maxUses ?? null, expiresAt: expiresAt ?? null });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Code already exists' });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/codes/:id — update active, description, expiresAt (superadmin)
router.patch('/:id', requireAuth(), async (req, res) => {
  if (!sa(req, res)) return;
  const allowed = ['active', 'description', 'expiresAt', 'maxUses'];
  const update = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  // Recalculate used flag if maxUses changed
  if ('maxUses' in update) {
    const code = await Code.findById(req.params.id);
    if (!code) return res.status(404).json({ error: 'Not found' });
    update.used = update.maxUses !== null && code.useCount >= update.maxUses;
  }
  const code = await Code.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!code) return res.status(404).json({ error: 'Not found' });
  res.json(code);
});

// DELETE /api/codes/:id — hard delete (superadmin)
router.delete('/:id', requireAuth(), async (req, res) => {
  if (!sa(req, res)) return;
  await Code.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
