import { describe, it, expect } from 'vitest'
import { filterPages, parseFilterQuery, toFilterQuery } from '../src/lib/pageFilters'

const p = (url, usedPuppeteer = false, priority = 'normal') => ({ url, usedPuppeteer, priority })

const pages = [
  p('https://dosiedough.com/', false, 'high'),
  p('https://dosiedough.com/menu', false, 'normal'),
  p('https://shop.dosiedough.com/products/sourdough', true, 'normal'),
  p('https://shop.dosiedough.com/', true, 'high'),
  p('https://dosiedough.com/about', false, undefined),
]

const urls = (list) => list.map((pg) => pg.url)

describe('filterPages', () => {
  it('returns every page with no filters or default filters', () => {
    expect(filterPages(pages)).toHaveLength(5)
    expect(filterPages(pages, { search: '', renderer: 'all', priority: 'all' })).toHaveLength(5)
  })

  it('returns an empty array for an empty or missing list', () => {
    expect(filterPages([], { search: 'x' })).toEqual([])
    expect(filterPages(null, {})).toEqual([])
  })

  it('does not mutate the input array', () => {
    const list = [...pages]
    filterPages(list, { renderer: 'js' })
    expect(list).toEqual(pages)
  })

  describe('search', () => {
    it('matches URL substrings case-insensitively', () => {
      expect(urls(filterPages(pages, { search: 'SHOP.' }))).toEqual([
        'https://shop.dosiedough.com/products/sourdough',
        'https://shop.dosiedough.com/',
      ])
      expect(filterPages(pages, { search: 'menu' })).toHaveLength(1)
      expect(filterPages(pages, { search: 'nomatch' })).toHaveLength(0)
    })

    it('ignores surrounding whitespace and treats null (cleared field) as no search', () => {
      expect(filterPages(pages, { search: '  menu  ' })).toHaveLength(1)
      expect(filterPages(pages, { search: null })).toHaveLength(5)
      expect(filterPages(pages, { search: '   ' })).toHaveLength(5)
    })
  })

  describe('renderer', () => {
    it('html keeps pages not rendered by Puppeteer', () => {
      expect(urls(filterPages(pages, { renderer: 'html' }))).toEqual([
        'https://dosiedough.com/',
        'https://dosiedough.com/menu',
        'https://dosiedough.com/about',
      ])
    })

    it('js keeps Puppeteer-rendered pages only', () => {
      expect(filterPages(pages, { renderer: 'js' }).every((pg) => pg.usedPuppeteer)).toBe(true)
      expect(filterPages(pages, { renderer: 'js' })).toHaveLength(2)
    })
  })

  describe('priority', () => {
    it('high keeps only high-priority pages', () => {
      expect(urls(filterPages(pages, { priority: 'high' }))).toEqual([
        'https://dosiedough.com/',
        'https://shop.dosiedough.com/',
      ])
    })

    it('normal keeps everything not high, including a missing priority', () => {
      expect(urls(filterPages(pages, { priority: 'normal' }))).toEqual([
        'https://dosiedough.com/menu',
        'https://shop.dosiedough.com/products/sourdough',
        'https://dosiedough.com/about',
      ])
    })
  })

  describe('combined', () => {
    it('applies renderer and priority together', () => {
      expect(urls(filterPages(pages, { renderer: 'js', priority: 'high' }))).toEqual([
        'https://shop.dosiedough.com/',
      ])
      expect(urls(filterPages(pages, { renderer: 'html', priority: 'normal' }))).toEqual([
        'https://dosiedough.com/menu',
        'https://dosiedough.com/about',
      ])
    })

    it('applies search, renderer and priority together', () => {
      expect(urls(filterPages(pages, { search: 'dosiedough.com/', renderer: 'html', priority: 'high' }))).toEqual([
        'https://dosiedough.com/',
      ])
      expect(filterPages(pages, { search: 'products', renderer: 'html' })).toHaveLength(0)
      expect(filterPages(pages, { search: 'products', renderer: 'js', priority: 'normal' })).toHaveLength(1)
    })
  })
})

describe('parseFilterQuery', () => {
  it('returns defaults for an empty or missing query', () => {
    const defaults = { search: '', renderer: 'all', priority: 'all' }
    expect(parseFilterQuery({})).toEqual(defaults)
    expect(parseFilterQuery()).toEqual(defaults)
    expect(parseFilterQuery(null)).toEqual(defaults)
  })

  it('reads known values', () => {
    expect(parseFilterQuery({ search: 'menu', renderer: 'js', priority: 'high' }))
      .toEqual({ search: 'menu', renderer: 'js', priority: 'high' })
    expect(parseFilterQuery({ renderer: 'html', priority: 'normal' }))
      .toEqual({ search: '', renderer: 'html', priority: 'normal' })
  })

  it('falls back to all for unknown renderer or priority values', () => {
    expect(parseFilterQuery({ renderer: 'bogus', priority: 'HIGH' }))
      .toEqual({ search: '', renderer: 'all', priority: 'all' })
    expect(parseFilterQuery({ renderer: '', priority: null }))
      .toEqual({ search: '', renderer: 'all', priority: 'all' })
  })

  it('takes the first value when a key is repeated', () => {
    expect(parseFilterQuery({ search: ['menu', 'about'], renderer: ['js', 'html'], priority: ['nope', 'high'] }))
      .toEqual({ search: 'menu', renderer: 'js', priority: 'all' })
  })

  it('ignores unrelated keys such as domain', () => {
    expect(parseFilterQuery({ domain: 'dosiedough.com' }))
      .toEqual({ search: '', renderer: 'all', priority: 'all' })
  })
})

describe('toFilterQuery', () => {
  it('emits no keys for the defaults', () => {
    expect(toFilterQuery({ search: '', renderer: 'all', priority: 'all' })).toEqual({})
    expect(toFilterQuery({})).toEqual({})
    expect(toFilterQuery()).toEqual({})
    expect(toFilterQuery({ search: null, renderer: 'all', priority: 'all' })).toEqual({})
    expect(toFilterQuery({ search: '   ' })).toEqual({})
  })

  it('emits only the non-default keys', () => {
    expect(toFilterQuery({ search: 'menu', renderer: 'all', priority: 'all' })).toEqual({ search: 'menu' })
    expect(toFilterQuery({ search: '', renderer: 'js', priority: 'all' })).toEqual({ renderer: 'js' })
    expect(toFilterQuery({ search: '', renderer: 'all', priority: 'normal' })).toEqual({ priority: 'normal' })
    expect(toFilterQuery({ search: ' menu ', renderer: 'html', priority: 'high' }))
      .toEqual({ search: 'menu', renderer: 'html', priority: 'high' })
  })

  it('never emits an unknown renderer or priority', () => {
    expect(toFilterQuery({ renderer: 'bogus', priority: 'urgent' })).toEqual({})
  })

  it('round-trips through parseFilterQuery', () => {
    const filters = [
      { search: '', renderer: 'all', priority: 'all' },
      { search: 'shop', renderer: 'js', priority: 'high' },
      { search: '', renderer: 'html', priority: 'normal' },
    ]
    for (const f of filters) expect(parseFilterQuery(toFilterQuery(f))).toEqual(f)
  })
})
