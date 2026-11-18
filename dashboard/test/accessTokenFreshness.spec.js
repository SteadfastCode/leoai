// Proactive access-token refresh (LEO-090), and what its outcome actually proves (LEO-118).
//
// Refreshing only on a 401 is invisible for the dashboard's own API but not for POST /chat,
// which is public and answers 200 to an unauthenticated request — a spent Bearer token there
// turns a playground test message into real visitor traffic. These specs cover the check that
// runs before a request leaves, the two things it must never do (block the user out on a token
// it simply could not read; report a server it could not reach as an expired session), and the
// interceptor's own contract, which is unchanged: attach whatever token exists and let the
// server have the last word.

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
/** The server answered and said no — the refresh token itself is finished. */
const refreshRejecting = (status = 401) =>
  vi.fn((config) => Promise.reject({ config, response: { status, data: {} } }))
/** No answer at all: a dropped connection, a timeout, DNS. `response` is undefined. */
const refreshUnreachable = () =>
  vi.fn((config) => Promise.reject(Object.assign(new Error('Network Error'), { config })))

/** The state of a signed-in tab whose access token is spent but whose session is fine. */
function signedInWithSpentAccessToken() {
  localStorage.setItem('leo_access_token', tokenExpiringIn(-120))
  localStorage.setItem('leo_refresh_token', 'refresh-1')
}

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
  it('leaves a token with plenty of life alone, and says so', async () => {
    const token = tokenExpiringIn(600)
    localStorage.setItem('leo_access_token', token)

    expect(await ensureFreshAccessToken('spec')).toEqual({ token, proved: true, reason: 'fresh' })
    expect(refreshAdapter).not.toHaveBeenCalled()
  })

  it('refreshes an expired token and stores the new one', async () => {
    signedInWithSpentAccessToken()

    expect(await ensureFreshAccessToken('spec')).toEqual({ token: 'fresh-token', proved: true, reason: 'refreshed' })
    expect(refreshAdapter).toHaveBeenCalledTimes(1)
    expect(JSON.parse(refreshAdapter.mock.calls[0][0].data).refreshToken).toBe('refresh-1')
    expect(localStorage.getItem('leo_access_token')).toBe('fresh-token')
  })

  it('refreshes a token that is still valid but inside the skew window', async () => {
    // 30s of life left: valid right now, plausibly expired by the time /chat is handled.
    localStorage.setItem('leo_access_token', tokenExpiringIn(30))

    expect(await ensureFreshAccessToken('spec')).toEqual({ token: 'fresh-token', proved: true, reason: 'refreshed' })
    expect(refreshAdapter).toHaveBeenCalledTimes(1)
  })

  it('reports no token at all as such, without calling refresh', async () => {
    expect(await ensureFreshAccessToken('spec')).toEqual({ token: null, proved: false, reason: 'no-token' })
    expect(refreshAdapter).not.toHaveBeenCalled()
  })

  it('passes an unreadable token through unchanged, but does NOT call it proved (LEO-118)', async () => {
    // The pass-through is deliberate: a decode quirk must not log anyone out of the
    // dashboard, where the server answers 401 and the retry path copes. `proved: false` is
    // what stops the same token from being sent to public /chat, which answers 200 and
    // charges the message to the entity instead.
    localStorage.setItem('leo_access_token', 'opaque-not-a-jwt')

    expect(await ensureFreshAccessToken('spec')).toEqual({
      token: 'opaque-not-a-jwt', proved: false, reason: 'unreadable',
    })
    expect(refreshAdapter).not.toHaveBeenCalled()
  })

  it('a truncated JWT is unreadable too — shape alone proves nothing', async () => {
    localStorage.setItem('leo_access_token', `${b64url({ alg: 'HS256' })}.${b64url({ sub: 'u' })}.sig`)

    expect(await ensureFreshAccessToken('spec')).toMatchObject({ proved: false, reason: 'unreadable' })
  })

  it('a refresh the server REJECTED means the session is gone', async () => {
    signedInWithSpentAccessToken()
    const stale = localStorage.getItem('leo_access_token')
    axios.defaults.adapter = refreshAdapter = refreshRejecting(401)

    expect(await ensureFreshAccessToken('spec')).toEqual({
      token: stale, proved: false, reason: 'refresh-rejected',
    })
    // The stale token is left exactly where it was; clearing the session is the 401
    // interceptor's job, not this check's.
    expect(localStorage.getItem('leo_access_token')).toBe(stale)
  })

  it('treats a 403 the same way — the server still answered', async () => {
    signedInWithSpentAccessToken()
    axios.defaults.adapter = refreshAdapter = refreshRejecting(403)

    expect(await ensureFreshAccessToken('spec')).toMatchObject({ proved: false, reason: 'refresh-rejected' })
  })

  it('a refresh it could not REACH is not an expired session (LEO-118)', async () => {
    // The old code returned null here too, so both callers told the owner their sign-in had
    // expired and to sign out and back in — wrong about the cause, and a remedy that cannot
    // work while the server is unreachable.
    signedInWithSpentAccessToken()
    const stale = localStorage.getItem('leo_access_token')
    axios.defaults.adapter = refreshAdapter = refreshUnreachable()

    expect(await ensureFreshAccessToken('spec')).toEqual({
      token: stale, proved: false, reason: 'refresh-unavailable',
    })
    expect(localStorage.getItem('leo_access_token')).toBe(stale)
  })

  it('a 5xx is a refresh it could not reach, not a session it lost', async () => {
    signedInWithSpentAccessToken()
    axios.defaults.adapter = refreshAdapter = refreshRejecting(503)

    expect(await ensureFreshAccessToken('spec')).toMatchObject({ proved: false, reason: 'refresh-unavailable' })
  })

  it('with no refresh token stored the session IS gone, whatever the call did', async () => {
    // The backend answers 400 to a refresh with no token in the body, and an offline tab
    // never gets an answer at all — but there was nothing to refresh with either way, so
    // signing in again is the honest advice.
    localStorage.setItem('leo_access_token', tokenExpiringIn(-120))
    axios.defaults.adapter = refreshAdapter = refreshUnreachable()

    expect(await ensureFreshAccessToken('spec')).toMatchObject({ proved: false, reason: 'refresh-rejected' })
  })

  it('shares one refresh between concurrent callers', async () => {
    signedInWithSpentAccessToken()

    const results = await Promise.all([
      ensureFreshAccessToken('a'),
      ensureFreshAccessToken('b'),
      ensureFreshAccessToken('c'),
    ])

    expect(results.map((r) => r.token)).toEqual(['fresh-token', 'fresh-token', 'fresh-token'])
    expect(results.every((r) => r.proved)).toBe(true)
    expect(refreshAdapter).toHaveBeenCalledTimes(1)
  })

  it('names the source at the light tier, not just the new value', async () => {
    localStorage.setItem('leo_log_level', 'light')
    localStorage.setItem('leo_access_token', tokenExpiringIn(-42))
    localStorage.setItem('leo_refresh_token', 'refresh-1')
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

  it('names the REASON at the light tier when a refresh fails, not just that it failed', async () => {
    localStorage.setItem('leo_log_level', 'light')
    signedInWithSpentAccessToken()
    axios.defaults.adapter = refreshAdapter = refreshUnreachable()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await ensureFreshAccessToken('playground send')

    const line = log.mock.calls.at(-1)[0]
    expect(line).toContain('source: playground send')
    expect(line).toContain('reason: refresh-unavailable')
    log.mockRestore()
  })
})

