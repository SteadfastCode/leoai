const BUFFER_SIZE = 500;
const buffer = [];
let _io = null;
let _seq = 0;

function addEntry(level, args) {
  const entry = {
    id: ++_seq,
    ts: new Date().toISOString(),
    level,
    message: args.map(a => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' '),
  };
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.shift();
  if (_io) {
    try { _io.to('superadmin').emit('log_entry', entry); } catch { /* never crash the caller */ }
  }
}

const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);

console.log   = (...args) => { _origLog(...args);   addEntry('info',  args); };
console.warn  = (...args) => { _origWarn(...args);  addEntry('warn',  args); };
console.error = (...args) => { _origError(...args); addEntry('error', args); };

function setup(io) { _io = io; }
function getRecentLogs() { return buffer.slice(); }

// Morgan stream — writes HTTP access log lines with level 'http'
const morganStream = { write: (msg) => addEntry('http', [msg.trim()]) };

module.exports = { setup, getRecentLogs, morganStream };
