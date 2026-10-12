// Test-mode gate for POST /chat (LEO-025, extended in LEO-040).
//
// The gate must return true only when the request carries either
//   (a) a valid X-API-Key that resolved against the ApiKey model, or
//   (b) a valid dashboard session (Bearer JWT) whose user has a membership for the
//       SAME domain the request body names — the owner playground.
// resolveApiKey's contract: null = no header, false = header present but invalid
// (including DB failure), object = ApiKey doc. A request-body flag must never be
// sufficient on its own — the body is visitor-controlled — and the body's `domain` is
// only ever the thing a credential is checked AGAINST, never a grant by itself.
//
// Run: `yarn test` (node --test). No DB, no network — both resolvers are injected.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTestModeGate, sessionOwnsDomain } = require('../src/services/testMode');

// A resolver faithful to resolveApiKey's shape: reads only the header, knows one key.
const fakeResolver = async (req) => {
  const raw = req.headers?.['x-api-key'];
  if (!raw) return null;
  if (raw !== 'valid-key') return false;
  return { _id: 'k1', scope: 'mcp', label: 'test' };
};

// A session resolver faithful to resolveDashboardSession: Bearer header only, returns the
// user document (memberships) or null. 'owner-token' belongs to a member of own.example.com.
const OWNER = { _id: 'u1', memberships: [{ entityDomain: 'own.example.com', roles: ['owner'] }] };
const SUPERADMIN = { _id: 'u2', memberships: [{ entityDomain: 'steadfastcode.tech', roles: ['superadmin'] }] };
const fakeSession = async (req) => {
  const header = req.headers?.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  if (token === 'owner-token') return OWNER;
  if (token === 'superadmin-token') return SUPERADMIN;
  return null; // bad signature / expired / unknown user all collapse to null
};

const gate = createTestModeGate({ resolveKey: fakeResolver, resolveSession: fakeSession });

const bearer = (token) => ({ authorization: `Bearer ${token}` });

test('no credentials → not test mode', async () => {
  assert.equal(await gate({ headers: {}, body: { domain: 'own.example.com' } }), false);
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

test('valid key still works with no domain in the body at all', async () => {
  // The MCP tools and the nightly smoke send a key; the JWT path must not have
  // introduced a domain requirement for them.
  assert.equal(await gate({ headers: { 'x-api-key': 'valid-key' }, body: {} }), true);
});

test('resolver failure (false) fails closed to normal visitor mode', async () => {
  const failingGate = createTestModeGate({ resolveKey: async () => false, resolveSession: fakeSession });
  assert.equal(await failingGate({ headers: { 'x-api-key': 'valid-key' }, body: {} }), false);
});

// --- LEO-040: dashboard session path --------------------------------------------------

test('owner JWT for its OWN domain → test mode', async () => {
  assert.equal(await gate({ headers: bearer('owner-token'), body: { domain: 'own.example.com' } }), true);
});

test('owner JWT for a DIFFERENT domain → not test mode', async () => {
  assert.equal(await gate({ headers: bearer('owner-token'), body: { domain: 'someone-else.example.com' } }), false);
});

test('owner JWT with no domain in the body → not test mode', async () => {
  assert.equal(await gate({ headers: bearer('owner-token'), body: {} }), false);
});

test('unverifiable JWT → not test mode', async () => {
  assert.equal(await gate({ headers: bearer('garbage'), body: { domain: 'own.example.com' } }), false);
});

test('a non-Bearer Authorization header is not a dashboard session', async () => {
  assert.equal(await gate({ headers: { authorization: 'Basic b3duZXI6cHc=' }, body: { domain: 'own.example.com' } }), false);
});

test('superadmin JWT → test mode on any domain (matches requireAuth)', async () => {
  assert.equal(await gate({ headers: bearer('superadmin-token'), body: { domain: 'any.example.com' } }), true);
});

test('an invalid API key does NOT fall through to a valid session', async () => {
  // A request that presented a key it could not prove has failed its own authentication;
  // it must not get a second bite via the Bearer header.
  const req = { headers: { 'x-api-key': 'wrong', ...bearer('owner-token') }, body: { domain: 'own.example.com' } };
  assert.equal(await gate(req), false);
});

test('a throwing session resolver fails closed, it does not reject', async () => {
  const explodingGate = createTestModeGate({
    resolveKey: fakeResolver,
    resolveSession: async () => { throw new Error('mongo down'); },
  });
  assert.equal(await explodingGate({ headers: bearer('owner-token'), body: { domain: 'own.example.com' } }), false);
});

test('sessionOwnsDomain: exact membership match only, junk inputs are false', async () => {
  assert.equal(sessionOwnsDomain(OWNER, 'own.example.com'), true);
  assert.equal(sessionOwnsDomain(OWNER, 'sub.own.example.com'), false);
  assert.equal(sessionOwnsDomain(OWNER, ''), false);
  assert.equal(sessionOwnsDomain(OWNER, undefined), false);
  assert.equal(sessionOwnsDomain(null, 'own.example.com'), false);
  assert.equal(sessionOwnsDomain({}, 'own.example.com'), false);
});
