const express = require('express');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const router = express.Router({ mergeParams: true });

const Chunk = require('../models/Chunk');
const { embedTexts } = require('../services/embeddings');
const { chunkText } = require('../services/scraper');
const { requireAuth } = require('../middleware/auth');
const { PERMISSIONS } = require('../models/Permission');

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
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      text = workbook.SheetNames.map(name => {
        const sheet = workbook.Sheets[name];
        return `[Sheet: ${name}]\n` + XLSX.utils.sheet_to_csv(sheet);
      }).join('\n\n');
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

// ── Shared ingest helper ───────────────────────────────────────────────────
async function ingestText({ domain, label, text, source, res }) {
  try {
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
