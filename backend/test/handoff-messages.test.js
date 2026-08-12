// Handoff alert message rendering (LEO-012).
//
// Pure-function tests on the exported builders — NOTHING here goes anywhere
// near a send path. No Twilio client is constructed, no email service is
// invoked, no network. sendHandoffNotification itself is deliberately not
// called in this suite.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildHandoffSms,
  buildHandoffEmail,
  buildQuestionBlock,
  SMS_QUESTION_CAP,
} = require('../src/services/notifications');

const base = {
  entityName: 'Dosie Dough',
  reason: 'Do you ship internationally?',
  lastMessage: 'Can you ship a sourdough starter to Canada?',
  conversationLink: 'http://localhost:5173/#/conversations/abc123',
  shortSession: 'sess-12345',
};

const q = (n) => Array.from({ length: n }, (_, i) => `Question number ${i + 1}?`);

test('zero questions: both channels render the no-questions placeholder', () => {
  const sms = buildHandoffSms({ ...base, pendingQuestions: [] });
  assert.ok(sms.includes('(no questions recorded)'));

  const { subject, text } = buildHandoffEmail({ ...base, pendingQuestions: [] });
  assert.equal(subject, 'Dosie Dough — Leo needs your help');
  assert.ok(text.includes('(no questions recorded)'));
  assert.ok(text.includes('Open question(s):'));
});

test('one question: rendered as a single bullet in both channels', () => {
  const sms = buildHandoffSms({ ...base, pendingQuestions: q(1) });
  assert.ok(sms.includes('• Question number 1?'));
  assert.ok(!sms.includes('more'), 'no truncation tail for a single question');

  const { text } = buildHandoffEmail({ ...base, pendingQuestions: q(1) });
  assert.ok(text.includes('• Question number 1?'));
});

test('many questions: SMS caps with +N more, email renders every one', () => {
  const seven = q(7);
  const sms = buildHandoffSms({ ...base, pendingQuestions: seven });
  for (let i = 1; i <= SMS_QUESTION_CAP; i++) assert.ok(sms.includes(`• Question number ${i}?`));
  assert.ok(!sms.includes(`• Question number ${SMS_QUESTION_CAP + 1}?`), 'SMS must stop at the cap');
  assert.ok(sms.includes(`+${7 - SMS_QUESTION_CAP} more`));

  const { text } = buildHandoffEmail({ ...base, pendingQuestions: seven });
  for (let i = 1; i <= 7; i++) assert.ok(text.includes(`• Question number ${i}?`));
  assert.ok(!text.includes('more'), 'email is never truncated');
});

test('truncation boundary: exactly at the cap renders all, one past it truncates', () => {
  const atCap = buildQuestionBlock(q(SMS_QUESTION_CAP), SMS_QUESTION_CAP);
  assert.equal(atCap.split('\n').length, SMS_QUESTION_CAP, 'no tail line at exactly the cap');
  assert.ok(!atCap.includes('more'));

  const pastCap = buildQuestionBlock(q(SMS_QUESTION_CAP + 1), SMS_QUESTION_CAP);
  const lines = pastCap.split('\n');
  assert.equal(lines.length, SMS_QUESTION_CAP + 1, 'cap lines plus the tail');
  assert.equal(lines.at(-1), '+1 more');
});

test('SMS and email render the same question block (up to the SMS cap)', () => {
  const two = q(2);
  const sms = buildHandoffSms({ ...base, pendingQuestions: two });
  const { text } = buildHandoffEmail({ ...base, pendingQuestions: two });
  const block = buildQuestionBlock(two);
  assert.ok(sms.includes(block), 'SMS must contain the shared block');
  assert.ok(text.includes(block), 'email must contain the shared block');
});

test('reason and truncated last message still render in the SMS', () => {
  const long = 'x'.repeat(150);
  const sms = buildHandoffSms({ ...base, lastMessage: long, pendingQuestions: q(1) });
  assert.ok(sms.includes('Visitor needs help: "Do you ship internationally?"'));
  assert.ok(sms.includes(`"${'x'.repeat(100)}…"`), 'last message capped at 100 chars');
});
