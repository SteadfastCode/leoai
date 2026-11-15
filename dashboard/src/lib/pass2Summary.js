// The Pass 2 (Puppeteer) line for the scrape feed (LEO-146).
//
// A crawl's chunk count can look perfectly healthy while every JS-rendered page
// quietly fell back to plain HTML — which is exactly what happened on Railway on
// 2026-11-14, when all ~25 Puppeteer fallbacks timed out and the run still
// reported success because the site's plain HTML was good enough. This renders
// the backend's `summary.puppeteer` tally so that failure is visible.
//
// Tolerates a summary from a backend older than this dashboard (no `puppeteer`
// key at all) and a cached socket payload from one: both render nothing rather
// than "0 pages" or an error.

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0)

export function pass2Stats(summary) {
  const p = summary?.puppeteer
  if (!p || typeof p !== 'object') return null
  const attempted = num(p.attempted)
  if (attempted <= 0) return null
  return {
    attempted,
    rendered: num(p.rendered),
    salvaged: num(p.salvaged),
    failed: num(p.failed),
    failures: Array.isArray(p.failures) ? p.failures : [],
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// "12 pages needed JS rendering — 12 rendered" plus, only when they are non-zero,
// the salvaged and failed counts. Returns '' when there is nothing to say.
export function pass2Line(summary) {
  const s = pass2Stats(summary)
  if (!s) return ''
  let line = `${plural(s.attempted, 'page')} needed JS rendering — ${s.rendered} rendered`
  if (s.salvaged) line += ` (${s.salvaged} after a slow load)`
  line += s.failed
    ? `, ${s.failed} could not be rendered and fell back to plain HTML`
    : ', none failed'
  return line
}
