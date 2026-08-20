const express = require('express');
const router = express.Router();
const Entity = require('../models/Entity');
const Conversation = require('../models/Conversation');
const UnansweredQuestion = require('../models/UnansweredQuestion');
const { retrieveContext } = require('../services/rag');
const { buildRetrievalQuery } = require('../services/retrievalQuery');
const { chat, classifyQuery, summarizeTopic } = require('../services/claude');
const { sendHandoffNotification, sendQuotaWarning, sendQuotaExceededNotification } = require('../services/notifications');
const { questionSimilarity, SIMILARITY_THRESHOLD: DUPLICATE_THRESHOLD } = require('../services/questions');
const { shouldLogUnanswered } = require('../services/unanswered');
const { isTestModeRequest } = require('../services/testMode');
const { trackDailyVolume } = require('../services/dailyVolume');
const { checkRateLimit, clientIp } = require('../services/rateLimit');
const logger = require('../services/logger');

const HANDOFF_RE        = /\[HANDOFF_REQUESTED:\s*([^\]]+)\]\s*$/;
const HANDOFF_CANCEL_RE = /\[HANDOFF_CANCEL:\s*([^\]]+)\]\s*$/;
const OPTIONS_RE        = /\[OPTIONS:\s*([^\]]+)\]\s*$/;

const PAGE_SIZE = 20;

// GET /chat/entity-name — lightweight public endpoint for widget initialization
router.get('/entity-name', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'domain required' });
  const entity = await Entity.findOne({ domain }).select('name').lean();
  res.json({ name: entity?.name || '' });
});

