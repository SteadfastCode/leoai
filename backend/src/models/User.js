const mongoose = require('mongoose');

const passkeySchema = new mongoose.Schema({
  credentialID:        { type: String, required: true },
  credentialPublicKey: { type: Buffer, required: true },
  counter:             { type: Number, required: true },
  deviceType:          { type: String },
  backedUp:            { type: Boolean },
  transports:          [{ type: String }],
  name:                { type: String, default: 'Passkey' },
}, { _id: false });

const refreshTokenSchema = new mongoose.Schema({
  token:     { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { _id: false });

const userSchema = new mongoose.Schema(
  {
    name:              { type: String, required: true },
    email:             { type: String, required: true, unique: true, lowercase: true, trim: true },
    hashedPassword:    { type: String }, // null for passkey-only accounts

    // A user can belong to multiple entities (e.g. agency staff, Steadfast Code employees)
    // Each entry scopes their roles and individual permissions to a specific domain
    // For superadmin/Steadfast Code users, entityDomain is 'steadfastcode.tech'
    memberships: [{
      entityDomain:  { type: String, required: true },
      roles:         [{ type: String }], // role names from ROLE_PRESETS or custom entity roles
      permissions:   [{ type: String }], // individual permission overrides (additions or exceptions)
      _id: false,
    }],

    showNameInReplies: { type: Boolean, default: false },
    passkeys:          [passkeySchema],
    refreshTokens:     [refreshTokenSchema],
    currentChallenge:       { type: String }, // ephemeral WebAuthn challenge
    passwordResetToken:     { type: String },
    passwordResetExpiresAt: { type: Date },
  },
  { timestamps: true }
);

/**
 * Compute the full resolved permission set for a user in a given domain context.
 * Merges all role preset permissions + individual permission grants.
 */
userSchema.methods.resolvePermissions = function(entityDomain, rolePresets) {
  const membership = this.memberships.find((m) => m.entityDomain === entityDomain);
  if (!membership) return new Set();

  const granted = new Set();

  for (const role of membership.roles) {
    const preset = rolePresets[role] || [];
    preset.forEach((p) => granted.add(p));
  }

  // Individual permissions layer on top — can add beyond what roles grant
  for (const perm of membership.permissions || []) {
    granted.add(perm);
  }

  return granted;
};

userSchema.methods.hasPermission = function(entityDomain, permission, rolePresets) {
  const resolved = this.resolvePermissions(entityDomain, rolePresets);
  return resolved.has(permission);
};

module.exports = mongoose.model('User', userSchema);
