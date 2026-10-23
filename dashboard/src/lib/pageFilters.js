// Pure helpers for the Page Explorer grid, kept out of the component so they
// can be unit-tested without mounting Vuetify. Follows lib/entityFilters.js.

// First value of each list is the default (= no query key, all pages shown).
export const RENDERER_VALUES = ['all', 'html', 'js']
export const PRIORITY_VALUES = ['all', 'high', 'normal']
// Report-only LeoScan findings (LEO-060) — 'flagged' shows only pages whose
// chunks tripped a rule. Nothing was dropped from the knowledge base; the chip
// and this filter are the entire feature.
export const SCAN_VALUES = ['all', 'flagged']

// Query keys this module owns. The view clears these before writing a new
// query so a filter returning to its default drops out of the URL entirely.
export const FILTER_QUERY_KEYS = ['search', 'renderer', 'priority', 'scan']

// Filtering is client-side: MAX_PAGES=500, so the whole page list is already in
// memory and a keystroke must not cost a round trip.
//   renderer: 'html' = cheerio pass 1, 'js' = Puppeteer pass 2 (usedPuppeteer)
//   priority: anything not explicitly 'high' counts as normal (the model default)
//   scan:     'flagged' = scanRules non-empty. Pages scraped before LEO-060 have
//             no scanRules at all, which reads the same as "nothing tripped".
export function filterPages(pages, { search = '', renderer = 'all', priority = 'all', scan = 'all' } = {}) {
  // search may arrive as null — v-text-field's clear button sets the model to null.
  const q = (search || '').trim().toLowerCase()
  return (pages || []).filter((p) => {
    if (renderer === 'html' && p.usedPuppeteer) return false
    if (renderer === 'js' && !p.usedPuppeteer) return false
    if (priority === 'high' && p.priority !== 'high') return false
    if (priority === 'normal' && p.priority === 'high') return false
    if (scan === 'flagged' && !(p.scanRules || []).length) return false
    if (!q) return true
    return (p.url || '').toLowerCase().includes(q)
  })
}

// Unknown or repeated (array-valued) query params fall back to the default, so a
// hand-edited URL can never leave a mandatory v-btn-toggle on a value none of
// its buttons carry — which renders as no button selected at all.
const oneOf = (values, val) => (values.includes(val) ? val : values[0])

export function parseFilterQuery(query = {}) {
  return {
    search:   typeof query.search === 'string' ? query.search : '',
    renderer: oneOf(RENDERER_VALUES, query.renderer),
    priority: oneOf(PRIORITY_VALUES, query.priority),
    scan:     oneOf(SCAN_VALUES, query.scan),
  }
}

// Emits only the keys that differ from their default — a default filter leaves
// no trace in the URL, so a shared link carries exactly the filters that matter.
export function toFilterQuery({ search = '', renderer = 'all', priority = 'all', scan = 'all' } = {}) {
  const query = {}
  // Trimmed: filterPages ignores whitespace, so a whitespace-only term filters
  // nothing and has no business in the URL.
  const q = (search || '').trim()
  if (q) query.search = q
  if (renderer !== 'all') query.renderer = renderer
  if (priority !== 'all') query.priority = priority
  if (scan !== 'all') query.scan = scan
  return query
}
