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
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !toAddress) return;

  const isLocalhost = SMTP_HOST === '127.0.0.1' || SMTP_HOST === 'localhost';
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: Number(SMTP_PORT) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    tls: isLocalhost ? { rejectUnauthorized: false } : undefined,
  });

  await transporter.sendMail({
    from: SMTP_FROM || SMTP_USER,
    to: toAddress,
    subject: `${businessName} — Leo needs your help`,
    text: [
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
    ].join('\n'),
  });
}

module.exports = { sendHandoffNotification };
