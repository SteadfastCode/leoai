// Follow-up-aware retrieval query construction (LEO-039).
//
// buildRetrievalQuery is a pure function: no DB, no network. These tests pin
// the contract chat.js relies on — the returned text feeds query embedding
// only, and must be the raw message whenever prepending history would not help.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRetrievalQuery,
  SELF_CONTAINED_LENGTH,
  MAX_PRIOR_CHARS,
} = require('../src/services/retrievalQuery');

test('no history → message unchanged', () => {
  assert.equal(buildRetrievalQuery('and the price?', []), 'and the price?');
  assert.equal(buildRetrievalQuery('and the price?', undefined), 'and the price?');
  assert.equal(buildRetrievalQuery('and the price?', null), 'and the price?');
});

test('short follow-up with history → prior user turn prepended', () => {
  const history = [
    { role: 'user', content: 'Do you sell sourdough bread?' },
    { role: 'assistant', content: 'Yes! We bake sourdough fresh every morning.' },
  ];
  assert.equal(
    buildRetrievalQuery('and the price?', history),
    'Do you sell sourdough bread?\nand the price?'
  );
});

test('uses the LAST user turn, skipping assistant and owner_reply messages', () => {
  const history = [
    { role: 'user', content: 'What are your hours?' },
    { role: 'assistant', content: 'We are open 9-5.' },
    { role: 'user', content: 'Do you have gluten-free options?' },
    { role: 'assistant', content: 'We do!' },
    { role: 'owner_reply', content: 'Also try our new muffins.' },
  ];
  assert.equal(
    buildRetrievalQuery('what about that one?', history),
    'Do you have gluten-free options?\nwhat about that one?'
  );
});

test('long self-contained message → unchanged even with history', () => {
  const history = [{ role: 'user', content: 'Do you sell sourdough bread?' }];
  const longMsg = 'Could you tell me everything about your catering services for a wedding of 150 people next June?';
  assert.ok(longMsg.length >= SELF_CONTAINED_LENGTH);
  assert.equal(buildRetrievalQuery(longMsg, history), longMsg);
});

test('history with no user turns → unchanged', () => {
  const history = [
    { role: 'assistant', content: 'Welcome back! Last time we talked about bread.' },
    { role: 'owner_reply', content: 'Thanks for visiting.' },
  ];
  assert.equal(buildRetrievalQuery('and the price?', history), 'and the price?');
});

test('prior turn is capped at MAX_PRIOR_CHARS', () => {
  const longPrior = 'x'.repeat(MAX_PRIOR_CHARS + 200);
  const history = [{ role: 'user', content: longPrior }];
  const out = buildRetrievalQuery('and that one?', history);
  assert.equal(out, `${'x'.repeat(MAX_PRIOR_CHARS)}\nand that one?`);
});

test('whitespace-only and malformed history entries are skipped', () => {
  const history = [
    { role: 'user', content: 'Do you ship nationwide?' },
    { role: 'user', content: '   ' },
    { role: 'user' },
    null,
  ];
  assert.equal(
    buildRetrievalQuery('how much?', history),
    'Do you ship nationwide?\nhow much?'
  );
});

test('empty message → returned unchanged (empty)', () => {
  assert.equal(buildRetrievalQuery('', [{ role: 'user', content: 'hi' }]), '');
  assert.equal(buildRetrievalQuery(undefined, [{ role: 'user', content: 'hi' }]), '');
});
