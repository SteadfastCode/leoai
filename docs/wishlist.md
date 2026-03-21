# LeoAI — Ideas & Wishlist

Post-MVP concepts. Nothing here is a commitment. Add freely.

---

## Church Mode: Scripture via Bible API (RAG replacement)

**Priority: High for Church Mode launch**

Leo is currently hard-blocked from quoting Scripture verbatim from memory (system prompt v2.1 — hard rule). LLMs misquote with confidence; a wrong word in a Bible verse is unacceptable in a faith context. The correct solution is to retrieve Scripture from an authoritative source at query time.

**Approach:**
- Integrate a Bible API (api.bible is the most comprehensive — covers 2,000+ translations including LSB, ESV, NIV, KJV, NASB, CSB) — free tier available
- When Leo detects a Scripture reference in the conversation, query the API for the exact text in the entity's preferred translation
- Return the authoritative text as additional context in the Claude call, alongside RAG chunks
- Leo quotes from that context, not from memory

**Caching:** Bible text does not change. Fetched verses can be stored permanently in MongoDB (keyed by reference + translation) — no need to re-fetch. This is fundamentally different from the scrape pipeline which needs LeoRefresh because website content changes. Embed once, cache forever.

**Per-entity translation setting:** Already modeled in the entity schema. Default: LSB. Visitor can request any available translation mid-conversation.

**System prompt integration:** Add a `[SCRIPTURE_CONTEXT]` variable injected alongside RAG context when a verse is retrieved. Leo quotes from it and cites the translation.

**Until this ships:** Leo may not quote Scripture verbatim from memory, and may not paraphrase or summarize a specific passage without a direct reference to cite alongside it. Broad theological discussion (not tied to a specific passage) is still permitted. This is enforced in the system prompt.

---

## Church Mode: Hymnary.org API Integration

**Priority: Post-launch Church Mode enhancement**

Leo may currently quote hymn lyrics from memory with a precision caveat. This is acceptable for launch, but the right long-term answer is authoritative hymn text from hymnary.org.

**hymnary.org API:**
- REST API, comprehensive public domain hymn database
- Covers traditional/classical hymns well (pre-1928 public domain)
- Returns lyrics, author, tune name, publication date, meter
- Limitation: modern copyrighted worship songs (Getty, Sovereign Grace, Hillsong) are not available — those would still require memory + caveat, or licensing

**Approach:** Same pattern as Bible API — detect hymn requests, query API, inject text as context, Leo quotes from context and cites hymnary.org.

**Until this ships:** Leo quotes from memory with a caveat to verify against printed text or hymnary.org.

---

## Semantic Chunking — Embedding-Based Boundary Detection

**Priority: Medium — pairs with tree retrieval for full benefit**

Replace size+paragraph-based chunk boundaries with semantically aware ones. Before flushing a chunk, embed the candidate unit and the next paragraph, compute cosine similarity. If similarity is high (same concept), keep accumulating. If it drops, flush — a concept boundary was crossed.

**Why it matters:** Current chunking splits on structural signals (block element boundaries, size cap). This is good but not semantic — a list of schedule items and the event description that precedes them may get split into separate chunks that both lack context when retrieved alone. Semantic chunking keeps concept-coherent content together.

**Implementation (no LLM calls):**
- During `embedPageData`, embed each paragraph individually (batched with Voyage — marginal cost increase)
- Measure cosine similarity between adjacent paragraphs before deciding to flush
- Flush when similarity drops below a threshold (e.g., 0.65) OR size cap is hit
- Adds ~1 embedding per paragraph during scrape (~$0.0002/page at current volume)

**Synergy with tree retrieval:** Once chunks are concept-coherent, the sibling threshold in tree retrieval becomes meaningful rather than approximate. The `chunkIndex` field is already being stored — the retrieval TODO comment in `rag.js` (narrow to `chunkIndex ±2`) activates when this lands. Without semantic chunking, "adjacent chunk" could mean anything; with it, it means "adjacent concept on the same page."

**Tradeoff:** Variable chunk sizes. Some concept-coherent sections may be long (a full event schedule). The size cap still prevents runaway chunks, and larger coherent chunks generally retrieve better than small decontextualized fragments.

