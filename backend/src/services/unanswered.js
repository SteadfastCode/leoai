// Unanswered-question detection (LEO-024). Pure string handling — no DB, no
// network — extracted from routes/chat.js so it can be tested directly.
//
// The old logic short-circuited on `if (!hadContext) return true`, which
// logged every context-less message ("hi", "thanks", "that answered it!"),
// and matched phrases as substrings, so a real answer like "I'm not sure what
// time you mean — we're open 9-5" logged as unanswered.
//
// New rule: log only when there was NO retrieved context AND the turn shows
// Leo actually failing to answer — a handoff was offered, or the reply opens
// a sentence with an I-can't-answer phrase. Greetings/closers/thanks and
// interactive button clicks never log.

// Phrases Leo uses when it can't find an answer in the KB. The uncertainty
// phrases are matched ANCHORED — at the start of the reply or the start of a
// sentence — never as bare substrings mid-sentence ("...but I'm not sure
// about holidays" is an answer with a caveat, not a failure).
const ANCHORED_PHRASES = [
  "i don't have information",
  "i don't have that information",
  "i don't have specific",
  "i don't have details",
  "i'm not sure",
  "i am not sure",
  "i don't know",
  "i do not know",
  "i'm unable to find",
  "i am unable to find",
  "i don't have access to that",
];

// These declare failure wherever they appear ("Sourdough classes aren't in my
// knowledge base yet") — structurally they never open a sentence, so they stay
// position-independent.
const ANYWHERE_PHRASES = [
  "isn't in my knowledge base",
  "aren't in my knowledge base",
  "not in my knowledge base",
];

const UNANSWERED_PHRASES = [...ANCHORED_PHRASES, ...ANYWHERE_PHRASES];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Start of text, or after sentence-ending punctuation / a line break.
// Allows leading markdown/quote characters before the phrase.
const ANCHORED_PHRASE_RE = new RegExp(
  `(?:^|[.!?]\\s|\\n)[\\s*_>"']*(?:${ANCHORED_PHRASES.map(escapeRe).join('|')})`,
  'i'
);
const ANYWHERE_PHRASE_RE = new RegExp(`(?:${ANYWHERE_PHRASES.map(escapeRe).join('|')})`, 'i');

function matchesUnansweredPhrase(replyText) {
  if (typeof replyText !== 'string' || !replyText) return false;
  return ANCHORED_PHRASE_RE.test(replyText) || ANYWHERE_PHRASE_RE.test(replyText);
}

// Conversational filler that must never be logged as an unanswered question,
// however empty the RAG result was. Compared against the message with
// punctuation/emoji stripped and whitespace collapsed.
const SMALL_TALK = new Set([
  'hi', 'hello', 'hey', 'yo', 'hiya', 'howdy',
  'good morning', 'good afternoon', 'good evening', 'good night',
  'thanks', 'thank you', 'thanks so much', 'thank you so much', 'thx', 'ty',
  'thanks that answered it', 'that answered it', 'that answers it',
  'thats all', 'thats it', 'thats all i needed', 'that helps', 'that helped',
  'ok', 'okay', 'k', 'kk', 'got it', 'sounds good', 'will do',
  'great', 'awesome', 'perfect', 'cool', 'nice', 'wonderful',
  'yes', 'no', 'yep', 'nope', 'yeah', 'nah', 'sure', 'no thanks', 'no thank you',
  'bye', 'goodbye', 'see you', 'see ya', 'later', 'take care', 'have a good day',
]);

function isSmallTalk(message) {
  if (typeof message !== 'string') return false;
  const normalized = message
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 && SMALL_TALK.has(normalized);
}

/**
 * Should this turn be logged as an unanswered question?
 * @param {object} turn
 * @param {string}  turn.message         visitor's message
 * @param {string}  turn.reply           Leo's reply (markers already stripped)
 * @param {boolean} turn.hadContext      RAG retrieved at least one chunk
 * @param {boolean} turn.handoffOffered  Leo fired [HANDOFF_REQUESTED] this turn
 * @param {boolean} turn.interactive     message was a quick-reply button click
 */
function shouldLogUnanswered({ message, reply, hadContext, handoffOffered, interactive }) {
  if (interactive) return false;
  if (hadContext) return false;
  if (isSmallTalk(message)) return false;
  return !!handoffOffered || matchesUnansweredPhrase(reply);
}

module.exports = { shouldLogUnanswered, matchesUnansweredPhrase, isSmallTalk, UNANSWERED_PHRASES };
