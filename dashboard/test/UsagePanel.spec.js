import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import UsagePanel from '../src/components/UsagePanel.vue'

// UsagePanel snapshots `new Date()` once at setup, so the clock is frozen for
// every mount. With NOW/START/RESET below: 10 days elapsed of a 30-day period,
// which makes projectedTotal exactly `used * 3` and puts the burn-rate
// boundaries on whole numbers.
const NOW = new Date('2026-06-15T12:00:00.000Z')
const START = '2026-06-05T12:00:00.000Z'
const RESET = '2026-07-05T12:00:00.000Z'

const FREE_LIMIT = 100

function mountPanel(entity) {
  return mount(UsagePanel, {
    props: {
      entity: {
        billingPeriodStart: START,
        billingPeriodResetAt: RESET,
        ...entity,
      },
    },
  })
}

const progressColor = (wrapper) =>
  wrapper.find('v-progress-linear-stub').attributes('color')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('UsagePanel — free tier burn rate', () => {
  it('reports "not enough data" before 3 days of a period have elapsed', () => {
    const wrapper = mountPanel({
      plan: 'free',
      messageCountThisPeriod: 50,
      billingPeriodStart: '2026-06-13T12:00:00.000Z', // 2 days ago
    })

    expect(wrapper.text()).toContain('Not enough data yet')
    expect(progressColor(wrapper)).toBe('grey-lighten-1')
  })

  it('is green with headroom — projected under 90% of the limit', () => {
    // 29 used over 10 days -> ~87 projected -> ratio 0.87
    const wrapper = mountPanel({ plan: 'free', messageCountThisPeriod: 29 })

    expect(progressColor(wrapper)).toBe('success')
    expect(wrapper.text()).toContain(`${FREE_LIMIT - 29} remaining`)
  })

  it('turns amber the moment projected usage reaches 90% of the limit', () => {
    // 30 used -> exactly 90 projected -> ratio 0.90, the inclusive lower edge
    const wrapper = mountPanel({ plan: 'free', messageCountThisPeriod: 30 })

    expect(progressColor(wrapper)).toBe('warning')
    expect(wrapper.text()).toContain('Projected ~90 msgs — approaching limit')
  })

  it('stays amber at 110% — the top of the warning band', () => {
    // 36 used -> 108 projected -> ratio 1.08, still <= 1.1
    const wrapper = mountPanel({ plan: 'free', messageCountThisPeriod: 36 })

    expect(progressColor(wrapper)).toBe('warning')
    expect(wrapper.text()).toContain('Projected ~108 msgs')
  })

  it('turns red once projected usage passes 110% of the limit', () => {
    // 37 used -> 111 projected -> ratio 1.11, the first value over the band
    const wrapper = mountPanel({ plan: 'free', messageCountThisPeriod: 37 })

    expect(progressColor(wrapper)).toBe('error')
    expect(wrapper.text()).toContain('Projected ~111 msgs — may exceed limit')
  })

  it('clamps the bar at 100% and never shows negative remaining when over quota', () => {
    const wrapper = mountPanel({ plan: 'free', messageCountThisPeriod: 150 })

    expect(wrapper.find('v-progress-linear-stub').attributes('model-value')).toBe('100')
    expect(wrapper.text()).not.toContain('-')
  })

  it('treats a zero-message period as "not enough data" even well into the period', () => {
    // Documents current behaviour: dailyRate of 0 is falsy, so the panel cannot
    // distinguish "no data yet" from "genuinely zero usage". Ten days in with
    // nothing sent, an owner sees the first-3-days copy rather than "100 remaining".
    const wrapper = mountPanel({ plan: 'free', messageCountThisPeriod: 0 })

    expect(wrapper.text()).toContain('Not enough data yet')
  })

  it('defaults a missing message count to zero rather than rendering NaN', () => {
    const wrapper = mountPanel({ plan: 'free' })

    expect(wrapper.text()).not.toContain('NaN')
  })
})

describe('UsagePanel — pay-as-you-go', () => {
  it('targets the next unreached milestone and prices the projection at the base rate', () => {
    // 400 used over 10 days -> 1200 projected -> $12.00 at $0.01/msg
    const wrapper = mountPanel({ plan: 'payg', messageCountThisPeriod: 400 })

    expect(wrapper.text()).toContain('500') // next milestone
    expect(wrapper.text()).toContain('Projected monthly cost: ~$12.00')
  })

  it('flags the retroactive saving when the projection clears the milestone', () => {
    // 1200 projected >= 500 -> (0.01 - 0.009) * 500 = $0.50 back
    const wrapper = mountPanel({ plan: 'payg', messageCountThisPeriod: 400 })

    expect(wrapper.text()).toContain('saves you $0.50 retroactively')
  })

  it('stays silent about savings when the projection falls short of the milestone', () => {
    // 100 used -> 300 projected, short of the 500 milestone
    const wrapper = mountPanel({ plan: 'payg', messageCountThisPeriod: 100 })

    expect(wrapper.text()).not.toContain('retroactively')
  })

  it('drops the milestone entirely once usage passes the top tier', () => {
    const wrapper = mountPanel({ plan: 'payg', messageCountThisPeriod: 6000 })

    expect(wrapper.text()).not.toContain('retroactively')
    expect(wrapper.text()).toContain('6,000')
  })

  it('never renders the free-tier burn copy', () => {
    const wrapper = mountPanel({ plan: 'payg', messageCountThisPeriod: 400 })

    expect(wrapper.text()).not.toContain('remaining')
    expect(wrapper.text()).not.toContain('Not enough data yet')
  })
})

describe('UsagePanel — unlimited plans', () => {
  it.each(['infinity', 'lifetime'])('shows %s usage against infinity with no projection', (plan) => {
    const wrapper = mountPanel({ plan, messageCountThisPeriod: 4321 })

    expect(wrapper.text()).toContain('4,321')
    expect(wrapper.text()).toContain('∞')
    expect(wrapper.text()).not.toContain('Projected')
    expect(wrapper.find('v-progress-linear-stub').exists()).toBe(false)
  })
})

describe('UsagePanel — period reset date', () => {
  it('renders the reset date when the entity has one', () => {
    const wrapper = mountPanel({ plan: 'free', messageCountThisPeriod: 10 })

    expect(wrapper.text()).toContain('Resets Jul 5')
  })

  it('omits the reset line when the entity has no reset date', () => {
    const wrapper = mountPanel({
      plan: 'free',
      messageCountThisPeriod: 10,
      billingPeriodResetAt: null,
    })

    expect(wrapper.text()).not.toContain('Resets')
  })
})
