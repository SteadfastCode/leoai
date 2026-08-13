// Test-mode gate for POST /chat (LEO-025).
//
// The gate must return true only when the request carries a valid X-API-Key that
// resolved against the ApiKey model. resolveApiKey's contract: null = no header,
// false = header present but invalid (including DB failure), object = ApiKey doc.
// A request-body flag must never be sufficient — the body is visitor-controlled.
//
// Run: `yarn test` (node --test). No DB, no network — resolvers are injected.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestModeGate } = require('../src/services/testMode');

// A resolver faithful to resolveApiKey's shape: reads only the header, knows one key.
const fakeResolver = async (req) => {
  const raw = req.headers?.['x-api-key'];
  if (!raw) return null;
  if (raw !== 'valid-key') return false;
  return { _id: 'k1', scope: 'mcp', label: 'test' };
};

const gate = createTestModeGate(fakeResolver);

test('no key → not test mode', async () => {
  assert.equal(await gate({ headers: {}, body: {} }), false);
});

test('bad key → not test mode', async () => {
  assert.equal(await gate({ headers: { 'x-api-key': 'wrong' }, body: {} }), false);
});

test('body flag alone is never sufficient', async () => {
  assert.equal(await gate({ headers: {}, body: { isTest: true, testMode: true } }), false);
});

test('body flag plus bad key is still not test mode', async () => {
  assert.equal(await gate({ headers: { 'x-api-key': 'wrong' }, body: { isTest: true } }), false);
});

test('valid key → test mode', async () => {
  assert.equal(await gate({ headers: { 'x-api-key': 'valid-key' }, body: {} }), true);
});

test('resolver failure (false) fails closed to normal visitor mode', async () => {
  const failingGate = createTestModeGate(async () => false);
  assert.equal(await failingGate({ headers: { 'x-api-key': 'valid-key' }, body: {} }), false);
});
