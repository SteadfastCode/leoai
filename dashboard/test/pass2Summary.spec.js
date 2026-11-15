import { describe, it, expect } from 'vitest'
import { pass2Line, pass2Stats } from '../src/lib/pass2Summary'

describe('pass2Summary', () => {
  it('says nothing when the backend sent no Pass 2 tally', () => {
    expect(pass2Line({ success: true })).toBe('')
    expect(pass2Line(undefined)).toBe('')
    expect(pass2Line(null)).toBe('')
    expect(pass2Stats({ success: true })).toBe(null)
  })

  it('says nothing when no page needed rendering', () => {
    expect(pass2Line({ puppeteer: { attempted: 0, rendered: 0, salvaged: 0, failed: 0 } })).toBe('')
  })

  it('reports a clean Pass 2', () => {
    expect(pass2Line({ puppeteer: { attempted: 12, rendered: 12, salvaged: 0, failed: 0 } }))
      .toBe('12 pages needed JS rendering — 12 rendered, none failed')
  })

  it('reports the 2026-11-14 shape: everything needed rendering, nothing rendered', () => {
    expect(pass2Line({ puppeteer: { attempted: 25, rendered: 0, salvaged: 0, failed: 25 } }))
      .toBe('25 pages needed JS rendering — 0 rendered, 25 could not be rendered and fell back to plain HTML')
  })

  it('names salvaged pages separately', () => {
    expect(pass2Line({ puppeteer: { attempted: 8, rendered: 7, salvaged: 3, failed: 1 } }))
      .toBe('8 pages needed JS rendering — 7 rendered (3 after a slow load), 1 could not be rendered and fell back to plain HTML')
  })

  it('singularises one page', () => {
    expect(pass2Line({ puppeteer: { attempted: 1, rendered: 1, salvaged: 0, failed: 0 } }))
      .toBe('1 page needed JS rendering — 1 rendered, none failed')
  })

  it('tolerates junk counts and a missing failures array', () => {
    const s = pass2Stats({ puppeteer: { attempted: '4', rendered: null, failed: 'x' } })
    expect(s).toEqual({ attempted: 4, rendered: 0, salvaged: 0, failed: 0, failures: [] })
  })
})
