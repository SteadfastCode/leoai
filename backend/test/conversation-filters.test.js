// conversationFilterQuery contract (LEO-015).
//
// Pure mapping from the ?filter= query param to the Mongo query used by both
// the find() and countDocuments() of the conversations list. Unknown values
// must fall back to unfiltered, never throw.

const test = require('node:test');
const assert = require('node:assert/strict');

const { conversationFilterQuery } = require('../src/services/conversations');

const DOMAIN = 'example.com';

test('needs_reply matches pending handoff OR pending questions', () => {
  assert.deepEqual(conversationFilterQuery(DOMAIN, 'needs_reply'), {
    domain: DOMAIN,
    $or: [{ handoffPending: true }, { 'pendingQuestions.0': { $exists: true } }],
  });
});

test('answered excludes both signals', () => {
  assert.deepEqual(conversationFilterQuery(DOMAIN, 'answered'), {
    domain: DOMAIN,
    handoffPending: { $ne: true },
    'pendingQuestions.0': { $exists: false },
  });
});

test('all is unfiltered', () => {
  assert.deepEqual(conversationFilterQuery(DOMAIN, 'all'), { domain: DOMAIN });
});

test('absent filter is unfiltered (default response unchanged)', () => {
  assert.deepEqual(conversationFilterQuery(DOMAIN, undefined), { domain: DOMAIN });
});

test('unknown value falls back to unfiltered rather than throwing', () => {
  assert.deepEqual(conversationFilterQuery(DOMAIN, 'bogus'), { domain: DOMAIN });
  assert.deepEqual(conversationFilterQuery(DOMAIN, ''), { domain: DOMAIN });
  assert.deepEqual(conversationFilterQuery(DOMAIN, null), { domain: DOMAIN });
  // express can hand an array for a repeated query param
  assert.deepEqual(conversationFilterQuery(DOMAIN, ['needs_reply']), { domain: DOMAIN });
});
