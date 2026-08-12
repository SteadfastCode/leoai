/**
 * Pure helpers for team membership logic, kept free of Mongoose so they can be
 * unit-tested without a database.
 */

/**
 * True when the given user is an owner of `domain` and no OTHER member also
 * holds the owner role there — i.e. demoting or removing them would leave the
 * entity ownerless.
 *
 * `members` is an array of user-shaped objects: { _id, memberships: [{ entityDomain, roles }] }.
 * Returns false when the user is not a member or not an owner of the domain.
 */
function isLastOwner(members, userId, domain) {
  const id = String(userId);
  const ownsDomain = (m) =>
    (m.memberships || []).some(
      (ms) => ms.entityDomain === domain && (ms.roles || []).includes('owner')
    );

  const target = members.find((m) => String(m._id) === id);
  if (!target || !ownsDomain(target)) return false;

  return !members.some((m) => String(m._id) !== id && ownsDomain(m));
}

module.exports = { isLastOwner };
