const Log = require('../models/Log');

const BUFFER_SIZE = 500;
// A console.log of a chunk with a 512-float embedding is ~60KB — bound every
// buffered entry so neither the ring buffer nor the socket stream ships that.
const MAX_MESSAGE_CHARS = 2000;
const buffer = [];
let _io = null;
let _seq = 0;

// ---------------------------------------------------------------------------
// MongoDB persistence — batched, fire-and-forget (LEO-011)
//
// LOG_PERSIST_LEVEL: 'off' = nothing, 'warn' (default) = warn+error only,
// 'all' = everything including info/http. Batches flush at FLUSH_SIZE entries
// or after FLUSH_MS, whichever comes first. THE FLUSH PATH MUST NEVER CALL ANY
// CONSOLE METHOD — console is monkey-patched below, so a console call from in
// here recurses forever. It must also never throw: losing a log line is fine,
// taking the process down over one is not.
// ---------------------------------------------------------------------------
const PERSIST_LEVEL = (process.env.LOG_PERSIST_LEVEL || 'warn').toLowerCase();
const FLUSH_SIZE = 50;
const FLUSH_MS = 5000;
let pending = [];
let flushTimer = null;

function shouldPersist(level) {
  if (PERSIST_LEVEL === 'off') return false;
  if (PERSIST_LEVEL === 'all') return true;
  return level === 'warn' || level === 'error';
}

function flushPending() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending.length) return;
  const batch = pending;
  pending = [];
  try {
    Log.insertMany(batch, { ordered: false }).catch(() => { /* swallow — see header */ });
  } catch { /* swallow — see header */ }
}

function enqueuePersist(entry) {
  if (!shouldPersist(entry.level)) return;
  pending.push({
    // The Log level enum is ['info','warn','error'] — morgan's 'http' maps to
    // info with its own source so the schema is untouched.
    level: entry.level === 'http' ? 'info' : entry.level,
    source: entry.level === 'http' ? 'http' : 'console',
    message: entry.message,
  });
  if (pending.length >= FLUSH_SIZE) return flushPending();
  if (!flushTimer) {
    flushTimer = setTimeout(flushPending, FLUSH_MS);
    if (flushTimer.unref) flushTimer.unref();
  }
}

function addEntry(level, args) {
  let message = args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  if (message.length > MAX_MESSAGE_CHARS) message = message.slice(0, MAX_MESSAGE_CHARS) + ' …[truncated]';

  const entry = { id: ++_seq, ts: new Date().toISOString(), level, message };
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.shift();
  enqueuePersist(entry);
  if (_io) {
    try {
      // Serializing + emitting for an empty room is pure waste — skip unless a
      // superadmin dashboard is actually connected.
      const room = _io.sockets && _io.sockets.adapter && _io.sockets.adapter.rooms
        ? _io.sockets.adapter.rooms.get('superadmin')
        : null;
      if (room && room.size > 0) _io.to('superadmin').emit('log_entry', entry);
    } catch { /* never crash the caller */ }
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
