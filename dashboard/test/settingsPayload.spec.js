import { describe, it, expect } from 'vitest'
import { settingsPayload } from '../src/lib/settingsPayload'

// A form shaped the way Settings.vue's watcher builds it, trimmed to the keys
// that matter here plus a few that must survive untouched.
const form = (over = {}) => ({
  name: 'Dosie Dough',
  timezone: 'America/New_York',
  linksOpenInNewTab: true,
  quotaWarningThresholds: [50, 75, 90],
  quotaAlertChannels: ['email'],
  conversationRetentionDays: 0,
  crawlSettings: {
    keepSocialHandles: false,
    keepShortUrls: true,
    variantPriceSweep: false,
    staleDays: 0,
  },
  handoffFollowUp: { enabled: true, intervalHours: 24 },
  ragThreshold: 0.75,
  ...over,
})

describe('settingsPayload — blank numeric boxes', () => {
  // The regression this module exists for: v-model.number leaves '' as '' when
  // parseFloat yields NaN, the validator refuses it as "received text", and the
  // route then discards the entire PATCH.
  it('turns a cleared box into 0, the documented "off" value', () => {
    const out = settingsPayload(form({
      conversationRetentionDays: '',
      crawlSettings: { ...form().crawlSettings, staleDays: '' },
    }))
    expect(out.conversationRetentionDays).toBe(0)
    expect(out.crawlSettings.staleDays).toBe(0)
  })

  it('leaves a real number alone, 0 and non-zero alike', () => {
    const out = settingsPayload(form({
      conversationRetentionDays: 7,
      crawlSettings: { ...form().crawlSettings, staleDays: 0 },
    }))
    expect(out.conversationRetentionDays).toBe(7)
    expect(out.crawlSettings.staleDays).toBe(0)
  })

  it('treats a whitespace-only value and null as cleared', () => {
    const out = settingsPayload(form({
      conversationRetentionDays: '  ',
      crawlSettings: { ...form().crawlSettings, staleDays: null },
    }))
    expect(out.conversationRetentionDays).toBe(0)
    expect(out.crawlSettings.staleDays).toBe(0)
  })

  // Out-of-range is the validator's call, not this module's: a negative number
  // must still reach the server so the rejection toast names the field.
  it('passes an out-of-range number through untouched', () => {
    const out = settingsPayload(form({ conversationRetentionDays: -5 }))
    expect(out.conversationRetentionDays).toBe(-5)
  })

  it('does not invent keys the form never held', () => {
    const out = settingsPayload({ name: 'Dosie Dough' })
    expect('conversationRetentionDays' in out).toBe(false)
    expect('crawlSettings' in out).toBe(false)
  })

  it('does not mutate the form it was handed', () => {
    const input = form({
      conversationRetentionDays: '',
      crawlSettings: { ...form().crawlSettings, staleDays: '' },
    })
    settingsPayload(input)
    expect(input.conversationRetentionDays).toBe('')
    expect(input.crawlSettings.staleDays).toBe('')
  })
})

describe('settingsPayload — thresholds', () => {
  // Unchanged behaviour, pinned so the extraction out of save() stays faithful.
  it('sorts the thresholds ascending whatever order they were ticked', () => {
    expect(settingsPayload(form({ quotaWarningThresholds: [90, 50, 75] })).quotaWarningThresholds)
      .toEqual([50, 75, 90])
  })

  it('copies the list rather than sorting the form in place', () => {
    const input = form({ quotaWarningThresholds: [90, 50, 75] })
    settingsPayload(input)
    expect(input.quotaWarningThresholds).toEqual([90, 50, 75])
  })

  it('sends an empty list when the form has none', () => {
    expect(settingsPayload(form({ quotaWarningThresholds: undefined })).quotaWarningThresholds).toEqual([])
    expect(settingsPayload({}).quotaWarningThresholds).toEqual([])
  })
})

describe('settingsPayload — everything else', () => {
  it('copies every other key through unchanged, nested booleans included', () => {
    const input = form()
    const out = settingsPayload(input)
    expect(out.name).toBe('Dosie Dough')
    expect(out.timezone).toBe('America/New_York')
    expect(out.linksOpenInNewTab).toBe(true)
    expect(out.quotaAlertChannels).toEqual(['email'])
    expect(out.ragThreshold).toBe(0.75)
    expect(out.handoffFollowUp).toEqual({ enabled: true, intervalHours: 24 })
    expect(out.crawlSettings).toEqual({
      keepSocialHandles: false,
      keepShortUrls: true,
      variantPriceSweep: false,
      staleDays: 0,
    })
    // Same key set, no additions and no drops.
    expect(Object.keys(out).sort()).toEqual(Object.keys(input).sort())
  })
})
