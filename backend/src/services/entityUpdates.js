// Nested-subdocument merge for PATCH /api/dashboard/entities/:domain (LEO-076).
//
// The route allowlists `crawlSettings`, `handoffFollowUp`, `unansweredDigest`,
// `weeklyDigest` (plus superadmin `churchConfig`) as TOP-LEVEL keys and handed
// the survivors to `Entity.findOneAndUpdate({ domain }, updates)`. Mongoose
// treats a plain object as `$set`, so each subdocument was `$set` as a WHOLE
// VALUE — a body naming one nested key reset every sibling key in that
// subdocument to its schema default.
//
// That was never a theory:
//
//   * `Entity.js` keeps `unansweredDigestLastSentAt` and `lastWeeklyDigestAt`
//     deliberately OUTSIDE their subdocuments, commented "the PATCH handler
//     replaces that whole subdocument, which would wipe a nested send stamp".
//   * `crawlSettings.honorRobots` (LEO-071) and `handoffFollowUp.maxReminders`
//     are on the model but absent from the literal `dashboard/src/views/
//     Settings.vue` rebuilds, so every owner save reset them. The grader of
//     LEO-065 hit this from the other end: a `crawlSettings` flag set out of
//     band was wiped by the next owner save.
//   * Every non-dashboard caller — the MCP server, a future guided-setup write,
//     any `curl` with an API key — hits it with any partial body.
//
// So a subdocument is rewritten into dot-paths (`crawlSettings.keepShortUrls`)
// and unmentioned siblings are simply not in the update. Scope is deliberately
// one thing: WHAT the route hands Mongoose. Which fields are settable, the
// superadmin split and the bounds (LEO-062, services/entitySettings.js) are all
// unchanged — this runs on the validator's output, not on the raw body.
//
// Arrays (`quotaWarningThresholds`, `quotaAlertChannels`, `doNotRelay`) pass
// through as whole values. Merging a list by index is wrong: dropping an entry
// from `[50, 75, 90]` must store two thresholds, not leave 90 behind at index 2.
//
// The declared nested keys come from `FIELD_RULES` in services/entitySettings.js
// rather than a second hand-written table — one allowlist, already mirroring the
// model and already drift-tested, cannot disagree with itself.
//
// Pure apart from the gated debug line below. Unit-tested in
// test/entity-updates.test.js.
//
// Debug tiers — ENTITY_UPDATES_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per PATCH that flattened a subdocument, naming the
//                   dot-paths written and how many siblings were left untouched
//   normal          adds nested keys dropped as undeclared, and subdocument keys
//                   dropped for not being an object
//   verbose         adds the full top-level key list, flattened or passed through
// Never the values: `churchConfig` holds a church's statement of faith.

const { FIELD_RULES } = require('./entitySettings');

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.ENTITY_UPDATES_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[EntityUpdates] ${message}`);
}

// A subdocument on the model, as opposed to a scalar, an array or a free-form
// value: `type: 'object'` with a `fields` map of the keys it declares.
function subdocumentFields(rule) {
  return rule && rule.type === 'object' && rule.fields ? rule.fields : null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Rewrite allowlisted nested objects in an entity update into dot-paths, so a
 * body naming one nested key leaves its siblings alone.
 *
 * Expects the OUTPUT of validateEntityUpdates — every value here has already
 * passed its type and bounds check and every key is already settable by this
 * caller. Run on a raw body it is still safe (an undeclared nested key is
 * dropped, a non-object subdocument value is dropped rather than spread), but it
 * validates nothing and is not a substitute for the validator.
 *
 * @param {object} updates            validated updates, keyed by field name
 * @param {object} [rules=FIELD_RULES] field table declaring nested keys
 * @returns {object} a flat update object: dot-paths for subdocuments, whole
 *   values for everything else. Safe to hand straight to `findOneAndUpdate`,
 *   which applies a plain object as `$set`.
 */
function flattenEntityUpdates(updates, rules = FIELD_RULES) {
  const flat = {};
  if (!isPlainObject(updates)) return flat;

  const written = [];      // dot-paths emitted, for the light-tier line
  const untouched = [];    // declared siblings this body did not name
  const droppedKeys = [];  // nested keys not declared by the table
  const notObjects = [];   // subdocument keys whose value was not an object

  for (const [field, value] of Object.entries(updates)) {
    // The validator never emits undefined; a raw body can. Mongoose turns an
    // undefined dot-path into an $unset, which would be a silent wipe of
    // exactly the kind this module exists to prevent.
    if (value === undefined) continue;

    const fields = subdocumentFields(rules[field]);
    if (!fields) {
      // Scalar, array, sanitised list, or a field the table does not describe —
      // pass through whole. Index-wise array merging is never correct.
      flat[field] = value;
      continue;
    }

    if (!isPlainObject(value)) {
      // A subdocument key carrying a string or a list would otherwise be $set
      // whole, resetting the entire subdocument. Drop it instead of spreading
      // it; the validator already rejects this shape on the real path.
      notObjects.push(field);
      continue;
    }

    for (const key of Object.keys(fields)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        untouched.push(`${field}.${key}`);
        continue;
      }
      if (value[key] === undefined) {
        untouched.push(`${field}.${key}`);
        continue;
      }
      flat[`${field}.${key}`] = value[key];
      written.push(`${field}.${key}`);
    }

    // Iterating the DECLARED keys above rather than the body's means an
    // undeclared nested key can never reach the update, and no body-supplied
    // string ever becomes part of a key — no dotted or `$`-prefixed path
    // injection is possible.
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(fields, key)) droppedKeys.push(`${field}.${key}`);
    }
  }

  if (written.length) {
    debug('light', `merged nested settings (source: PATCH body named these keys) — set ${written.join(', ')}`
      + `; left ${untouched.length} declared sibling(s) untouched`
      + (untouched.length ? `: ${untouched.join(', ')}` : ''));
  }
  if (droppedKeys.length) {
    debug('normal', `dropped ${droppedKeys.length} undeclared nested key(s) (source: not in entitySettings FIELD_RULES): ${droppedKeys.join(', ')}`);
  }
  if (notObjects.length) {
    debug('normal', `dropped ${notObjects.length} subdocument key(s) whose value was not an object (source: PATCH body shape): ${notObjects.join(', ')}`);
  }
  debug('verbose', `in ${Object.keys(updates).length} field(s) → out ${Object.keys(flat).length} path(s): ${Object.keys(flat).join(', ') || '(none)'}`);

  return flat;
}

module.exports = { flattenEntityUpdates };
