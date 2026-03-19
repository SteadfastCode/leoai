import axios from 'axios'
import { sessionExpired, lastKnownEmail } from './session'

const api = axios.create({ baseURL: 'http://localhost:3001' })

// Attach access token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('leo_access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// On 401, attempt silent token refresh then retry once
let refreshing = null
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config
    if (err.response?.status === 401 && !original._retry) {
      original._retry = true
      try {
        if (!refreshing) {
          refreshing = axios.post('http://localhost:3001/auth/refresh', {
            refreshToken: localStorage.getItem('leo_refresh_token'),
          }).then((r) => {
            localStorage.setItem('leo_access_token', r.data.accessToken)
            return r.data.accessToken
          }).finally(() => { refreshing = null })
        }
        const newToken = await refreshing
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
    return Promise.reject(err)
  }
)

export default api

export const getEntities      = ()             => api.get('/api/dashboard/entities')
export const getStats         = (domain)       => api.get(`/api/dashboard/entities/${domain}/stats`)
export const getConversations = (domain, page) => api.get(`/api/dashboard/entities/${domain}/conversations`, { params: { page } })
export const getConversation  = (domain, id)   => api.get(`/api/dashboard/entities/${domain}/conversations/${id}`)
export const getPages         = (domain)       => api.get(`/api/dashboard/entities/${domain}/pages`)
export const updateEntity          = (domain, data) => api.patch(`/api/dashboard/entities/${domain}`, data)
export const extractChurchConfig   = (domain)       => api.post(`/api/dashboard/entities/${domain}/church-config/extract`)
export const triggerScrape    = (data)         => api.post('/scrape', data)
export const getActiveScrapes = ()             => api.get('/scrape/active')
export const postOwnerReply   = (domain, id, data) => api.post(`/api/dashboard/entities/${domain}/conversations/${id}/reply`, data)

export const getBilling                = (domain)       => api.get(`/api/billing/${domain}`)
export const createCheckoutSession     = (domain, plan) => api.post(`/api/billing/${domain}/checkout`, { plan })
export const createPortalSession       = (domain)       => api.post(`/api/billing/${domain}/portal`)
export const createLeoRefreshCheckout  = (domain)       => api.post(`/api/billing/${domain}/leorefresh/checkout`)
export const cancelLeoRefresh          = (domain)       => api.post(`/api/billing/${domain}/leorefresh/cancel`)

export const getTeam         = (domain)           => api.get(`/api/dashboard/entities/${domain}/team`)
export const removeMember    = (domain, userId)   => api.delete(`/api/dashboard/entities/${domain}/team/${userId}`)
export const getInvites      = (domain)           => api.get(`/api/dashboard/entities/${domain}/invites`)
export const sendInvite      = (domain, data)     => api.post(`/api/dashboard/entities/${domain}/invites`, data)
export const cancelInvite    = (domain, inviteId) => api.delete(`/api/dashboard/entities/${domain}/invites/${inviteId}`)
export const getInviteInfo   = (token)            => api.get(`/auth/invite/${token}`)
export const acceptInvite    = (token, data)      => api.post(`/auth/invite/${token}/accept`, data)
