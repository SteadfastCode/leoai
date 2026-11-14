// Short schedule lines (LEO-143).
//
// Schedules, service times and business hours are published as RUNS OF SHORT
// LINES inside a single block — one <br>-separated line per entry in one
// WordPress/Elementor text-editor widget, or one <span> per line in the same
// <p>. extractStructuredText turns each <br> into a single '\n', the paragraph
// pipeline then split on /\n+/, and keepPara's 20-char floor killed every line
// that happened to be short. Measured on campcalvary.com/camps/mr/ (the Men's
// Retreat schedule): "7:00 Dinner", "8:15 SESSION #1", "8:45 SESSION #2",
// "10:00 Break", "11:00 SESSION #3", "3:45 SESSION #4" and "5:00 Dinner" were
// all dropped while the longer "1:00 Free Time Activities…" survived, so the
// stored schedule read as all free time and no sessions.
//
// Two independent fixes, both needed:
//
//   toParagraphs()  replaces `text.split(/\n+/)` at every paragraph call site.
//                   It splits BLOCKS on blank lines exactly as before, but
//                   within a block a run of consecutive short lines that
//                   carries a schedule signal is joined into ONE paragraph,
//                   one line each. A schedule then survives chunking as a
//                   single unit instead of as a scatter of fragments.
//
//   isScheduleLine() a line holding a clock time, a meridiem time, a weekday,
//                   a month/date or a price is kept by keepPara whatever its
//                   length. This is what saves a short line that sits alone
//                   between two long ones, where there is no run to join.
//
// Nav and footer chrome stays excluded exactly as it is today, by two
// deliberate narrowings:
//
//   * A run is only joined when at least one of its lines carries a schedule
//     signal. Nav menus are runs of short lines too; none of them says
//     "7:00 pm". Without this gate, Puppeteer's innerText — which separates
//     sibling blocks with a single '\n', unlike the cheerio path where every
//     block boundary is a blank line — would fold a whole header menu into one
//     long paragraph that then clears the 20-char floor.
//   * A joined paragraph is capped at MAX_JOIN_LEN, which is scraper.js's
//     BOILERPLATE_MAX. Paragraphs longer than that bypass cross-page dedup
//     (they are assumed to be real prose), so an uncapped join of a footer
//     hours block would stop deduping and reappear on every page of the site —
//     and with it, one buildHoursChunk per page.
//
// Debug tiers — SCHEDULE_LINES_LOG_LEVEL = off | light | normal | verbose:
//   off             nothing
//   light (default) one line per page whose text had a run joined, naming the
//                   SOURCE url that changed and the first line of the first
//                   run — not just that a join happened
//   normal          adds the same for the measurement and dedup call sites,
//                   which re-derive the same paragraphs and would otherwise
//                   quadruple every line
//   verbose         adds every joined run verbatim
//
// Unit-tested in backend/test/schedule-lines.test.js.

const TIERS = { off: 0, light: 1, normal: 2, verbose: 3 };

function logTier() {
  const name = String(process.env.SCHEDULE_LINES_LOG_LEVEL || 'light').toLowerCase();
  return TIERS[name] ?? TIERS.light;
}

function debug(tier, message) {
  if (logTier() >= TIERS[tier]) console.log(`[ScheduleLines] ${message}`);
}

// A bare clock time: 7:00, 8:15, 10:45, 12:15. The most common schedule marker
// and the one the pre-existing TIME_RE missed — it required a meridiem.
const CLOCK_RE = /\b\d{1,2}:\d{2}\b/;

// A time with a meridiem, which may have no minutes: "7 pm", "10:45 A.M.".
const MERIDIEM_RE = /\b\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/i;

// Weekday words, full and abbreviated, plus the umbrella terms a schedule uses
// in their place. Shaped after hoursChunk.js's DAY_RE but kept separate on
// purpose, so a widening here cannot change which pages produce a standalone
// hours chunk. The trailing s? is the widening that matters: "Closed Sundays"
// is a real 14-char hours line that DAY_RE's \bsunday\b cannot match.
const WEEKDAY_RE = /\b(?:(?:mon|tues?|wednes|wed|thurs|thur|fri|satur|sat|sun)(?:day)?s?|daily|weekdays?|weekends?|every\s?day)\b/i;

// A month name, alone or with a day — "March", "Mar 14", "December 6-8".
const MONTH_RE = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\b/i;

