import axios from 'axios'
import { sessionExpired, lastKnownEmail } from './session'
import { notify, apiErrorMessage } from './notify'
import { impersonation } from './impersonation'
import { makeDebug } from './debug'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001'
const api = axios.create({ baseURL: API_URL })

const debug = makeDebug('Auth')

// ── Access-token freshness (LEO-090) ─────────────────────────────────────────
// Access tokens live 15 minutes (backend middleware/auth.js signAccessToken).
// Refreshing only on a 401 is enough for the dashboard's own API, where a spent
// token is rejected loudly and the retry below fixes it invisibly.
//
// It is NOT enough for POST /chat. That is the PUBLIC widget endpoint, and the
// playground calls it with the dashboard's Bearer token to earn test mode. An
// unauthenticated /chat is a perfectly normal request, so a stale token there
// does not 401 — it silently downgrades the message to real visitor traffic:
// counted against quota, logged as an unanswered question, emitted to dashboard
// sockets, and able to fire a real handoff SMS to the owner. Nothing retries,
// because nothing failed. So the token is also checked BEFORE a request leaves.
const REFRESH_SKEW_SECONDS = 60

// Credential endpoints must not be gated on a fresh access token: /auth/refresh
// IS the refresh, and login/logout are reached carrying whatever stale token
// happens to still be sitting in storage.
const SKIP_FRESHNESS = /\/auth\/(refresh|login|logout)$/

/**
 * `exp` (epoch seconds) read out of a JWT, or null if it cannot be read.
 * Deliberately no verification — only the server can do that. This is used to
 * decide when to ask for a new token, never to decide that one is trustworthy.
 */
export function accessTokenExpiry(token) {
  try {
    const segment = String(token).split('.')[1]
    if (!segment) return null
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
    const { exp } = JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)))
    return typeof exp === 'number' ? exp : null
  } catch {
    return null
  }
}

// One in-flight refresh at a time, shared by the proactive and the 401 path, so
// a burst of requests from a woken tab cannot rotate the refresh token twice.
let refreshing = null

function refreshNow(source) {
  if (refreshing) {
    debug('normal', `access token refresh already in flight — source: ${source} joined it`)
    return refreshing
  }
  refreshing = axios.post(`${API_URL}/auth/refresh`, {
    refreshToken: localStorage.getItem('leo_refresh_token'),
  }).then((r) => {
    localStorage.setItem('leo_access_token', r.data.accessToken)
    debug('light', `access token refreshed — source: ${source}`)
    return r.data.accessToken
  }).finally(() => { refreshing = null })
  return refreshing
}

/**
 * Makes sure the stored access token will still be accepted, refreshing it when
 * it is spent or within REFRESH_SKEW_SECONDS of being so.
 *
 * Returns an outcome, never a bare token (LEO-118):
 *
 *   { token, proved, reason }
 *
 * `token` is whatever should travel on the request — the stored token, or the
 * refreshed one — and is null only when there is none. `proved` is the question
 * a caller on a PUBLIC endpoint has to ask: did we establish that this token
 * will be honoured? `reason` says which of the ways it went:
 *
 *   fresh                still well inside its life — nothing to do
 *   refreshed            was spent or nearly; /auth/refresh issued a new one
 *   no-token             not signed in
 *   unreadable           stored token is not a readable JWT, so nothing about
 *                        it can be proved (it is still sent, see below)
 *   refresh-rejected     /auth/refresh said no, or there was no refresh token
 *                        to send — the session really is gone, only signing in
 *                        again fixes it
 *   refresh-unavailable  the refresh could not be ASKED — 5xx, timeout, dropped
 *                        connection. This says nothing about the session.
 *
 * The axios interceptor below attaches `token` whenever there is one and lets
 * the server have the last word, which is right for the dashboard's own API: a
 * token it will not honour comes back 401 and the retry path handles it.
 *
 * A caller whose endpoint answers 200 to an unauthenticated request (POST /chat)
 * must refuse unless `proved`. There, a silently-unhonoured token is not an
 * error — it is a test message quietly turned into billable visitor traffic.
 */