---

## Semantic Chunk Clustering (RAG Quality Experiment)

**Priority: Post-launch, data-dependent**

The idea: after standard chunking, run a second pass to group semantically similar fragments across pages into unified chunks — e.g., "hours" mentioned in three different page contexts consolidated into one dense chunk.

**Potential upside:** Reduces fragmentation for facts that appear scattered across many pages in short snippets, each individually below the retrieval threshold.

**Known tradeoffs (worth testing against before building):**
- A merged chunk embeds to the centroid of its topics — potentially a weaker retrieval signal than a focused single-topic chunk
- Loses provenance: "closes at 5pm" (storefront) and "available 24/7" (online shop) merged = contradictory blob
- The paragraph-aware chunking + sentence overlap we shipped in v2 largely closes the gap this was meant to address

**Suggested approach when we have data:** Compare context hit rate and avg topScore (already logged per-message) before and after on a test entity. Only pursue if the numbers show meaningful improvement. Would require Voyage embeddings per paragraph + clustering (e.g. k-means or HDBSCAN) + optional Haiku pass to rewrite merged content coherently. Probably $0.05–0.20 per full site rescrape at current scale.

---

## Google Drive Folder Integration

Allow entities to connect a specific Google Drive folder as a live knowledge source. Leo automatically ingests all files in that folder and can re-sync when content changes.

**User flow:**
1. Entity owner creates a dedicated folder in Google Drive (e.g., "Leo Knowledge Base") and drops files into it — docs, PDFs, spreadsheets, whatever.
2. In the dashboard Knowledge Base tab, they click "Connect Google Drive Folder."
3. Google OAuth picker opens with `drive.file` scope (not full drive access — user explicitly selects the folder, which grants access only to that folder and its contents).
4. User picks the folder → LeoAI stores the folder ID and OAuth refresh token on the entity.
5. Backend lists all files in the folder, downloads each, runs them through the existing parse pipeline (pdf-parse, mammoth, xlsx — already in place), and ingests chunks as `source: 'gdrive'`.

**Ongoing sync:**
- Manual "Re-sync" button in dashboard pulls latest files.
- If LeoRefresh is enabled, include a daily Drive sync alongside the rescrape.
- Files deleted from the folder are removed from the KB on next sync.
- Files that haven't changed (compare `modifiedTime` from Drive API metadata) are skipped — no re-embedding needed.

**Scope rationale:**
`https://www.googleapis.com/auth/drive.file` — only accesses files/folders the user explicitly selects via the picker. Much less scary than full drive access. No access to anything outside the chosen folder.

**Implementation notes:**
- Google Drive API v3 + `googleapis` npm package
- OAuth2 client credentials needed (Google Cloud Console project)
- Store refresh token per entity (encrypted at rest)
- Drive Picker API for the folder selection UI (requires a browser-side API key)
- Files endpoint: `drive.files.list` with `q: '${folderId}' in parents`
- Download: `drive.files.get` with `alt: media`
- Supported file types: Google Docs → export as DOCX, Google Sheets → export as XLSX, Google Slides → export as PDF. Native DOCX/PDF/XLSX already handled by existing parsers.
- Show connected folder name + file count in KB tab. "Disconnect" option to revoke token.

**Why this is valuable:**
Many small business owners already maintain Google Docs for menus, FAQs, policies. This turns that existing workflow into a seamless knowledge source — no copy-paste required. Church admin teams often share Docs for bulletins, sermons, event schedules. Huge quality-of-life win for the exact audience LeoAI targets.

---

## Cloud Storage Integrations — Roadmap (Beyond Google Drive)

Google Drive ships first. Others follow in rough priority order based on user base size.

**Dropbox**
Large user base, simple API, excellent OAuth2 + folder-scoped access. Folder sharing model maps cleanly to the same pattern as Drive. Likely the second integration after Drive.

**OneDrive / SharePoint**
Microsoft Graph API. High value for businesses already in the Microsoft ecosystem (common for churches, small offices). SharePoint adds complexity but opens the door to org-wide document libraries.

