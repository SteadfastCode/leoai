// Unanswered-question detection precision (LEO-024).
//
// Pure string handling — no DB, no network. The old chat.js logic logged every
// context-less message and substring-matched uncertainty phrases; these specs
// pin the new rule: log only when !hadContext AND (handoff offered OR the
// reply opens a sentence with an I-can't-answer phrase), never for small talk
// or interactive clicks.
//
// Run: `yarn test` (node --test).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldLogUnanswered,
  matchesUnansweredPhrase,
  isSmallTalk,
} = require('../src/services/unanswered');

// Default turn: a real question with no context and no failure signal.
const turn = (overrides = {}) => ({
  message: 'Do you offer gluten-free bread?',
  reply: 'We bake fresh sourdough daily!',
  hadContext: false,
  handoffOffered: false,
  interactive: false,
  ...overrides,
});

// ── The old false positives, now excluded ──────────────────────────────────

test('greetings, thanks, and closers never log — even with no context', () => {
  for (const message of ['hi', 'Hello!', 'hey', 'thanks', 'Thank you so much!', 'that answered it!', 'ok', 'Bye!', 'Good morning', 'no thanks']) {
    assert.equal(shouldLogUnanswered(turn({ message })), false, `"${message}" must not log`);
  }
});

test('interactive quick-reply selections never log', () => {
  assert.equal(shouldLogUnanswered(turn({ interactive: true, handoffOffered: true, reply: "I don't know." })), false);
});

test('a real answer containing an uncertainty phrase mid-sentence does not log', () => {
  // The spec's exact false-positive: substring matching flagged this.
  assert.equal(shouldLogUnanswered(turn({
    hadContext: true,
    reply: "I'm not sure what time you mean — we're open 9-5",
  })), false);
  // Even without context, a mid-sentence caveat is an answer, not a failure.
  assert.equal(shouldLogUnanswered(turn({
    reply: "We're open 9-5 on weekdays, but I'm not sure about holidays.",
  })), false);
});

test('having context suppresses logging entirely', () => {
  assert.equal(shouldLogUnanswered(turn({ hadContext: true, reply: "I don't know about that." })), false);
  assert.equal(shouldLogUnanswered(turn({ hadContext: true, handoffOffered: true })), false);
});

test('no context alone is not enough — needs a handoff or an anchored phrase', () => {
  assert.equal(shouldLogUnanswered(turn()), false);
});

// ── What still logs ────────────────────────────────────────────────────────

test('no context + handoff offered logs', () => {
  assert.equal(shouldLogUnanswered(turn({ handoffOffered: true })), true);
});

test('no context + reply opening with an uncertainty phrase logs', () => {
  assert.equal(shouldLogUnanswered(turn({ reply: "I don't have information about gluten-free options." })), true);
  assert.equal(shouldLogUnanswered(turn({ reply: "I'm not sure about that one!" })), true);
});

test('phrase at the start of a later sentence logs', () => {
  assert.equal(shouldLogUnanswered(turn({
    reply: "Great question! I don't have details on that in my notes.",
  })), true);
});

test('knowledge-base failure phrases log wherever they appear', () => {
  assert.equal(shouldLogUnanswered(turn({
    reply: "Sourdough classes aren't in my knowledge base yet — want me to ask the team?",
  })), true);
});

// ── Unit-level edges ───────────────────────────────────────────────────────

test('matchesUnansweredPhrase anchors and handles markdown/newlines', () => {
  assert.equal(matchesUnansweredPhrase("**I don't know** about that."), true);
  assert.equal(matchesUnansweredPhrase("Hours:\nI'm not sure about Sundays."), true);
  assert.equal(matchesUnansweredPhrase('We open at 9. You said you were not sure.'), false);
  assert.equal(matchesUnansweredPhrase(''), false);
  assert.equal(matchesUnansweredPhrase(null), false);
});

test('isSmallTalk normalizes punctuation and emoji, and rejects real questions', () => {
  assert.equal(isSmallTalk('Thanks!! 🙏'), true);
  assert.equal(isSmallTalk('  GOOD   MORNING  '), true);
  assert.equal(isSmallTalk('thanks for nothing, what are your hours?'), false);
  assert.equal(isSmallTalk('what are your hours?'), false);
  assert.equal(isSmallTalk(''), false);
  assert.equal(isSmallTalk(undefined), false);
});