export async function ensureFreshAccessToken(source) {
  const token = localStorage.getItem('leo_access_token')
  if (!token) {
    debug('verbose', `no access token to keep fresh — source: ${source}, reason: no-token`)
    return { token: null, proved: false, reason: 'no-token' }
  }
  const exp = accessTokenExpiry(token)
  if (exp === null) {
    // Not a shape we can read. Not ours to judge either — it goes out unchanged, because
    // a decode quirk must never log anyone out of the dashboard. But unchanged is not the
    // same as proved: a malformed or truncated token is exactly what the /chat gate needs
    // to refuse on, so the outcome says so instead of reading as a healthy token.
    debug('normal', `access token expiry unreadable — source: ${source}, reason: unreadable, sending it unchanged`)
    return { token, proved: false, reason: 'unreadable' }
  }
  const secondsLeft = Math.round(exp - Date.now() / 1000)
  if (secondsLeft > REFRESH_SKEW_SECONDS) {
    debug('verbose', `access token still good for ${secondsLeft}s — source: ${source}, reason: fresh`)
    return { token, proved: true, reason: 'fresh' }
  }
  const age = secondsLeft <= 0 ? `expired ${-secondsLeft}s ago` : `expires in ${secondsLeft}s`
  try {
    return { token: await refreshNow(`${source}, access token ${age}`), proved: true, reason: 'refreshed' }
  } catch (err) {
    // WHY the refresh failed changes what a caller should tell the user. A 401/403 from
    // /auth/refresh is the server saying the refresh token itself is finished, and a
    // missing refresh token (which that endpoint answers 400) means there was nothing to
    // ask with: the session is gone either way, and only signing in again fixes it. A 5xx
    // or a dropped connection says nothing about the session — telling that user to sign
    // out and back in is both the wrong diagnosis and a remedy that cannot work while the
    // server is unreachable, and it destroys a session that was probably still fine.
    const status = err?.response?.status
    const sessionGone = status === 401 || status === 403 || !localStorage.getItem('leo_refresh_token')
    const reason = sessionGone ? 'refresh-rejected' : 'refresh-unavailable'
    debug('light', `access token NOT refreshed — source: ${source}, reason: ${reason}${status ? ` (HTTP ${status})` : ' (no response)'}; token is still ${age}`)
    return { token, proved: false, reason }
  }
}

// Attach access token to every request, plus the impersonation header when a superadmin is
// viewing as another user. The backend only honours it for a real superadmin, so it is inert
// for everyone else; the impersonate call itself runs before any target is set, so it is never
// self-impersonated.
api.interceptors.request.use(async (config) => {
  if (!SKIP_FRESHNESS.test(config.url || '')) {
    await ensureFreshAccessToken(`pre-request ${String(config.method || 'get').toUpperCase()} ${config.url}`)
  }
  // Re-read after the await rather than using the outcome's `token`: identical for every
  // outcome above (each returns what is stored, and a refresh stores before it returns),
  // and it is also the only way to get a token on the SKIP_FRESHNESS paths, which never
  // call the check at all. Deliberately unconditional — `proved` is the chat callers'
  // question, not this one's; here the server has the last word.
  const token = localStorage.getItem('leo_access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  if (impersonation.value?.userId) config.headers['X-Impersonate-User'] = impersonation.value.userId
  return config
})

// On 401, attempt silent token refresh then retry once
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true
      try {
        const newToken = await refreshNow(`401 from ${String(original.method || 'get').toUpperCase()} ${original.url}`)
        original.headers.Authorization = `Bearer ${newToken}`
        return api(original)
      } catch {
        // Refresh failed — only fire session-expired if the user had an active session
        const stored = localStorage.getItem('leo_user')
        if (stored) {
          try { lastKnownEmail.value = JSON.parse(stored).email || '' } catch { /* ignore */ }
          localStorage.removeItem('leo_access_token')
          localStorage.removeItem('leo_refresh_token')
          localStorage.removeItem('leo_user')
          sessionExpired.value = true
        }
      }
    }
    // Surface everything the 401 refresh branch didn't absorb. Pass
    // { silent: true } in the request config to opt out and handle the
    // error locally instead.
    if (!err.config?.silent) {
      const message = apiErrorMessage(err)
      if (message) notify(message)
    }
    return Promise.reject(err)
  }
)

export default api

