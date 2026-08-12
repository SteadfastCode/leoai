const twilio = require('twilio');
const { sendEmailRaw } = require('./email');

// Twilio segments at 160 chars — cap the SMS question list and tail with "+N more".
const SMS_QUESTION_CAP = 3;

// Shared pending-question block for handoff alerts and follow-ups. Pure.
// cap = null renders every question (email); a number caps with a "+N more" tail.
function buildQuestionBlock(pendingQuestions, cap = null) {
  const questions = (pendingQuestions || []).filter(Boolean);
  if (!questions.length) return '(no questions recorded)';
  const shown = cap && questions.length > cap ? questions.slice(0, cap) : questions;
  const lines = shown.map((q) => `• ${q}`);
  if (shown.length < questions.length) lines.push(`+${questions.length - shown.length} more`);
  return lines.join('\n');
}

// Pure message builders — unit-tested without any Twilio/Resend involvement.
function buildHandoffSms({ entityName, reason, lastMessage, conversationLink, shortSession, pendingQuestions }) {
  return [
    `🦁 Leo handoff — ${entityName}`,
    `Visitor needs help: "${reason}"`,
    buildQuestionBlock(pendingQuestions, SMS_QUESTION_CAP),
    `Last message: "${lastMessage.slice(0, 100)}${lastMessage.length > 100 ? '…' : ''}"`,
    `View chat: ${conversationLink}`,
    `Session: ${shortSession}`,
  ].join('\n');
}

function buildHandoffEmail({ entityName, reason, lastMessage, conversationLink, shortSession, pendingQuestions }) {
  return {
    subject: `${entityName} — Leo needs your help`,
    text: [
      `Hey! Leo flagged a conversation that needs a human.`,
      ``,
      `Business: ${entityName}`,
      `Reason: ${reason}`,
      `Open question(s):`,
      buildQuestionBlock(pendingQuestions),
      `Last message: "${lastMessage}"`,
      ``,
      `View the full conversation: ${conversationLink}`,
      `Session: ${shortSession}`,
      ``,
      `— LeoAI by Steadfast Code`,
    ].join('\n'),
  };
}

/**
 * Send a handoff notification to the business owner via SMS and/or email,
 * depending on what's configured on the entity and in the environment.
 *
 * Both channels are optional and fail gracefully — a missing config or
 * send failure never blocks the chat response.
 *
 * @param {object} opts
 * @param {object} opts.entity        - The Entity document
 * @param {string} opts.reason        - The reason Leo flagged for handoff
 * @param {string[]} [opts.pendingQuestions] - Open question texts on the conversation
 * @param {string} opts.sessionToken  - Visitor's session token
 * @param {string} opts.conversationId - MongoDB _id of the Conversation
 * @param {string} opts.lastMessage   - The visitor's last message
 */
async function sendHandoffNotification({ entity, reason, pendingQuestions, sessionToken, conversationId, lastMessage }) {
  const shortSession = sessionToken.slice(0, 10);
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const conversationLink = `${dashboardUrl}/#/conversations/${conversationId}`;

  const parts = { entityName: entity.name, reason, lastMessage, conversationLink, shortSession, pendingQuestions };
  const smsBody = buildHandoffSms(parts);
  const { subject, text } = buildHandoffEmail(parts);

  const results = await Promise.allSettled([
    sendSms(entity.ownerPhone, smsBody),
    sendEmailRaw(entity.ownerEmail, subject, text),
  ]);

  // Log failures without throwing — notifications are best-effort
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const channel = i === 0 ? 'SMS' : 'email';
      console.error(`Handoff ${channel} failed for ${entity.domain}:`, r.reason?.message || r.reason);
    }
  });
}

async function sendSms(toNumber, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER || !toNumber) return;

  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await client.messages.create({ from: TWILIO_FROM_NUMBER, to: toNumber, body });
}

