// Per-entity do-not-relay list (LEO-047).
//
// Owners can name question types they never want forwarded — competitor
// comparisons, salary questions, anything their team will not answer. The list
// is consumed in three places, all of which go through this module so they
// cannot drift apart:
//   1. buildSystemPrompt (services/claude.js) — tells Leo to decline warmly and
//      NOT raise a handoff for those topics. This is the real mechanism.
//   2. PATCH /entities/:domain (routes/dashboard.js) — sanitises on write.
//   3. sendHandoffNotification (services/notifications.js) — the safety net, in
//      case a handoff fires anyway. The alert still sends; the matched question
//      is simply left out of the SMS/email body.
//
// Pure functions, no I/O — unit-tested in test/do-not-relay.test.js.

// Keep the stored list small enough that it can be injected into the system
// prompt and rendered as chips without blowing up either.
const MAX_ENTRIES = 50;
const MAX_ENTRY_LENGTH = 120;

// Lowercase + collapse every whitespace run to a single space, so
// "Salary   questions" and "salary questions" are the same phrase. Used for
// both dedupe and matching, which is why they can never disagree.
function normalize(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Clean an owner-supplied do-not-relay list for storage.
 *
 * Non-strings are dropped (a v-combobox can hand back objects or numbers),
 * entries are trimmed and whitespace-collapsed, truncated to MAX_ENTRY_LENGTH,
 * deduped case-insensitively keeping the first spelling the owner typed, and
 * the whole list capped at MAX_ENTRIES.
 *
 * @param {unknown} list
 * @returns {string[]} always an array, never null
 */
function sanitizeList(list) {
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set();

  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const entry = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_LENGTH);
    if (!entry) continue;
    const key = normalize(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= MAX_ENTRIES) break;
  }

  return out;
}

/**
 * Does `text` contain any phrase on the do-not-relay list?
 *
 * Substring match on the normalised forms, so case and whitespace differences
 * never cause a miss. Deliberately a phrase match rather than a word-set or
 * semantic one: the owner typed the phrase, and a surprising match is worse
 * than a missed one — the prompt layer, not this function, is what the feature
 * leans on.
 *
 * @param {string} text  - the question (or any text) to test
 * @param {string[]} list - the entity's doNotRelay list, raw or sanitised
 * @returns {boolean}
 */
function matchesDoNotRelay(text, list) {
  if (!Array.isArray(list) || !list.length) return false;
  if (typeof text !== 'string') return false;

  const haystack = normalize(text);
  if (!haystack) return false;

  return list.some((phrase) => {
    if (typeof phrase !== 'string') return false;
    const needle = normalize(phrase);
    // A blank entry would match everything — the one failure mode that would
    // silently swallow every question on the list.
    if (!needle) return false;
    return haystack.includes(needle);
  });
}

module.exports = { sanitizeList, matchesDoNotRelay, MAX_ENTRIES, MAX_ENTRY_LENGTH };
