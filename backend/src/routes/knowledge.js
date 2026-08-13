const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const router = express.Router({ mergeParams: true });

const Chunk = require('../models/Chunk');
const { embedTexts, embedQuery } = require('../services/embeddings');
const { chunkText } = require('../services/scraper');
const { scanText } = require('../services/leoscan');
const { requireAuth, isSuperAdmin } = require('../middleware/auth');
const { PERMISSIONS } = require('../models/Permission');

// Domain-scoping floor — same intent as routes/dashboard.js's router.param
// guard. This router is mounted directly in index.js (not under the dashboard
// router), so it never inherited that floor: requireAuth() without a
// PERMISSIONS argument authenticates but does not check membership. A
// router.param here would never fire (:domain belongs to the parent mount
// path), so it is router-level middleware instead — mergeParams exposes
// req.params.domain. Every route on this router gets it, including future
// ones; per-route requireAuth(PERMISSIONS.*) still applies on top.
router.use(requireAuth());
router.use((req, res, next) => {
  const { domain } = req.params;
  if (isSuperAdmin(req.user)) return next();
  const hasMembership = req.user?.memberships?.some((m) => m.entityDomain === domain);
  if (!hasMembership) return res.status(403).json({ error: 'Forbidden' });
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
});

// GET /api/dashboard/entities/:domain/kb/entries
// List all manual + upload entries, one record per logical entry (grouped by label)
router.get('/entries', requireAuth(), async (req, res) => {
  try {
    const { domain } = req.params;

    // Aggregate to get one doc per label with chunk count
    const entries = await Chunk.aggregate([
      { $match: { domain, source: { $in: ['manual', 'upload', 'owner_reply'] }, label: { $exists: true, $ne: '' } } },
      {
        $group: {
          _id: '$label',
          source: { $first: '$source' },
          chunkCount: { $sum: 1 },
          createdAt: { $min: '$createdAt' },
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    res.json(entries.map(e => ({
      label: e._id,
      source: e.source,
      chunkCount: e.chunkCount,
      createdAt: e.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/entities/:domain/kb/entries  (text)
router.post('/entries', requireAuth(PERMISSIONS.SETTINGS_EDIT), async (req, res) => {
  const { domain } = req.params;
  const { title, content } = req.body;
  if (!title?.trim() || !content?.trim()) {
    return res.status(400).json({ error: 'title and content are required' });
  }

  const label = title.trim();
  await ingestText({ domain, label, text: content.trim(), source: 'manual', res });
});

// POST /api/dashboard/entities/:domain/kb/upload  (file)
router.post('/upload', requireAuth(PERMISSIONS.SETTINGS_EDIT), upload.single('file'), async (req, res) => {
  const { domain } = req.params;
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const { originalname, mimetype, buffer } = req.file;
  const ext = originalname.toLowerCase().split('.').pop();
  let text = '';

  if (ext === 'pdf' || mimetype === 'application/pdf') {
    try {
      const result = await pdfParse(buffer);
      text = result.text;
    } catch {
      return res.status(422).json({ error: 'Could not parse PDF — the file may be scanned/image-only' });
    }
  } else if (ext === 'docx' || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    try {
      const result = await mammoth.extractRawText({ buffer });
      text = result.value;
    } catch {
      return res.status(422).json({ error: 'Could not parse DOCX file' });
    }
  } else if (ext === 'xlsx' || ext === 'xls' || mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mimetype === 'application/vnd.ms-excel') {
    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      const sheetTexts = [];
      workbook.eachSheet((worksheet) => {
        const rows = [];
        worksheet.eachRow((row) => {
          const cells = row.values.slice(1).map(v => {
            if (v == null) return '';
            if (typeof v === 'object') {
              if (v.richText) return v.richText.map(r => r.text).join('');
              if (v.result != null) return String(v.result);
              if (v instanceof Date) return v.toISOString().slice(0, 10);
            }
            return String(v);
          });
          rows.push(cells.join(','));
        });
        sheetTexts.push(`[Sheet: ${worksheet.name}]\n` + rows.join('\n'));
      });
      text = sheetTexts.join('\n\n');
    } catch {
      return res.status(422).json({ error: 'Could not parse Excel file' });
    }
  } else if (ext === 'csv' || mimetype === 'text/csv') {
    text = buffer.toString('utf8');
  } else if (mimetype.startsWith('text/') || ['txt', 'md', 'rtf'].includes(ext)) {
    text = buffer.toString('utf8');
  } else {
    return res.status(415).json({ error: 'Unsupported file type. Accepted: PDF, DOCX, XLSX, XLS, CSV, TXT, MD' });
  }

  text = text.trim();
  if (!text) return res.status(422).json({ error: 'File appears to be empty or unreadable' });

  await ingestText({ domain, label: originalname, text, source: 'upload', res });
});

// DELETE /api/dashboard/entities/:domain/kb/entries/:label
router.delete('/entries/:label', requireAuth(PERMISSIONS.SETTINGS_EDIT), async (req, res) => {
  try {
    const { domain } = req.params;
    const label = decodeURIComponent(req.params.label);
    const result = await Chunk.deleteMany({ domain, label, source: { $in: ['manual', 'upload', 'owner_reply'] } });
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/entities/:domain/kb/search?q=...&mode=semantic|text
// Owner-facing "is this actually in Leo's knowledge base?" (LEO-033).
// text: exact case-insensitive substring match (regex metacharacters treated
//       as literals) — answers "is the string '9am' anywhere in my KB".
// semantic: same Atlas $vectorSearch shape as the superadmin admin.js search,
//       scored, so owners build intuition for what Leo retrieves and why.
const SNIPPET_RADIUS = 120;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a snippet window around the first match. Returns { snippet,
// matchStart, matchLength } with matchStart relative to the snippet (-1 when
// there is no literal match, e.g. semantic mode), so the frontend can
// highlight without any HTML round-tripping.
function makeSnippet(content, q) {
  const idx = content.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) {
    const snippet = content.slice(0, SNIPPET_RADIUS * 2);
    return { snippet: snippet + (content.length > snippet.length ? '…' : ''), matchStart: -1, matchLength: 0 };
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(content.length, idx + q.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return {
    snippet: prefix + content.slice(start, end) + suffix,
    matchStart: prefix.length + (idx - start),
    matchLength: q.length,
  };
}

router.get('/search', async (req, res) => {
  try {
    const { domain } = req.params;
    const q = (req.query.q || '').trim();
    const mode = req.query.mode === 'text' ? 'text' : 'semantic';
    if (!q) return res.status(400).json({ error: 'q is required' });

    if (mode === 'text') {
      const re = new RegExp(escapeRegex(q), 'i');
      const chunks = await Chunk.find({ domain, content: re })
        .select('url label pageH1 source content')
        .limit(50)
        .lean();
      return res.json({
        mode,
        results: chunks.map((c) => ({
          _id: c._id,
          url: c.url,
          label: c.label ?? null,
          pageH1: c.pageH1 ?? null,
          source: c.source,
          ...makeSnippet(c.content, q),
        })),
        total: chunks.length,
      });
    }

    const queryEmbedding = await embedQuery(q);
    const chunks = await Chunk.aggregate([
      {
        $vectorSearch: {
          index: 'vector_index',
          path: 'embedding',
          queryVector: queryEmbedding,
          numCandidates: 100,
          limit: 20,
          filter: { domain },
        },
      },
      {
        $project: {
          content: 1,
          url: 1,
          label: 1,
          pageH1: 1,
          source: 1,
          score: { $meta: 'vectorSearchScore' },
        },
      },
    ]);
    res.json({
      mode,
      results: chunks.map((c) => ({
        _id: c._id,
        url: c.url,
        label: c.label ?? null,
        pageH1: c.pageH1 ?? null,
        source: c.source,
        score: c.score,
        ...makeSnippet(c.content, q),
      })),
      total: chunks.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Shared ingest helper ───────────────────────────────────────────────────
async function ingestText({ domain, label, text, source, res }) {
  try {
    // LeoScan (LEO-021): manual/upload paths only — never the scraper, where a
    // false positive would silently drop chunks unattended. Must run BEFORE the
    // deleteMany below so a rejected re-upload leaves existing chunks intact.
    const flags = scanText(text);
    if (flags.length) {
      return res.status(422).json({
        error: 'This content appears to contain sensitive data (passwords, keys, or personal numbers) and was not added to the knowledge base. Remove the flagged items and try again.',
        flags,
      });
    }

    const url = `${source}://${domain}/${label}`;

    // Replace any existing chunks for this label (idempotent re-upload)
    await Chunk.deleteMany({ domain, label, source });

    const rawChunks = chunkText(text, url);
    if (!rawChunks.length) {
      return res.status(400).json({ error: 'Content is too short to add to the knowledge base (minimum ~50 chars)' });
    }

    const embeddings = await embedTexts(rawChunks.map(c => c.content));

    await Chunk.insertMany(rawChunks.map((c, i) => ({
      domain,
      url,
      label,
      content: c.content,
      embedding: embeddings[i],
      source,
    })));

    res.json({ ok: true, label, chunks: rawChunks.length });
  } catch (err) {
    console.error('KB ingest error:', err);
    res.status(500).json({ error: err.message });
  }
}

module.exports = router;
