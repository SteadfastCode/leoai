// Audit writer contract (LEO-010).
//
// recordAudit is fire-and-forget: it must never throw and its returned promise
// must never reject, whatever the model does. The AuditLog model is stubbed in
// require.cache BEFORE audit.js loads, so no DB is involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');

// Mutable stub — tests reassign behaviour between calls.
const stubState = {
  createImpl: async () => ({}),
  createdDocs: [],
};

const auditLogPath = require.resolve(path.join(srcDir, 'models', 'AuditLog.js'));
require.cache[auditLogPath] = {
  id: auditLogPath,
  filename: auditLogPath,
  loaded: true,
  exports: {
    create: (doc) => {
      stubState.createdDocs.push(doc);
      return stubState.createImpl(doc);
    },
  },
};

const { recordAudit } = require('../src/services/audit');

test('resolves (never rejects) when the model create rejects', async () => {
  stubState.createImpl = async () => { throw new Error('mongo down'); };
  const result = await recordAudit({ user: { _id: 'u1', email: 'a@b.c' } }, 'entity.delete', { domain: 'x.com' });
  assert.equal(result, undefined, 'must resolve to undefined, not reject');
});

test('resolves when create throws synchronously', async () => {
  stubState.createImpl = () => { throw new Error('sync explosion'); };
  const result = await recordAudit({ user: {} }, 'api_key.create', {});
  assert.equal(result, undefined);
});

test('resolves even with a malformed req', async () => {
  stubState.createImpl = async () => ({});
  assert.equal(await recordAudit(null, 'x', {}), undefined);
  assert.equal(await recordAudit(undefined, 'x'), undefined);
});

test('person actor: records id + email; api-key actor: records the key label instead', async () => {
  stubState.createImpl = async () => ({});
  stubState.createdDocs = [];

  await recordAudit(
    { user: { _id: 'user-1', email: 'daniel@example.com' } },
    'snapshot.restore',
    { domain: 'a.com', details: { snapshotId: 's1' } }
  );
  const personDoc = stubState.createdDocs[0];
  assert.equal(personDoc.actorType, 'user');
  assert.equal(personDoc.actorId, 'user-1');
  assert.equal(personDoc.actorEmail, 'daniel@example.com');
  assert.equal(personDoc.apiKeyLabel, null);
  assert.equal(personDoc.domain, 'a.com');

  await recordAudit(
    { user: { _id: null, isApiKey: true }, apiKey: { label: 'mcp-server' } },
    'scrape.force',
    { domain: 'b.com' }
  );
  const keyDoc = stubState.createdDocs[1];
  assert.equal(keyDoc.actorType, 'api_key');
  assert.equal(keyDoc.apiKeyLabel, 'mcp-server');
  assert.equal(keyDoc.actorId, null);
  assert.equal(keyDoc.actorEmail, null);
});

// ---------------------------------------------------------------------------
// Source-level assertion: no route's success path reads recordAudit's result.
// ---------------------------------------------------------------------------

test('route call sites: recordAudit is always a bare fire-and-forget statement', () => {
  const routesDir = path.join(srcDir, 'routes');
  const offenders = [];
  let callSites = 0;

  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))) {
    const lines = fs.readFileSync(path.join(routesDir, file), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes('recordAudit(') || line.includes('require(')) return;
      callSites++;
      const bare = /^\s*recordAudit\(/.test(line);
      const consumed = /(await\s+recordAudit|[=:]\s*recordAudit|return\s+recordAudit|recordAudit\(.*\)\s*\.\s*(then|catch))/.test(line);
      if (!bare || consumed) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }

  assert.ok(callSites >= 6, `expected the 6 audited actions to call recordAudit, found ${callSites}`);
  assert.deepEqual(offenders, [], 'recordAudit results must never be awaited, assigned, returned, or chained');
});
