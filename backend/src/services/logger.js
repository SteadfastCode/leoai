const Log = require('../models/Log');

async function log(level, source, message, meta = {}, domain = null) {
  // Always write to console
  const consoleFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleFn(`[${level.toUpperCase()}] [${source}]`, message, meta && Object.keys(meta).length ? meta : '');

  // Write to DB — fire-and-forget, never blocks the caller
  Log.create({ level, source, message, meta, domain }).catch(() => {});
}

module.exports = {
  info:  (source, message, meta, domain) => log('info',  source, message, meta, domain),
  warn:  (source, message, meta, domain) => log('warn',  source, message, meta, domain),
  error: (source, message, meta, domain) => log('error', source, message, meta, domain),
};
