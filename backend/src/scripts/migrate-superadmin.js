/**
 * One-time migration: update the superadmin account to the new memberships-based RBAC schema.
 * Run with: node src/scripts/migrate-superadmin.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);

  // Find users that still have the old flat 'role' field in their document
  // Mongoose won't expose it via the model (schema doesn't define it), so use native query
  const col = mongoose.connection.collection('users');
  const oldUsers = await col.find({ role: { $exists: true } }).toArray();

  if (!oldUsers.length) {
    console.log('No users with old-style role field found. Nothing to migrate.');
    await mongoose.disconnect();
    return;
  }

  for (const doc of oldUsers) {
    const { _id, role, entityDomain } = doc;
    const domain = entityDomain || 'steadfastcode.tech';

    const membership = { entityDomain: domain, roles: [role], permissions: [] };

    // Only add membership if not already present
    const existingMemberships = doc.memberships || [];
    const alreadyHas = existingMemberships.some((m) => m.entityDomain === domain);

    const update = { $unset: { role: '', entityDomain: '' } };
    if (!alreadyHas) {
      update.$push = { memberships: membership };
    }

    await col.updateOne({ _id }, update);
    console.log(`Migrated ${doc.email} — role=${role}, domain=${domain}`);
  }

  console.log(`Done. Migrated ${oldUsers.length} user(s).`);
  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
