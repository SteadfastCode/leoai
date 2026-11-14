import { describe, it, expect } from 'vitest'
import { notLearnedFromSummary, reasonLabel, REASON_LABELS } from '../src/lib/notLearned'

const SUMMARY = {
  pagesScraped: 4,
  failedUrls: [
    { url: 'https://d.test/missing', reason: 'http_error', status: 404 },
    { url: 'https://d.test/empty', reason: 'empty_after_render', status: null },
    { url: 'https://d.test/slow', reason: 'fetch_error', status: null },
  ],
  skippedUrls: ['https://d.test/about'],
}

describe('notLearnedFromSummary', () => {
  it('returns nothing for a missing or clean summary', () => {
    expect(notLearnedFromSummary(null)).toEqual([])
    expect(notLearnedFromSummary(undefined)).toEqual([])
    expect(notLearnedFromSummary({ pagesScraped: 12 })).toEqual([])
    expect(notLearnedFromSummary({ failedUrls: [], skippedUrls: [] })).toEqual([])
  })

  it('merges both loss lists, fetch failures before embed skips', () => {
    const rows = notLearnedFromSummary(SUMMARY)
    expect(rows.map((r) => r.url)).toEqual([
      'https://d.test/missing',
      'https://d.test/empty',
      'https://d.test/slow',
      'https://d.test/about',
    ])
    expect(rows.map((r) => r.reason)).toEqual([
      'http_error',
      'empty_after_render',
      'fetch_error',
      'embed_failed',
    ])
  })

  it('labels every reason it emits', () => {
    for (const row of notLearnedFromSummary(SUMMARY)) {
      expect(row.label).toBe(REASON_LABELS[row.reason])
      expect(row.label).not.toBe('Not learned')
      expect(row.hint.length).toBeGreaterThan(0)
    }
  })

  it('keeps a real HTTP status and nulls everything else', () => {
    const rows = notLearnedFromSummary({
      failedUrls: [
        { url: 'https://d.test/a', reason: 'http_error', status: 500 },
        { url: 'https://d.test/b', reason: 'fetch_error', status: 0 },
        { url: 'https://d.test/c', reason: 'fetch_error' },
        { url: 'https://d.test/d', reason: 'fetch_error', status: 'nope' },
      ],
    })
    expect(rows.map((r) => r.status)).toEqual([500, null, null, null])
  })

  it('shows a URL once, under its fetch reason, when both lists name it', () => {
    const rows = notLearnedFromSummary({
      failedUrls: [{ url: 'https://d.test/x', reason: 'http_error', status: 403 }],
      skippedUrls: ['https://d.test/x'],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].reason).toBe('http_error')
  })

  it('tolerates unshaped input from an older backend', () => {
    // bare strings, an unknown reason, a null entry, and non-array fields
    const rows = notLearnedFromSummary({
      failedUrls: ['https://d.test/bare', { url: 'https://d.test/odd', reason: 'wat' }, null, {}],
      skippedUrls: 'not-an-array',
    })
    expect(rows.map((r) => [r.url, r.reason])).toEqual([
      ['https://d.test/bare', 'fetch_error'],
      ['https://d.test/odd', 'fetch_error'],
    ])
  })
})

// The stored copy of a run, read off entity.lastScrape (LEO-115). The same
// function has to consume it unchanged: it is the one the KB panel seeds itself
// from when the live socket payload is gone — a reload, or a 3am LeoRefresh.
describe('notLearnedFromSummary over a stored run', () => {
  // Shaped by the backend and round-tripped through Mongo, so the arrays arrive
  // as plain objects and `at` as an ISO string.
  const STORED = {
    at: '2026-11-14T03:04:05.000Z',
    mode: 'rescrape',
    pagesChanged: 3,
    chunksUpdated: 11,
    failedUrls: [
      { url: 'https://d.test/missing', reason: 'http_error', status: 404 },
      { url: 'https://d.test/empty', reason: 'empty_after_render', status: null },
    ],
    skippedUrls: ['https://d.test/about'],
    robotsDisallowed: [],
    durationMs: 31000,
  }

  it('renders the stored run exactly as the live summary', () => {
    expect(notLearnedFromSummary(STORED)).toEqual(
      notLearnedFromSummary({ failedUrls: STORED.failedUrls, skippedUrls: STORED.skippedUrls }),
    )
  })

  it('names every loss with its reason and status', () => {
    const rows = notLearnedFromSummary(STORED)
    expect(rows.map((r) => [r.url, r.reason, r.status])).toEqual([
      ['https://d.test/missing', 'http_error', 404],
      ['https://d.test/empty', 'empty_after_render', null],
      ['https://d.test/about', 'embed_failed', null],
    ])
    for (const row of rows) expect(row.label).toBe(REASON_LABELS[row.reason])
  })

  it('shows nothing for a stored run that lost no page', () => {
    expect(notLearnedFromSummary({
      at: STORED.at, mode: 'full', pagesScraped: 9,
      failedUrls: [], skippedUrls: [], robotsDisallowed: [],
    })).toEqual([])
  })
})

describe('reasonLabel', () => {
  it('falls back for an unknown reason', () => {
    expect(reasonLabel('http_error')).toBe('HTTP error')
    expect(reasonLabel('something_new')).toBe('Not learned')
    expect(reasonLabel(undefined)).toBe('Not learned')
  })
})
