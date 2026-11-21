// The churchConfig half of the Settings form (LEO-133).
//
// Settings.vue listed the churchConfig fields in three places — the form it
// rebuilds when the entity loads, the merge of what "Populate from Knowledge
// Base" proposes, and the template — so adding serviceTimes meant adding it
// three times and a field could silently exist in two of them. The first two
// are pure object shuffling, so they live here and are unit-tested without
// mounting Vuetify (dashboard/test/churchConfig.spec.js); the template still
// lists its own controls, which is the one place a missing field is visible.
//
// Field names mirror `churchConfig` in backend/src/services/entitySettings.js.
// A name only the server knows is dropped on save, so the list is the contract.

export const CHURCH_CONFIG_FIELDS = [
  'missionStatement',
  'statementOfFaith',
  'denominationalDistinctives',
  'churchValues',
  'pastoralToneNotes',
  // The church's own service schedule. Unlike the fields above it is read on
  // every chat, not only inside the Church Mode prompt section — it is what
  // makes "What are the service times?" answerable whatever retrieval scored.
  'serviceTimes',
]

/**
 * The churchConfig slice of the settings form for an entity.
 *
 * Every field is present and a string: a v-model bound to `undefined` makes the
 * control uncontrolled on first keystroke, and the PATCH must be able to CLEAR
 * a field, which an absent key cannot do.
 *
 * @param {object} [entity] the entity as the API returned it
 * @returns {Record<string, string>} one key per CHURCH_CONFIG_FIELDS entry
 */
export function churchConfigForm(entity) {
  const stored = entity?.churchConfig || {}
  const form = {}
  for (const field of CHURCH_CONFIG_FIELDS) {
    form[field] = typeof stored[field] === 'string' ? stored[field] : ''
  }
  return form
}

/**
 * Merge what POST /church-config/extract proposed into the form's churchConfig.
 *
 * Only non-empty strings are taken, and only for known fields: the extract is
 * an AI proposal, so a field it could not find comes back '' and must not wipe
 * what the owner already typed. Returns a NEW object — the form is the live
 * reactive one, and rewriting it key by key would move a control under the
 * owner's cursor halfway through.
 *
 * Nothing is saved here. The owner reviews the populated fields and presses
 * Save, exactly as before.
 *
 * @param {object} current   the form's current churchConfig
 * @param {object} extracted the extract response body
 * @returns {Record<string, string>} merged churchConfig
 */
export function mergeExtractedChurchConfig(current, extracted) {
  const merged = { ...churchConfigForm({ churchConfig: current }) }
  if (!extracted || typeof extracted !== 'object') return merged
  for (const field of CHURCH_CONFIG_FIELDS) {
    const proposed = extracted[field]
    if (typeof proposed === 'string' && proposed.trim()) merged[field] = proposed.trim()
  }
  return merged
}
