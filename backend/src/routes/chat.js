const express = require('express');
const router = express.Router();
const Entity = require('../models/Entity');
const Conversation = require('../models/Conversation');
const { retrieveContext } = require('../services/rag');
const { chat } = require('../services/claude');
const { sendHandoffNotification } = require('../services/notifications');

const HANDOFF_RE = /\[HANDOFF_REQUESTED:\s*([^\]]+)\]\s*$/;
const OPTIONS_RE  = /\[OPTIONS:\s*([^\]]+)\]\s*$/;

const PAGE_SIZE = 20;

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

    let conversation = await Conversation.findOne({ sessionToken, domain });

    const { context: ragContext, sources } = await retrieveContext(domain, message);

    let reply = await chat({ entity, conversation, ragContext, sources, userMessage: message });

    // Detect and strip signals from Leo's reply
    const handoffMatch = reply.match(HANDOFF_RE);
    if (handoffMatch) reply = reply.replace(HANDOFF_RE, '').trimEnd();

    const optionsMatch = reply.match(OPTIONS_RE);
    let options = null;
    if (optionsMatch) {
      options = optionsMatch[1].split('|').map(o => o.trim()).filter(Boolean).slice(0, 4);
      reply = reply.replace(OPTIONS_RE, '').trimEnd();
    }

    if (!conversation) {
      conversation = new Conversation({ sessionToken, domain, messages: [] });
    }

    const userMsg = { role: 'user', content: message };
    if (type === 'interactive' && interactiveData) {
      userMsg.type = 'interactive';
      userMsg.interactiveData = {
        options:  interactiveData.options  || [],
        selected: interactiveData.selected || message,
      };
    }
    conversation.messages.push(userMsg);
    conversation.messages.push({ role: 'assistant', content: reply });
    conversation.lastActiveAt = new Date();
    conversation.lastTopic = message.length > 120 ? message.slice(0, 120) + '…' : message;

    // Accumulate pending questions, only notify owner on the first handoff
    if (handoffMatch) {
      const question = handoffMatch[1].trim();
      if (!conversation.pendingQuestions) conversation.pendingQuestions = [];
      conversation.pendingQuestions.push(question);

      if (!conversation.handoffPending) {
        // First handoff in this cycle — notify owner
        conversation.handoffPending = true;
        if (entity.ownerPhone || entity.ownerEmail) {
          sendHandoffNotification({
            entity,
            reason: question,
            pendingQuestions: conversation.pendingQuestions,
            sessionToken,
            conversationId: conversation._id,
            lastMessage: message,
          }).catch((err) => console.error('Handoff notification error:', err));
        }
      }
      // If handoffPending is already true, Leo will tell the visitor it's been added —
      // no duplicate notification fires
    }

    await conversation.save();

    res.json({ reply, sessionToken, handoffTriggered: !!handoffMatch, options });
  } catch (err) {
    console.error('Chat error:', err);
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
    const conversation = await Conversation.findOne({ sessionToken, domain });
    if (!conversation || !conversation.messages.length) {
      return res.json({ messages: [], hasMore: false });
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
    });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

module.exports = router;
