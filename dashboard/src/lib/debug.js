// Tiered browser-side debug logging, mirroring the backend convention
// (backend/src/services/testMode.js).
//
// The tier is read fresh on EVERY call, from localStorage first:
//
//   localStorage.setItem('leo_log_level', 'verbose')   // then keep using the tab
//
// That matters because the behaviour these logs describe — an access token
// quietly going stale on a tab that has been open for twenty minutes — cannot be
// reproduced by reloading with a different build flag. The knob has to be
// reachable on the tab that is already misbehaving.
//
// VITE_LOG_LEVEL sets the build-time default for a deploy; localStorage wins.
//
//   off      nothing
//   light    (default) one line per change, always naming its SOURCE
//   normal   adds decisions that declined to change anything but were close
//   verbose  adds the uneventful path — every check, including the no-ops
const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 }

export function logLevel() {
  let stored = null
  try {
    stored = localStorage.getItem('leo_log_level')
  } catch {
    // localStorage throws in a sandboxed iframe / blocked-cookie context. A
    // logging knob is never worth failing the thing it is logging about.
  }
  const name = String(stored || import.meta.env?.VITE_LOG_LEVEL || 'light').toLowerCase()
  return TIERS[name] ?? TIERS.light
}

/** A `debug(tier, message)` for one subsystem, prefixed `[scope]`. */
export function makeDebug(scope) {
  return function debug(tier, message) {
    if (logLevel() >= (TIERS[tier] ?? TIERS.light)) console.log(`[${scope}] ${message}`)
  }
}
