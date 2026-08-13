// Standalone opening-hours chunk builder (LEO-018).
//
// Small-business sites almost universally publish hours as terse footer lines
// ("Monday - Saturday" / "7 am - 2 pm") rather than prose. Embedded inside a
// mixed page chunk, that text scores well below the 0.75 retrieval threshold
// for "what are your hours?" — measured 0.68 on dosiedough.com's homepage
// chunk vs 0.79 for the same lines isolated under an [H2] Hours heading.
// This module detects day/time paragraph runs in a page's filtered paragraphs
// and emits one dedicated hours chunk so the most common visitor question has
// a chunk whose embedding is actually about hours.
//
// Called from chunkText (scraper.js) after paragraph filtering, so upstream
// seenParaHashes dedup guarantees at most one hours chunk per crawl — footer
// paragraphs only survive to chunking on the first page they appear on.

// Day words: full/abbreviated day names, plus common umbrella terms.
const DAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|weds?|thurs?|fri|sat|sun|daily|weekdays?|weekends?|every\s?day)\b/i;

// A time range: "7 am - 2 pm", "7:30am–2pm", "8 am to 5 pm". The opening time's
// meridiem is optional ("7 - 2 pm"); the closing time's is required so bare
// numeric ranges like "10 - 12" (scores, quantities) don't match.
const TIME_RANGE_RE = /\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\s*(-|–|—|to)\s*\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/i;

const CLOSED_RE = /\bclosed\b/i;

// Paragraphs longer than this are prose, not hours-table lines.
const MAX_LINE_LEN = 80;

// Detect hours lines in a page's paragraphs and build a standalone chunk.
// paras: array of plain paragraph strings (post-keepPara, post-stripBlockMarker).
// Returns a chunk object (without chunkIndex — caller assigns) or null.
function buildHoursChunk(paras, url) {
  const lines = [];
  let hasTimeRange = false;

  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (p.length > MAX_LINE_LEN || /^\[H[123]\] /.test(p)) continue;
    const day = DAY_RE.test(p);
    const time = TIME_RANGE_RE.test(p);

    if (day && time) {
      lines.push(p);
      hasTimeRange = true;
    } else if (day && !CLOSED_RE.test(p)) {
      // Day-only line — pair with an immediately following time-range or
      // "Closed" line (the <br>-split footer pattern: "Monday - Saturday"
      // then "7 am - 2 pm").
      const next = paras[i + 1];
      if (next && next.length <= MAX_LINE_LEN) {
        if (TIME_RANGE_RE.test(next)) {
          lines.push(`${p}: ${next}`);
          hasTimeRange = true;
          i++;
        } else if (CLOSED_RE.test(next)) {
          lines.push(`${p}: ${next}`);
          i++;
        }
      }
    }
  }

  // Require at least one line pairing a day with a real time range —
  // "closed"-only or time-only matches are not evidence of an hours table.
  if (!hasTimeRange || lines.length === 0) return null;

  const content = `[Source: ${url}]\n[H2] Hours\n\n${lines.join('\n\n')}`;
  return {
    content,
    url,
    pageH1: null,
    sectionH2: 'Hours',
    label: 'Hours',
    sourceUrls: [url],
  };
}

module.exports = { buildHoursChunk };
