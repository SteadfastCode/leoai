# CLAUDE.md — LeoAI by Steadfast Code

> Update this file at natural commit points — when architecture decisions are made, approaches finalized, milestones completed, or the system prompt updated. Standard: would a future Claude session make a worse decision without this? If yes, log it. If derivable from code, skip it.

---

## What Is LeoAI?

AI-powered chatbot widget for small businesses, churches, and ministries. Single `<script>` tag embed. Answers visitor questions 24/7, trained on the business's own site content.

Differentiators: faith-driven values baked in (non-configurable), Church & Ministry Mode with theological depth and sycophancy resistance, warm childlike personality, built for people who can't afford enterprise software.

Built by Daniel, Steadfast Code, Lititz PA. *Colossians 3:23*

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend (marketing) | Vue 3 + Vuetify, mobile-first SPA |
| Frontend (widget) | Vanilla JS — chatbot.js, embeds via script tag |
| Backend | Node.js + Express |
| Database | MongoDB (collections: entities, chunks, conversations, scrapedpages) |
| AI / LLM | Claude API (Anthropic) |
| RAG | Custom — scrape → chunk → embed → Atlas Vector Search |
| Payments | Stripe |
| Push Notifications | OneSignal |
| Hosting | Vercel (frontend), backend TBD |
| Local DB | MongoDB Community Server (localhost:27017) |
| Package Manager | Yarn |
| Repo | GitHub (steadfastcode/leoai) — private |

---

## Architecture

### Chat Flow
1. User types → widget POSTs to `/chat`
2. Backend embeds query → Atlas Vector Search retrieves relevant chunks
3. Build Claude call: system prompt + RAG context + conversation history + message
4. Response sent to widget, conversation saved to MongoDB (keyed to session token + domain)

### RAG Layer
Scrape → chunk (1500 chars) → embed (Voyage AI `voyage-3-lite`) → store in MongoDB → Atlas Vector Search (cosine similarity) at query time.