export const getEntities      = ()             => api.get('/api/dashboard/entities')
export const getStats         = (domain)       => api.get(`/api/dashboard/entities/${domain}/stats`)
export const getAnalytics     = (domain)       => api.get(`/api/dashboard/entities/${domain}/analytics`)
export const getConversations = (domain, page, filter) => api.get(`/api/dashboard/entities/${domain}/conversations`, { params: filter && filter !== 'all' ? { page, filter } : { page } })
export const getConversation  = (domain, id)   => api.get(`/api/dashboard/entities/${domain}/conversations/${id}`)
export const getPages         = (domain)       => api.get(`/api/dashboard/entities/${domain}/pages`)
export const updateEntity          = (domain, data) => api.patch(`/api/dashboard/entities/${domain}`, data)
export const deleteEntity          = (domain)       => api.delete(`/api/dashboard/entities/${domain}`)
export const extractChurchConfig   = (domain)       => api.post(`/api/dashboard/entities/${domain}/church-config/extract`)
export const triggerScrape    = (data)         => api.post('/scrape', data)
export const getChunks        = (domain, url)  => api.get(`/api/dashboard/entities/${domain}/chunks`, { params: { url } })
export const getActiveScrapes = ()             => api.get('/scrape/active')
export const getScrapedPages  = (params)       => api.get('/scrape/pages', { params })
export const postOwnerReply   = (domain, id, data) => api.post(`/api/dashboard/entities/${domain}/conversations/${id}/reply`, data)
export const resolveHandoff   = (domain, id)       => api.post(`/api/dashboard/entities/${domain}/conversations/${id}/resolve-handoff`)

export const getBilling                = (domain)       => api.get(`/api/billing/${domain}`)
export const createCheckoutSession     = (domain, plan) => api.post(`/api/billing/${domain}/checkout`, { plan })
export const createPortalSession       = (domain)       => api.post(`/api/billing/${domain}/portal`)
export const createLeoRefreshCheckout  = (domain)       => api.post(`/api/billing/${domain}/leorefresh/checkout`)
export const cancelLeoRefresh          = (domain)       => api.post(`/api/billing/${domain}/leorefresh/cancel`)

export const getTeam         = (domain)           => api.get(`/api/dashboard/entities/${domain}/team`)
export const removeMember    = (domain, userId)   => api.delete(`/api/dashboard/entities/${domain}/team/${userId}`)
export const updateMemberRole = (domain, userId, role) => api.patch(`/api/dashboard/entities/${domain}/team/${userId}`, { role })
export const getInvites      = (domain)           => api.get(`/api/dashboard/entities/${domain}/invites`)
export const sendInvite      = (domain, data)     => api.post(`/api/dashboard/entities/${domain}/invites`, data)
export const cancelInvite    = (domain, inviteId) => api.delete(`/api/dashboard/entities/${domain}/invites/${inviteId}`)
export const getInviteInfo   = (token)            => api.get(`/auth/invite/${token}`)
export const acceptInvite    = (token, data)      => api.post(`/auth/invite/${token}/accept`, data)

export const requestMinistryPlan   = (domain) => api.post(`/api/dashboard/entities/${domain}/ministry-plan-request`)
export const getMinistryRequests   = ()       => api.get('/api/dashboard/ministry-requests')
export const getModelStats         = (domain, days) => api.get(`/api/dashboard/entities/${domain}/model-stats`, { params: { days } })

export const onboard             = (data)         => api.post('/auth/onboard', data)

export const getKbEntries    = (domain)           => api.get(`/api/dashboard/entities/${domain}/kb/entries`)
export const searchKb        = (domain, q, mode)  => api.get(`/api/dashboard/entities/${domain}/kb/search`, { params: { q, mode } })
export const addKbEntry      = (domain, data)     => api.post(`/api/dashboard/entities/${domain}/kb/entries`, data)
export const uploadKbFile    = (domain, file)     => { const fd = new FormData(); fd.append('file', file); return api.post(`/api/dashboard/entities/${domain}/kb/upload`, fd) }
export const deleteKbEntry   = (domain, label)    => api.delete(`/api/dashboard/entities/${domain}/kb/entries/${encodeURIComponent(label)}`)

export const getLogs = (params) => api.get('/api/admin/logs', { params })
export const getFleet = () => api.get('/api/admin/fleet')
export const getAuditLog = (params) => api.get('/api/admin/audit-log', { params })
export const getUsageReport = (params) => api.get('/api/admin/usage-report', { params })
export const impersonate = (payload) => api.post('/api/admin/impersonate', payload)

export const getUnanswered     = (domain)     => api.get(`/api/dashboard/entities/${domain}/unanswered`)
export const addUnansweredToKb = (domain, id) => api.post(`/api/dashboard/entities/${domain}/unanswered/${id}/add-to-kb`)
export const dismissUnanswered = (domain, id) => api.delete(`/api/dashboard/entities/${domain}/unanswered/${id}`)
