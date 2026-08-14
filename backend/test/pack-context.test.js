// Context packing (LEO-020).
//
// Pure-function tests on the extracted packContext. The old loop `break`-ed on
// the first oversized chunk, discarding every remaining chunk — including small
// high-scoring siblings that would have fit. It now skips and continues.
// Requiring rag.js pulls the embeddings service; stub it so no Voyage key is
// needed (packContext itself never touches it).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'src');
require.cache[require.resolve(path.join(srcDir, 'services', 'embeddings.js'))] = {
  id: 'stub', filename: 'stub', loaded: true,
  exports: { embedQuery: async () => [0], embedTexts: async () => [[0]] },
};

const { packContext } = require('../src/services/rag');

const chunk = (content, url = 'https://x.com/a') => ({ content, url });

test('oversized first chunk is skipped, later small chunks still pack', () => {
  const { context, sources } = packContext([
    chunk('X'.repeat(100), 'https://x.com/big'),
    chunk('small one', 'https://x.com/s1'),
    chunk('small two', 'https://x.com/s2'),
  ], 50);
  assert.ok(!context.includes('X'.repeat(100)));
  assert.ok(context.includes('small one'));
  assert.ok(context.includes('small two'));
  assert.deepEqual(sources, [
    { url: 'https://x.com/s1', name: 's1' },
    { url: 'https://x.com/s2', name: 's2' },
  ]);
});

test('mixed: oversized chunk mid-list does not abort the loop', () => {
  const { context } = packContext([
    chunk('aaaa'),
    chunk('B'.repeat(100)),
    chunk('cccc'),
  ], 30);
  assert.ok(context.includes('aaaa'));
  assert.ok(!context.includes('B'.repeat(100)));
  assert.ok(context.includes('cccc'), 'chunk after the oversized one must still pack');
});

test('all oversized returns empty context and no sources', () => {
  const { context, sources } = packContext([
    chunk('Y'.repeat(60)),
    chunk('Z'.repeat(60)),
  ], 50);
  assert.equal(context, '');
  assert.deepEqual(sources, []);
});

test('empty input returns empty context', () => {
  const { context, sources } = packContext([], 6000);
  assert.equal(context, '');
  assert.deepEqual(sources, []);
});

test('cap counts the accumulated total, not per-chunk size', () => {
  // Each fits alone; together the third would exceed the cap and is skipped.
  const { context } = packContext([
    chunk('1'.repeat(20)),
    chunk('2'.repeat(20)),
    chunk('3'.repeat(20)),
  ], 50);
  assert.ok(context.includes('1'.repeat(20)));
  assert.ok(context.includes('2'.repeat(20)));
  assert.ok(!context.includes('3'.repeat(20)));
});

test('duplicate URLs appear once in sources', () => {
  const { sources } = packContext([
    chunk('one', 'https://x.com/p'),
    chunk('two', 'https://x.com/p'),
  ], 6000);
  assert.deepEqual(sources, [{ url: 'https://x.com/p', name: 'p' }]);
});

// Source-page linking (LEO-031). Leo links using the page NAME as anchor text, so
// every source must resolve to one. pageH1 is the scraped page title; manual and
// uploaded chunks have no H1, which is why the label and URL-slug fallbacks exist —
// without them the smoke entity (manual chunks only) could never produce a link.
test('page name prefers pageH1, then label, then the URL slug', () => {
  const { sources } = packContext([
    { content: 'a', url: 'https://x.com/hours', pageH1: 'Opening Hours', label: 'Hours' },
    { content: 'b', url: 'https://x.com/menu', label: 'Our Menu' },
    { content: 'c', url: 'https://x.com/contact-us' },
  ], 6000);
  assert.deepEqual(sources, [
    { url: 'https://x.com/hours', name: 'Opening Hours' },
    { url: 'https://x.com/menu', name: 'Our Menu' },
    { url: 'https://x.com/contact-us', name: 'contact us' },
  ]);
});

test('slug fallback strips query, hash, trailing slash and extension', () => {
  const { sources } = packContext([
    { content: 'a', url: 'https://x.com/about_us/' },
    { content: 'b', url: 'https://x.com/pricing.html?ref=nav' },
    { content: 'c', url: 'https://x.com/staff#team' },
  ], 6000);
  assert.deepEqual(sources.map((s) => s.name), ['about us', 'pricing', 'staff']);
});

test('root URL falls back to a generic name rather than an empty one', () => {
  const { sources } = packContext([{ content: 'a', url: 'https://x.com/' }], 6000);
  assert.equal(sources[0].name, 'this page');
});