describe('the request interceptor', () => {
  // Unchanged by LEO-118: `proved` is the chat callers' question. Here a token the server
  // will not honour comes back 401 and the retry path handles it, so the interceptor
  // attaches whatever token exists in every one of the outcomes above.
  const sentToken = () => requestAdapter.mock.calls[0][0].headers.Authorization

  it('sends the refreshed token, not the spent one it started with', async () => {
    signedInWithSpentAccessToken()

    await api.post('/chat', { message: 'hours?' })

    expect(refreshAdapter).toHaveBeenCalledTimes(1)
    expect(sentToken()).toBe('Bearer fresh-token')
  })

  it('still sends a healthy token', async () => {
    const token = tokenExpiringIn(600)
    localStorage.setItem('leo_access_token', token)

    await api.post('/chat', { message: 'hours?' })

    expect(sentToken()).toBe(`Bearer ${token}`)
  })

  it('still sends an unreadable token — only the chat callers refuse on one', async () => {
    localStorage.setItem('leo_access_token', 'opaque-not-a-jwt')

    await api.post('/chat', { message: 'hours?' })

    expect(sentToken()).toBe('Bearer opaque-not-a-jwt')
  })

  it('still sends the stale token when the refresh was rejected', async () => {
    signedInWithSpentAccessToken()
    const stale = localStorage.getItem('leo_access_token')
    axios.defaults.adapter = refreshAdapter = refreshRejecting(401)

    await api.post('/chat', { message: 'hours?' })

    expect(sentToken()).toBe(`Bearer ${stale}`)
  })

  it('still sends the stale token when the refresh could not be reached', async () => {
    signedInWithSpentAccessToken()
    const stale = localStorage.getItem('leo_access_token')
    axios.defaults.adapter = refreshAdapter = refreshUnreachable()

    await api.post('/chat', { message: 'hours?' })

    expect(sentToken()).toBe(`Bearer ${stale}`)
  })

  it('sends no Authorization header when there is no token', async () => {
    await api.post('/chat', { message: 'hours?' })

    expect(requestAdapter.mock.calls[0][0].headers.Authorization).toBeUndefined()
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
