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

describe('reasonLabel', () => {
  it('falls back for an unknown reason', () => {
    expect(reasonLabel('http_error')).toBe('HTTP error')
    expect(reasonLabel('something_new')).toBe('Not learned')
    expect(reasonLabel(undefined)).toBe('Not learned')
  })
})
