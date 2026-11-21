// Church service times in the system prompt (LEO-133).
//
// Three halves, all of them pure — no network, no database:
//   1. services/serviceTimes — the gate, the prompt section, the context note.
//   2. The REAL buildSystemPrompt from services/claude, proving the section
//      actually reaches the assembled prompt and that an entity without a
//      schedule gets a byte-identical prompt to the one it got before.
//   3. The settings allowlist (services/entitySettings), proving the field is
//      storable at all — a field the PATCH drops is a field no church can set.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const { serviceTimesText, serviceTimesSection, serviceTimesContextNote } =
  require('../src/services/serviceTimes');
const { validateEntityUpdates } = require('../src/services/entitySettings');

// Quiet by default: 'light' would print a line per assertion here.
process.env.SERVICE_TIMES_LOG_LEVEL = process.env.SERVICE_TIMES_LOG_LEVEL || 'off';

const SCHEDULE = "Sunday School 9:30 AM; Worship 10:45 AM (livestreamed, Children's Church ages 2 to 4th grade)";

const church = (over = {}) => ({
  name: 'Grace Baptist Church',
  domain: 'gbclancaster.org',
  churchModeEnabled: true,
  churchConfig: { serviceTimes: SCHEDULE },
  ...over,
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a church-mode entity with a schedule yields its trimmed text', () => {
  assert.equal(serviceTimesText(church()), SCHEDULE);
  assert.equal(
    serviceTimesText(church({ churchConfig: { serviceTimes: `\n  ${SCHEDULE}  \n` } })),
    SCHEDULE,
    'leading and trailing whitespace from a textarea is stripped',
  );
});

test('an empty field yields nothing — Leo is never handed a schedule to invent from', () => {
  for (const serviceTimes of ['', '   ', '\n\t ', undefined, null, 42, {}, ['9:30']]) {
    assert.equal(serviceTimesText(church({ churchConfig: { serviceTimes } })), '',
      `${JSON.stringify(serviceTimes)} must not produce a schedule`);
  }
  assert.equal(serviceTimesText(church({ churchConfig: {} })), '');
  assert.equal(serviceTimesText(church({ churchConfig: undefined })), '');
});

test('Church Mode off suppresses a stored schedule', () => {
  // A church switched back to a business must not keep announcing services.
  assert.equal(serviceTimesText(church({ churchModeEnabled: false })), '');
  assert.equal(serviceTimesText(church({ churchModeEnabled: undefined })), '');
});

test('the gate tolerates junk input without throwing — it runs on every chat', () => {
  for (const entity of [undefined, null, {}, 'nonsense', 42, []]) {
    assert.equal(serviceTimesText(entity), '');
    assert.equal(serviceTimesSection(entity), '');
    assert.equal(serviceTimesContextNote(entity), '');
  }
});

// ---------------------------------------------------------------------------
// The prompt section and the context note
// ---------------------------------------------------------------------------

