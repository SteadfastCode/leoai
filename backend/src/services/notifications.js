const twilio = require('twilio');
const { sendEmailRaw } = require('./email');
const { matchesDoNotRelay } = require('./doNotRelay');

// Twilio segments at 160 chars — cap the SMS question list and tail with "+N more".
const SMS_QUESTION_CAP = 3;

// Do-not-relay debug tiers — DO_NOT_RELAY_LOG_LEVEL = off | light | normal | verbose:
//   light (default) one line per alert that actually withheld something
//   normal          adds alerts that were checked against a list and withheld nothing
//   verbose         adds entities with no list configured (i.e. every handoff alert)
// The suppression happens inside a fire-and-forget send whose body the owner
// only ever sees as an SMS, so the light tier names the SOURCE of the change
// (entity.doNotRelay) and which FIELDS it withheld — never the matched text
// itself, which the admin log viewer would then put back on a screen.
const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.DO_NOT_RELAY_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[DoNotRelay] ${message}`);
}

// One spelling of the reason, so the question-block tail and the single-field
// marker can never drift apart.
const DO_NOT_RELAY_REASON = 'matched your "don\'t relay" list';
const WITHHELD_FIELD = `(withheld — ${DO_NOT_RELAY_REASON})`;

// Render one free-text alert field, replacing it wholesale when it matches the
// owner's do-not-relay list (LEO-094). Filtering only the question block left
// the same words on the `reason` and `lastMessage` lines a line or two above
// it: chat.js passes the question itself as `reason`, and `lastMessage` is
// normally the visitor turn that produced it, so a matched question was still
// relayed in full on both channels.
//
// `quote` wraps a surviving value the way each line always has — a withheld
// marker is never quoted, because it isn't something the visitor said. `cap`
// truncates with an ellipsis (the SMS line has always capped at 100).
function withholdIfMatched(text, doNotRelay, { quote = false, cap = 0 } = {}) {
  const value = typeof text === 'string' ? text : '';
  if (matchesDoNotRelay(value, doNotRelay)) return WITHHELD_FIELD;
  const shown = cap && value.length > cap ? `${value.slice(0, cap)}…` : value;
  return quote ? `"${shown}"` : shown;
}

// Log-safe summary of what an alert withheld: field names and a question count,
// never the text. Returns null when nothing was withheld. Pure — the send paths
// log it, the builders stay I/O-free.
function describeWithheld({ reason, lastMessage, pendingQuestions, doNotRelay }) {
  const fields = [];
  if (matchesDoNotRelay(reason, doNotRelay)) fields.push('reason');
  if (matchesDoNotRelay(lastMessage, doNotRelay)) fields.push('lastMessage');
  const questions = (pendingQuestions || [])
    .filter(Boolean)
    .filter((q) => matchesDoNotRelay(q, doNotRelay)).length;
  if (questions) fields.push(`${questions} question${questions === 1 ? '' : 's'}`);
  return fields.length ? fields.join(', ') : null;
}

// Light/normal/verbose line for one alert's suppression outcome.
function logWithheld(label, entity, parts) {
  const list = Array.isArray(entity?.doNotRelay) ? entity.doNotRelay : [];
  const domain = entity?.domain || 'unknown';
  if (!list.length) {
    debug('verbose', `${label} for ${domain}: nothing withheld — source: entity.doNotRelay is empty`);
    return;
  }
  const withheld = describeWithheld({ ...parts, doNotRelay: list });
  if (withheld) {
    debug('light', `${label} for ${domain}: withheld ${withheld} — source: entity.doNotRelay (${list.length} phrase${list.length === 1 ? '' : 's'})`);
  } else {
    debug('normal', `${label} for ${domain}: nothing withheld — source: entity.doNotRelay (${list.length} phrase${list.length === 1 ? '' : 's'}) matched nothing`);
  }
}

// Shared pending-question block for handoff alerts and follow-ups. Pure.
// cap = null renders every question (email); a number caps with a "+N more" tail.
//
// doNotRelay (LEO-047) is the safety net, not the mechanism: Leo is instructed
// not to raise a handoff for those topics at all. If one slips through anyway
// the alert still sends — the owner needs to know a visitor is waiting — but the
// matched question is left out of the body, replaced by a withheld count so the
// owner can tell "nothing recorded" from "suppressed by my own list".
function buildQuestionBlock(pendingQuestions, cap = null, doNotRelay = []) {
  const all = (pendingQuestions || []).filter(Boolean);
  const questions = all.filter((q) => !matchesDoNotRelay(q, doNotRelay));
  const withheld = all.length - questions.length;
  const withheldLine = `(${withheld} question${withheld === 1 ? '' : 's'} withheld — ${DO_NOT_RELAY_REASON})`;

  if (!questions.length) return withheld ? withheldLine : '(no questions recorded)';

  const shown = cap && questions.length > cap ? questions.slice(0, cap) : questions;
  const lines = shown.map((q) => `• ${q}`);
  if (shown.length < questions.length) lines.push(`+${questions.length - shown.length} more`);
  if (withheld) lines.push(withheldLine);
  return lines.join('\n');
}

// Pure message builders — unit-tested without any Twilio/Resend involvement.
function buildHandoffSms({ entityName, reason, lastMessage, conversationLink, shortSession, pendingQuestions, doNotRelay }) {
  return [
    `🦁 Leo handoff — ${entityName}`,
    `Visitor needs help: ${withholdIfMatched(reason, doNotRelay, { quote: true })}`,
    buildQuestionBlock(pendingQuestions, SMS_QUESTION_CAP, doNotRelay),
    `Last message: ${withholdIfMatched(lastMessage, doNotRelay, { quote: true, cap: 100 })}`,
    `View chat: ${conversationLink}`,
    `Session: ${shortSession}`,
  ].join('\n');
}

function buildHandoffEmail({ entityName, reason, lastMessage, conversationLink, shortSession, pendingQuestions, doNotRelay }) {
  return {
    subject: `${entityName} — Leo needs your help`,
    text: [
      `Hey! Leo flagged a conversation that needs a human.`,
      ``,
      `Business: ${entityName}`,
      `Reason: ${withholdIfMatched(reason, doNotRelay)}`,
      `Open question(s):`,
      buildQuestionBlock(pendingQuestions, null, doNotRelay),
      `Last message: ${withholdIfMatched(lastMessage, doNotRelay, { quote: true })}`,
      ``,
      `View the full conversation: ${conversationLink}`,
      `Session: ${shortSession}`,
      ``,
      `— LeoAI by Steadfast Code`,
    ].join('\n'),
  };
}

// The follow-up reminder's bodies, hoisted out of the send path (LEO-094) for
// the same reason the handoff ones live here: the do-not-relay filter they
// apply can only be asserted with no Twilio/Resend client in the room. The
// reminder used to call buildQuestionBlock with no list at all, so every
// question the first alert withheld was relayed in full 24 hours later.
function buildFollowUpSms({ entityName, conversationLink, shortSession, pendingQuestions, doNotRelay }) {
  return [
    `🦁 Leo reminder — ${entityName}`,
    `A visitor is still waiting for your reply.`,
    buildQuestionBlock(pendingQuestions, SMS_QUESTION_CAP, doNotRelay),
    `View chat: ${conversationLink}`,
    `Session: ${shortSession}`,
  ].join('\n');
}

function buildFollowUpEmail({ entityName, conversationLink, shortSession, pendingQuestions, doNotRelay }) {
  return {
    subject: `Reminder — ${entityName} visitor still waiting`,
    text: [
      `Hey! Just a reminder from LeoAI.`,
      ``,
      `A visitor on ${entityName} is still waiting for a response from your team.`,
      ``,
      `Open question(s):`,
      buildQuestionBlock(pendingQuestions, null, doNotRelay),
      ``,
      `View and reply: ${conversationLink}`,
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

  const parts = { entityName: entity.name, reason, lastMessage, conversationLink, shortSession, pendingQuestions, doNotRelay: entity.doNotRelay };
  const smsBody = buildHandoffSms(parts);
  const { subject, text } = buildHandoffEmail(parts);
  logWithheld('handoff alert', entity, parts);

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


// Daily volume guardrail alert (LEO-035) — fires at most once per UTC day per
// entity (enforced upstream in dailyVolume.js). Warns, never blocks. Owner
// channels mirror sendQuotaWarning; the superadmin copy goes to ADMIN_PHONE /
// ADMIN_EMAIL like sendMinistryPlanRequest.
async function sendDailyVolumeAlert({ entity, count, threshold }) {
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const overviewLink = `${dashboardUrl}/#/overview`;
  const channels = entity.quotaAlertChannels || ['email'];

  const smsBody = [
    `🦁 LeoAI volume alert — ${entity.name}`,
    `Leo has handled ${count} messages today, above your daily alert threshold of ${threshold}.`,
    `Traffic is not blocked — check the dashboard if this is unexpected: ${overviewLink}`,
  ].join('\n');
  const subject = `${entity.name} — unusually high Leo traffic today`;
  const text = [
    `Hey! A heads-up from LeoAI.`,
    ``,
    `${entity.name}'s Leo has handled ${count} messages so far today (UTC) — above the daily alert threshold of ${threshold}.`,
    `Traffic is NOT blocked. This is an early warning in case something unexpected (a bug, abuse, or a traffic spike) is driving volume.`,
    ``,
    `You can adjust the threshold in Settings, or check today's conversations here:`,
    `${overviewLink}`,
    ``,
    `— LeoAI by Steadfast Code`,
  ].join('\n');

  const tasks = [];
  if (channels.includes('sms') && entity.ownerPhone) {
    tasks.push({ label: 'owner SMS', promise: sendSms(entity.ownerPhone, smsBody) });
  }
  if (channels.includes('email') && entity.ownerEmail) {
    tasks.push({ label: 'owner email', promise: sendEmailRaw(entity.ownerEmail, subject, text) });
  }
  if (process.env.ADMIN_PHONE) {
    tasks.push({ label: 'admin SMS', promise: sendSms(process.env.ADMIN_PHONE, `${smsBody}\nEntity: ${entity.domain}`) });
  }
  if (process.env.ADMIN_EMAIL) {
    tasks.push({ label: 'admin email', promise: sendEmailRaw(process.env.ADMIN_EMAIL, `[admin] ${subject}`, `${text}\n\nEntity: ${entity.domain}`) });
  }

  const results = await Promise.allSettled(tasks.map((t) => t.promise));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Daily volume alert ${tasks[i].label} failed for ${entity.domain}:`, r.reason?.message || r.reason);
    }
  });
}

async function sendHandoffFollowUpNotification({ entity, conversationId, sessionToken, pendingQuestions }) {
  const shortSession = sessionToken.slice(0, 10);
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const conversationLink = `${dashboardUrl}/#/conversations/${conversationId}`;
  const parts = { entityName: entity.name, conversationLink, shortSession, pendingQuestions, doNotRelay: entity.doNotRelay };
  logWithheld('handoff reminder', entity, { pendingQuestions });
  const smsBody = buildFollowUpSms(parts);
  const { subject, text } = buildFollowUpEmail(parts);

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
  sendDailyVolumeAlert,
  sendEmailRaw,
  sendMinistryPlanRequest,
  // Pure builders, exported for unit tests — no send path touches them directly.
  buildHandoffSms,
  buildHandoffEmail,
  buildFollowUpSms,
  buildFollowUpEmail,
  buildQuestionBlock,
  withholdIfMatched,
  describeWithheld,
  SMS_QUESTION_CAP,
  WITHHELD_FIELD,
};
