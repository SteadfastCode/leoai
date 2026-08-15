import { ref } from 'vue'

// Superadmin "view as user" state (LEO-045). When set, api.js attaches the
// X-Impersonate-User header to every request and the backend swaps req.user to the
// target (only if the real caller is a superadmin — see backend middleware/auth.js).
//
// This module holds STATE only; the POST /api/admin/impersonate call lives in the caller
// (avoids a circular import with api.js). Persisted to localStorage so a reload keeps the
// impersonation active — reloading is exactly how begin/stop take effect everywhere.

const STORAGE_KEY = 'leo_impersonate'

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

// { userId, name, email } while impersonating, else null.
export const impersonation = ref(load())

// target = { userId, name, email } from the impersonate endpoint's response.
export function beginImpersonation(target) {
  impersonation.value = target
  localStorage.setItem(STORAGE_KEY, JSON.stringify(target))
  // Reload so every view re-fetches as the target and the banner mounts.
  window.location.reload()
}

export function stopImpersonation() {
  impersonation.value = null
  localStorage.removeItem(STORAGE_KEY)
  window.location.reload()
}
