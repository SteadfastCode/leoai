const twilio = require('twilio');
const nodemailer = require('nodemailer');

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
 * @param {string} opts.sessionToken  - Visitor's session token
 * @param {string} opts.conversationId - MongoDB _id of the Conversation
 * @param {string} opts.lastMessage   - The visitor's last message
 */
async function sendHandoffNotification({ entity, reason, sessionToken, conversationId, lastMessage }) {
  const shortSession = sessionToken.slice(0, 10);
  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
  const conversationLink = `${dashboardUrl}/#/conversations/${conversationId}`;

  const smsBody = [
    `🦁 Leo handoff — ${entity.name}`,
    `Visitor needs help: "${reason}"`,
    `Last message: "${lastMessage.slice(0, 100)}${lastMessage.length > 100 ? '…' : ''}"`,
    `View chat: ${conversationLink}`,
    `Session: ${shortSession}`,
  ].join('\n');

  const results = await Promise.allSettled([
    sendSms(entity.ownerPhone, smsBody),
    sendEmail(entity.ownerEmail, entity.name, reason, lastMessage, conversationLink, shortSession),
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

async function sendEmail(toAddress, businessName, reason, lastMessage, conversationLink, shortSession) {
  const subject = `${businessName} — Leo needs your help`;
  const text = [
    `Hey! Leo flagged a conversation that needs a human.`,
    ``,
    `Business: ${businessName}`,
    `Reason: ${reason}`,
    `Last message: "${lastMessage}"`,
    ``,
    `View the full conversation: ${conversationLink}`,
    `Session: ${shortSession}`,
    ``,
    `— LeoAI by Steadfast Code`,
  ].join('\n');
  await sendEmailRaw(toAddress, subject, text);
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

// Singleton transporter — created once on first use and reused for all sends.
// Creating a new transporter per call opens and tears down a TCP+SMTP connection
// each time; if the server sends 250 OK but the connection drops before nodemailer
// reads it, nodemailer retries and the SMTP server delivers a duplicate.
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;

  const isLocalhost = SMTP_HOST === '127.0.0.1' || SMTP_HOST === 'localhost';
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: isLocalhost ? { rejectUnauthorized: false } : undefined,
    pool: true,
    maxConnections: 1,
  });
  return _transporter;
}

async function sendEmailRaw(toAddress, subject, text) {
  if (!toAddress) return;
  const transporter = getTransporter();
  if (!transporter) return;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({ from, to: toAddress, subject, text });
}

module.exports = { sendHandoffNotification, sendQuotaWarning, sendQuotaExceededNotification, sendEmailRaw };
