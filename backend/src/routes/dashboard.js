const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const Entity = require('../models/Entity');
const Conversation = require('../models/Conversation');
const Chunk = require('../models/Chunk');
const ScrapedPage = require('../models/ScrapedPage');
const Invite = require('../models/Invite');
const User = require('../models/User');
const { embedTexts } = require('../services/embeddings');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const { PERMISSIONS } = require('../models/Permission');
const { sendEmailRaw } = require('../services/notifications');

// All dashboard routes require auth
router.use(requireAuth());

// GET /api/dashboard/entities — list entities the user has access to
router.get('/entities', async (req, res) => {
  try {
    // Superadmin sees all entities; others see only domains they have a membership in
    const filter = isSuperAdmin(req.user)
      ? {}
      : { domain: { $in: (req.user.memberships || []).map((m) => m.entityDomain) } };
    const entities = await Entity.find(filter).sort({ createdAt: -1 });
    res.json(entities);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/entities/:domain/stats — overview stats for one entity
router.get('/entities/:domain/stats', async (req, res) => {
  try {
    const { domain } = req.params;

    const [entity, chunkCount, pageCount, conversationCount, messageAgg] = await Promise.all([
      Entity.findOne({ domain }),
      Chunk.countDocuments({ domain }),
      ScrapedPage.countDocuments({ domain }),
      Conversation.countDocuments({ domain }),
      Conversation.aggregate([
        { $match: { domain } },
        { $project: { count: { $size: '$messages' } } },
        { $group: { _id: null, total: { $sum: '$count' } } },
      ]),
    ]);

    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    const totalMessages = messageAgg[0]?.total ?? 0;

    res.json({
      entity,
      stats: {
        chunkCount,
        pageCount,
        conversationCount,
        totalMessages,
        lastScrapedAt: entity.lastScrapedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/entities/:domain/conversations — paginated conversations
router.get('/entities/:domain/conversations', async (req, res) => {
  try {
    const { domain } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = 20;
    const skip = (page - 1) * limit;

    const [conversations, total] = await Promise.all([
      Conversation.find({ domain })
        .sort({ lastActiveAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-messages.embedding'),
      Conversation.countDocuments({ domain }),
    ]);

    res.json({ conversations, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/entities/:domain/conversations/:id — single conversation
router.get('/entities/:domain/conversations/:id', async (req, res) => {
  try {
    const conversation = await Conversation.findById(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Not found' });
    res.json(conversation); // includes pendingQuestions and handoffPending
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/entities/:domain/pages — scraped pages list
router.get('/entities/:domain/pages', async (req, res) => {
  try {
    const pages = await ScrapedPage.find({ domain: req.params.domain }).sort({ lastChangedAt: -1 });
    res.json(pages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/entities/:domain/conversations/:id/reply — owner replies to a conversation
router.post('/entities/:domain/conversations/:id/reply', requireAuth(PERMISSIONS.CONVERSATIONS_REPLY), async (req, res) => {
  const { replyText, answeredQuestions, addToKb } = req.body;
  if (!replyText?.trim()) return res.status(400).json({ error: 'replyText is required' });

  try {
    const [conversation, entity] = await Promise.all([
      Conversation.findById(req.params.id),
      Entity.findOne({ domain: req.params.domain }),
    ]);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    if (!entity) return res.status(404).json({ error: 'Entity not found' });

    // Append the owner reply — seenByVisitor: false so visitor gets greeted with it on return
    conversation.messages.push({ role: 'owner_reply', content: replyText.trim(), seenByVisitor: false });
    conversation.lastActiveAt = new Date();

    // Remove answered questions from pendingQuestions, reset handoffPending if all answered
    if (answeredQuestions?.length) {
      conversation.pendingQuestions = (conversation.pendingQuestions || []).filter(
        (q) => !answeredQuestions.includes(q.text)
      );
    }
    if (!conversation.pendingQuestions?.length) {
      conversation.handoffPending = false;
    }

    await conversation.save();

    // Optionally embed answered Q&A pairs into the knowledge base
    const shouldAddToKb = addToKb ?? entity.autoAddRepliesToKb;
    if (shouldAddToKb && answeredQuestions?.length) {
      const pairs = answeredQuestions.map((q) => `Q: ${q}\nA: ${replyText.trim()}`);
      const embeddings = await embedTexts(pairs);
      await Promise.all(pairs.map((content, i) =>
        Chunk.create({
          domain: req.params.domain,
          url: `owner-reply://${req.params.domain}`,
          content,
          embedding: embeddings[i],
          source: 'owner_reply',
        })
      ));
    }

    // Push reply to visitor in real-time if they're still in the chat
    const io = req.app.get('io');
    io.to(conversation.sessionToken).emit('owner_reply', { message: replyText.trim() });

    res.json({
      conversation,
      addedToKb: shouldAddToKb && !!answeredQuestions?.length,
    });
  } catch (err) {
    console.error('Owner reply error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/dashboard/entities/:domain — update entity settings (owner only)
router.patch('/entities/:domain', requireAuth(PERMISSIONS.SETTINGS_EDIT), async (req, res) => {
  try {
    const allowed = ['name', 'timezone', 'avgWaitTime', 'ownerPhone', 'ownerEmail', 'autoAddRepliesToKb', 'offerHandoffBeforeContact', 'quotaWarningThresholds', 'quotaAlertChannels'];
    const superadminOnly = ['churchModeEnabled', 'churchConfig', 'leoRefreshEnabled'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (isSuperAdmin(req.user)) {
      Object.assign(updates, Object.fromEntries(Object.entries(req.body).filter(([k]) => superadminOnly.includes(k))));
    }
    const entity = await Entity.findOneAndUpdate({ domain: req.params.domain }, updates, { new: true });
    if (!entity) return res.status(404).json({ error: 'Entity not found' });
    res.json(entity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Team management
// ---------------------------------------------------------------------------

// GET /api/dashboard/entities/:domain/team — list members with membership for this domain
router.get('/entities/:domain/team', requireAuth(PERMISSIONS.USERS_VIEW), async (req, res) => {
  try {
    const { domain } = req.params;
    const members = await User.find(
      { 'memberships.entityDomain': domain },
      { name: 1, email: 1, memberships: 1 }
    );
    res.json(members.map((u) => {
      const membership = u.memberships.find((m) => m.entityDomain === domain);
      return { _id: u._id, name: u.name, email: u.email, roles: membership?.roles || [] };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/entities/:domain/invites — pending (not accepted, not expired) invites
router.get('/entities/:domain/invites', requireAuth(PERMISSIONS.USERS_VIEW), async (req, res) => {
  try {
    const invites = await Invite.find({
      domain: req.params.domain,
      acceptedAt: null,
      expiresAt: { $gt: new Date() },
    }).populate('invitedBy', 'name');
    res.json(invites);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/entities/:domain/invites — create and email an invite
router.post('/entities/:domain/invites', requireAuth(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  const { domain } = req.params;
  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required' });

  try {
    const alreadyMember = await User.findOne({ email, 'memberships.entityDomain': domain });
    if (alreadyMember) return res.status(409).json({ error: 'This person is already a team member' });

    const pendingInvite = await Invite.findOne({ domain, email, acceptedAt: null, expiresAt: { $gt: new Date() } });
    if (pendingInvite) return res.status(409).json({ error: 'An invite is already pending for this email' });

    const entity = await Entity.findOne({ domain });
    const token = crypto.randomBytes(32).toString('hex');
    const invite = await Invite.create({
      token,
      domain,
      email,
      role: role || 'agent',
      invitedBy: req.user._id,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });

    const dashboardOrigin = process.env.DASHBOARD_ORIGIN || 'http://localhost:5173';
    const inviteUrl = `${dashboardOrigin}/#/accept-invite/${token}`;

    await sendEmailRaw(
      email,
      `You've been invited to join ${entity.name} on LeoAI`,
      `Hi!\n\n${req.user.name} has invited you to join ${entity.name}'s LeoAI dashboard as ${role || 'agent'}.\n\nAccept your invitation here:\n${inviteUrl}\n\nThis link expires in 48 hours.\n\n— LeoAI by Steadfast Code`
    );

    res.status(201).json(invite);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dashboard/entities/:domain/invites/:inviteId — cancel a pending invite
router.delete('/entities/:domain/invites/:inviteId', requireAuth(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  try {
    await Invite.findByIdAndDelete(req.params.inviteId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dashboard/entities/:domain/team/:userId — remove a member
router.delete('/entities/:domain/team/:userId', requireAuth(PERMISSIONS.USERS_MANAGE), async (req, res) => {
  try {
    const { domain, userId } = req.params;
    if (req.user._id.toString() === userId) {
      return res.status(400).json({ error: 'You cannot remove yourself' });
    }
    const member = await User.findById(userId);
    if (!member) return res.status(404).json({ error: 'User not found' });
    member.memberships = member.memberships.filter((m) => m.entityDomain !== domain);
    await member.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