**Box**
Less consumer, more SMB/enterprise. Worth adding if enterprise-tier customers become a target segment.

**Proton Drive**
Niche but notable — end-to-end encrypted, which means files must be decrypted client-side or via Proton's SDK before LeoAI can read them. More complex than the others. Worth supporting eventually given the privacy-conscious audience overlap with LeoAI's values (faith communities, small businesses that care about data ownership).

**Implementation pattern (shared across all):**
All integrations follow the same shape as Drive: OAuth2 → folder picker → store folder ID + refresh token → list files → download → existing parse pipeline → embed. The parse pipeline already handles PDF, DOCX, XLSX, CSV, TXT, MD. New integrations are mostly OAuth + file-listing glue, not parser work.

**Dashboard UI:**
KB tab gets an "Integrations" section alongside manual uploads. Each connected source shows: provider icon, folder name, file count, last synced. Connect/disconnect per source. LeoRefresh syncs all connected sources nightly alongside the rescrape.

---

## Bible Translation RAG — Authoritative Scripture for Church Mode

Direct Bible quotations must never be generated from Claude's memory. LLMs misquote, misattribute, and occasionally fabricate verses with high confidence. For a product serving churches and seekers, this is a non-negotiable reliability constraint. The fix is architectural: embed authoritative Bible translation text as a RAG source, so Leo *retrieves* exact verses rather than *recalling* them.

Claude still owns theology, reasoning, apologetics, church history, and conceptual questions. Scripture retrieval is the one case where Claude's knowledge is explicitly bypassed in favor of a trusted text corpus.

**Default translation: LSB (Legacy Standard Bible)**
Daniel's preferred translation and Leo's system default. Literal, scholarly, in the tradition of NASB. Per-entity setting lets churches override with their own preferred translation. Visitors can request any available translation mid-conversation — Leo switches to that translation's text for direct quotes for the rest of the session.

**Target translation list (priority order):**

| Abbrev | Name | Notes |
|---|---|---|
| LSB | Legacy Standard Bible | Default. Very literal. 2021. The Master's Seminary. |
| KJV | King James Version | Public domain. Widely memorized. Many traditional churches require it. |
| ESV | English Standard Version | Dominant evangelical translation. Crossway API available. |
| NIV | New International Version | Most widely sold. Biblica API available. |
| NASB | New American Standard Bible | Highly literal. LSB's predecessor. Same Lockman Foundation. |
| NLT | New Living Translation | Thought-for-thought. Accessible. Common in contemporary churches. |
| CSB | Christian Standard Bible | Lifeway/SBC. Optimal equivalence. Growing use. |
| NKJV | New King James Version | Bridges traditional and modern. Thomas Nelson. |
| AMP | Amplified Bible | Expands meaning inline. Useful for study questions. |
| MSG | The Message | Paraphrase, not translation. Peterson. Some churches use it contextually. |
| NET | New English Translation | Extensive translator notes. Has a free API. |
| WEB | World English Bible | Public domain modern English. Good fallback. |
| NRSV | New Revised Standard Version | Mainline Protestant standard. Academic use. |
| CEB | Common English Bible | Plain language. Some mainline/progressive churches. |
| GNT | Good News Translation | Simple vocabulary. Good for new readers and ESL. |
| YLT | Young's Literal Translation | Public domain. Extremely literal. Study use. |
| ASV | American Standard Version | Public domain. NASB's predecessor. |
| RSV | Revised Standard Version | Classic mid-century scholarly translation. |
| HCSB | Holman Christian Standard Bible | CSB's predecessor. Some churches still use it. |
| TLB | The Living Bible | Taylor paraphrase. Older but some churches grew up on it. |

**Sourcing strategy:**

Do not embed raw text manually. Use **API.Bible** (American Bible Society — `scripture.api.bible`) as the primary source. It provides:
- 2,000+ translations/versions
- REST API with verse, passage, and chapter endpoints
- Usage-based pricing (generous free tier for low volume)
- Covers most translations above, including LSB

