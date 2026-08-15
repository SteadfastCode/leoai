import 'dotenv/config';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.API_BASE || 'https://api.leo-ai.chat';
const API_KEY  = process.env.API_KEY;

if (!API_KEY) {
  process.stderr.write('ERROR: API_KEY env var is required — generate one from the dashboard Admin → API Keys page\n');
  process.exit(1);
}

// Authenticated request (dashboard / admin / scrape routes)
async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'X-API-Key': API_KEY,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// Public request (chat endpoints — no auth required)
async function apiPublic(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

// Fetch entity name to use as scrape "name" param (required by POST /scrape)
async function getEntityName(domain) {
  const entities = await api('GET', '/api/dashboard/entities');
  const entity = entities.find(e => e.domain === domain);
  return entity?.name || domain;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'kick_off_scrape',
    description: 'Trigger a full site scrape for an entity (wipes and re-crawls everything). Returns a summary with page count and duration.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain, e.g. "example.com"' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'kick_off_rescrape',
    description: 'Trigger a smart rescrape for an entity (hash-diff — only re-embeds changed pages). Faster and cheaper than a full scrape.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain, e.g. "example.com"' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'send_test_message',
    description: 'Send a test chat message to an entity\'s Leo and return full debug output: reply, model used, classifier route/reason, top RAG score, context hit, handoff state, and message count. This is the primary RAG quality and routing QA tool. Pass the sessionToken from a previous call to continue the same conversation (multi-turn testing).',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain, e.g. "example.com"' },
        message: { type: 'string', description: 'The test message to send' },
        sessionToken: { type: 'string', description: 'Optional. Reuse the sessionToken returned by a previous call to send this message into the same conversation — Leo sees the earlier turns as history. Omit to start a fresh conversation.' },
      },
      required: ['domain', 'message'],
    },
  },
  {
    name: 'search_chunks',
    description: 'Run semantic RAG retrieval against an entity\'s knowledge base and return the top matching chunks with similarity scores. Useful for debugging why Leo does or doesn\'t have context for a query.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain, e.g. "example.com"' },
        query: { type: 'string', description: 'The search query to embed and match against' },
        threshold: { type: 'number', description: 'Minimum similarity score (0.0–1.0). Default: 0.5' },
        limit: { type: 'number', description: 'Max chunks to return (1–50). Default: 20' },
      },
      required: ['domain', 'query'],
    },
  },
  {
    name: 'list_entities',
    description: 'List all entities (businesses / churches) in LeoAI with their plan, last scraped date, and message counts.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_entity',
    description: 'Get full details for a single entity: settings, stats (chunk count, page count, conversation count, total messages), and billing info.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain, e.g. "example.com"' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_quota_usage',
    description: 'Get current billing period message usage vs. limit for an entity.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Entity domain, e.g. "example.com"' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'get_recent_logs',
    description: 'Fetch recent backend logs from the circular log buffer. Optionally filter by level.',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['error', 'warn', 'info', 'debug'],
          description: 'Filter by log level. Omit to return all levels.',
        },
        source: { type: 'string', description: 'Filter by source label, e.g. "scrape", "chat"' },
        domain: { type: 'string', description: 'Filter by entity domain' },
        page: { type: 'number', description: 'Page number (50 logs per page). Default: 1' },
      },
      required: [],
    },
  },
];

// ── Tool handlers ────────────────────────────────────────────────────────────

async function handleKickOffScrape(args) {
  const { domain } = args;
  const name = await getEntityName(domain);
  const result = await api('POST', '/scrape', {
    domain,
    url: `https://${domain}`,
    name,
    rescrape: false,
  });
  return result;
}

async function handleKickOffRescrape(args) {
  const { domain } = args;
  const name = await getEntityName(domain);
  const result = await api('POST', '/scrape', {
    domain,
    url: `https://${domain}`,
    name,
    rescrape: true,
  });
  return result;
}