**Decisions to preserve:**
- **Vector embeddings over keyword matching** — keyword fails on natural queries ("what do you sell?"). Query expansion via Haiku was tested and rejected: costs more, worse results. Embedding cost: ~$0.0015 per scrape at current scale, negligible at query time.
- **Two-pass scraping:** Pass 1 = axios + cheerio. If content < 300 chars → Pass 2 = Puppeteer (JS rendering). Required for React/Vue/Webflow/Square Online/Squarespace sites. Puppeteer waits for `body.innerText > 100 chars` after networkidle2 to handle loading overlays. Only removes `script/style/noscript` (not nav/header/footer — JS frameworks render real content there).
- **Subdomain crawling:** Follows links to subdomains (e.g. `shop.example.com`) as part of the same KB. Subdomain links are prioritized (unshifted) in the queue so they aren't crowded out by main-site pagination.
- **URL normalization:** Uses `hostname + pathname` as the dedup key — strips query params so the same product appearing under multiple category context URLs (Square's `category_id`, `cp`, `si`, etc.) is only fetched once.
- **Parallel fetching:** Pages fetched in batches of 5 concurrently (`CONCURRENCY = 5`). ~5x speedup vs sequential. Harvest Lane Farm Market (534 pages, Square shop subdomain) scrapes in ~7 minutes.
- **Smart rescrape:** Hash-based diffing — only re-embeds changed pages. **Exception: PDFs must always be re-fetched** (same URL, changed content is undetectable by hash alone).
- **MAX_PAGES = 500** — sites with shop subdomains need room. 50 was too small.
- **Paragraph-aware chunking:** CHUNK_TARGET=1200, CHUNK_MAX=1800, CHUNK_OVERLAP=200. Split on `\n+` (handles both cheerio and Puppeteer whitespace). Sentence-boundary overlap. Paragraph-level hash dedup (seenParaHashes shared across batches) strips boilerplate before chunking. Chunk-level dedup as secondary safety net.
- **Two-phase RAG retrieval:** Phase 1 = Atlas Vector Search (primary threshold, default 0.75). Phase 2 = tree siblings — all chunks from pages that produced a primary hit are scored in-memory against the query embedding (dot product; Voyage embeddings are unit-normalized); those passing a lower sibling threshold (default: primary − 0.15, min 0.50) are added to context. Chunks carry `chunkIndex` (position within page) — once semantic chunking lands, Phase 2 will narrow to ±2 neighbors instead of the full page.
- **Per-entity ragThreshold** (superadmin-gated slider, 0.50–0.95, default 0.75).

---

## Leo System Prompt

Full prompt: `prompts/leo-system-prompt.md`. Current version: **v1.9**

**Personality:** Warm, friendly, almost childlike. Honest about being an AI. Wants to be your best friend.

**Runtime variables:** `[BUSINESS_NAME]`, `[AVG_WAIT_TIME]`, `[PREVIOUS_TOPIC]`, `[CHURCH_MODE_ENABLED]`, `[CURRENT_DATETIME]`, plus church parameters (mission, statement of faith, denominational distinctives).

**Faith layer (always on, non-configurable):** Honest, never manipulative. Treats every person with dignity. Won't participate in harmful conversations.

**Refuses by default:** Politics, sexually suggestive content (not configurable), conspiracy theories, competing businesses, out-of-scope topics.

**Sycophancy resistance is a high priority.** Updates position on new information. Never updates position just because a user pushes back. On theological essentials: never updates.

---

## Church & Ministry Mode

**Layer 1 — Hardlines (non-negotiable):** Trinity, Scripture authority, deity/death/resurrection of Christ, salvation by grace, reality of sin. Leo never contradicts these.

**Layer 2 — Denominational Parameters (per entity):** Baptism theology, spiritual gifts, eschatology, church governance, worship theology. Leo represents the church's position with baked-in humility — acknowledges non-essentials as such. Anchored by Augustine: *"In essentials, unity. In non-essentials, liberty. In all things, charity."* Humility on non-essentials never drifts into "all paths are valid."

**Layer 3 — Mission & Identity (per entity):** Mission statement, core values, statement of faith, pastoral tone preferences.

**Gate:** Church Mode is NOT self-service. Daniel enables after review. Entities see "Request Ministry Plan" button.

**Pastoral review required** before Church Mode ships — Layer 1 hardlines + Layer 2 humility framing should be affirmed by one or more pastors.

**General knowledge boundary — critical constraint (v2.1):**
Leo must never draw on general training knowledge — not for cultural references, hymn lyrics, Scripture, pop culture, historical trivia, or anything outside the entity's RAG data. Confirmed in testing (Church Mode off): Leo recognized a Monty Python reference and riffed on it; in a separate message, quoted accurate hymn lyrics for a hymn not in the knowledge base. The "you do not have general internet knowledge" line in earlier prompts was insufficient — Claude's training bleeds through. v2.1 base prompt adds explicit instruction + a redirect script. v2.0 (Church Mode section) also adds a hard constraint against verbatim text reproduction. Church Mode intentionally re-enables general theological/apologetics knowledge — but still prohibits verbatim text quotation unless from RAG.

**Default translation: LSB (Legacy Standard Bible).** Per-entity setting allows churches to set their own default. Visitors can request any available translation mid-conversation and Leo will pull from that translation's embedded text for the remainder of the session.

---

## Pricing

| Tier | Price |
|---|---|
| Free | 100 messages/month |
| Pay-as-you-go | $0.01/message, retroactive milestone discounting |
| Infinity Plan (monthly) | $20/month |
| Infinity Plan (3/6/12/24mo) | $55 / $105 / $200 / $380 |
| Lifetime Deal | $777 (10 slots, 60-day window) |
| LeoRefresh add-on | $10/month |
| Messenger add-on | $5/month |
| Live Chat add-on | ~$30-40/month (TBD) |

Ministry Plan: 50% off. Not a coupon — a distinct plan. See [`docs/pricing-strategy.md`](docs/pricing-strategy.md) for rationale, verification approach, and marketing campaign strategy.

---

## Key Features

**LeoRefresh** — Daily re-scrape. Critical for churches (weekly events) and businesses with changing content.

**Handoff / Escalation** — Leo fires `[HANDOFF_REQUESTED: reason]` → backend strips it, fires Twilio SMS + nodemailer email to owner. Fire-and-forget (never blocks response). Owner replies via dashboard (not SMS inbound). See Known Issues for current bugs.

**Returning Visitors** — Session token in localStorage + cookie fallback. Conversation loaded from MongoDB on open. Leo greets back with last topic. Frictionless recognition is a priority — no account required.

**Interactive Quick-Replies** — Leo appends `[OPTIONS: A | B]`; backend strips and returns `options[]`; widget renders pill buttons with hotkeys (Y/N, 1-4).

**Site Navigation & Deep Linking (post-MVP, high priority)** — Leo guides visitors to the exact page/section with the answer. Requires scraper change: chunks must store a `sectionAnchor` field. Widget tracks viewport via `IntersectionObserver`. Prerequisite for Leo-Guided Onboarding.

**Leo-Guided Onboarding (high priority)** — Signup lives at `leo-ai.app/#/signup` (public route in the dashboard app). Steps: Account → Business Info → Scrape (live progress) → Done. Traditional form is the primary path; Leo companion widget is scaffolded for guided path and will be iterated into a fluid experience. Leo fills fields via JS bridge (`window.dispatchEvent(new CustomEvent('leo-fill', { detail: { field, value } }))`). Auto-saves to localStorage per step.

**Alpha gate (current):** Signup requires an alpha code validated server-side against `ALPHA_CODES` env var (comma-separated). No public signup until alpha ends. Plan/pricing step is scaffolded but skipped — all alpha users start on free tier.

**Crawl-ASAP principle:** Scrape is fired immediately after business info is submitted (step 2), before the user finishes setup. Most small business sites scrape in under 2 minutes — Leo is already learning while the user reads the done screen. This is a marketing differentiator: "Your site is already being learned."

**Owner Reply Flow** — Owner gets SMS/email alert with dashboard link → "Reply to visitor" input in ConversationDetail → stored as message → Leo surfaces it on visitor's next open. One-click "Add to knowledge base" on reply closes the improvement loop.

See [`docs/wishlist.md`](docs/wishlist.md) for post-MVP ideas (tiered model routing, semantic cache, live chat, superadmin impersonation, Leo accounts, etc.).

---

## What Leo Will Never Do

- Pretend to be human
- Fold on Layer 1 theological essentials under pressure
- Spread misinformation or engage conspiracy theories
- Say anything sexually suggestive
- Manipulate or deceive
- Make a user feel stupid or unwelcome

---

## Current State

- ✅ Marketing site live at steadfastcode.tech
- ✅ System prompt v2.1 — interactive options, sycophancy resistance, Church Mode with apologetics knowledge; v2.0 added no-verbatim-text constraint for Church Mode; v2.1 strengthened base knowledge boundary — Leo no longer engages with cultural references (Monty Python, hymns outside KB, etc.) regardless of Church Mode status
- ✅ Vector embeddings (Voyage AI voyage-3-lite) — replaced keyword RAG
- ✅ Atlas Vector Search index configured
- ✅ Smart rescrape with hash-based diffing
- ✅ Two-pass scraping with Puppeteer fallback for JS-rendered pages
- ✅ Subdomain crawling (shop subdomains included in same KB)
- ✅ URL normalization — dedup by hostname+pathname, strips context query params
- ✅ Parallel page fetching (CONCURRENCY=5, ~5x speedup)
- ✅ Live scrape feed in dashboard KB page with per-page progress + duration
- ✅ /chat endpoint — full system prompt, RAG context, conversation history
- ✅ Widget — bubble, drawer, markdown rendering, drag-to-resize, three-dot menu
- ✅ Privacy consent screen (per-domain localStorage)
- ✅ Conversation memory — MongoDB, infinite scroll (20/page)
- ✅ Returning visitor greeting with last topic — Haiku summarizes recent session into a topic list, stored as `lastTopic` on the conversation, fire-and-forget after each chat response
- ✅ Handoff / escalation — Twilio SMS + email, fire-and-forget
- ✅ Interactive quick-reply buttons with hotkeys
- ✅ Dashboard — Overview, Conversations, Knowledge Base, Settings (Vue 3 + Vuetify)
- ✅ Auth — JWT (15min access / 7day refresh), bcrypt (cost 12), passkeys (SimpleWebAuthn), RBAC, multi-entity memberships[], silent refresh, session-expired dialog
- ✅ Dashboard UX — sticky header, jump FABs, collapsible sidebar, markdown in Leo bubbles
- ✅ Widget dark mode — CSS custom properties, follows prefers-color-scheme automatically
- ✅ Multi-entity test harness (test.html — Dosie Dough, Burk Digital, Tomato Pie Cafe, dark mode toggle)
- ✅ Stripe billing integration — checkout session, customer portal, webhooks (checkout.session.completed, subscription updated/deleted, invoice.payment_failed). Entity model has full billing fields. Billing.vue dashboard page with plan/usage card and upgrade cards.
- ✅ Free tier quota enforcement — 100 msg/month cap, 402 response, widget handles gracefully with Leo-voiced message
- ✅ Quota warning notifications — owner alerted at 50/75/90% and on limit hit (configurable thresholds + alert channels: email/SMS). Resets each billing period. Dashboard Settings > Usage Alerts UI.
- ✅ Stripe price IDs + env vars configured in sandbox. Webhook handler fixed (current_period_start/end guarded against undefined).
- ⬜ OneSignal integration
- ✅ Church & Ministry Mode — toggle + full config fields (mission, statement of faith, denominational distinctives, core values, pastoral tone), system prompt v1.9, RAG context church-aware, AI-extract from KB. Superadmin-gated on both frontend (v-if="isSuperAdmin") and backend (superadminOnly field list). Non-superadmin entities see "Request Ministry Plan" card. Pastoral review still needed before enabling for real churches.
- ✅ LeoRefresh scheduler — node-cron, 3 AM UTC daily, sequential per-entity rescrape
- ✅ Passkey registration UI — Settings > Security card; name field, register/delete; discoverable login (no email)
- ✅ User invite / team management — Team.vue (members list, pending invites, invite form), AcceptInvite.vue (new + existing user paths), full backend (Invite model, team endpoints, invite accept/validate routes)
- ✅ Password reset flow — forgot-password email link, reset-password token validation, ResetPassword.vue
- ✅ Leo-Guided Onboarding v1 — /signup public route; 4-step stepper (Account → Business Info → Scrape → Done); alpha code gate (ALPHA_CODES env var); auto-login after account creation; scrape fires immediately on step 2 submit; live scrape progress via socket on step 3; JS bridge scaffolded (leo-fill CustomEvent); draft auto-saved to localStorage
- ✅ RAG quality — paragraph-aware chunking, paragraph-level hash dedup (seenParaHashes), chunk viewer in KB accordion, force rescrape (SA-gated), per-entity ragThreshold slider, model routing analytics, owner reply chunks injected as separate labeled block
- ✅ Two-phase RAG retrieval (tree siblings) — Phase 1 vector search + Phase 2 in-memory sibling scoring for all chunks sharing a primary hit's page URL; lower sibling threshold (primary − 0.15); chunkIndex stored on each chunk for future ±N neighbor narrowing once semantic chunking lands

---

## Known Issues (Fix Before Ship)

None currently logged.

---

## MVP Roadmap

1. RAG backend ✅
2. Widget shell ✅
3. Widget ↔ backend connected ✅
4. Leo system prompt wired in ✅
5. Demo-ready on real business ✅

Everything else (payments, Church Mode, LeoRefresh) follows the working demo.

---

## North Star

Leo exists to serve people well — with honesty, dignity, and grace. If it helps a small business stay afloat, that's a win. If it helps a church connect with someone quietly seeking, and plays even a small part in their journey toward Christ — that's the dream.

*Colossians 3:23 — "Whatever you do, work at it with all your heart, as working for the Lord, not for human masters."*
