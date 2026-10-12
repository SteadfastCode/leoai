import { describe, it, expect } from 'vitest'
import {
  filterPages,
  parseFilterQuery,
  toFilterQuery,
  FILTER_QUERY_KEYS,
  RENDERER_VALUES,
  PRIORITY_VALUES,
} from '../src/lib/pageFilters'

const p = (url, usedPuppeteer, priority) => ({ url, usedPuppeteer, priority })

const PAGES = [
  p('https://dosiedough.com/',            false, 'high'),
  p('https://dosiedough.com/menu',        false, 'normal'),
  p('https://shop.dosiedough.com/breads', true,  'high'),
  p('https://shop.dosiedough.com/cakes',  true,  undefined),
]

describe('filterPages', () => {
  it('returns an empty array for an empty or missing list', () => {
    expect(filterPages([], { search: 'x' })).toEqual([])
    expect(filterPages(null, {})).toEqual([])
    expect(filterPages(undefined)).toEqual([])
  })

  it('returns every page with no filters applied', () => {
    expect(filterPages(PAGES)).toHaveLength(4)
    expect(filterPages(PAGES, {})).toHaveLength(4)
    expect(filterPages(PAGES, { search: '', renderer: 'all', priority: 'all' })).toHaveLength(4)
  })

  it('matches search against the url, case-insensitively', () => {
    expect(filterPages(PAGES, { search: 'MENU' }).map((x) => x.url)).toEqual([
      'https://dosiedough.com/menu',
    ])
    expect(filterPages(PAGES, { search: 'shop.' })).toHaveLength(2)
    expect(filterPages(PAGES, { search: 'nomatch' })).toHaveLength(0)
  })

  it('ignores surrounding whitespace and a null search term', () => {
    expect(filterPages(PAGES, { search: '  /menu  ' })).toHaveLength(1)
    // v-text-field's clear button sets the model to null, not ''
    expect(filterPages(PAGES, { search: null })).toHaveLength(4)
  })

  it('tolerates a page with no url', () => {
    expect(filterPages([{ usedPuppeteer: false }], { search: 'menu' })).toEqual([])
  })

  it('filters by renderer on usedPuppeteer', () => {
    expect(filterPages(PAGES, { renderer: 'html' }).map((x) => x.url)).toEqual([
      'https://dosiedough.com/',
      'https://dosiedough.com/menu',
    ])
    expect(filterPages(PAGES, { renderer: 'js' })).toHaveLength(2)
    expect(filterPages(PAGES, { renderer: 'all' })).toHaveLength(4)
  })

  it('filters by priority, treating a missing priority as normal', () => {
    expect(filterPages(PAGES, { priority: 'high' })).toHaveLength(2)
    expect(filterPages(PAGES, { priority: 'normal' }).map((x) => x.url)).toEqual([
      'https://dosiedough.com/menu',
      'https://shop.dosiedough.com/cakes',
    ])
    expect(filterPages(PAGES, { priority: 'all' })).toHaveLength(4)
  })

  it('combines renderer and priority', () => {
    expect(filterPages(PAGES, { renderer: 'js', priority: 'high' }).map((x) => x.url)).toEqual([
      'https://shop.dosiedough.com/breads',
    ])
    expect(filterPages(PAGES, { renderer: 'html', priority: 'normal' }).map((x) => x.url)).toEqual([
      'https://dosiedough.com/menu',
    ])
  })

  it('combines all three filters', () => {
    expect(
      filterPages(PAGES, { search: 'dosiedough.com', renderer: 'js', priority: 'normal' }).map((x) => x.url),
    ).toEqual(['https://shop.dosiedough.com/cakes'])
    expect(
      filterPages(PAGES, { search: '/menu', renderer: 'js', priority: 'all' }),
    ).toHaveLength(0)
  })

  it('does not mutate the input list', () => {
    const list = [...PAGES]
    filterPages(list, { renderer: 'js' })
    expect(list).toHaveLength(4)
  })
})

describe('parseFilterQuery', () => {
  it('defaults every filter on an empty or missing query', () => {
    expect(parseFilterQuery({})).toEqual({ search: '', renderer: 'all', priority: 'all' })
    expect(parseFilterQuery()).toEqual({ search: '', renderer: 'all', priority: 'all' })
  })

  it('reads known values through', () => {
    expect(parseFilterQuery({ search: 'cakes', renderer: 'js', priority: 'high' })).toEqual({
      search: 'cakes',
      renderer: 'js',
      priority: 'high',
    })
    expect(parseFilterQuery({ renderer: 'html', priority: 'normal' })).toEqual({
      search: '',
      renderer: 'html',
      priority: 'normal',
    })
  })

  it('falls back to all on an unknown query value', () => {
    expect(parseFilterQuery({ renderer: 'webflow' }).renderer).toBe('all')
    expect(parseFilterQuery({ priority: 'urgent' }).priority).toBe('all')
    expect(parseFilterQuery({ renderer: 'JS' }).renderer).toBe('all')
  })

  it('falls back on non-string query values', () => {
    // vue-router yields an array when a key is repeated: ?renderer=js&renderer=html
    expect(parseFilterQuery({ renderer: ['js', 'html'] }).renderer).toBe('all')
    expect(parseFilterQuery({ search: ['a', 'b'] }).search).toBe('')
    expect(parseFilterQuery({ search: null, priority: null })).toEqual({
      search: '',
      renderer: 'all',
      priority: 'all',
    })
  })

  it('ignores query keys it does not own', () => {
    expect(parseFilterQuery({ domain: 'dosiedough.com' })).toEqual({
      search: '',
      renderer: 'all',
      priority: 'all',
    })
  })
})

describe('toFilterQuery', () => {
  it('emits no keys when every filter is at its default', () => {
    expect(toFilterQuery({ search: '', renderer: 'all', priority: 'all' })).toEqual({})
    expect(toFilterQuery({})).toEqual({})
    expect(toFilterQuery()).toEqual({})
    expect(Object.keys(toFilterQuery({ search: null }))).toEqual([])
    // whitespace filters nothing, so it is not a filter worth putting in the URL
    expect(toFilterQuery({ search: '   ' })).toEqual({})
  })

  it('trims the search term it emits', () => {
    expect(toFilterQuery({ search: '  menu  ' })).toEqual({ search: 'menu' })
  })

  it('emits only the non-default keys', () => {
    expect(toFilterQuery({ renderer: 'js' })).toEqual({ renderer: 'js' })
    expect(toFilterQuery({ search: 'cakes', priority: 'high' })).toEqual({
      search: 'cakes',
      priority: 'high',
    })
    expect(toFilterQuery({ search: 'cakes', renderer: 'html', priority: 'normal' })).toEqual({
      search: 'cakes',
      renderer: 'html',
      priority: 'normal',
    })
  })

  it('only ever emits keys the view knows to clear', () => {
    const query = toFilterQuery({ search: 'cakes', renderer: 'js', priority: 'high' })
    expect(Object.keys(query).every((k) => FILTER_QUERY_KEYS.includes(k))).toBe(true)
  })

  it('round-trips every filter state through parseFilterQuery', () => {
    for (const renderer of RENDERER_VALUES) {
      for (const priority of PRIORITY_VALUES) {
        const state = { search: 'menu', renderer, priority }
        expect(parseFilterQuery(toFilterQuery(state))).toEqual(state)
      }
    }
  })
})