At query time: when Leo needs a direct quote, call API.Bible with the identified reference and translation, return the canonical text. Cache aggressively (verse text doesn't change) — store in MongoDB as `{ reference, translation, text, fetchedAt }`. First request hits the API, every subsequent request hits the cache. Cost and latency drop to near-zero after warmup.

For translations not available on API.Bible (check LSB specifically — it's newer), fall back to Crossway's ESV API or direct licensing from the publisher. Public domain translations (KJV, WEB, ASV, YLT) can be embedded directly from Project Gutenberg or similar sources.

**Conversation flow:**

- Leo identifies that a response needs a Scripture quote
- Extracts the reference (book, chapter, verse)
- Checks translation preference: visitor override > entity default > system default (LSB)
- Retrieves exact text from cache or API
- Returns quote with reference and translation label: *"John 3:16 (LSB): 'For God so loved the world...'"*
- If reference is ambiguous or verse doesn't exist, Leo says so honestly rather than guessing

**What Claude still handles:**
- Theological reasoning and explanation
- Apologetics and historical evidence
- Contextual interpretation of passages
- Questions about what a passage *means*
- Church history and denominational distinctives
- Any question that doesn't require producing an exact quote

**What Leo says when asked for a quote he can't verify:**
"I want to make sure I get that exactly right — let me pull it directly. [retrieves]. If you want to read the full context, I can point you to BibleGateway." Never paraphrases and presents it as a quote. Never generates a verse reference from memory without retrieval.

---

## Admin Console Log Viewer

Live backend log stream visible in the admin dashboard without needing to SSH into the host.

**Implementation:**
- Replace raw `console.log/warn/error` calls with a thin wrapper that writes to both stdout (existing behavior) and an in-memory circular buffer (last ~500 lines)
- On new log entries, emit via Socket.io to clients in the `superadmin` room (already exists)
- New admin tab "Logs" — connects to the socket, streams new entries live, loads recent history on mount via a `GET /api/admin/logs` endpoint
- Log entries include: timestamp, level (info/warn/error), message
- Color-coded by level, monospace font, auto-scroll with a "pause scroll" toggle
- Filter by level (all / errors only / warnings+errors)

**Why not a third-party logging service:** For a solo founder at this stage, the overhead of setting up Datadog/Logtail/etc. isn't worth it. This is a lightweight in-process solution that costs nothing and is always available from the dashboard.

**When this matters:** Once the backend is hosted, `console.log` output is locked behind the host's log viewer (Render dashboard, Railway, etc.). Having it in the admin panel means you can debug a live issue from your phone without opening a laptop.

---

## LeoScan — Sensitive Content Detection

Before any chunk gets embedded into the knowledge base — whether from a website scrape, manual text entry, file upload, or cloud storage sync — scan it for sensitive information that a visitor (or bad actor) could extract by asking Leo directly.

**The problem:** A business might accidentally expose passwords, API keys, SSNs, or internal credentials via a document they upload or a page Leo scraped. Leo would then happily answer "what's the WiFi password?" or "what's the admin login?" if that data is in his context.

**What to detect:**

*Pattern-based (regex, high confidence):*
- Passwords in plain text (e.g., "Password: hunter2", "pwd=abc123")
- API keys and tokens (common formats: `sk-...`, `ghp_...`, `AKIA...`, bearer tokens, JWT strings)
- Private keys / certificates (PEM blocks)
- Social Security Numbers (XXX-XX-XXXX)
- Credit card numbers (Luhn-valid 13-16 digit sequences)
- Bank account / routing numbers
- AWS / GCP / Azure credential patterns

*Semantic (Haiku call, catches what regex misses):*
- "The admin password is..." buried in a paragraph
- Credentials embedded in meeting notes or internal docs
- Personal health information (PHI)
- Internal-only pricing, margins, employee compensation

**Response when something is flagged:**

Block + warn. The entire source (file, entry, or chunk batch) is not embedded. Dashboard shows a clear alert in the KB tab: "LeoScan flagged potential sensitive content in [filename / URL / entry title]" with enough context to know what triggered it. Owner fixes the source, re-uploads or re-syncs, and moves on.

This is the right UX for the audience. A business owner or church admin who finds out Leo caught their bank PIN or staff password in a document isn't going to be frustrated — they're going to be grateful. Finding it is the feature. The alternative (silently redacting and ingesting) would be worse: it hides the problem from the owner, who never knows the sensitive data was there in the first place.

**Scope:** Runs on every ingest path:
- File uploads (manual)
- Cloud storage syncs (Drive, Dropbox, etc.)
- Website scrapes (per chunk, not per page — a page might be mostly clean)
- Manual text entries

**Implementation notes:**
- Pattern-based scan runs first (cheap, synchronous, catches the obvious stuff)
- If patterns pass, optionally run a Haiku semantic check (adds ~$0.0005/chunk, worth it for uploads and Drive syncs; possibly skip for high-volume scrapes unless entity opts in)
- Flagged chunks stored separately (e.g., `flaggedChunks` collection or a `flagged: true` field on Chunk) pending owner review
- Dashboard KB tab gets a "LeoScan Alerts" section — only visible when there are flags
- Audit log: who dismissed a flag, when, from which source

**Why this matters:**
The people LeoAI serves are not technical. A church admin might upload the wrong version of a document. A small business owner might not realize a scraped page has an internal staff note with credentials. LeoScan is the safety net that makes LeoAI trustworthy as a knowledge host, not just a knowledge retriever.

---

## Handoff Filtering — What Gets Forwarded to the Team

Leo should be discerning about what questions actually get forwarded. Several related capabilities:

**Leo-side discretion:** Leo already uses judgment, but explicit guidance would help. Some things should never be forwarded (spam, abuse, nonsensical inputs). Others are ambiguous.

**Tolerance slider (per entity):** How lenient Leo is about forwarding borderline questions. Low tolerance = only clearly unanswerable questions go to the team. High tolerance = forward anything uncertain. Default somewhere in the middle.

**Do-not-relay list (per entity):** Business owner maintains a list of question types Leo won't forward. E.g., "competitor comparisons," "salary questions," "political topics." Leo responds warmly: *"That's not something the team is able to help with, but here's what I can do..."*

**Dashboard workflow when owner doesn't want to answer:**
- Owner can write their own reply (always available)
- Or: dashboard suggests auto-denial phrasing (Leo-voiced, warm)
- Or: one-click "Don't relay this type" → adds to do-not-relay list going forward

**Aggressive users:** Leo needs guidance on handling combative or hostile visitors. Warm but firm. Doesn't escalate, doesn't capitulate. Probably a system prompt addition (non-configurable floor), with a Church Mode variant that's more pastoral.

**Note:** Tolerance slider and do-not-relay list require UI in dashboard Settings, a new entity field, and prompt changes. Not trivial. Log for post-alpha.

---

## Overview — Usage Panel Enhancements

Upgrade the message count display on the dashboard Overview from a raw number to a smart usage panel.

**Display format (fraction):**
- Free: `63 / 100`
- Pay-as-you-go: `332 / 500` (next threshold — see below)
- Infinity: `332 / ∞`

**Burn rate projection (free tier):**
Linear projection based on days elapsed in billing period vs. messages used. Color coded:
- 🟢 Green — projected to finish well under limit (> 10% headroom)
- 🟡 Yellow — projected to land within 10% of the limit (either side)
- 🔴 Red — projected to exceed limit before period ends
- ⚫ Gray — fewer than 3 days into period, "Not enough data yet" — burn rate too noisy

**Pay-as-you-go projection:**
No hard limit, so instead show projected monthly cost based on current burn rate. The "limit" shown in the fraction is the *next milestone threshold* (the next tier where retroactive discounting kicks in). Add a small note: e.g., *"At this rate you'll hit the 500-message tier — that saves you $X retroactively."* Turns the projection into a positive nudge rather than a warning.

**Infinity plan:**
No projection or color coding. Just show usage with the ∞ symbol. On-brand, clean.

**Also show:**
- Messages remaining (free tier): e.g., "37 remaining"
- Quota reset date: pulled from `billingPeriodResetAt` on Entity

**Info icon (ⓘ) on the panel:**
Tooltip explaining: color thresholds, that projections are based on current daily average, and reset date context.

---

## Pastoral Handoff Threshold (Church Mode — High Priority)

Leo is not a counselor. When a conversation needs a human shepherd, he hands off warmly.

**Non-configurable floor (always escalates):**
- Crisis signals: suicidal ideation, self-harm, abuse, severe distress
- Any situation where a person's safety is at risk
Leo responds with warmth and care but always surfaces a human connection. This is the pastoral equivalent of a Layer 1 hardline.

**Configurable threshold (church sets their bar):**
- Serious doubt or deconstruction
- Grief, trauma, major life events
- Deep theological disputes
- Prayer requests needing real human follow-through
- Any topic the church flags as "always escalate"

Large churches with dedicated pastoral care may want Leo to escalate almost anything personal. Small churches may prefer Leo handles more. Both valid.

**Implementation note:** Crisis detection should run on every Church Mode message — not just when Leo can't answer. A question about service times could contain a buried cry for help.

---

## Tiered Model Routing (Post-MVP, High Priority)

Classify each query first, route accordingly. Haiku for simple factual traffic; Sonnet for what it's actually good at.

**Classifier (Haiku, near-zero cost):** Single call before main chat. Outputs `{"route": "simple"}` or `{"route": "complex"}`.

**Route to Haiku:** Hours, location, menu, pricing, contact info. Single-fact lookups. Short conversations with no tension.

**Route to Sonnet:** Multi-part questions, any user pushback, Church Mode, long conversations, classifier uncertain.

**Expected split:** ~70-80% Haiku, ~20-30% Sonnet. Conservative classifier — default to Sonnet on uncertainty. Better to over-route than under-serve a sensitive moment.

This is intentional model deployment, not just cost optimization. Haiku for information, Sonnet for relationship.

---

## Semantic Response Cache (Post-MVP)

Before hitting Claude, check `cached_responses` collection for semantically similar prior answers for that domain.

**Flow:**
1. Embed query (Voyage)
2. Vector search `cached_responses` for domain (~0.95 similarity threshold)
3. Cache hit → Haiku rephrase so it feels natural (don't return verbatim)
4. Cache miss → full RAG + Sonnet, store result
5. On rescrape → invalidate only cache entries referencing changed chunk IDs

**Cost ladder:**
- Cache hit: Voyage + Haiku ≈ $0.0024/message (~75% cheaper than full Sonnet)
- Cache miss: Voyage + RAG + Sonnet ≈ $0.009/message
- At 1,000 msg/month, 40% hit rate: ~$2.40/month saved per entity

**Prefetching (cold start fix):** At scrape time, run ~20-25 common questions through full RAG pipeline and cache answers. Use Haiku for generation. Standard question sets:
- **Universal:** hours, location, parking, contact, hiring, pricing
- **Food/retail:** menu, delivery, reservations, catering
- **Church:** service times, denomination, kids programs, how to get involved

Cost: ~$0.05/scrape. Regenerate only prefetched answers whose source chunk IDs changed.

**Risks:** Similarity threshold needs tuning. Cached answers lack conversational context (fine for factual, awkward for follow-ups). Cache invalidation must tie to rescrape events.

---

## Superadmin Impersonation (Post-MVP)

Daniel impersonates any user or role from superadmin dashboard for testing and support.

**Behavior:**
- Impersonate specific user (domain implied) or assume a role + select domain
- Persistent banner while impersonating: "You are impersonating [name / role @ domain] — [exit]"
- Multi-role support deferred until multi-entity user accounts are built

**Security logging (non-negotiable):** Every event logged — start, end, every action. Fields: `superadminId`, `targetUserId`, `entityDomain`, `action`, `timestamp`. Append-only, superadmin-only. Actions attributed to both impersonator and target.

---

## Handoff Follow-Up Notifications

When a handoff is pending and the owner hasn't replied, Leo follows up automatically. Configurable per entity (default: daily).

**Notification content:** "Visitor still waiting." New questions since last notification. Total pending count. Direct dashboard link.

**Implementation:** node-cron job — queries `handoffPending: true` + `lastHandoffNotifiedAt` older than interval → fires SMS/email via existing notifications service. Tracks `lastHandoffNotifiedAt` to prevent duplicates.

**Configurable per entity:** enabled/disabled, interval in hours (default: 24).

---

## Multi-User Dashboard — Roles & Auth

**User model:** `email`, `hashedPassword`, `name`, `displayName`, `entityDomain`, `role`, `showNameInReplies`

**Default roles:**
- `owner`: full access (settings, billing, reply, live chat)
- `agent`: reply, live chat, view conversations — no settings/billing
- `readonly`: view only

**Widget display:** Owner/agent replies can show name + role optionally. Opt-in per user. Anonymous = "The [Business Name] team."

**Dependency:** Live chat and agent identity in replies depend on this.

---

## Live Chat / Human Takeover (Premium Add-On)

Team member jumps into an active conversation in real time.

**Flow:**
1. Agent sees active conversation, clicks "Join"
2. Leo detects takeover signal, says warmly: *"A real person from the [Business] team wants to jump in — want me to connect you?"*
3. Visitor confirms → Leo bows out, widget shifts (different bubble color, agent name shown)
4. Agent and visitor chat via Socket.io
5. Agent can hand back to Leo at any time

**Dependency:** Auth/roles + Socket.io infrastructure.

---

## Owner Reply Flow (Follow-up to Handoff — High Priority)

Current handoff is one-way. Owner needs a path to reply.

**Approach (dashboard reply, not SMS inbound):**
- SMS/email alert → link to conversation in dashboard
- ConversationDetail "Reply to visitor" input → stored as message with owner flag
- On visitor's next open, Leo surfaces it: *"Someone from the [Business] team got back to you..."*

**Why not SMS inbound webhook:** Matching owner SMS reply to visitor session is fragile. Dashboard reply is simpler, cleaner, more reliable.

**Learning Loop:** One-click "Add to knowledge base" on owner reply. Stores Q&A pair as embedded chunk (source: `owner_reply`). Closes the loop: Leo flags gap → owner replies → gap becomes knowledge.

---

## Unanswered Questions Log

Log every question Leo can't answer. Fields: question, timestamp, handoff offered/accepted, conversation snippet.

**Dashboard:** Questions grouped by frequency. One-click "Add to knowledge base."

**Email report:** Configurable frequency (default: weekly). Actionable format — not a data dump. *"Leo couldn't answer these 7 questions this week."*

**Implementation:** Flag in chat route when RAG returns no context, or detect via Leo's response signal.

---

## Leo Applications (Paid Add-on)

Leo handles job applications in chat. Collects name, contact, availability, experience → submits to entity as structured lead. File upload support (resume, portfolio) — needs attachment button in widget. Churches can use for volunteer sign-ups. Ties into handoff/notification system.

---

## Animated Leo Character (Post-MVP)

Small animated lion in the chat window.
- Idle: sitting, subtle breathing/blinking
- Thinking: triggered while waiting for API response (replaces/accompanies typing indicator)

Not MVP. Meaningful differentiator, on-brand. Budget design time post-launch.

---

## Leo-Guided Alert Preference Setup

During Leo-guided onboarding, after Leo has collected both email and phone number, ask the user which channels they want for quota usage alerts: both, email only, SMS only, or none.

**Logic:**
- If only email provided → default email only, no need to ask
- If only phone provided → default SMS only, no need to ask
- If both provided → Leo asks: *"Got it! For usage alerts — like when Leo's getting close to the monthly message limit — would you like those by email, SMS, or both? Or I can skip them entirely."*

**Implementation note:** The `quotaAlertChannels` field already exists on Entity. The guided setup just needs to write it during onboarding. No backend changes needed — just the Leo-guided onboarding flow.

---

## Leo Accounts (Phase 2)

Optional end-user accounts enabling cross-site recognition. Visitor with Leo account is greeted by name on any Leo-enabled site: *"Fancy seeing you here, Daniel!"*

Cross-site cookies are increasingly restricted — Leo account login is the reliable path. Deferred to Phase 2.
