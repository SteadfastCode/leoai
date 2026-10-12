// The widget's chat rendering, shared by every dashboard surface that shows a Leo
// reply (ChatWindow in the admin tray, the owner playground). Extracted in LEO-040 so
// the playground renders replies exactly as a visitor sees them instead of growing a
// second, drifting copy of this.
//
// Escaping comes FIRST and is the only defence here: the output is handed to v-html,
// and a reply can contain anything the knowledge base contains. Every rule below runs
// on already-escaped text, so no rule can reintroduce a tag.
export function renderMarkdown(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(?<!href=")(https?:\/\/[^\s<"]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

export default renderMarkdown;