test('the section states the schedule and that it is authoritative', () => {
  const section = serviceTimesSection(church());
  assert.match(section, /## SERVICE TIMES/);
  assert.ok(section.includes(SCHEDULE), 'the schedule appears verbatim');
  assert.ok(section.includes('Grace Baptist Church'), 'attributed to the church, not to the website');
  assert.match(section, /authoritative/);
  assert.match(section, /do NOT need any retrieved website content/);
  assert.match(section, /must not say you don't know the service times/);
  // The other half of the item: no invention on top of what the church wrote.
  assert.match(section, /do not add, round, or guess/);
});

test('no schedule means no section at all, so the prompt is unchanged', () => {
  assert.equal(serviceTimesSection(church({ churchConfig: { serviceTimes: '  ' } })), '');
  assert.equal(serviceTimesSection(church({ churchModeEnabled: false })), '');
});

test('the context note overrides the "you don\'t have that detail" instruction', () => {
  const note = serviceTimesContextNote(church());
  assert.match(note, /SERVICE TIMES/);
  assert.match(note, /whether or not any content above mentions them/);
  assert.match(note, /never tell a visitor you don't have the service times/);
  // The note points AT the section; repeating the schedule in two places invites
  // one of them going stale against the other.
  assert.ok(!note.includes(SCHEDULE), 'the note references the section, it does not duplicate it');
  assert.equal(serviceTimesContextNote(church({ churchConfig: {} })), '');
});

// ---------------------------------------------------------------------------
// The assembled system prompt, through the real buildSystemPrompt
// ---------------------------------------------------------------------------

// claude.js constructs an Anthropic client at require time, which throws without
// a key. No request is ever made — buildSystemPrompt is pure.
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-not-used';
const { buildSystemPrompt } = require('../src/services/claude');

test('the schedule reaches the system prompt for a church that set one', () => {
  const prompt = buildSystemPrompt(church(), null);
  assert.ok(prompt.includes('## SERVICE TIMES'), 'the section is appended');
  assert.ok(prompt.includes(SCHEDULE), 'the times themselves are in the prompt');
  // It must not have displaced the sections that were already appended.
  assert.ok(prompt.includes('## CURRENT CONTEXT'), 'temporal context survives');
  assert.ok(prompt.includes('Handoff status:'), 'handoff state survives');
  assert.ok(!prompt.includes('[SERVICE_TIMES]'), 'nothing was templated into the prompt file');
});

test('an entity with no schedule gets the prompt it got before this field existed', () => {
  const base = buildSystemPrompt({ name: 'A Bakery' }, null);
  assert.ok(!base.includes('SERVICE TIMES'));

  // Same entity, Church Mode on but the field never filled in.
  const blank = buildSystemPrompt(church({ churchConfig: { serviceTimes: '' } }), null);
  assert.ok(!blank.includes('SERVICE TIMES'));

  // And a business that carries a leftover schedule from a church trial.
  const business = buildSystemPrompt(church({ churchModeEnabled: false }), null);
  assert.ok(!business.includes('SERVICE TIMES'));
  assert.ok(!business.includes(SCHEDULE));
});

// ---------------------------------------------------------------------------
// The settings allowlist — can a church store this at all?
// ---------------------------------------------------------------------------

const AS_OWNER = { isSuperAdmin: false };
const AS_SUPER = { isSuperAdmin: true };

test('serviceTimes is settable through the churchConfig allowlist, and trimmed', () => {
  const applied = validateEntityUpdates({ churchConfig: { serviceTimes: `  ${SCHEDULE}  ` } }, AS_SUPER);
  assert.deepEqual(applied.rejected, []);
  assert.deepEqual(applied.updates, { churchConfig: { serviceTimes: SCHEDULE } });
});

test('serviceTimes rides the same superadmin gate as the rest of churchConfig', () => {
  // Church Mode is not self-service (CLAUDE.md), so an owner's copy is dropped
  // silently rather than refused — Settings.vue posts the whole form.
  assert.deepEqual(validateEntityUpdates({ churchConfig: { serviceTimes: SCHEDULE } }, AS_OWNER),
    { updates: {}, rejected: [] });
});

test('serviceTimes is bounded — it goes into every prompt for the entity', () => {
  const ok = validateEntityUpdates({ churchConfig: { serviceTimes: 'x'.repeat(1000) } }, AS_SUPER);
  assert.deepEqual(ok.rejected, []);

  const tooLong = validateEntityUpdates({ churchConfig: { serviceTimes: 'x'.repeat(1001) } }, AS_SUPER);
  assert.equal(tooLong.rejected.length, 1);
  assert.equal(tooLong.rejected[0].field, 'churchConfig.serviceTimes');
  assert.match(tooLong.rejected[0].reason, /1000 characters or fewer/);
});

test('clearing serviceTimes is a real instruction, not a no-op', () => {
  // The way a church removes a schedule it no longer keeps: '' must survive
  // validation as '' so the PATCH stores it, rather than being dropped.
  const cleared = validateEntityUpdates({ churchConfig: { serviceTimes: '' } }, AS_SUPER);
  assert.deepEqual(cleared.rejected, []);
  assert.deepEqual(cleared.updates, { churchConfig: { serviceTimes: '' } });
});

test('a non-string serviceTimes is rejected, not cast', () => {
  const bad = validateEntityUpdates({ churchConfig: { serviceTimes: 930 } }, AS_SUPER);
  assert.equal(bad.rejected.length, 1);
  assert.equal(bad.rejected[0].field, 'churchConfig.serviceTimes');
});

// ---------------------------------------------------------------------------
// Dot-path merge: setting one churchConfig key must not wipe its siblings
// ---------------------------------------------------------------------------

const { flattenEntityUpdates } = require('../src/services/entityUpdates');

test('a schedule-only save is written as a dot-path, leaving the prose fields alone', () => {
  const { updates } = validateEntityUpdates({ churchConfig: { serviceTimes: SCHEDULE } }, AS_SUPER);
  assert.deepEqual(flattenEntityUpdates(updates), { 'churchConfig.serviceTimes': SCHEDULE });
});