// A slash date: 3/14, 03/14/2026. The dashed form is deliberately absent — it
// cannot be told apart from a page range or a numeric list, and a dashed date
// in a schedule carries a month name or a clock time alongside it anyway.
const SLASH_DATE_RE = /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/;

// A price. Same shape as scraper.js's MONEY_RE, which keepPara already honours;
// repeated here so isScheduleLine answers the item's question on its own.
const PRICE_RE = /[$€£¥]\s*\d[\d.,]*/;

// Heading markers ([H1]/[H2#id]/[H3]) and the [SB] semantic-block marker, which
// ride on the front of a paragraph and must not count toward its length.
const MARKER_PREFIX_RE = /^(?:\[SB\]|\[H[123](?:#[^\]\s]*)?\] )+/;

// Lines at or under this are schedule/list lines rather than prose, and are
// candidates for joining. Above keepPara's 20-char floor on purpose: a run
// mixing "7:00 Dinner" with "8:00 Welcome and Introductions" is one schedule,
// and breaking the run at every line that would have survived on its own would
// leave the short ones stranded as fragments again.
const SHORT_LINE_MAX = 60;

// A run must be at least this many lines. A lone short line is handled by
// isScheduleLine, not by joining it to whatever happens to sit next to it.
const MIN_RUN = 2;

// Cap on a joined paragraph. This is scraper.js's BOILERPLATE_MAX — see the
// dedup note in the header. A longer schedule simply becomes two joined
// paragraphs, which still sit adjacent and in order in the same chunk.
const MAX_JOIN_LEN = 200;

// Strip leading [SB]/[H*] markers — for length and heading tests only; the
// returned paragraphs always keep their markers for the downstream pipeline.
function bareText(line) {
  return line.replace(MARKER_PREFIX_RE, '');
}

// True when a line carries a time, a date, a weekday or a price, and so must
// be kept whatever its length.
function isScheduleLine(line) {
  const bare = bareText(String(line ?? ''));
  return CLOCK_RE.test(bare)
    || MERIDIEM_RE.test(bare)
    || WEEKDAY_RE.test(bare)
    || MONTH_RE.test(bare)
    || SLASH_DATE_RE.test(bare)
    || PRICE_RE.test(bare);
}

// A heading is never folded into a run — it is the schedule's label, and
// chunkText splits sections on it.
function isHeading(line) {
  return /^\[H[123](?:#[^\]\s]*)?\] /.test(line);
}

function isShort(line) {
  return !isHeading(line) && bareText(line).length <= SHORT_LINE_MAX;
}

// Split a page's extracted text into paragraphs, joining short schedule runs.
//
// Drop-in replacement for `text.split(/\n+/).map(p => p.trim()).filter(Boolean)`:
// identical output for every block that has no joinable run, which is why it is
// safe at all four paragraph call sites. `source` is the page url (or another
// label) and only changes which debug tier reports the join.
function toParagraphs(text, source = null) {
  const out = [];
  const joined = [];

  for (const block of String(text ?? '').split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);

    let i = 0;
    while (i < lines.length) {
      // Longest run of consecutive short lines starting at i, capped so the
      // joined paragraph stays under MAX_JOIN_LEN.
      let end = i;
      let len = 0;
      while (end < lines.length && isShort(lines[end])) {
        const next = len === 0 ? lines[end].length : len + 1 + lines[end].length;
        if (end > i && next > MAX_JOIN_LEN) break;
        len = next;
        end += 1;
      }

      const run = lines.slice(i, end);
      if (run.length >= MIN_RUN && run.some(isScheduleLine)) {
        out.push(run.join('\n'));
        joined.push(run);
        i = end;
      } else {
        // No joinable run here — emit this line exactly as the old split did.
        out.push(lines[i]);
        i += 1;
      }
    }
  }

  if (joined.length > 0) {
    const where = source ? ` source: ${source}` : ' source: unlabelled call site';
    debug(source ? 'light' : 'normal',
      `joined ${joined.length} short-line run(s), ${joined.reduce((n, r) => n + r.length, 0)} lines —${where} — first "${joined[0][0]}"`);
    for (const run of joined) debug('verbose', `  run: ${JSON.stringify(run.join(' | '))}`);
  }

  return out;
}

module.exports = {
  toParagraphs,
  isScheduleLine,
  SHORT_LINE_MAX,
  MIN_RUN,
  MAX_JOIN_LEN,
};
