// reminderDue contract (LEO-016).
//
// Pure decision for the handoff follow-up tick: reminders only while enabled,
// only with an owner contact channel, only after the initial notification,
// only past the interval, and never beyond the cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const { reminderDue, DEFAULT_MAX_REMINDERS } = require('../src/services/handoff');

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-12T00:00:00Z');

function entity(overrides = {}) {
  return {
    ownerPhone: '+15551234567',
    ownerEmail: 'owner@example.com',
    handoffFollowUp: { enabled: true, intervalHours: 24, maxReminders: 3 },
    ...overrides,
  };
}

function convo(overrides = {}) {
  return {
    lastHandoffNotifiedAt: new Date(NOW - 25 * HOUR),
    handoffReminderCount: 0,
    ...overrides,
  };
}

test('under the interval: not due', () => {
  assert.equal(reminderDue(entity(), convo({ lastHandoffNotifiedAt: new Date(NOW - 23 * HOUR) }), NOW), false);
});

test('over the interval: due', () => {
  assert.equal(reminderDue(entity(), convo(), NOW), true);
});

test('exactly at the interval boundary: due', () => {
  assert.equal(reminderDue(entity(), convo({ lastHandoffNotifiedAt: new Date(NOW - 24 * HOUR) }), NOW), true);
});

test('at the cap: not due', () => {
  assert.equal(reminderDue(entity(), convo({ handoffReminderCount: 3 }), NOW), false);
});

test('over the cap: not due', () => {
  assert.equal(reminderDue(entity(), convo({ handoffReminderCount: 7 }), NOW), false);
});

test('one under the cap: due', () => {
  assert.equal(reminderDue(entity(), convo({ handoffReminderCount: 2 }), NOW), true);
});

test('follow-up disabled: not due', () => {
  const e = entity({ handoffFollowUp: { enabled: false, intervalHours: 24, maxReminders: 3 } });
  assert.equal(reminderDue(e, convo(), NOW), false);
});

test('no owner contact at all: not due', () => {
  assert.equal(reminderDue(entity({ ownerPhone: '', ownerEmail: '' }), convo(), NOW), false);
});

test('either contact channel alone is enough', () => {
  assert.equal(reminderDue(entity({ ownerPhone: '' }), convo(), NOW), true);
  assert.equal(reminderDue(entity({ ownerEmail: '' }), convo(), NOW), true);
});

test('never notified initially: not due', () => {
  assert.equal(reminderDue(entity(), convo({ lastHandoffNotifiedAt: null }), NOW), false);
});

test('pre-existing docs without the new fields use defaults', () => {
  // entity without maxReminders → default cap; convo without reminderCount → 0
  const e = entity({ handoffFollowUp: { enabled: true, intervalHours: 24 } });
  const c = { lastHandoffNotifiedAt: new Date(NOW - 25 * HOUR) };
  assert.equal(reminderDue(e, c, NOW), true);
  assert.equal(reminderDue(e, { ...c, handoffReminderCount: DEFAULT_MAX_REMINDERS }, NOW), false);
});

test('missing handoffFollowUp object entirely: not due (enabled is falsy)', () => {
  assert.equal(reminderDue({ ownerEmail: 'x@y.z' }, convo(), NOW), false);
});
