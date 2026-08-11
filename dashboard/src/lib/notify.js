import { ref } from 'vue'

// Shared reactive notification queue. The api interceptor pushes here and the
// single app-level snackbar in App.vue drains it — views never render their
// own error toasts for plain API failures.
export const notifications = ref([])
let nextId = 1

export function notify(message, color = 'error') {
  notifications.value.push({ id: nextId++, message, color })
}

export function dismiss(id) {
  notifications.value = notifications.value.filter((n) => n.id !== id)
}

// Maps an axios rejection to a user-facing message, or null when the status is
// one a caller (or the 401 refresh/session-expired flow) handles itself.
// Pure — exported separately from the queue so it can be unit-tested directly.
export function apiErrorMessage(err) {
  if (!err.response) return 'Cannot reach the server — check your connection and try again.'
  const status = err.response.status
  const serverMessage = err.response.data?.error
  if (status === 403) return serverMessage || "You don't have permission to do that."
  if (status === 404) return serverMessage || 'That item could not be found. It may have been deleted.'
  if (status === 429) return 'Too many requests — please wait a moment and try again.'
  if (status >= 500) return 'Something went wrong on the server. Please try again.'
  return null
}
