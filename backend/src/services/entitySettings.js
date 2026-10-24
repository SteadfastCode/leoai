// Entity settings validation for PATCH /api/dashboard/entities/:domain (LEO-062).
//
// The route filters the body against an allowlist and used to hand the
// survivors straight to `Entity.findOneAndUpdate(..., updates, { new: true })`.
// Mongoose does not run schema validators on `findOneAndUpdate` unless
// `runValidators: true` is passed, so every `min`/`max` on the Entity model was
// decorative on the one path owners actually write through:
//
//   * `leoRefreshHour: 99` stored fine, and `isDueNow` (services/leoRefresh.js)
//     compares it against a real UTC hour — that entity never refreshes again.
//   * `ragThreshold: 5` stored fine and empties every retrieval.
//   * `dailyVolumeAlert: -1` alerts on the first message of every day.
//   * `quotaWarningThresholds` had no schema bound at all.
//   * a non-numeric value took the other route — a CastError surfaced as a 500
//     carrying the raw driver message.
//
// So bounds live here, in ONE table mirroring backend/src/models/Entity.js, and
// the route rejects the whole write with a 400 when anything is out of range.
// `runValidators: true` on the update call is the second line of defence.
//
// Pure — no I/O, no mongoose. Unit-tested in test/entity-settings.test.js.

const { sanitizeList: sanitizeDoNotRelay } = require('./doNotRelay');

// Generous caps: long enough that no legitimate settings form or AI extract
// trips them, short enough that nothing unbounded reaches the system prompt.
const MAX_SHORT_TEXT = 200;
const MAX_LONG_TEXT = 20000;

// ---------------------------------------------------------------------------
// The table. Every field on the route's PATCH allowlist appears exactly once;
// `superadmin: true` marks the ones behind the superadmin split. Bounds must
// mirror models/Entity.js — test/entity-settings.test.js fails if they drift.
// ---------------------------------------------------------------------------
const FIELD_RULES = {
  // General
  name:        { type: 'string', max: MAX_SHORT_TEXT, required: true },
  timezone:    { type: 'string', max: 64 },
  avgWaitTime: { type: 'string', max: 64 },
  ownerPhone:  { type: 'string', max: 32 },
  ownerEmail:  { type: 'string', max: 254 },

  // Switches
  autoAddRepliesToKb:        { type: 'boolean' },
  offerHandoffBeforeContact: { type: 'boolean' },
  linksOpenInNewTab:         { type: 'boolean' },

  // Counters and schedules
  dailyVolumeAlert:          { type: 'integer', min: 0 },             // 0 = off
  conversationRetentionDays: { type: 'integer', min: 0 },             // 0 = keep forever
  leoRefreshHour:            { type: 'integer', min: 0, max: 23 },    // UTC hour
  leoRefreshFrequency:       { type: 'enum', values: ['daily', 'weekly'] },

  // Usage alerts. The thresholds are percentages of the free-tier cap, read in
  // ascending order by routes/chat.js; an empty list means "use the defaults".
  quotaWarningThresholds: { type: 'integerList', min: 1, max: 99, maxEntries: 10, ascending: true },
  quotaAlertChannels:     { type: 'enumList', values: ['email', 'sms'] },

  // Sanitised rather than rejected (LEO-047) — a v-combobox hands back numbers
  // and objects, and a junk list has always been coerced to [], not refused.
  doNotRelay: { type: 'sanitized', sanitize: sanitizeDoNotRelay },

  crawlSettings: {
    type: 'object',
    fields: {
      keepSocialHandles: { type: 'boolean' },
      keepShortUrls:     { type: 'boolean' },
      variantPriceSweep: { type: 'boolean' },
      staleDays:         { type: 'integer', min: 0 },  // 0 = disabled
    },
  },
  handoffFollowUp: {
    type: 'object',
    fields: {
      enabled:       { type: 'boolean' },
      intervalHours: { type: 'integer', min: 1, max: 720 },  // 1 hour … 30 days
      maxReminders:  { type: 'integer', min: 0, max: 20 },
    },
  },
  unansweredDigest: {
    type: 'object',
    fields: {
      enabled:   { type: 'boolean' },
      frequency: { type: 'enum', values: ['weekly', 'daily'] },
      hourUtc:   { type: 'integer', min: 0, max: 23 },
      dayOfWeek: { type: 'integer', min: 0, max: 6 },  // 0 = Sunday
    },
  },
  weeklyDigest: {
    type: 'object',
    fields: {
      enabled:   { type: 'boolean' },
      dayOfWeek: { type: 'integer', min: 0, max: 6 },  // 0 = Sunday
      hour:      { type: 'integer', min: 0, max: 23 }, // UTC
    },
  },

  // Superadmin-gated
  churchModeEnabled: { type: 'boolean', superadmin: true },
  churchConfig: {
    type: 'object',
    superadmin: true,
    fields: {
      missionStatement:           { type: 'string', max: MAX_LONG_TEXT },
      statementOfFaith:           { type: 'string', max: MAX_LONG_TEXT },
      denominationalDistinctives: { type: 'string', max: MAX_LONG_TEXT },
      churchValues:               { type: 'string', max: MAX_LONG_TEXT },
      pastoralToneNotes:          { type: 'string', max: MAX_LONG_TEXT },
    },
  },
  ragThreshold:      { type: 'number', min: 0.5, max: 0.95, superadmin: true },
  lowConfidenceBand: { type: 'number', min: 0,   max: 0.2,  superadmin: true },
};

const OWNER_FIELDS      = Object.keys(FIELD_RULES).filter((k) => !FIELD_RULES[k].superadmin);
const SUPERADMIN_FIELDS = Object.keys(FIELD_RULES).filter((k) =>  FIELD_RULES[k].superadmin);

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

