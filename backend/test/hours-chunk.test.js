// Standalone hours chunk builder (LEO-018).
//
// Pure-function tests — no DB, no network. The day/time paragraph fixtures
// mirror what extractStructuredText + keepPara actually emit for real footer
// hours (verified against dosiedough.com's live homepage HTML).

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildHoursChunk } = require('../src/services/hoursChunk');

const URL = 'https://example.com';

test('dosiedough footer pattern: day-only line paired with following time line', () => {
  const paras = ['Hours', 'Monday - Saturday', '7 am - 2 pm', 'Sunday', '8 am - 2 pm'];
  const chunk = buildHoursChunk(paras, URL);
  assert.ok(chunk, 'expected a chunk');
  assert.match(chunk.content, /^\[Source: https:\/\/example\.com\]\n\[H2\] Hours\n/);
  assert.match(chunk.content, /Monday - Saturday: 7 am - 2 pm/);
  assert.match(chunk.content, /Sunday: 8 am - 2 pm/);
  assert.equal(chunk.label, 'Hours');
  assert.equal(chunk.sectionH2, 'Hours');
  assert.deepEqual(chunk.sourceUrls, [URL]);
});

test('single-line day+time paragraphs are kept as-is', () => {
  const paras = ['Open Monday through Friday 8:00 am to 5:00 pm'];
  const chunk = buildHoursChunk(paras, URL);
  assert.ok(chunk);
  assert.match(chunk.content, /Open Monday through Friday 8:00 am to 5:00 pm/);
});

test('day paired with a Closed line, alongside a real time range', () => {
  const paras = ['Monday - Saturday', '7 am - 2 pm', 'Sunday', 'Closed'];
  const chunk = buildHoursChunk(paras, URL);
  assert.ok(chunk);
  assert.match(chunk.content, /Sunday: Closed/);
});

test('closed-only with no time range anywhere returns null', () => {
  assert.equal(buildHoursChunk(['Sunday', 'Closed'], URL), null);
});

test('time range without any day word returns null', () => {
  assert.equal(buildHoursChunk(['7 am - 2 pm', 'Come visit us!'], URL), null);
});

test('day names in prose paragraphs (over 80 chars) are ignored', () => {
  const paras = [
    'Join us every Sunday for our weekly community brunch, where friends and neighbors gather from 9 am - 2 pm for pastries.',
  ];
  assert.equal(buildHoursChunk(paras, URL), null);
});

test('bare numeric ranges do not count as time ranges', () => {
  // "10 - 12" without a closing meridiem must not match (scores, quantities)
  assert.equal(buildHoursChunk(['Monday', '10 - 12'], URL), null);
});

test('testimonial and menu content produces no chunk', () => {
  const paras = [
    '"Dosie Dough serves the highest quality European-style breads!"',
    'Latte 3.25',
    '45 S Broad St',
    '(717) 626 - 2266',
  ];
  assert.equal(buildHoursChunk(paras, URL), null);
});

test('empty input returns null', () => {
  assert.equal(buildHoursChunk([], URL), null);
});

test('heading-marker paragraphs are never treated as hours lines', () => {
  const paras = ['[H2] Sunday Services', 'Monday - Friday', '9 am - 5 pm'];
  const chunk = buildHoursChunk(paras, URL);
  assert.ok(chunk);
  assert.ok(!chunk.content.includes('[H2] Sunday Services'), 'H2 marker line must not be swept in');
  assert.match(chunk.content, /Monday - Friday: 9 am - 5 pm/);
});
