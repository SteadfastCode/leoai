// isLastOwner contract (LEO-013).
//
// Pure function — no DB, no stubs. Guards the PATCH team/:userId role-change
// endpoint against demoting an entity's only owner.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLastOwner } = require('../src/services/team');

const DOMAIN = 'example.com';

function member(id, roles, entityDomain = DOMAIN) {
  return { _id: id, memberships: [{ entityDomain, roles }] };
}

test('sole owner is the last owner', () => {
  const members = [member('u1', ['owner'])];
  assert.equal(isLastOwner(members, 'u1', DOMAIN), true);
});

test('one of two owners is not the last owner', () => {
  const members = [member('u1', ['owner']), member('u2', ['owner'])];
  assert.equal(isLastOwner(members, 'u1', DOMAIN), false);
  assert.equal(isLastOwner(members, 'u2', DOMAIN), false);
});

test('owner alongside an agent is the last owner', () => {
  const members = [member('u1', ['owner']), member('u2', ['agent'])];
  assert.equal(isLastOwner(members, 'u1', DOMAIN), true);
  // the agent is not an owner at all, so never "the last owner"
  assert.equal(isLastOwner(members, 'u2', DOMAIN), false);
});

test('target not a member returns false', () => {
  const members = [member('u1', ['owner'])];
  assert.equal(isLastOwner(members, 'missing', DOMAIN), false);
});

test('ownership in a different domain does not count', () => {
  // u2 owns some other entity — u1 is still the last owner of DOMAIN
  const members = [member('u1', ['owner']), member('u2', ['owner'], 'other.com')];
  assert.equal(isLastOwner(members, 'u1', DOMAIN), true);
});

test('ObjectId-like non-string ids compare by string value', () => {
  const oid = { toString: () => 'u1' };
  const members = [member(oid, ['owner'])];
  assert.equal(isLastOwner(members, 'u1', DOMAIN), true);
});

test('member with empty roles is handled', () => {
  const members = [member('u1', ['owner']), { _id: 'u2', memberships: [{ entityDomain: DOMAIN }] }];
  assert.equal(isLastOwner(members, 'u1', DOMAIN), true);
  assert.equal(isLastOwner(members, 'u2', DOMAIN), false);
});