async function sendQuotaWarning({ entity, threshold, messageCountThisPeriod, limit }) {
  const channels = entity.quotaAlertChannels || ['email'];
  if (!channels.length) return;

  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const billingLink  = `${dashboardUrl}/#/billing`;
  const remaining    = limit - messageCountThisPeriod;

  const tasks = [];

  if (channels.includes('sms') && entity.ownerPhone) {
    const smsBody = [
      `🦁 LeoAI usage alert — ${entity.name}`,
      `Leo has used ${threshold}% of your free plan (${messageCountThisPeriod}/${limit} messages).`,
      `${remaining} messages remaining this month.`,
      `Upgrade to keep Leo running: ${billingLink}`,
    ].join('\n');
    tasks.push({ label: 'SMS', promise: sendSms(entity.ownerPhone, smsBody) });
  }

  if (channels.includes('email') && entity.ownerEmail) {
    const subject = `${entity.name} — Leo is at ${threshold}% of your free plan`;
    const text = [
      `Hey! Just a heads-up from LeoAI.`,
      ``,
      `${entity.name}'s Leo has used ${threshold}% of the free plan this month.`,
      `Messages used: ${messageCountThisPeriod} of ${limit}`,
      `Messages remaining: ${remaining}`,
      ``,
      `If Leo runs out, visitors will see a message letting them know Leo is temporarily unavailable.`,
      `Upgrade to Infinity (unlimited, $20/month) to keep the conversation going:`,
      `${billingLink}`,
      ``,
      `— LeoAI by Steadfast Code`,
    ].join('\n');
    tasks.push({ label: 'email', promise: sendEmailRaw(entity.ownerEmail, subject, text) });
  }

  const results = await Promise.allSettled(tasks.map((t) => t.promise));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Quota warning ${tasks[i].label} failed for ${entity.domain}:`, r.reason?.message || r.reason);
    }
  });
}

async function sendQuotaExceededNotification({ entity, messageCountThisPeriod, limit }) {
  const channels = entity.quotaAlertChannels || ['email'];
  if (!channels.length) return;

  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const billingLink  = `${dashboardUrl}/#/billing`;

  const tasks = [];

  if (channels.includes('sms') && entity.ownerPhone) {
    const smsBody = [
      `🦁 LeoAI — ${entity.name} hit the free plan limit`,
      `Leo has reached ${limit} messages this month and is now paused for visitors.`,
      `Upgrade now to restore service: ${billingLink}`,
    ].join('\n');
    tasks.push({ label: 'SMS', promise: sendSms(entity.ownerPhone, smsBody) });
  }

  if (channels.includes('email') && entity.ownerEmail) {
    const subject = `Action needed — ${entity.name}'s Leo has hit the monthly limit`;
    const text = [
      `Hey! Important notice from LeoAI.`,
      ``,
      `${entity.name}'s Leo has reached the free plan limit of ${limit} messages this month.`,
      ``,
      `Leo is currently unavailable to visitors until the plan is upgraded or the month resets.`,
      `Visitors are seeing a friendly message letting them know Leo is temporarily paused.`,
      ``,
      `Upgrade to Infinity (unlimited, $20/month) to restore service immediately:`,
      `${billingLink}`,
      ``,
      `— LeoAI by Steadfast Code`,
    ].join('\n');
    tasks.push({ label: 'email', promise: sendEmailRaw(entity.ownerEmail, subject, text) });
  }

  const results = await Promise.allSettled(tasks.map((t) => t.promise));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Quota exceeded ${tasks[i].label} failed for ${entity.domain}:`, r.reason?.message || r.reason);
    }
  });
}


async function sendHandoffFollowUpNotification({ entity, conversationId, sessionToken, pendingQuestions }) {
  const shortSession = sessionToken.slice(0, 10);
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const conversationLink = `${dashboardUrl}/#/conversations/${conversationId}`;
  const smsBody = [
    `🦁 Leo reminder — ${entity.name}`,
    `A visitor is still waiting for your reply.`,
    buildQuestionBlock(pendingQuestions, SMS_QUESTION_CAP),
    `View chat: ${conversationLink}`,
    `Session: ${shortSession}`,
  ].join('\n');

  const subject = `Reminder — ${entity.name} visitor still waiting`;
  const text = [
    `Hey! Just a reminder from LeoAI.`,
    ``,
    `A visitor on ${entity.name} is still waiting for a response from your team.`,
    ``,
    `Open question(s):`,
    buildQuestionBlock(pendingQuestions),
    ``,
    `View and reply: ${conversationLink}`,
    `Session: ${shortSession}`,
    ``,
    `— LeoAI by Steadfast Code`,
  ].join('\n');

  const results = await Promise.allSettled([
    sendSms(entity.ownerPhone, smsBody),
    sendEmailRaw(entity.ownerEmail, subject, text),
  ]);

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const channel = i === 0 ? 'SMS' : 'email';
      console.error(`Handoff follow-up ${channel} failed for ${entity.domain}:`, r.reason?.message || r.reason);
    }
  });
}

async function sendMinistryPlanRequest({ entityName, domain, requestedBy }) {
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const adminPhone = process.env.ADMIN_PHONE;
  const adminEmail = process.env.ADMIN_EMAIL;

  const smsBody = [
    `⛪ Ministry Plan Request — LeoAI`,
    `Entity: ${entityName} (${domain})`,
    `Requested by: ${requestedBy}`,
    `Review: ${dashboardUrl}/#/ministry-requests`,
  ].join('\n');

  const results = await Promise.allSettled([
    sendSms(adminPhone, smsBody),
    adminEmail ? sendEmailRaw(adminEmail, `Ministry Plan Request — ${entityName}`, smsBody) : Promise.resolve(),
  ]);

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const channel = i === 0 ? 'SMS' : 'email';
      console.error(`Ministry plan request ${channel} notification failed:`, r.reason?.message || r.reason);
    }
  });
}

module.exports = {
  sendHandoffNotification,
  sendHandoffFollowUpNotification,
  sendQuotaWarning,
  sendQuotaExceededNotification,
  sendEmailRaw,
  sendMinistryPlanRequest,
  // Pure builders, exported for unit tests — no send path touches them directly.
  buildHandoffSms,
  buildHandoffEmail,
  buildQuestionBlock,
  SMS_QUESTION_CAP,
};
