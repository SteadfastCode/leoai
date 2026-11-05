// Password-reset token hashing (LEO-098).
//
// The reset token is the entire credential: whoever holds it can set a new
// password with no password and no access to the owner's inbox. It used to be
// written onto the user document verbatim, so read access to the `users`
// collection — an Atlas backup, a leaked connection string, a superadmin
// browsing data — was enough to take over any account with a live reset
// request. Every other credential in this backend is already stored as a
// digest (`hashedPassword` is bcrypt, `ApiKey.keyHash` is SHA-256), so this
// follows ApiKey: the raw value goes in the email and nowhere else, only its
// SHA-256 digest is stored, and the lookup hashes the token it was handed.
//
// SHA-256 rather than bcrypt deliberately: the input is 32 bytes of CSPRNG
// output, so there is nothing to brute-force and the lookup has to be a single
// indexed equality match rather than a scan of every live token.
//
// Both halves live behind this one pure function so the write site and the read
// site can never disagree about how a token is stored.

const crypto = require('crypto');

/**
 * SHA-256 digest of a raw reset token, as 64 lowercase hex characters.
 * Anything that is not a non-empty string returns null — callers must treat
 * null as "no usable token" rather than querying with it, since a query for
 * `passwordResetToken: null` would match every user who has no live request.
 */
function hashResetToken(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = { hashResetToken };
