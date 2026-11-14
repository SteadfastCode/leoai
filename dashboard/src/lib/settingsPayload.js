// Shapes the Settings form into the body of PATCH /api/dashboard/entities/:domain.
//
// Pulled out of Settings.vue's save() (LEO-114) so the fix-ups the server
// requires can be unit-tested without mounting Vuetify. Pure: it returns a new
// object and never touches the form it was handed — the form is the live
// reactive one, and rewriting a value in it would move a control under the
// owner's cursor mid-save.
//
// Two shapes have to be corrected here, both because the control cannot produce
// what validateEntityUpdates (backend/src/services/entitySettings.js) demands:
//
//   1. quotaWarningThresholds — the checkboxes record the order the owner
//      ticked them, not the order of their values, and the server requires
//      ascending percentages.
//   2. The two type="number" boxes — `v-model.number` runs Vue's
//      `looseToNumber`, which returns its input UNCHANGED when `parseFloat`
//      yields NaN, so an owner who clears the box to mean "off" posts the empty
//      string. The validator checks `typeof raw !== 'number'` and refuses it as
//      "received text", and the route then declines the whole PATCH — so one
//      emptied box silently discarded every other edit on the page, with the
//      only clue a rejection toast naming the field the owner meant to clear.

// The only two free-text numbers on the page: `conversationRetentionDays` and
// `crawlSettings.staleDays`. Every other number there is a v-select or a
// v-slider, neither of which can be emptied. For both of these 0 is the
// documented "disabled" value, and 0 is already what each falls back to when
// the entity loads — so a cleared box means 0.

// A cleared type="number" box arrives as '' (a v-text-field clear button would
// send null). Anything else is left alone — a real 0 is a real answer, and an
// out-of-range number must still reach the server so the rejection toast can
// name the field rather than this quietly rounding it into range.
function isCleared(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

export function settingsPayload(form = {}) {
  const payload = {
    ...form,
    quotaWarningThresholds: [...(form.quotaWarningThresholds || [])].sort((a, b) => a - b),
  }

  if ('conversationRetentionDays' in payload && isCleared(payload.conversationRetentionDays)) {
    payload.conversationRetentionDays = 0
  }

  // The spread above is shallow, so payload.crawlSettings is still the form's
  // own object — copy it before rewriting a key inside it.
  if (payload.crawlSettings && typeof payload.crawlSettings === 'object' && isCleared(payload.crawlSettings.staleDays)) {
    payload.crawlSettings = { ...payload.crawlSettings, staleDays: 0 }
  }

  return payload
}
