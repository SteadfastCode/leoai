// Proactive access-token refresh (LEO-090).
//
// Refreshing only on a 401 is invisible for the dashboard's own API but not for POST /chat,
// which is public and answers 200 to an unauthenticated request — a spent Bearer token there
// turns a playground test message into real visitor traffic. These specs cover the check that
// runs before a request leaves, and the one thing it must never do: block the user out on a
// token it simply could not read.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import axios from 'axios'
import api, { accessTokenExpiry, ensureFreshAccessToken } from '../src/lib/api'

const b64url = (obj) =>
  btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** A structurally real JWT with the given `exp`. The signature is never checked client-side. */
const tokenExpiringIn = (seconds) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + seconds })}.sig`

// The refresh goes out on the bare `axios`, not the `api` instance, so the two adapters are
// independent: `axios.defaults.adapter` answers refreshes, `api.defaults.adapter` answers the
// request that triggered one.
let refreshAdapter
let requestAdapter

const refreshReturning = (accessToken) =>
  vi.fn((config) => Promise.resolve({ data: { accessToken }, status: 200, statusText: 'OK', headers: {}, config }))
const refreshFailing = () =>
  vi.fn((config) => Promise.reject({ config, response: { status: 401, data: {} } }))

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('leo_log_level', 'off')
  refreshAdapter = refreshReturning('fresh-token')
  requestAdapter = vi.fn((config) => Promise.resolve({ data: { ok: true }, status: 200, statusText: 'OK', headers: {}, config }))
  axios.defaults.adapter = refreshAdapter
  api.defaults.adapter = requestAdapter
})

afterEach(() => {
  delete axios.defaults.adapter
  delete api.defaults.adapter
})

describe('accessTokenExpiry', () => {
  it('reads exp out of a token without verifying it', () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    expect(accessTokenExpiry(`${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u', exp })}.sig`)).toBe(exp)
  })

  it('returns null for anything it cannot read, rather than guessing', () => {
    expect(accessTokenExpiry('')).toBe(null)
    expect(accessTokenExpiry('opaque-not-a-jwt')).toBe(null)
    expect(accessTokenExpiry(`${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u' })}.sig`)).toBe(null)
    expect(accessTokenExpiry(null)).toBe(null)
    expect(accessTokenExpiry(undefined)).toBe(null)
  })
})

describe('ensureFreshAccessToken', () => {
  it('leaves a token with plenty of life alone', async () => {
    const token = tokenExpiringIn(600)
    localStorage.setItem('leo_access_token', token)

    expect(await ensureFreshAccessToken('spec')).toBe(token)
    expect(refreshAdapter).not.toHaveBeenCalled()
  })

  it('refreshes an expired token and stores the new one', async () => {
    localStorage.setItem('leo_access_token', tokenExpiringIn(-120))
    localStorage.setItem('leo_refresh_token', 'refresh-1')

    expect(await ensureFreshAccessToken('spec')).toBe('fresh-token')
    expect(refreshAdapter).toHaveBeenCalledTimes(1)
    expect(JSON.parse(refreshAdapter.mock.calls[0][0].data).refreshToken).toBe('refresh-1')
    expect(localStorage.getItem('leo_access_token')).toBe('fresh-token')
  })

  it('refreshes a token that is still valid but inside the skew window', async () => {
    // 30s of life left: valid right now, plausibly expired by the time /chat is handled.
    localStorage.setItem('leo_access_token', tokenExpiringIn(30))

    expect(await ensureFreshAccessToken('spec')).toBe('fresh-token')
    expect(refreshAdapter).toHaveBeenCalledTimes(1)
  })

  it('returns null when the refresh fails, and keeps the stale token untouched', async () => {
    const stale = tokenExpiringIn(-120)
    localStorage.setItem('leo_access_token', stale)
    axios.defaults.adapter = refreshAdapter = refreshFailing()

    expect(await ensureFreshAccessToken('spec')).toBe(null)
    expect(localStorage.getItem('leo_access_token')).toBe(stale)
  })

  it('returns null when there is no token at all, without calling refresh', async () => {
    expect(await ensureFreshAccessToken('spec')).toBe(null)
    expect(refreshAdapter).not.toHaveBeenCalled()
  })

  it('passes an unreadable token through — a decode quirk must not log anyone out', async () => {
    localStorage.setItem('leo_access_token', 'opaque-not-a-jwt')

    expect(await ensureFreshAccessToken('spec')).toBe('opaque-not-a-jwt')
    expect(refreshAdapter).not.toHaveBeenCalled()
  })

  it('shares one refresh between concurrent callers', async () => {
    localStorage.setItem('leo_access_token', tokenExpiringIn(-10))

    const results = await Promise.all([
      ensureFreshAccessToken('a'),
      ensureFreshAccessToken('b'),
      ensureFreshAccessToken('c'),
    ])

    expect(results).toEqual(['fresh-token', 'fresh-token', 'fresh-token'])
    expect(refreshAdapter).toHaveBeenCalledTimes(1)
  })

  it('names the source at the light tier, not just the new value', async () => {
    localStorage.setItem('leo_log_level', 'light')
    localStorage.setItem('leo_access_token', tokenExpiringIn(-42))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await ensureFreshAccessToken('playground send')

    expect(log).toHaveBeenCalledTimes(1)
    const line = log.mock.calls[0][0]
    expect(line).toContain('[Auth]')
    expect(line).toContain('source: playground send')
    expect(line).toMatch(/expired \d+s ago/)
    // The token itself is never logged.
    expect(line).not.toContain('fresh-token')
    log.mockRestore()
  })
})

describe('the request interceptor', () => {
  it('sends the refreshed token, not the spent one it started with', async () => {
    localStorage.setItem('leo_access_token', tokenExpiringIn(-60))

    await api.post('/chat', { message: 'hours?' })

    expect(refreshAdapter).toHaveBeenCalledTimes(1)
    expect(requestAdapter.mock.calls[0][0].headers.Authorization).toBe('Bearer fresh-token')
  })

  it('does not gate the refresh call itself on a fresh token', async () => {
    localStorage.setItem('leo_access_token', tokenExpiringIn(-60))

    await api.post('/auth/refresh', { refreshToken: 'refresh-1' })

    expect(refreshAdapter).not.toHaveBeenCalled()
    expect(requestAdapter).toHaveBeenCalledTimes(1)
  })

  it('does not gate login on a leftover expired token', async () => {
    localStorage.setItem('leo_access_token', tokenExpiringIn(-60))

    await api.post('/auth/login', { email: 'a@b.c', password: 'x' })

    expect(refreshAdapter).not.toHaveBeenCalled()
  })
})