async function handleSendTestMessage(args) {
  const { domain, message } = args;
  const sessionToken = args.sessionToken || `mcp-test-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Send the chat message THROUGH api() so the X-API-Key header goes with it. /chat is a public
  // endpoint, but a valid key flips the backend into test-mode (LEO-025): the reply is still
  // real (RAG, classifier, Claude call, conversation save all run), but quota counters,
  // handoff SMS/email, unanswered logging, and the domain socket broadcast are all skipped, and
  // the conversation is marked isTest. Without the key this tool silently ran as real traffic.
  const chatResponse = await api('POST', '/chat', { domain, sessionToken, message });

  // Fetch history to get per-message debug fields stored in MongoDB
  const history = await apiPublic('GET', `/chat/history?domain=${encodeURIComponent(domain)}&sessionToken=${encodeURIComponent(sessionToken)}`);
  const messages = history.messages || [];
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');

  return {
    reply: chatResponse.reply,
    options: chatResponse.options || null,
    usage: chatResponse.usage,
    debug: {
      model: lastAssistant?.model ?? null,
      classifierRoute: lastAssistant?.classifierRoute ?? null,
      classifierReason: lastAssistant?.classifierReason ?? null,
      topScore: lastAssistant?.topScore ?? null,
      hadContext: lastAssistant?.hadContext ?? null,
      handoffTriggered: chatResponse.handoffTriggered ?? null,
    },
    sessionToken,
    isTest: chatResponse.isTest ?? true,
    note: 'Test-mode: does NOT count against quota and fires no owner notifications (valid API key sent). Pass sessionToken back in to continue this conversation.',
  };
}

async function handleSearchChunks(args) {
  const { domain, query, threshold, limit } = args;
  const params = new URLSearchParams({ domain, query });
  if (threshold !== undefined) params.set('threshold', String(threshold));
  if (limit !== undefined) params.set('limit', String(limit));
  return api('GET', `/api/admin/search?${params}`);
}

async function handleListEntities() {
  const entities = await api('GET', '/api/dashboard/entities');
  return entities.map(e => ({
    domain: e.domain,
    name: e.name,
    plan: e.plan,
    lastScrapedAt: e.lastScrapedAt,
    messageCount: e.messageCount,
    messageCountThisPeriod: e.messageCountThisPeriod,
    churchModeEnabled: e.churchModeEnabled,
    leoRefreshEnabled: e.leoRefreshEnabled,
  }));
}

async function handleGetEntity(args) {
  const { domain } = args;
  return api('GET', `/api/dashboard/entities/${encodeURIComponent(domain)}/stats`);
}

async function handleGetQuotaUsage(args) {
  const { domain } = args;
  const data = await api('GET', `/api/dashboard/entities/${encodeURIComponent(domain)}/stats`);
  const entity = data.entity;
  const FREE_LIMIT = 100;
  return {
    domain,
    plan: entity.plan,
    messageCountThisPeriod: entity.messageCountThisPeriod ?? 0,
    limitThisPeriod: entity.plan === 'free' ? FREE_LIMIT : null,
    billingPeriodResetAt: entity.billingPeriodResetAt ?? null,
    quotaExceededNotified: entity.quotaExceededNotified ?? false,
    percentUsed: entity.plan === 'free'
      ? Math.round(((entity.messageCountThisPeriod ?? 0) / FREE_LIMIT) * 100)
      : null,
  };
}

async function handleGetRecentLogs(args) {
  const { level, source, domain, page = 1 } = args;
  const params = new URLSearchParams({ page: String(page) });
  if (level) params.set('level', level);
  if (source) params.set('source', source);
  if (domain) params.set('domain', domain);
  return api('GET', `/api/admin/logs?${params}`);
}

// ── MCP server wiring ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'leoai-admin', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case 'kick_off_scrape':    result = await handleKickOffScrape(args);    break;
      case 'kick_off_rescrape':  result = await handleKickOffRescrape(args);  break;
      case 'send_test_message':  result = await handleSendTestMessage(args);  break;
      case 'search_chunks':      result = await handleSearchChunks(args);     break;
      case 'list_entities':      result = await handleListEntities();         break;
      case 'get_entity':         result = await handleGetEntity(args);        break;
      case 'get_quota_usage':    result = await handleGetQuotaUsage(args);    break;
      case 'get_recent_logs':    result = await handleGetRecentLogs(args);    break;
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