// POST /chat — send a message
router.post('/', async (req, res) => {
  const { domain, sessionToken, message, type, interactiveData } = req.body;

  if (!domain || !sessionToken || !message) {
    return res.status(400).json({ error: 'domain, sessionToken, and message are required' });
  }

  try {
    const entity = await Entity.findOne({ domain });
    if (!entity) {
      return res.status(404).json({ error: 'Entity not found' });
    }

    // Test-mode (LEO-025): valid X-API-Key only — a body flag is never sufficient
    const isTest = await isTestModeRequest(req);

    // Rate limit (LEO-034) — in-memory sliding window; test-mode requests bypass
    if (!isTest) {
      const verdict = checkRateLimit({ sessionToken, ip: clientIp(req), domain });
      if (!verdict.allowed) {
        return res.status(429).json({
          error: 'rate_limited',
          message: "Whew — you're sending a lot of messages! Give me just a moment to catch my breath, then let's keep going. 😊",
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
      }
    }

    // --- Quota check & usage tracking ---
    const now = new Date();
    // Reset monthly counter if the billing period has rolled over
    if (entity.billingPeriodResetAt && now >= entity.billingPeriodResetAt) {
      entity.messageCountThisPeriod = 0;
      entity.notifiedThresholds = [];
      entity.quotaExceededNotified = false;
      entity.billingPeriodStart = now;
      entity.billingPeriodResetAt = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
    }
    // Initialise period dates on first message if not set
    if (!entity.billingPeriodResetAt) {
      entity.billingPeriodStart = now;
      entity.billingPeriodResetAt = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
    }

    const FREE_TIER_LIMIT = 100;
    if (entity.plan === 'free' && entity.messageCountThisPeriod >= FREE_TIER_LIMIT) {
      // Notify owner once when the limit is first hit
      if (!entity.quotaExceededNotified) {
        entity.quotaExceededNotified = true;
        entity.save().catch((err) => console.error('Entity save error (quota exceeded):', err));
        sendQuotaExceededNotification({
          entity,
          messageCountThisPeriod: entity.messageCountThisPeriod,
          limit: FREE_TIER_LIMIT,
        }).catch((err) => console.error('Quota exceeded notification error:', err));
      }
      return res.status(402).json({
        error: 'quota_exceeded',
        message: 'Free plan limit reached (100 messages/month). Upgrade to keep the conversation going.',
        messageCountThisPeriod: entity.messageCountThisPeriod,
        plan: entity.plan,
      });
    }

    let conversation = await Conversation.findOne({ sessionToken, domain });

    // Retrieval only — the message Leo sees is unchanged (LEO-039)
    const retrievalQuery = buildRetrievalQuery(message, conversation?.messages);
    const [{ context: ragContext, ownerReplyContext, sources, topScore }, classifierResult] = await Promise.all([
      retrieveContext(domain, retrievalQuery, entity.ragThreshold),
      classifyQuery(message, conversation),
    ]);

    const { text: replyText, model, classifierRoute, classifierReason } = await chat({ entity, conversation, ragContext, ownerReplyContext, sources, topScore, userMessage: message, classifierResult });
    let reply = replyText;

    // Detect and strip signals from Leo's reply
    const handoffMatch = reply.match(HANDOFF_RE);
    if (handoffMatch) reply = reply.replace(HANDOFF_RE, '').trimEnd();

    const cancelMatch = reply.match(HANDOFF_CANCEL_RE);
    if (cancelMatch) reply = reply.replace(HANDOFF_CANCEL_RE, '').trimEnd();

    const optionsMatch = reply.match(OPTIONS_RE);
    let options = null;
    if (optionsMatch) {
      options = optionsMatch[1].split('|').map(o => o.trim()).filter(Boolean).slice(0, 4);
      reply = reply.replace(OPTIONS_RE, '').trimEnd();
    }

    if (!conversation) {
      conversation = new Conversation({ sessionToken, domain, messages: [] });
    }
    if (isTest) conversation.isTest = true;

    const userMsg = { role: 'user', content: message };
    if (type === 'interactive' && interactiveData) {
      userMsg.type = 'interactive';
      userMsg.interactiveData = {
        options:  interactiveData.options  || [],
        selected: interactiveData.selected || message,
      };
    }
    const hadContext = !!(ragContext || ownerReplyContext);
    conversation.messages.push(userMsg);
    conversation.messages.push({ role: 'assistant', content: reply, model, topScore, hadContext, classifierRoute, classifierReason });
    conversation.lastActiveAt = new Date();

    // Remove a specific pending question when visitor confirms cancellation
    if (cancelMatch && conversation.pendingQuestions?.length) {
      const cancelText = cancelMatch[1].trim();
      const idx = conversation.pendingQuestions.findIndex(q => q.text === cancelText);
      if (idx !== -1) conversation.pendingQuestions.splice(idx, 1);
      if (conversation.pendingQuestions.length === 0) conversation.handoffPending = false;
    }

    // Accumulate pending questions, only notify owner on the first handoff
    if (handoffMatch) {
      const question = handoffMatch[1].trim();
      if (!conversation.pendingQuestions) conversation.pendingQuestions = [];
      const isDuplicate = conversation.pendingQuestions.some(
        (q) => questionSimilarity(question, q.text) >= DUPLICATE_THRESHOLD
      );
      if (!isDuplicate) conversation.pendingQuestions.push({ text: question, askedAt: new Date() });
      conversation.handoffPending = true;

      if (!isTest && (entity.ownerPhone || entity.ownerEmail)) {
        // Atomic test-and-set: only the request that transitions handoffPending false→true
        // fires the notification, preventing race-condition duplicate alerts.
        // New conversations (not yet in DB) can't race — treat as first handoff directly.
        const isFirstHandoff = conversation.isNew
          ? true
          : !!(await Conversation.findOneAndUpdate(
              { sessionToken, domain, handoffPending: { $ne: true } },
              { $set: { handoffPending: true } }
            ));

        if (isFirstHandoff) {
          conversation.lastHandoffNotifiedAt = new Date();
          sendHandoffNotification({
            entity,
            reason: question,
            pendingQuestions: conversation.pendingQuestions.map((q) => q.text),
            sessionToken,
            conversationId: conversation._id,
            lastMessage: message,
          }).catch((err) => console.error('Handoff notification error:', err));
        }
      }
    }

    // Increment usage counters (skipped for test-mode sessions)
    if (!isTest) {
      entity.messageCount = (entity.messageCount || 0) + 1;
      entity.messageCountThisPeriod = (entity.messageCountThisPeriod || 0) + 1;
    }

    // Fire quota warning notifications for free tier when thresholds are crossed
    if (!isTest && entity.plan === 'free') {
      const thresholds = entity.quotaWarningThresholds?.length ? entity.quotaWarningThresholds : [50, 75, 90];
      const alreadyNotified = entity.notifiedThresholds || [];
      const newlyHit = thresholds.filter((t) => {
        const triggerAt = Math.ceil(FREE_TIER_LIMIT * t / 100);
        return entity.messageCountThisPeriod >= triggerAt && !alreadyNotified.includes(t);
      });
      if (newlyHit.length) {
        entity.notifiedThresholds = [...alreadyNotified, ...newlyHit];
        const highestHit = Math.max(...newlyHit);
        sendQuotaWarning({
          entity,
          threshold: highestHit,
          messageCountThisPeriod: entity.messageCountThisPeriod,
          limit: FREE_TIER_LIMIT,
        }).catch((err) => console.error('Quota warning notification error:', err));
      }
    }

    await Promise.all([conversation.save(), entity.save()]);

    // Daily volume guardrail (LEO-035) — fire-and-forget, warns but never blocks
    if (!isTest) {
      trackDailyVolume({ entityId: entity._id, now }).catch((err) => console.error('Daily volume guardrail error:', err));
    }

    // Fire-and-forget — log questions Leo couldn't answer (skip interactive button clicks)
    if (!isTest && shouldLogUnanswered({ message, reply, hadContext, handoffOffered: !!handoffMatch, interactive: type === 'interactive' })) {
      UnansweredQuestion.create({
        entityDomain: domain,
        question: message,
        conversationId: conversation._id,
        sessionToken,
        handoffOffered: !!handoffMatch,
      }).catch((err) => console.error('UnansweredQuestion save error:', err));
    }

    // Notify dashboard clients watching this domain (suppressed for test-mode sessions)
    const io = isTest ? null : req.app.get('io');
    io?.to(`domain:${domain}`).emit('new_message', {
      conversationId: conversation._id,
      sessionToken,
      domain,
      lastMessage: message.slice(0, 120),
      messageCount: conversation.messages.length,
      lastActiveAt: conversation.lastActiveAt,
      handoffPending: conversation.handoffPending,
    });
    if (handoffMatch) {
      io?.to(`domain:${domain}`).emit('handoff_requested', {
        conversationId: conversation._id,
        sessionToken,
        domain,
        question: handoffMatch[1].trim(),
      });
    }

    // Fire-and-forget lastTopic summarization — skip on first exchange (< 4 messages)
    if (conversation.messages.length >= 4) {
      summarizeTopic(conversation.messages)
        .then((topic) => Conversation.findByIdAndUpdate(conversation._id, { lastTopic: topic }))
        .catch((err) => console.error('lastTopic summarization error:', err));
    }

    res.json({
      reply,
      sessionToken,
      handoffTriggered: !!handoffMatch,
      isTest,
      options,
      usage: {
        messageCountThisPeriod: entity.messageCountThisPeriod,
        plan: entity.plan,
        limitThisPeriod: entity.plan === 'free' ? FREE_TIER_LIMIT : null,
      },
    });
  } catch (err) {
    const domain = req.body?.domain || 'unknown';
    logger.error('chat', err.message, { stack: err.stack }, domain);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /chat/history — paginated message history for a session
router.get('/history', async (req, res) => {
  const { domain, sessionToken, before } = req.query;

  if (!domain || !sessionToken) {
    return res.status(400).json({ error: 'domain and sessionToken are required' });
  }

  try {
    const [conversation, entity] = await Promise.all([
      Conversation.findOne({ sessionToken, domain }),
      Entity.findOne({ domain }).select('linksOpenInNewTab'),
    ]);

    const entityConfig = { linksOpenInNewTab: entity?.linksOpenInNewTab ?? true, name: entity?.name || '' };

    if (!conversation || !conversation.messages.length) {
      return res.json({ messages: [], hasMore: false, entityConfig });
    }

    // Find unseen owner replies before filtering/paginating
    const unseenReplies = conversation.messages.filter(
      (m) => m.role === 'owner_reply' && !m.seenByVisitor
    );
    if (unseenReplies.length) {
      unseenReplies.forEach((m) => { m.seenByVisitor = true; });
      await conversation.save();
    }

    let messages = conversation.messages;

    if (before) {
      const beforeDate = new Date(before);
      messages = messages.filter((m) => new Date(m.timestamp) < beforeDate);
    }

    const hasMore = messages.length > PAGE_SIZE;
    const page = messages.slice(-PAGE_SIZE);

    res.json({
      messages: page,
      hasMore,
      lastTopic: conversation.lastTopic || null,
      unseenOwnerReplies: unseenReplies.map((m) => m.content),
      entityConfig,
    });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

module.exports = router;
