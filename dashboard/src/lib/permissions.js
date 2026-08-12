import { user } from './auth'

// Pure helpers — exported for unit tests. `u` is the stored user object from
// /auth/me (or localStorage). Permission truth comes from the server's
// resolvedPermissions map; the client never re-implements role→permission
// mapping. A user persisted before resolvedPermissions existed simply fails
// closed until refreshUser() replaces it (App.vue refreshes on mount).

export function isSuperAdminUser(u) {
  return u?.memberships?.some((m) => m.roles?.includes('superadmin')) ?? false
}

export function userCan(u, domain, permission) {
  if (!u) return false
  if (isSuperAdminUser(u)) return true
  const resolved = u.resolvedPermissions?.[domain]
  return Array.isArray(resolved) && resolved.includes(permission)
}

export function can(domain, permission) {
  return userCan(user.value, domain, permission)
}
