# LeoAI Admin MCP Server

Wraps the LeoAI backend API so you can call admin tools directly from Claude Desktop or Cowork without pasting tokens in chat.

## Setup

```bash
cd mcp
cp .env.example .env
# Edit .env — paste your API key (see below)
yarn install
```

**`mcp/.env`**:
```
API_BASE=https://api.leo-ai.chat
API_KEY=leoai_your_key_here
```

### Getting your API key

1. Open [leo-ai.app](https://leo-ai.app) and log in as a superadmin user.
2. Go to **Admin → API Keys**.
3. Click **Generate MCP Key**, give it a label (e.g. "MCP server — dev laptop"), and copy the key.
4. Paste it into `mcp/.env` as `API_KEY=leoai_...`.

API keys don't expire. Revoke and regenerate from the same page if a key is compromised.

## Connecting in Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "leoai-admin": {
      "command": "node",
      "args": ["/absolute/path/to/leoai/mcp/index.js"],
      "env": {
        "API_BASE": "https://api.leo-ai.chat",
        "API_KEY": "leoai_your_key_here"
      }
    }
  }
}
```

Or omit `env` and keep them in `mcp/.env` — dotenv loads automatically.

The project-root `.mcp.json` configures this server for Claude Code (the CLI) automatically when you run `claude` from the repo root.

## Available tools

| Tool | Description |
|---|---|
| `send_test_message(domain, message, sessionToken?)` | **Most useful.** Send a test chat message and get the reply + full debug output: model, classifierRoute, classifierReason, topScore, hadContext, handoffTriggered. Pass the returned `sessionToken` back in to continue the same conversation (multi-turn testing). |
| `search_chunks(domain, query)` | Run RAG retrieval and return top matching chunks with similarity scores. Debug why Leo does/doesn't have context. |
| `kick_off_scrape(domain)` | Trigger a full scrape (wipes + re-crawls). |
| `kick_off_rescrape(domain)` | Trigger a smart rescrape (hash-diff, only re-embeds changed pages). |
| `list_entities()` | List all entities with plan, last scraped date, and message counts. |
| `get_entity(domain)` | Full entity details + stats (chunks, pages, conversations). |
| `get_quota_usage(domain)` | Current billing period usage vs. limit. |
| `get_recent_logs(level?, source?, domain?)` | Pull from the backend log buffer (50/page). |

## Multi-turn testing with `send_test_message`

Each call without a `sessionToken` starts a **fresh** conversation. To test conversation memory,
returning-visitor behavior, or handoff flows, feed the `sessionToken` from the first response
into the next call:

**Turn 1** — omit `sessionToken`:

```json
{ "domain": "smoke.leo-ai.chat", "message": "What are your opening hours?" }
```

Response (abridged):

```json
{
  "reply": "We're open Tuesday to Saturday, 8am to 4pm! ...",
  "debug": { "model": "claude-haiku-...", "topScore": 0.79, "hadContext": true, "handoffTriggered": false },
  "sessionToken": "mcp-test-1754790000000-ab12cd34"
}
```

**Turn 2** — pass that token back; Leo now has turn 1 as history:

```json
{
  "domain": "smoke.leo-ai.chat",
  "message": "And are you open on the weekend?",
  "sessionToken": "mcp-test-1754790000000-ab12cd34"
}
```

Leo's reply will resolve "you" against the turn-1 context (hours), which a fresh session could not.

`debug.handoffTriggered` is `true` on any turn where Leo fired `[HANDOFF_REQUESTED]` — i.e. the
turn that would alert the owner. Combined with token reuse you can drive a conversation up to a
handoff and assert exactly which turn triggers it.

## Notes

- **Test messages run in test-mode.** `send_test_message` sends its `/chat` request with the `X-API-Key`, which flips the backend into test-mode: the reply is real, but the message does **not** count against quota, fires no owner SMS/email, logs no unanswered question, and marks the conversation `isTest`. Safe to use freely, including on free-tier entities.
- `kick_off_scrape` and `kick_off_rescrape` are **long-running** — the HTTP request won't return until the scrape completes (can be several minutes for large sites). If you need live progress, watch the dashboard KB page instead.
- `API_BASE` defaults to `https://api.leo-ai.chat`. Set it to `http://localhost:3001` for local development.
