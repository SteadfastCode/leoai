// Pure helpers for the Page Explorer grid filters and their router-query
// round-trip, kept out of the component so they can be unit-tested without
// mounting Vuetify.

export const RENDERERS = ['all', 'html', 'js']
export const PRIORITIES = ['all', 'high', 'normal']
export const FILTER_QUERY_KEYS = ['search', 'renderer', 'priority']

// Router query values may be a string, null, or an array (repeated key).
const first = (value) => (Array.isArray(value) ? value[0] : value)

const oneOf = (value, allowed) => (allowed.includes(value) ? value : 'all')

// renderer: html = cheerio-only, js = Puppeteer-rendered.
// priority: normal = anything not explicitly 'high' (including missing).
export function filterPages(pages, { search = '', renderer = 'all', priority = 'all' } = {}) {
  const q = (search || '').trim().toLowerCase()
  return (pages || []).filter((pg) => {
    if (renderer === 'html' && pg.usedPuppeteer) return false
    if (renderer === 'js' && !pg.usedPuppeteer) return false
    if (priority === 'high' && pg.priority !== 'high') return false
    if (priority === 'normal' && pg.priority === 'high') return false
    return !q || (pg.url || '').toLowerCase().includes(q)
  })
}

// Unknown or missing values fall back to the defaults.
export function parseFilterQuery(query = {}) {
  const search = first(query?.search)
  return {
    search: typeof search === 'string' ? search : '',
    renderer: oneOf(first(query?.renderer), RENDERERS),
    priority: oneOf(first(query?.priority), PRIORITIES),
  }
}

// Emits only non-default keys, so an unfiltered view keeps a clean URL.
export function toFilterQuery({ search = '', renderer = 'all', priority = 'all' } = {}) {
  const query = {}
  const q = (search || '').trim()
  if (q) query.search = q
  if (oneOf(renderer, RENDERERS) !== 'all') query.renderer = renderer
  if (oneOf(priority, PRIORITIES) !== 'all') query.priority = priority
  return query
}