// Named for the message, never the value — a rejection reason goes back to the
// owner verbatim, so it must not echo whatever they posted.
function typeName(value) {
  if (value === null) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a group of settings';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'a number';
  if (typeof value === 'boolean') return 'true/false';
  return typeof value;
}

function numberReason(rule) {
  const noun = rule.type === 'integer' ? 'a whole number' : 'a number';
  if (rule.max === undefined) return `must be ${noun} of ${rule.min} or more`;
  return `must be ${noun} from ${rule.min} to ${rule.max}`;
}

function fail(field, reason) {
  return { rejected: [{ field, reason }] };
}

function checkValue(field, raw, rule) {
  switch (rule.type) {
    case 'sanitized':
      return { value: rule.sanitize(raw) };

    case 'boolean':
      if (typeof raw !== 'boolean') return fail(field, `must be true or false (received ${typeName(raw)})`);
      return { value: raw };

    case 'string': {
      if (typeof raw !== 'string') return fail(field, `must be text (received ${typeName(raw)})`);
      const value = raw.trim();
      if (rule.required && !value) return fail(field, 'must not be empty');
      if (value.length > rule.max) return fail(field, `must be ${rule.max} characters or fewer`);
      return { value };
    }

    case 'enum': {
      const allowed = `must be one of: ${rule.values.join(', ')}`;
      if (typeof raw !== 'string') return fail(field, `${allowed} (received ${typeName(raw)})`);
      if (!rule.values.includes(raw)) return fail(field, allowed);
      return { value: raw };
    }

    case 'integer':
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return fail(field, `${numberReason(rule)} (received ${typeName(raw)})`);
      }
      if (rule.type === 'integer' && !Number.isInteger(raw)) return fail(field, numberReason(rule));
      if (raw < rule.min) return fail(field, numberReason(rule));
      if (rule.max !== undefined && raw > rule.max) return fail(field, numberReason(rule));
      return { value: raw };
    }

    case 'integerList': {
      if (!Array.isArray(raw)) return fail(field, `must be a list (received ${typeName(raw)})`);
      if (raw.length > rule.maxEntries) return fail(field, `must have ${rule.maxEntries} entries or fewer`);
      const bad = raw.some((n) => typeof n !== 'number' || !Number.isInteger(n) || n < rule.min || n > rule.max);
      if (bad) return fail(field, `every entry must be a whole number from ${rule.min} to ${rule.max}`);
      if (rule.ascending && raw.some((n, i) => i > 0 && n <= raw[i - 1])) {
        return fail(field, 'entries must be in ascending order, with no repeats');
      }
      return { value: [...raw] };
    }

    case 'enumList': {
      if (!Array.isArray(raw)) return fail(field, `must be a list (received ${typeName(raw)})`);
      if (raw.some((v) => !rule.values.includes(v))) {
        return fail(field, `may only contain: ${rule.values.join(', ')}`);
      }
      return { value: [...raw] };
    }

    case 'object': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return fail(field, `must be a group of settings (received ${typeName(raw)})`);
      }
      const value = {};
      const rejected = [];
      for (const [key, nested] of Object.entries(raw)) {
        const nestedRule = rule.fields[key];
        if (!nestedRule) continue;  // unknown nested key — ignored, as at the top level
        const result = checkValue(`${field}.${key}`, nested, nestedRule);
        if (result.rejected) rejected.push(...result.rejected);
        else value[key] = result.value;
      }
      return rejected.length ? { rejected } : { value };
    }

    /* istanbul ignore next — unreachable while the table only uses the cases above */
    default:
      return fail(field, 'has no validation rule');
  }
}

/**
 * Validate an owner-supplied entity settings patch.
 *
 * Drops anything not settable (unknown fields, and superadmin-only fields for a
 * non-superadmin) exactly as the route's allowlist always did, then checks every
 * survivor against FIELD_RULES. Nothing is coerced: a string where a number
 * belongs is rejected, not cast.
 *
 * @param {unknown} body                    raw request body
 * @param {object}  [options]
 * @param {boolean} [options.isSuperAdmin]  may the caller set the superadmin fields?
 * @param {string[]} [options.allowed]         owner-settable field names (route's allowlist)
 * @param {string[]} [options.superadminOnly]  superadmin-settable field names
 * @returns {{ updates: object, rejected: {field: string, reason: string}[] }}
 *   `rejected` non-empty means the caller must write nothing at all.
 */
function validateEntityUpdates(body, options = {}) {
  const {
    isSuperAdmin = false,
    allowed = OWNER_FIELDS,
    superadminOnly = SUPERADMIN_FIELDS,
  } = options;

  const updates = {};
  const rejected = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { updates, rejected };

  const settable = new Set(isSuperAdmin ? [...allowed, ...superadminOnly] : allowed);

  for (const [field, raw] of Object.entries(body)) {
    if (!settable.has(field)) continue;
    const rule = FIELD_RULES[field];
    if (!rule) {
      // A field the route allows but this table does not describe. Storing it
      // unvalidated keeps the owner's setting working; the warning says where
      // the gap is so the table can catch up. The drift test keeps this unreachable.
      console.warn(`[entitySettings] no bound declared for "${field}" (source: PATCH allowlist) — stored unvalidated`);
      updates[field] = raw;
      continue;
    }
    const result = checkValue(field, raw, rule);
    if (result.rejected) rejected.push(...result.rejected);
    else updates[field] = result.value;
  }

  return { updates, rejected };
}

module.exports = {
  validateEntityUpdates,
  FIELD_RULES,
  OWNER_FIELDS,
  SUPERADMIN_FIELDS,
};
