// The widget's chat rendering, shared by every dashboard surface that shows a Leo
// reply (ChatWindow in the admin tray, the owner playground). Extracted in LEO-040 so
// the playground renders replies exactly as a visitor sees them instead of growing a
// second, drifting copy of this.
//
// Escaping comes FIRST, but escaping `&<>` is NOT on its own a defence here, which is
// what this comment used to claim (LEO-091). The output goes to v-html AND the link
// rules drop a captured URL into an href="..." attribute, so the attribute delimiter
// matters as much as the tag delimiters: before this fix a reply containing
// [x](https://a"onmouseover=alert(1)) closed href early and the rest of the URL landed
// in the tag as a live event-handler attribute. Two layers now:
//
//   1. escapeHtml covers the attribute delimiters (" ') as well as & < >, in a single
//      pass so that no substitution can be re-escaped by a later one;
//   2. the link rules refuse an href that still holds a character RFC 3986 allows
//      nowhere in a URL (" < > and backtick — note ' IS legal, it is a sub-delim),
//      because after layer 1 the only way to see one is a probe at the quote boundary.
//
// Every rule runs on already-escaped text, so no rule can reintroduce a tag.
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Matches what layer 1 leaves behind for " < > (entities) plus a raw backtick.
const ILLEGAL_IN_URL = /&quot;|&lt;|&gt;|`/;

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// url and label arrive already escaped. Returns null when the url is not linkable, so
// each caller can decide what to leave behind in its place.
function anchor(url, label) {
  if (!/^https?:\/\/[^\s]/.test(url) || ILLEGAL_IN_URL.test(url)) return null;
  return `<a href="${url}" target="_blank" rel="noopener">${label}</a>`;
}

export function renderMarkdown(text) {
  return escapeHtml(text)
    // [label](url) — the url is delimited, so an illegal character means the whole
    // link is junk: leave the escaped source text and render no anchor at all.
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      (whole, label, url) => anchor(url, label) ?? whole
    )
    // Bare urls. Here the url ends at whitespace, so an illegal character is usually
    // ordinary prose running into the link (`"visit https://x.com"`): link the legal
    // prefix and hand the remainder back as text rather than dropping the link.
    // The `<` and `"` exclusions are load-bearing — they stop this rule from eating
    // the markup the rule above just produced.
    .replace(/(?<!href=")(https?:\/\/[^\s<"]+)/g, (whole) => {
      const cut = whole.search(ILLEGAL_IN_URL);
      if (cut === -1) return anchor(whole, whole) ?? whole;
      const prefix = whole.slice(0, cut);
      const link = anchor(prefix, prefix);
      return link ? link + whole.slice(cut) : whole;
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

export default renderMarkdown;
