// Pure helpers for the Admin Entities list, kept out of the component so they
// can be unit-tested without mounting Vuetify.

export const STALE_DAYS = 30

// Stale = never scraped, unparseable date, or older than STALE_DAYS.
export function isStale(lastScrapedAt, now = Date.now()) {
  if (!lastScrapedAt) return true
  const t = new Date(lastScrapedAt).getTime()
  if (Number.isNaN(t)) return true
  return now - t > STALE_DAYS * 24 * 60 * 60 * 1000
}

// Missing plan is displayed and filtered as 'free' (the model default).
export function filterEntities(entities, { search = '', plan = 'all' } = {}) {
  const q = search.trim().toLowerCase()
  return (entities || []).filter((e) => {
    if (plan !== 'all' && (e.plan || 'free') !== plan) return false
    if (!q) return true
    return (
      (e.name || '').toLowerCase().includes(q) ||
      (e.domain || '').toLowerCase().includes(q)
    )
  })
}

const byName = (a, b) => (a.name || '').localeCompare(b.name || '')

const COMPARATORS = {
  name: byName,
  domain: (a, b) => (a.domain || '').localeCompare(b.domain || ''),
  plan: (a, b) => (a.plan || 'free').localeCompare(b.plan || 'free'),
  // Newest first; never-scraped entities sink to the bottom.
  lastScrapedAt: (a, b) => {
    const ta = a.lastScrapedAt ? new Date(a.lastScrapedAt).getTime() : -Infinity
    const tb = b.lastScrapedAt ? new Date(b.lastScrapedAt).getTime() : -Infinity
    return tb - ta
  },
}

export function sortEntities(entities, sortKey = 'name') {
  const cmp = COMPARATORS[sortKey] || byName
  return [...(entities || [])].sort((a, b) => cmp(a, b) || byName(a, b))
}
