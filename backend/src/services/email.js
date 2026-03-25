const { Resend } = require('resend');

let _resend = null;

function getResend() {
  if (_resend) return _resend;
  const { RESEND_API_KEY } = process.env;
  if (!RESEND_API_KEY) return null;
  _resend = new Resend(RESEND_API_KEY);
  return _resend;
}

async function sendEmailRaw(toAddress, subject, text) {
  if (!toAddress) return;
  const resend = getResend();
  if (!resend) return;
  const from = process.env.RESEND_FROM || 'notifications@leo-ai.app';
  const { error } = await resend.emails.send({ from, to: toAddress, subject, text });
  if (error) throw new Error(error.message);
}

module.exports = { sendEmailRaw };
