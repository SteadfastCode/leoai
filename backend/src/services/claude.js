const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROMPT_PATH = path.join(__dirname, '../../../prompts/leo-system-prompt.md');

// Read fresh from disk on every call — prompt edits take effect immediately, no restart needed
function getRawPrompt() {
  const template = fs.readFileSync(PROMPT_PATH, 'utf8');
  const match = template.match(/```\n([\s\S]*?)\n```/);
  return match ? match[1] : template;
}

function buildSystemPrompt(entity, conversation) {
  const now = new Date().toLocaleString('en-US', {
    timeZone: entity.timezone || 'America/New_York',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const lastChatAt = conversation?.lastActiveAt
    ? new Date(conversation.lastActiveAt).toLocaleString('en-US', {
        timeZone: entity.timezone || 'America/New_York',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : null;

  const handoffModeInstruction = entity.offerHandoffBeforeContact === false
    ? 'When you cannot answer a question, share whatever contact information you have from your knowledge base (phone, email, contact form) directly. Still append [HANDOFF_REQUESTED] whenever you direct someone to contact the business.'
    : 'When you cannot answer a question, always offer to forward the question to the team first (two-step flow below). Only share contact info if the visitor declines.';

  let prompt = getRawPrompt()
    .replace(/\[BUSINESS_NAME\]/g, entity.name)
    .replace(/\[AVG_WAIT_TIME\]/g, entity.avgWaitTime || '24 hours')
    .replace(/\[CHURCH_MODE_ENABLED\]/g, entity.churchModeEnabled ? 'true' : 'false')
    .replace(/\[PREVIOUS_TOPIC\]/g, conversation?.lastTopic || '')
    .replace(/\[HANDOFF_MODE_INSTRUCTION\]/g, handoffModeInstruction);

  if (entity.churchModeEnabled && entity.churchConfig) {
    const c = entity.churchConfig;
    prompt = prompt
      .replace(/\[DENOMINATIONAL_DISTINCTIVES\]/g, c.denominationalDistinctives || '')
      .replace(/\[CHURCH_MISSION\]/g, c.missionStatement || '')
      .replace(/\[CHURCH_VALUES\]/g, '')
      .replace(/\[STATEMENT_OF_FAITH\]/g, c.statementOfFaith || '')
      .replace(/\[PASTORAL_TONE\]/g, c.pastoralToneNotes || 'warm and conversational');
  }

  // Inject temporal context so Leo knows current time and when user last visited
  prompt += `\n\n---\n\n## CURRENT CONTEXT\n\nCurrent date and time (${entity.timezone || 'America/New_York'}): ${now}`;
  if (lastChatAt) {
    prompt += `\nThis visitor last chatted with you on: ${lastChatAt}`;
  }

  // Inject handoff state so Leo knows whether there's an active open handoff
  if (conversation?.handoffPending) {
    const count = conversation.pendingQuestions?.length || 1;
    prompt += `\nHandoff status: ACTIVE — ${count} question${count !== 1 ? 's' : ''} already forwarded to the team and awaiting reply. Do NOT start a new handoff cycle. If the visitor raises another unanswerable question, let them know it will be added to the existing list already sent to the team.`;
  } else {
    prompt += `\nHandoff status: NONE — no open handoff. If you cannot answer a question, treat it as a fresh start and follow the normal handoff flow.`;
  }

  return prompt;
}

async function chat({ entity, conversation, ragContext, sources, userMessage }) {
  const systemPrompt = buildSystemPrompt(entity, conversation);

  const messages = [];

  const sourceNote = sources?.length
    ? `\n\nSource pages this content came from:\n${sources.map((s) => `- ${s}`).join('\n')}`
    : '';

  const contextContent = ragContext
    ? `Here is the ONLY information you are allowed to use when answering the next question. It comes directly from ${entity.name}'s website.\n\nCRITICAL RULES:\n- Only state facts that are explicitly present in this content.\n- Do NOT infer, extrapolate, or fill gaps with what seems reasonable.\n- Do NOT use the entity's name or any outside knowledge to guess at products, services, or details not mentioned here.\n- If the answer is not clearly present in this content, say so honestly and offer to connect the visitor with someone who can help.\n\n${ragContext}${sourceNote}`
    : `No relevant content was found in ${entity.name}'s website data for this query. Do NOT infer, guess, or assume anything — not from the business name, not from general knowledge, not from what seems reasonable. Ask a clarifying question or let the visitor know you don't have that information and offer to connect them with someone who does.`;

  messages.push({ role: 'user', content: contextContent });
  messages.push({
    role: 'assistant',
    content: ragContext
      ? 'Understood. I will only state facts explicitly present in that content and will not fill any gaps with inference or assumption.'
      : 'Understood — I have no relevant website content for this query. I will not guess or infer. I will ask a clarifying question or offer a handoff.',
  });

  // Append conversation history — map owner_reply to assistant so Claude API accepts it
  if (conversation?.messages?.length) {
    for (const msg of conversation.messages.slice(-10)) {
      if (msg.role === 'owner_reply') {
        messages.push({ role: 'assistant', content: `[A team member replied]: ${msg.content}` });
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  messages.push({ role: 'user', content: userMessage });

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  return response.content[0].text;
}

// Fire-and-forget topic summarization using Haiku — called after each chat response.
// Returns a comma-separated list of specific topics discussed (used in returning visitor greeting).
async function summarizeTopic(messages) {
  const transcript = messages
    .slice(-10)
    .map((m) => {
      const role = m.role === 'owner_reply' ? 'team' : m.role;
      const content = typeof m.content === 'string' ? m.content : m.interactiveData?.selected || '';
      return `${role}: ${content}`;
    })
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 60,
    messages: [
      {
        role: 'user',
        content: `List the specific topics discussed in this conversation as a short comma-separated list (2-5 items, 2-4 words each).

Be specific — name the actual subjects (e.g. "gluten-free bagel options, Sunday brunch hours, parking near the shop").
Never use generic terms like "store information", "customer questions", or "general inquiries".
Lowercase only. No punctuation except commas.

Conversation:
${transcript}`,
      },
    ],
  });

  return response.content[0].text.trim().toLowerCase().replace(/[^a-z0-9 ,]/g, '');
}

module.exports = { chat, summarizeTopic };
