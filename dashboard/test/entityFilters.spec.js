import { describe, it, expect } from 'vitest'
import { filterEntities, sortEntities, isStale, STALE_DAYS } from '../src/lib/entityFilters'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-11T12:00:00Z').getTime()

const e = (name, domain, plan, lastScrapedAt) => ({ name, domain, plan, lastScrapedAt })

describe('isStale', () => {
  it('is stale when lastScrapedAt is null or undefined', () => {
    expect(isStale(null, NOW)).toBe(true)
    expect(isStale(undefined, NOW)).toBe(true)
  })

  it('is stale when the date does not parse', () => {
    expect(isStale('not-a-date', NOW)).toBe(true)
  })

  it('is fresh within the window and stale beyond it', () => {
    expect(isStale(new Date(NOW - 1 * DAY).toISOString(), NOW)).toBe(false)
    expect(isStale(new Date(NOW - (STALE_DAYS * DAY - 1000)).toISOString(), NOW)).toBe(false)
    expect(isStale(new Date(NOW - (STALE_DAYS + 1) * DAY).toISOString(), NOW)).toBe(true)
  })
})

describe('filterEntities', () => {
  const list = [
    e('Dosie Dough', 'dosiedough.com', 'free', null),
    e('Burk Digital', 'burkdigital.com', 'infinity', null),
    e('Tomato Pie Cafe', 'tomatopiecafe.net', undefined, null),
  ]

  it('returns an empty array for an empty or missing list', () => {
    expect(filterEntities([], { search: 'x' })).toEqual([])
    expect(filterEntities(null, {})).toEqual([])
  })

  it('matches search against name and domain, case-insensitively', () => {
    expect(filterEntities(list, { search: 'dosie' })).toHaveLength(1)
    expect(filterEntities(list, { search: 'BURKDIGITAL.COM' })).toHaveLength(1)
    expect(filterEntities(list, { search: '.com' })).toHaveLength(2)
    expect(filterEntities(list, { search: 'nomatch' })).toHaveLength(0)
  })

  it('ignores surrounding whitespace in the search term', () => {
    expect(filterEntities(list, { search: '  dosie  ' })).toHaveLength(1)
  })

  it('filters by plan, treating a missing plan as free', () => {
    expect(filterEntities(list, { plan: 'infinity' })).toHaveLength(1)
    const free = filterEntities(list, { plan: 'free' })
    expect(free.map((x) => x.name)).toEqual(['Dosie Dough', 'Tomato Pie Cafe'])
    expect(filterEntities(list, { plan: 'all' })).toHaveLength(3)
  })

  it('combines search and plan filters', () => {
    expect(filterEntities(list, { search: '.com', plan: 'free' })).toHaveLength(1)
  })
})

describe('sortEntities', () => {
  it('handles an empty or missing list', () => {
    expect(sortEntities([], 'name')).toEqual([])
    expect(sortEntities(null, 'name')).toEqual([])
  })

  it('does not mutate the input array', () => {
    const list = [e('B', 'b.com'), e('A', 'a.com')]
    sortEntities(list, 'name')
    expect(list[0].name).toBe('B')
  })

  it('sorts by name by default and for unknown keys', () => {
    const list = [e('Zeta', 'z.com'), e('Alpha', 'a.com')]
    expect(sortEntities(list)[0].name).toBe('Alpha')
    expect(sortEntities(list, 'bogus')[0].name).toBe('Alpha')
  })

  it('sorts by lastScrapedAt newest first, entities without one last', () => {
    const list = [
      e('Never', 'n.com', 'free', null),
      e('Old', 'o.com', 'free', new Date(NOW - 40 * DAY).toISOString()),
      e('Recent', 'r.com', 'free', new Date(NOW - 1 * DAY).toISOString()),
    ]
    expect(sortEntities(list, 'lastScrapedAt').map((x) => x.name)).toEqual(['Recent', 'Old', 'Never'])
  })

  it('breaks ties on the sort key by name', () => {
    const ts = new Date(NOW - 1 * DAY).toISOString()
    const list = [
      e('Bravo', 'b.com', 'free', ts),
      e('Alpha', 'a.com', 'free', ts),
    ]
    expect(sortEntities(list, 'lastScrapedAt').map((x) => x.name)).toEqual(['Alpha', 'Bravo'])
    expect(sortEntities(list, 'plan').map((x) => x.name)).toEqual(['Alpha', 'Bravo'])
  })

  it('treats a missing plan as free when sorting by plan', () => {
    const list = [
      e('NoPlan', 'n.com', undefined, null),
      e('Infinity', 'i.com', 'infinity', null),
    ]
    // 'free' < 'infinity' alphabetically, so the missing-plan entity sorts first
    expect(sortEntities(list, 'plan').map((x) => x.name)).toEqual(['NoPlan', 'Infinity'])
  })
})
