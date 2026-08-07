#!/usr/bin/env node
/**
 * verify-prompt.js — asserts the Leo system prompt actually reaches Claude intact.
 *
 * Why this exists: getRawPrompt() extracts the prompt body from a markdown code fence in
 * prompts/leo-system-prompt.md. That file contains its own nested ``` fences, so a
 * non-greedy regex silently truncated the prompt at the first inner fence — Church Mode,
 * RETURNING VISITORS, FORMATTING and A NOTE ON WHO YOU ARE never reached the model, and
 * nothing failed loudly. This script is the loud failure.
 *
 * Run: node src/scripts/verify-prompt.js   (from backend/)
 * Exits non-zero on any problem, so it can gate a commit or a deploy.
 */

const fs = require('fs');
const path = require('path');

const PROMPT_PATH = path.join(__dirname, '../../prompts/leo-system-prompt.md');

// Sections that must survive extraction. Any heading listed here but missing from the
// extracted body means the prompt is being truncated again.
const REQUIRED_SECTIONS = [
  'YOUR IDENTITY',
  'YOUR PERSONALITY',
  'YOUR KNOWLEDGE',
  'YOUR VALUES',
  'CONVERSATIONAL AWARENESS',
  'HOLDING YOUR GROUND',
  'WHAT YOU WILL NOT DO',
  'HANDOFF BEHAVIOR',
  'INTERACTIVE RESPONSES',
  'RETURNING VISITORS',
  'FORMATTING',
  'CHURCH & MINISTRY MODE',
  'A NOTE ON WHO YOU ARE',
];

// Runtime placeholders buildSystemPrompt() substitutes. Each must be present in the
// extracted body — a placeholder stranded outside the fence is dead config.
// Keep in sync with the .replace() chain in services/claude.js.
const REQUIRED_PLACEHOLDERS = [
  '[BUSINESS_NAME]',
  '[AVG_WAIT_TIME]',
  '[PREVIOUS_TOPIC]',
  '[CHURCH_MODE_ENABLED]',
  '[HANDOFF_MODE_INSTRUCTION]',
  '[CHURCH_MISSION]',
  '[STATEMENT_OF_FAITH]',
  '[DENOMINATIONAL_DISTINCTIVES]',
  '[CHURCH_VALUES]',
  '[PASTORAL_TONE]',
];

// Bracket tokens that are intentionally NOT substituted — signals Leo emits, or literal
// instructional prose. Anything bracketed that is in neither this list nor the one above
// is an unwired placeholder: it would reach Claude as raw "[SOMETHING]" text.
const INTENTIONAL_LITERALS = [
  '[HANDOFF_REQUESTED]',
  '[POSITION]',
  '[reference]',
  '[contact info from knowledge base]',
];

// Mirrors getRawPrompt() in services/claude.js. Kept in sync deliberately: if that
// extraction changes, this must change with it and the assertions below re-run.
function extract(template) {
  const match = template.match(/```\r?\n([\s\S]*)\r?\n```/);
  return match ? match[1] : template;
}

function main() {
  const template = fs.readFileSync(PROMPT_PATH, 'utf8');
  const body = extract(template);
  const failures = [];

  if (body === template) {
    failures.push('No code fence matched — getRawPrompt() would fall back to the whole file, including the Version History section.');
  }

  const missingSections = REQUIRED_SECTIONS.filter((s) => !body.includes(s));
  if (missingSections.length) {
    failures.push(`Sections missing from the extracted prompt: ${missingSections.join(', ')}`);
  }

  const missingPlaceholders = REQUIRED_PLACEHOLDERS.filter((p) => !body.includes(p));
  if (missingPlaceholders.length) {
    failures.push(`Runtime placeholders missing from the extracted prompt: ${missingPlaceholders.join(', ')}`);
  }

  // The whole-file docs sections must NOT be in the prompt — they are notes to us, not to Leo.
  for (const leaked of ['Prompt Variables Reference', 'Version History']) {
    if (body.includes(leaked)) {
      failures.push(`"${leaked}" leaked into the prompt body — it should sit after the closing fence.`);
    }
  }

  // Inverse check: every bracket token must be either substituted or a known literal.
  // Catches a placeholder added to the prompt that nobody wired into buildSystemPrompt.
  const known = new Set([...REQUIRED_PLACEHOLDERS, ...INTENTIONAL_LITERALS]);
  const unwired = [
    ...new Set((body.match(/\[[A-Za-z_][A-Za-z_ :.]*\]/g) || []).filter((t) => !known.has(t))),
  ];
  if (unwired.length) {
    failures.push(
      `Unwired bracket tokens — substitute them in claude.js or add to INTENTIONAL_LITERALS: ${unwired.join(', ')}`
    );
  }

  const pct = Math.round((body.length / template.length) * 100);

  if (failures.length) {
    console.error('✗ Prompt verification FAILED\n');
    failures.forEach((f) => console.error(`  • ${f}`));
    console.error(`\n  Extracted ${body.length} of ${template.length} chars (${pct}%).`);
    process.exit(1);
  }

  console.log('✓ Prompt verification passed');
  console.log(`  ${REQUIRED_SECTIONS.length} sections, ${REQUIRED_PLACEHOLDERS.length} placeholders present.`);
  console.log(`  Extracted ${body.length} of ${template.length} chars (${pct}%).`);
}

main();
