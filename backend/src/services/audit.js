const AuditLog = require('../models/AuditLog');

// Fire-and-forget audit writer.
//
// Contract: recordAudit NEVER throws and its returned promise NEVER rejects,
// whatever the model does — an audit failure must not be able to break the
// action it records. Callers invoke it as a bare statement on their success
// path and must not read the result; the return value exists only so tests
// can assert the resolves-on-failure contract.
function recordAudit(req, action, fields = {}) {
  try {
    const apiKey = req && req.apiKey;
    const user = req && req.user;
    const impersonator = req && req.impersonator;
    const doc = {
      action,
      actorType: apiKey ? 'api_key' : 'user',
      apiKeyLabel: apiKey ? apiKey.label || '' : null,
      actorId: !apiKey && user && user._id ? user._id : null,
      actorEmail: !apiKey && user ? user.email || null : null,
      // If the action was taken while impersonating, record the real superadmin too.
      impersonatorId: impersonator && impersonator._id ? impersonator._id : null,
      impersonatorEmail: impersonator ? impersonator.email || null : null,
      ...fields,
    };
    return Promise.resolve()
      .then(() => AuditLog.create(doc))
      .then(() => undefined)
      .catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}

module.exports = { recordAudit };
