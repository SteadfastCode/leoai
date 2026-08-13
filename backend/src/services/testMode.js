const { resolveApiKey } = require('../middleware/auth');

/**
 * Test-mode gate for POST /chat (LEO-025).
 *
 * A chat request is test-mode when and only when it carries a valid X-API-Key header
 * validated against the ApiKey model. Nothing in the request body can grant test mode —
 * the body is visitor-controlled, and a body flag would let any visitor suppress quota
 * counting and owner notifications.
 *
 * resolveApiKey's contract (middleware/auth.js): null = no header, false = header present
 * but invalid (including DB lookup failure), object = the ApiKey document. Only the
 * object case is test mode; an invalid key is treated as a normal visitor message rather
 * than rejected, so a stale MCP key degrades to a real conversation instead of an error.
 */
function createTestModeGate(resolve = resolveApiKey) {
  return async function isTestModeRequest(req) {
    const key = await resolve(req);
    return typeof key === 'object' && key !== null;
  };
}

module.exports = { createTestModeGate, isTestModeRequest: createTestModeGate() };
