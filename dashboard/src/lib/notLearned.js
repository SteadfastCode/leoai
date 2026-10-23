// The "Not learned" list for the scrape feed (LEO-056).
//
// A run can lose a URL in two different ways, and the owner only ever has one
// question — "which pages did Leo not read?" — so both are rendered as one list
// with the reason named per row:
//   failedUrls   never produced text: a 404, a timeout, a non-HTML body, or a
//                page still empty after the Puppeteer fallback (scraper.js)
//   skippedUrls  fetched fine, but embedding failed after retries (LEO-019).
//                Its chunks and content hash are deliberately left alone so the
//                next rescrape retries the page — worth saying differently.
//
// Shaping of failedUrls happens on the backend (scrapePersist.shapeFailedUrls);
// this tolerates the unshaped forms anyway (bare strings, missing reason) so a
// backend older than this dashboard — or a cached socket payload from one —
// still renders something true rather than an empty section.

export const REASON_LABELS = {
  fetch_error: 'Fetch failed',
  http_error: 'HTTP error',
  empty_after_render: 'Empty page',
  embed_failed: 'Embed failed',
}

export const REASON_HINTS = {
  fetch_error: 'The page could not be fetched — timeout, DNS, or a non-HTML file.',
  http_error: 'The site answered with an error status for this URL.',
  empty_after_render: 'The page loaded but no text could be extracted from it.',
  embed_failed: 'The page was read but its embedding failed. The next refresh retries it.',
}

export function reasonLabel(reason) {
  return REASON_LABELS[reason] || 'Not learned'
}

const asArray = (x) => (Array.isArray(x) ? x : [])

// Merge a scrape summary's two loss lists into display rows, first-seen wins so a
// URL that both failed to fetch and was listed as skipped is shown once, under the
// more specific fetch reason.
export function notLearnedFromSummary(summary) {
  const rows = []
  const seen = new Set()

  const push = (url, reason, status) => {
    if (!url || seen.has(url)) return
    seen.add(url)
    const code = Number(status)
    rows.push({
      url,
      reason,
      status: Number.isFinite(code) && code > 0 ? code : null,
      label: reasonLabel(reason),
      hint: REASON_HINTS[reason] || '',
    })
  }

  if (!summary) return rows

  for (const entry of asArray(summary.failedUrls)) {
    if (typeof entry === 'string') push(entry, 'fetch_error', null)
    else push(entry?.url, REASON_LABELS[entry?.reason] ? entry.reason : 'fetch_error', entry?.status)
  }
  for (const entry of asArray(summary.skippedUrls)) {
    push(typeof entry === 'string' ? entry : entry?.url, 'embed_failed', null)
  }

  return rows
}
