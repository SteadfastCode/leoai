# LeoAI Admin MCP Server

Wraps the LeoAI backend API so you can call admin tools directly from Claude desktop / Cowork without pasting tokens in chat.

## Setup

```bash
cd mcp
cp .env.example .env
# Edit .env — fill in BEARER_TOKEN (see below)
yarn install
```

### Getting your BEARER_TOKEN

1. Open [leo-ai.app](https://leo-ai.app) and log in as a superadmin user.
2. Open DevTools → Application → Local Storage → `https://leo-ai.app`.
3. Copy the value of `access_token`.
4. Paste it into `mcp/.env` as `BEARER_TOKEN=...`.

JWT access tokens expire after 15 minutes. When a tool returns a 401, refresh the token by reloading the dashboard (silent refresh fires automatically) and copying the updated `access_token`.

## Connecting in Claude desktop

Add this to your Claude desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "leoai-admin": {
      "command": "node",
      "args": ["/absolute/path/to/leoai/mcp/index.js"],
      "env": {
        "API_BASE": "https://api.leo-ai.chat",
        "BEARER_TOKEN": "your_token_here"
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
| `send_test_message(domain, message)` | **Most useful.** Send a test chat message and get the reply + full debug output: model, classifierRoute, classifierReason, topScore, hadContext. |
| `search_chunks(domain, query)` | Run RAG retrieval and return top matching chunks with similarity scores. Debug why Leo does/doesn't have context. |
| `kick_off_scrape(domain)` | Trigger a full scrape (wipes + re-crawls). |
| `kick_off_rescrape(domain)` | Trigger a smart rescrape (hash-diff, only re-embeds changed pages). |
| `list_entities()` | List all entities with plan, last scraped date, and message counts. |
| `get_entity(domain)` | Full entity details + stats (chunks, pages, conversations). |
| `get_quota_usage(domain)` | Current billing period usage vs. limit. |
| `get_recent_logs(level?, source?, domain?)` | Pull from the backend log buffer (50/page). |

## Notes

- **Test messages count against quota.** `send_test_message` sends a real `/chat` request. Use sparingly on free-tier entities.
- `kick_off_scrape` and `kick_off_rescrape` are **long-running** — the HTTP request won't return until the scrape completes (can be several minutes for large sites). If you need live progress, watch the dashboard KB page instead.
- `API_BASE` defaults to `https://api.leo-ai.chat`. Set it to `http://localhost:3001` for local development.
