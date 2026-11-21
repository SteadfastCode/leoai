// The churchConfig half of the Settings form (LEO-133).
//
// Covers what Settings.vue used to do inline three times over: build the form
// from the entity, and merge what "Populate from Knowledge Base" proposed. The
// field that matters here is serviceTimes — the schedule Leo answers from
// directly, whatever retrieval scored.

import { describe, it, expect } from 'vitest'
import {
  CHURCH_CONFIG_FIELDS,
  churchConfigForm,
  mergeExtractedChurchConfig,
} from '../src/lib/churchConfig'

const SCHEDULE = "Sunday School 9:30 AM; Worship 10:45 AM (livestreamed, Children's Church ages 2 to 4th grade)"

describe('CHURCH_CONFIG_FIELDS', () => {
  it('includes serviceTimes alongside the prose fields', () => {
    expect(CHURCH_CONFIG_FIELDS).toContain('serviceTimes')
    // The names the server declares in backend/src/services/entitySettings.js —
    // one the server does not know is dropped on save.
    expect([...CHURCH_CONFIG_FIELDS].sort()).toEqual([
      'churchValues',
      'denominationalDistinctives',
      'missionStatement',
      'pastoralToneNotes',
      'serviceTimes',
      'statementOfFaith',
    ])
  })
})

describe('churchConfigForm', () => {
  it('reads a stored schedule into the form', () => {
    const form = churchConfigForm({ churchConfig: { serviceTimes: SCHEDULE } })
    expect(form.serviceTimes).toBe(SCHEDULE)
  })

  it('gives every field an empty string when the entity has no church config', () => {
    for (const entity of [undefined, null, {}, { churchConfig: null }]) {
      const form = churchConfigForm(entity)
      expect(Object.keys(form).sort()).toEqual([...CHURCH_CONFIG_FIELDS].sort())
      for (const field of CHURCH_CONFIG_FIELDS) expect(form[field]).toBe('')
    }
  })

  it('coerces a non-string stored value to an empty box rather than binding it', () => {
    // A v-model bound to a number makes the textarea uncontrolled on the first
    // keystroke; the server would reject it on save anyway.
    expect(churchConfigForm({ churchConfig: { serviceTimes: 930 } }).serviceTimes).toBe('')
  })

  it('keeps whitespace the owner typed — the server trims on write', () => {
    expect(churchConfigForm({ churchConfig: { serviceTimes: '  9:30  ' } }).serviceTimes).toBe('  9:30  ')
  })
})

describe('mergeExtractedChurchConfig', () => {
  it('takes a proposed schedule', () => {
    const merged = mergeExtractedChurchConfig(churchConfigForm(), { serviceTimes: SCHEDULE })
    expect(merged.serviceTimes).toBe(SCHEDULE)
  })

  it('never wipes a field the extract could not find', () => {
    const current = { ...churchConfigForm(), serviceTimes: SCHEDULE, missionStatement: 'Typed by hand' }
    const merged = mergeExtractedChurchConfig(current, { serviceTimes: '', churchValues: 'Scripture, prayer' })
    expect(merged.serviceTimes).toBe(SCHEDULE)
    expect(merged.missionStatement).toBe('Typed by hand')
    expect(merged.churchValues).toBe('Scripture, prayer')
  })

  it('ignores junk and unknown keys from the extract', () => {
    const merged = mergeExtractedChurchConfig(churchConfigForm(), {
      serviceTimes: { sunday: '10:45' },
      somethingElse: 'nope',
      churchValues: '   ',
    })
    expect(merged.serviceTimes).toBe('')
    expect(merged.churchValues).toBe('')
    expect('somethingElse' in merged).toBe(false)
  })

  it('tolerates a missing or non-object response body', () => {
    for (const data of [undefined, null, 'nonsense', 42]) {
      expect(mergeExtractedChurchConfig({ serviceTimes: SCHEDULE }, data).serviceTimes).toBe(SCHEDULE)
    }
  })

  it('returns a new object and does not mutate the live form', () => {
    const current = { ...churchConfigForm(), serviceTimes: 'old' }
    const merged = mergeExtractedChurchConfig(current, { serviceTimes: SCHEDULE })
    expect(current.serviceTimes).toBe('old')
    expect(merged).not.toBe(current)
  })

  it('trims a proposal, so a save is never rejected for whitespace alone', () => {
    expect(mergeExtractedChurchConfig({}, { serviceTimes: `\n ${SCHEDULE} \n` }).serviceTimes).toBe(SCHEDULE)
  })
})
