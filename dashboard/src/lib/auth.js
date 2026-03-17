import { ref, computed } from 'vue'
import api from './api'

const _user = ref(JSON.parse(localStorage.getItem('leo_user') || 'null'))
const _accessToken = ref(localStorage.getItem('leo_access_token') || '')
const _refreshToken = ref(localStorage.getItem('leo_refresh_token') || '')

export const user = computed(() => _user.value)
export const isAuthenticated = computed(() => !!_accessToken.value && !!_user.value)
export const accessToken = computed(() => _accessToken.value)

function persist(accessToken, refreshToken, userData) {
  _accessToken.value = accessToken
  _refreshToken.value = refreshToken
  _user.value = userData
  localStorage.setItem('leo_access_token', accessToken)
  localStorage.setItem('leo_refresh_token', refreshToken)
  localStorage.setItem('leo_user', JSON.stringify(userData))
}

function clear() {
  _accessToken.value = ''
  _refreshToken.value = ''
  _user.value = null
  localStorage.removeItem('leo_access_token')
  localStorage.removeItem('leo_refresh_token')
  localStorage.removeItem('leo_user')
}

export async function login(email, password) {
  const { data } = await api.post('/auth/login', { email, password })
  persist(data.accessToken, data.refreshToken, data.user)
  return data.user
}

export async function logout() {
  try {
    await api.post('/auth/logout', { refreshToken: _refreshToken.value })
  } catch { /* best effort */ }
  clear()
}

export async function refreshAccessToken() {
  const { data } = await api.post('/auth/refresh', { refreshToken: _refreshToken.value })
  _accessToken.value = data.accessToken
  localStorage.setItem('leo_access_token', data.accessToken)
  return data.accessToken
}

export { persist, clear }
