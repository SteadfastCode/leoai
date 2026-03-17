/**
 * Master permission registry.
 * All permission checks in the system use these string keys.
 * Organized by resource.action — add new ones here as features grow.
 */
const PERMISSIONS = {
  // Conversations
  CONVERSATIONS_VIEW:   'conversations.view',
  CONVERSATIONS_REPLY:  'conversations.reply',

  // Knowledge base
  KNOWLEDGE_VIEW:       'knowledge.view',
  KNOWLEDGE_EDIT:       'knowledge.edit',

  // Settings
  SETTINGS_VIEW:        'settings.view',
  SETTINGS_EDIT:        'settings.edit',

  // Billing
  BILLING_VIEW:         'billing.view',
  BILLING_EDIT:         'billing.edit',

  // Users & team management
  USERS_VIEW:           'users.view',
  USERS_MANAGE:         'users.manage',

  // Live chat (premium add-on)
  LIVECHAT_USE:         'livechat.use',

  // Superadmin only
  IMPERSONATION_USE:    'impersonation.use',
  ENTITIES_MANAGE:      'entities.manage',
};

/**
 * Default role presets — bundles of permissions.
 * These are the starting point. Entity owners can create custom roles
 * with any subset of permissions (post-MVP).
 */
const ROLE_PRESETS = {
  superadmin: Object.values(PERMISSIONS), // all permissions

  owner: [
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.KNOWLEDGE_VIEW,
    PERMISSIONS.KNOWLEDGE_EDIT,
    PERMISSIONS.SETTINGS_VIEW,
    PERMISSIONS.SETTINGS_EDIT,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.BILLING_EDIT,
    PERMISSIONS.USERS_VIEW,
    PERMISSIONS.USERS_MANAGE,
    PERMISSIONS.LIVECHAT_USE,
  ],

  agent: [
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.KNOWLEDGE_VIEW,
    PERMISSIONS.LIVECHAT_USE,
  ],

  readonly: [
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.KNOWLEDGE_VIEW,
    PERMISSIONS.SETTINGS_VIEW,
    PERMISSIONS.BILLING_VIEW,
    PERMISSIONS.USERS_VIEW,
  ],
};

module.exports = { PERMISSIONS, ROLE_PRESETS };
