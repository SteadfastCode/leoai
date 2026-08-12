// userCan / isSuperAdminUser (LEO-014).
//
// Fixtures are built from the REAL backend role tables — imported straight from
// backend/src/models/Permission.js — so these specs fail if the arrays drift
// from what the tests assume, rather than silently testing a stale copy.

import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'
import { userCan, isSuperAdminUser } from '../src/lib/permissions'

const require = createRequire(import.meta.url)
const { PERMISSIONS, ROLE_PRESETS } = require('../../backend/src/models/Permission.js')

const DOMAIN = 'example.com'
const ALL_PERMISSIONS = Object.values(PERMISSIONS)

// Mirrors what GET /auth/me returns: memberships + server-resolved permissions.
function userWithRole(role) {
  return {
    memberships: [{ entityDomain: DOMAIN, roles: [role] }],
    resolvedPermissions: { [DOMAIN]: ROLE_PRESETS[role] },
  }
}

describe('isSuperAdminUser', () => {
  it('true only when some membership carries the superadmin role', () => {
    expect(isSuperAdminUser(userWithRole('superadmin'))).toBe(true)
    expect(isSuperAdminUser(userWithRole('owner'))).toBe(false)
    expect(isSuperAdminUser(null)).toBe(false)
    expect(isSuperAdminUser({})).toBe(false)
  })
})

describe('userCan', () => {
  it('superadmin can do everything, in any domain', () => {
    const u = userWithRole('superadmin')
    for (const p of ALL_PERMISSIONS) {
      expect(userCan(u, DOMAIN, p)).toBe(true)
      expect(userCan(u, 'some-other-domain.com', p)).toBe(true)
    }
  })

  it('owner has exactly the owner preset for their domain', () => {
    const u = userWithRole('owner')
    for (const p of ALL_PERMISSIONS) {
      expect(userCan(u, DOMAIN, p)).toBe(ROLE_PRESETS.owner.includes(p))
    }
    // spot-check the boundary: manage yes, superadmin-only no
    expect(userCan(u, DOMAIN, PERMISSIONS.USERS_MANAGE)).toBe(true)
    expect(userCan(u, DOMAIN, PERMISSIONS.IMPERSONATION_USE)).toBe(false)
    expect(userCan(u, DOMAIN, PERMISSIONS.ENTITIES_MANAGE)).toBe(false)
  })

  it('agent has exactly the agent preset', () => {
    const u = userWithRole('agent')
    for (const p of ALL_PERMISSIONS) {
      expect(userCan(u, DOMAIN, p)).toBe(ROLE_PRESETS.agent.includes(p))
    }
    expect(userCan(u, DOMAIN, PERMISSIONS.CONVERSATIONS_REPLY)).toBe(true)
    expect(userCan(u, DOMAIN, PERMISSIONS.SETTINGS_VIEW)).toBe(false)
    expect(userCan(u, DOMAIN, PERMISSIONS.USERS_VIEW)).toBe(false)
  })

  it('readonly has exactly the readonly preset', () => {
    const u = userWithRole('readonly')
    for (const p of ALL_PERMISSIONS) {
      expect(userCan(u, DOMAIN, p)).toBe(ROLE_PRESETS.readonly.includes(p))
    }
    expect(userCan(u, DOMAIN, PERMISSIONS.CONVERSATIONS_VIEW)).toBe(true)
    expect(userCan(u, DOMAIN, PERMISSIONS.CONVERSATIONS_REPLY)).toBe(false)
    expect(userCan(u, DOMAIN, PERMISSIONS.KNOWLEDGE_EDIT)).toBe(false)
  })

  it('permissions are scoped to the membership domain', () => {
    const u = userWithRole('owner')
    expect(userCan(u, 'other.com', PERMISSIONS.CONVERSATIONS_VIEW)).toBe(false)
  })

  it('no membership / no user → false for everything', () => {
    const stranger = { memberships: [], resolvedPermissions: {} }
    for (const p of ALL_PERMISSIONS) {
      expect(userCan(stranger, DOMAIN, p)).toBe(false)
    }
    expect(userCan(null, DOMAIN, PERMISSIONS.CONVERSATIONS_VIEW)).toBe(false)
  })

  it('user persisted before resolvedPermissions existed fails closed', () => {
    const stale = { memberships: [{ entityDomain: DOMAIN, roles: ['owner'] }] }
    expect(userCan(stale, DOMAIN, PERMISSIONS.CONVERSATIONS_VIEW)).toBe(false)
  })
})
