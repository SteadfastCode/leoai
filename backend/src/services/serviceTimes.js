// Church service times in the system prompt (LEO-133).
//
// Service times are the most common question a church gets, and until now Leo
// only knew them if retrieval happened to find them. Measured on
// gbclancaster.org (2026-11-14): the times WERE in the knowledge base, but the
// plain question "What are the service times?" scored 0.709 against a 0.75
// threshold, so Leo answered that it did not have them and offered a handoff.
//
// hoursChunk.js (LEO-018) solved the same problem for a business, and cannot
// solve this one: it requires a time RANGE ("7 am - 2 pm"), while a church
// schedule is a list of single times ("Worship Service - 10:45 AM"), so it
// never fires for a church at all.
//
// So the schedule stops being something to retrieve and becomes something the
// church states: `churchConfig.serviceTimes`, entered in Settings, carried into
// EVERY system prompt for that entity. Retrieval score stops mattering.
//
// Two call sites in services/claude.js, both fed from here so the gate lives in
// one place:
//
//   section()      the authoritative SERVICE TIMES block appended to the system
//                  prompt. Appended rather than templated: the prompt file is
//                  verified by src/scripts/verify-prompt.js and is not touched
//                  for a settings item — the same call the per-entity
//                  do-not-relay list makes (services/doNotRelay.js).
//   contextNote()  one sentence in the Church Mode context message. Needed
//                  because that message is the LAST thing before the visitor's
//                  question and, when retrieval found nothing, it tells Leo in
//                  so many words to say it does not have the church's schedule
//                  — which would talk straight over the section above.
//
// Hard boundary, and the reason both strings say so explicitly: an empty field
// changes NOTHING. Leo must never invent a service time, so a church that has
// not filled this in behaves exactly as it did before.
//
// Church Mode gates it, exactly like the other churchConfig fields in
// claude.js: the field is only editable while Church Mode is on, and a schedule
// left behind by a church that was switched back to a business must not keep
// appearing in that business's prompt.
//
// Debug tiers — SERVICE_TIMES_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per prompt that INCLUDED a schedule, naming the
//                   source of the text (which entity's churchConfig.serviceTimes,
//                   set in Settings) and its first line — not just that it fired
//   normal          adds the two silent cases, which are what a "Leo still does
//                   not know the times" report needs: Church Mode on with the
//                   field empty, and a stored schedule suppressed because
//                   Church Mode is off
//   verbose         adds the assembled block verbatim
//
// Pure apart from those log lines. Unit-tested in backend/test/service-times.test.js.

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.SERVICE_TIMES_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[ServiceTimes] ${message}`);
}

function label(entity) {
  return entity?.domain || entity?.name || 'unknown entity';
}

/**
 * The schedule this entity has stated, or '' when it has none.
 *
 * '' covers every "behave as before" case: Church Mode off, no churchConfig, no
 * field, a non-string (a stray value from an out-of-band write), or whitespace.
 *
 * @param {object} entity  the Entity document (or a plain object shaped like one)
 * @returns {string} the trimmed schedule, or ''
 */
function serviceTimesText(entity) {
  const raw = entity?.churchConfig?.serviceTimes;
  const text = typeof raw === 'string' ? raw.trim() : '';

  if (!entity?.churchModeEnabled) {
    if (text) debug('normal', `suppressed a ${text.length}-char schedule — source: churchModeEnabled is false for ${label(entity)}`);
    return '';
  }
  if (!text) {
    debug('normal', `no schedule to add — source: churchConfig.serviceTimes is empty for ${label(entity)}`);
    return '';
  }
  return text;
}

/**
 * The SERVICE TIMES section for the system prompt, or '' when the entity has no
 * schedule. Starts with its own separator, so a caller appends it as-is.
 */
function serviceTimesSection(entity) {
  const text = serviceTimesText(entity);
  if (!text) return '';

  const name = entity?.name || 'the church';
  const section =
    `\n\n---\n\n## SERVICE TIMES\n\n` +
    `The ${name} team entered this service schedule themselves, so it is authoritative and current:\n\n` +
    `${text}\n\n` +
    `When a visitor asks when services are, what time to come, or about the weekly schedule, answer from this ` +
    `directly and warmly. You do NOT need any retrieved website content to answer it, and you must not say you ` +
    `don't know the service times — they are right here. Quote only what is written above: do not add, round, ` +
    `or guess at a service, a time or a detail it does not mention, and for anything the schedule does not ` +
    `cover follow the normal handoff flow.`;

  debug('light', `added ${text.length} chars to the system prompt — source: churchConfig.serviceTimes for ${label(entity)} (Settings → Church & Ministry Mode) — first line "${text.split('\n')[0].slice(0, 80)}"`);
  debug('verbose', `section:\n${section}`);
  return section;
}

/**
 * One sentence for the Church Mode context message, or '' when the entity has
 * no schedule. Written to read correctly whether or not retrieval found
 * anything, since both branches of that message get it.
 */
function serviceTimesContextNote(entity) {
  if (!serviceTimesText(entity)) return '';
  const name = entity?.name || 'the church';
  return `\n\nOne exception to the above: the SERVICE TIMES section of your instructions was entered by the ${name} team directly, not retrieved from the website. It is authoritative. Answer service-time questions from it whether or not any content above mentions them, and never tell a visitor you don't have the service times.`;
}

module.exports = {
  serviceTimesText,
  serviceTimesSection,
  serviceTimesContextNote,
};
