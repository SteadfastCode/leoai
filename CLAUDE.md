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
| Repo | GitHub (eckerdj7/SteadfastCode) |

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
- **Vector embeddings over keyword matching** — keyword fails on natural queries ("what do you sell?"). Query expansion via Haiku was tested and rejected: costs more, worse results. Embedding cost: ~$0.07/scrape, negligible at query time.
- **Two-pass scraping (planned, pre-launch):** Pass 1 = axios + cheerio. If content is thin → Pass 2 = Puppeteer (JS rendering). Required for React/Vue/Webflow/Squarespace sites, which are common for small businesses.
- **Smart rescrape:** Hash-based diffing — only re-embeds changed pages. **Exception: PDFs must always be re-fetched** (same URL, changed content is undetectable by hash alone).

---

## Leo System Prompt

Full prompt: `prompts/leo-system-prompt.md`. Current version: **v1.5**

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

**Leo-Guided Onboarding (high priority)** — Signup on steadfastcode.tech happens through Leo. Traditional form + Leo chat path both converge on same stepper (Account → Business Info → Plan → Scrape → Done). Auto-saves to localStorage. Leo fills fields via JS bridge.

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
- ✅ System prompt v1.5 — interactive options signal, repetitive closing lines fixed
- ✅ Vector embeddings (Voyage AI voyage-3-lite) — replaced keyword RAG
- ✅ Atlas Vector Search index configured
- ✅ Smart rescrape with hash-based diffing
- ✅ /chat endpoint — full system prompt, RAG context, conversation history
- ✅ Widget — bubble, drawer, markdown rendering, drag-to-resize, three-dot menu
- ✅ Privacy consent screen (per-domain localStorage)
- ✅ Conversation memory — MongoDB, infinite scroll (20/page)
- ✅ Returning visitor greeting with last topic
- ✅ Handoff / escalation — Twilio SMS + email, fire-and-forget
- ✅ Interactive quick-reply buttons with hotkeys
- ✅ Dashboard — Overview, Conversations, Knowledge Base, Settings (Vue 3 + Vuetify)
- ✅ Auth — JWT (15min access / 7day refresh), bcrypt (cost 12), passkeys (SimpleWebAuthn), RBAC, multi-entity memberships[], silent refresh, session-expired dialog
- ✅ Dashboard UX — sticky header, jump FABs, collapsible sidebar, markdown in Leo bubbles
- ✅ Multi-entity test harness (test.html — Dosie Dough, Burk Digital, Tomato Pie Cafe)
- ⬜ Stripe integration
- ⬜ OneSignal integration
- ⬜ Church & Ministry Mode (prompt engineering + pastoral review)
- ⬜ LeoRefresh scheduler
- ⬜ Passkey registration UI (backend ready)
- ⬜ User invite flow / team management UI
- ⬜ Password reset flow

---

## Known Issues (Fix Before Ship)

None currently open.

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
