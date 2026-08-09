# FEATURES.md — leo-nightly workqueue

**This file is the ONLY source of work.** Never read `docs/wishlist.md`, `CLAUDE.md`, or any
other doc as a source of items. `docs/wishlist.md` still contains full specs for features that
already shipped — treating it as a queue re-implements live code.

**Checkboxes here are for Daniel to read. They are NOT machine state.** Item selection reads
`ops/leo-nightly/state.json` on `origin/main` and nothing else. The routine updates both in the
same commit; if they ever disagree, `state.json` wins.

> **Routine note (2026-08-09, leo-nightly):** do NOT tick an item checkbox at claim and do NOT
> move completed lines into Completed Items yet — build-state.js parse() only reads unticked
> lines, so either edit turns the STEP 12 build-state --check gate red (and moving done items
> would drop them from state.json, starving LEO-005/Block E dependsOn). Claims and completions
> live in state.json ONLY until Daniel patches build-state.js (proposed diff in PR #1).
> LEO-001 is DONE (state.json) despite its unticked box below.

**Selection rule:** lowest-numbered item whose `state.json` status is `pending`, whose
`dependsOn` are all `done`, and whose `attempts < 2`. Never by list position.

**When the queue is drained, stop silently.** A quiet night is normal. Do not notify, do not
look for other work, do not invent items.

---

## Block A — Verification substrate (zero deployable code)

Nothing in this block changes code that ships. It exists because there is currently **no test
and no build gate for the backend at all** — `node --check` is the only check, and it passes on
a `require()` of a nonexistent module. Until these land, every later gate is theatre. They are
also safe by construction: a bug here cannot reach production.

- [ ] **(LEO-001) Backend chat-flow regression harness**
  Add `backend/test/chat-flow.test.js` (`node --test`) driving the real `/chat` router against
  `mongodb-memory-server`, plus `verify` and `test` scripts in `backend/package.json`. Cover:
  free-tier quota at 99/100/101 messages, first handoff fires exactly once (the atomic
  test-and-set), `[HANDOFF_REQUESTED]`/`[OPTIONS:]` stripping, returning-visitor history load.
  *Verify:* `yarn test` exits 0 on unmodified `main`. Then deliberately break one branch
  (comment out the quota check), confirm the suite goes red, restore. **Demonstrate both states
  in the PR body** — a suite that cannot fail is worse than none.

- [ ] **(LEO-003) Widget load-and-render smoke test**
  Add `widget/smoke.mjs`: boot happy-dom, stub `fetch`/`localStorage`/`WebSocket`/
  `document.currentScript`, `await import('./chatbot.js')`, assert the bubble exists in
  `document.body`, that a stubbed 200 from `/chat` renders an assistant bubble, and that
  `window.LEO_BACKEND_URL` is honoured. No refactor of `chatbot.js` — it is one IIFE, imported
  for side effects. This lifts `widget/**` off the denylist for LEO-030 and nothing else.
  *Verify:* `node widget/smoke.mjs` exits 0. Then introduce a module-scope TypeError in a
  scratch copy and confirm non-zero exit.

- [ ] **(LEO-004) MCP `send_test_message`: multi-turn + handoff state**
  Add an optional `sessionToken` input so an agent can drive turn 2 into the same conversation,
  and surface `handoffTriggered` alongside the existing debug fields. Document a worked two-turn
  example in `mcp/README.md`. `mcp/` is a local stdio server and never deploys.
  *Verify:* `node --check mcp/index.js`, then two calls with the same token against the smoke
  entity — the second reply must reference the first turn.

- [ ] **(LEO-005) GitHub Actions CI + branch protection prerequisites** *(needs LEO-001, LEO-002, LEO-003)*
  Add `.github/workflows/ci.yml` running `yarn install --frozen-lockfile`, `yarn verify`,
  `yarn test` for `backend/`, and `yarn build` + `yarn test` for `dashboard/`, plus
  `node widget/smoke.mjs`, on pull_request and push to main.
  *Verify:* the workflow must go green on an unmodified tree **and** red on a deliberately
  broken one, both demonstrated. Note in the PR body that enabling required-status-check
  branch protection is Daniel's manual step — the routine cannot grant itself a gate.

## Block B — Superadmin and dashboard-only surfaces

Nothing here is on the visitor path. A bug reaches Daniel, not a site visitor.

- [ ] **(LEO-006) Fix the false "Failed to send reply" toast**
  `ConversationDetail.vue`'s `sendReply()` reads `data.addedToKb` from an identifier it never
  bound. The ReferenceError is swallowed by its own catch, so a *successful* POST shows a
  failure toast and leaves the textarea uncleared — the owner re-sends and the visitor gets a
  duplicate reply. Capture the POST response, move `replyText.value = ''` above anything that
  can throw, narrow the catch.
  *Verify:* `yarn build` + a repo-wide grep for other views referencing an unbound `data`.
  Say plainly in the PR body that Vite does no undefined-variable analysis, so this is verified
  by inspection, not by the build.

- [ ] **(LEO-007) Consistent API error surfacing**
  Add `dashboard/src/lib/notify.js` (shared reactive queue). In `lib/api.js`'s response
  interceptor, after the 401/refresh branch, map 403/404/429/5xx/no-response to messages before
  rejecting. Honour a `config.silent` flag. One app-level snackbar in `App.vue`; replace the
  bare `catch {}` at `App.vue:78`.
  *Verify:* vitest spec on the status→message mapping (exported as a pure function) for every
  code plus no-response, and asserting the interceptor still **rejects** — swallowing the
  rejection breaks every existing caller's error path.

- [ ] **(LEO-008) Admin Entities — search, sort, expandable detail**
  Client-side search on name+domain, plan filter, sort select. Rows become expansion panels
  that lazily call `getStats(domain)`. Add a "Stale" chip when `lastScrapedAt` is null or
  >30 days. No backend change.
  *Verify:* `yarn build` + vitest on the extracted filter/sort helpers (empty list, missing
  `lastScrapedAt`, ties on sort key).

- [ ] **(LEO-009) Superadmin fleet overview page**
  `GET /api/admin/fleet` returning one row per entity from a single `Entity.find()` plus exactly
  two `$match`-scoped grouped aggregates. `Fleet.vue` as a sortable table with over-quota /
  near-quota / stale-crawl highlighting.
  *Verify:* unit-test the row-assembly function with fixtures including entities with zero
  chunks and zero conversations. **Grep-assert no `await` inside a loop** — that is the property
  that matters for production and it is checkable by reading.

- [ ] **(LEO-010) Admin audit log — model, write helper, viewer**
  `AuditLog` model (append-only, no update/delete route) and `services/audit.js` exporting
  `recordAudit(req, action, fields)` that can never throw. Fire-and-forget from entity
  hard-delete, API-key create/revoke, snapshot restore, force rescrape, superadmin PATCH fields.
  Add `GET /api/admin/audit-log` and `AuditLog.vue`. Record `req.apiKey.label` when the actor is
  a key rather than a person.
  *Verify:* unit-test `recordAudit` with a stubbed model whose `create` rejects; assert the
  returned promise **resolves**. Grep-assert no route's success path reads its return value.

- [ ] **(LEO-011) Persist backend logs to MongoDB + searchable history**
  `models/Log.js` exists with a 30-day TTL and nothing writes to it. In `consoleBuf.js`, batch to
  `Log.insertMany` on a 5s timer or 50 entries, persisting **warn and error only** by default via
  `LOG_PERSIST_LEVEL` (`off|warn|all`). Extend `GET /api/admin/logs` with a `mode=history`
  branch; leave the live buffer path byte-identical. Live/History toggle in `Logs.vue`.
  Also truncate buffered entries to 2000 chars and skip the socket emit when the `superadmin`
  room is empty — a `console.log` of chunks with 512-float embeddings is ~60KB per line.
  *Verify:* stubbed-model unit test asserting (a) flush at the size threshold, (b) a rejecting
  `insertMany` does not propagate, and (c) **the flush path calls no `console` method** —
  infinite recursion through the monkey-patched console is the one catastrophic failure here.

## Block C — Owner-facing backend correctness (off the visitor path)

- [ ] **(LEO-012) Include the pending question list in the first handoff alert**
  `chat.js` passes `pendingQuestions` into `sendHandoffNotification`, which never destructures
  it — the first alert shows one reason line while the 24h follow-up renders a proper list.
  Extract `buildHandoffSms`/`buildHandoffEmail` as pure functions, render the same block in
  both, cap the SMS at three questions plus `+N more` (Twilio segments at 160 chars).
  *Verify:* `node --test` on the rendered strings for zero/one/many and both sides of the
  truncation boundary. **Never attempt a real send.**

- [ ] **(LEO-013) Change an existing team member's role**
  `PATCH /entities/:domain/team/:userId` gated on `USERS_MANAGE`. Reject roles outside
  `ROLE_PRESETS`, reject `superadmin`, reject self-demotion, reject removing the last owner.
  Replace the display-only role chip in `Team.vue` with a select.
  *Verify:* extract `isLastOwner(members, userId, domain)` as a pure function and unit-test it:
  sole owner, two owners, owner+agent, target not a member.

- [ ] **(LEO-014) Permission-aware dashboard nav and route guards**
  The RBAC backend is fully built and the frontend ignores it — every user sees all seven nav
  items and any authenticated user can navigate to `/logs`, `/api-keys`, `/entities`. Have
  `GET /auth/me` return `resolvedPermissions` plus `isSuperAdmin`. Add `lib/permissions.js`
  exporting `can(domain, permission)`, filter nav through it, tag admin routes `meta.superadmin`,
  add a `router.beforeEach` redirect.
  *Verify:* vitest on `can()` for superadmin/owner/agent/readonly/no-membership, checked against
  the exact arrays in `models/Permission.js`.

- [ ] **(LEO-015) Conversations list — "Needs reply" filter and status badges**
  Accept `?filter=all|needs_reply|answered`, keeping pagination and totals consistent and the
  default response byte-identical. Chip-group filter synced to a router query param, amber
  "Needs reply" chip, first user message promoted to the row title. **Out of scope:** full-text
  search (unindexed regex on the conversations collection).
  *Verify:* unit-test the filter→Mongo-query mapping as an exported pure function for all three
  values plus an unknown value, which must fall back to unfiltered rather than throw.

- [ ] **(LEO-016) Handoff resolution — mark resolved, plus a reminder cap**
  `handoffPending` can only be cleared by a visitor cancel or a reply answering every pending
  question. Handled by phone, `runHandoffFollowUpTick` re-sends forever. Add
  `POST /conversations/:id/resolve-handoff`, `handoffFollowUp.maxReminders` (default 3), and
  `handoffReminderCount` incremented inside the existing atomic `findOneAndUpdate`.
  *Verify:* extract the "due for a reminder" decision as a pure function and cover
  under-interval, over-interval, at cap, over cap, disabled, no owner contact.

- [ ] **(LEO-017) Close the learning loop on owner replies**
  The reply handler clears `pendingQuestions` but never touches `UnansweredQuestion`, so an
  answered question stays on the Unanswered page and its "Add to KB" button embeds a redundant
  chunk. Match by the existing Jaccard similarity (≥0.6). Extract `questionSimilarity` —
  duplicated verbatim in `chat.js` and `dashboard.js` — into `services/questions.js`. Give
  owner-reply chunks a unique URL (`owner-reply://<domain>/<conversationId>/<n>`) so repeat
  answers stop accumulating as contradictory duplicates under one shared URL.
  *Verify:* `node --test` on the extracted similarity function. The DB mutation cannot be
  exercised offline, so keep it strictly additive — **never delete a doc that was not matched**.

## Block D — Ingest and retrieval (no visitor-facing behavior change)

- [ ] **(LEO-018) Investigate and fix the "what are your hours?" retrieval miss**
  Confirmed live: `retrieveContext('dosiedough.com', 'what are your hours?')` returns **no
  context** on an entity with 19 chunks, while "what kind of bread do you make?" retrieves fine.
  Hours is the single most common question a small business gets. Diagnose first — is the text
  absent from the KB, present but below threshold, or lost to `keepPara`/dedup during chunking?
  **Write up the diagnosis in the PR body before proposing a fix**, and do not change the global
  `ragThreshold` to paper over a chunking bug.
  *Verify:* MCP `search_chunks` for hours-related phrasings across several entities, before and
  after. State the topScore figures explicitly.

- [ ] **(LEO-019) Contain per-batch embedding failures**
  `fetchPage` errors are caught per URL but the embed call is not — Voyage rethrows after
  `MAX_RETRIES` and unwinds the entire crawl loop, leaving a half-populated KB and a 500. Wrap
  `embedPageData` (both call sites) and `embedThinPageGroups`, log affected URLs, continue, and
  surface `skippedUrls` in the scrape summary so the dashboard reports the partial result
  honestly.
  *Verify:* a node script overriding `require.cache` for `./embeddings` with a stub throwing on
  the second call; assert `scrapeSite` **resolves** with a non-empty `skippedUrls`.

- [ ] **(LEO-020) RAG context packing — skip oversized chunks instead of aborting**
  The packing loop `break`s the moment one chunk would exceed `MAX_CONTEXT_CHARS`, discarding
  every remaining chunk including small high-scoring siblings that would have fit. Change to
  `continue` and extract as an exported pure `packContext(chunks, maxChars)`. **Do not touch
  thresholds, the sibling offset, or the Phase 2 query.**
  *Verify:* `node --test` with synthetic arrays (oversized first, mixed, all oversized, empty).
  `rag.js` is restricted — diff under 30 lines, must not touch the `$vectorSearch` stage.

- [ ] **(LEO-021) LeoScan pattern scanner — manual KB ingest paths only**
  `services/leoscan.js` exporting `scanText(text)`. Ship exactly: labelled password, common API
  key prefixes, JWT, PEM BEGIN blocks, SSN, Luhn-valid 13–16 digit runs. **Deliberately exclude
  bank routing numbers** (they collide with product SKUs). Wire into `ingestText` only — abort
  with 422 and a `flags` array. **Explicitly NOT the scraper path and not a Haiku tier:** a false
  positive there silently drops legitimate chunks from a KB during an unattended LeoRefresh.
  *Verify:* a positive fixture per rule, and — the check that actually decides safety — a
  **negative corpus** of 20–30 real chunks pulled via MCP `search_chunks` (menu text, prices,
  phone numbers, addresses, SKUs). `scanText` must return `[]` for every one. Commit the corpus.

- [ ] **(LEO-022) Create the Entity at signup with owner contact and alert channels**
  `POST /auth/onboard` creates the User and membership but never touches Entity — the Entity is
  only upserted after a scrape *succeeds*. So every signup today has an Entity with empty
  `ownerEmail`/`ownerPhone`, meaning handoff SMS, handoff email and quota warnings **have no
  recipient**; a failed first crawl leaves the user logged in with no Entity at all. Upsert in
  `onboard` with `ownerEmail` from the signup email plus optional phone and channels. Add the
  controls to Signup step 2. Drop the dead `draft.password` read. **Do not attempt the
  conversational version** — there is no Leo widget on the signup page.
  *Verify:* point `MONGODB_URI` at the local mongod (this path needs no vector search), seed one
  alpha `Code`, POST `/auth/onboard`, assert the Entity exists with the right `ownerEmail`, and
  assert a duplicate email still 409s.

- [ ] **(LEO-023) Restore signup progress after a page reload** *(needs LEO-002)*
  `startSetup()` clears the draft then sets step 3, so a reload during the scrape drops an
  already-authenticated user back to step 1 with a crawl running invisibly. Persist
  `{step, domain, siteUrl, businessName, startedAt}` under a separate key; on mount restore
  **only** when the marker is under an hour old and a valid access token is present, reconnect
  the socket, re-emit `join_domain`.
  *Verify:* vitest — mount with a seeded marker and stubbed socket; assert step 3 and the
  `join_domain` emit; assert it does **not** restore when stale or unauthenticated.

## Block E — Chat path (gated on LEO-001)

Every item here touches `backend/src/routes/chat.js`, a restricted file. Diffs must be ≤30
changed lines, must not touch the quota block, the handoff atomic test-and-set, or
`conversation.save()`, and `yarn test` must be green.

- [ ] **(LEO-024) Fix unanswered-question logging precision**
  `isUnanswered` short-circuits on `if (!hadContext) return true`, so *every* message retrieving
  no context is logged — "hi", "thanks", "that answered it!". The phrase list also matches
  substrings, so a real answer containing "I'm not sure what time you mean — we're open 9-5"
  logs as unanswered. Extract into `services/unanswered.js`: log only when `!hadContext` **and**
  (a handoff was offered this turn **or** the reply matches an anchored phrase), never for
  greetings/closers/thanks or interactive selections.
  *Verify:* `node --test` — pure string handling, no DB, no network.

- [ ] **(LEO-025) Test-mode chat sessions** *(needs LEO-004)*
  Every MCP test message today writes a real Conversation, increments the real quota counter, can
  create UnansweredQuestion rows, and if it trips a handoff fires a real SMS and email. Accept
  `X-API-Key` on `POST /chat` as a test-mode credential **validated against the ApiKey model; a
  request-body flag must never be sufficient**. When and only when valid: skip notification
  sends, both counters, `UnansweredQuestion.create`, and the socket broadcast; mark the
  Conversation `isTest: true`. Still run RAG, the classifier, and the Claude call so debug output
  stays faithful.
  *Verify:* `node --test` on the gate helper — false for no-key, bad key, and body-flag-only;
  true only for a valid key. `yarn test` must stay green. **"No SMS arrived" is not observable to
  the agent** — say so in the PR body rather than claiming it was verified.

- [ ] **(LEO-026) Weekly unanswered-questions email digest — DEFAULT OFF**
  `unansweredDigest: { enabled: false, ... }` on Entity and the PATCH allowlist. Extract the
  greedy Jaccard grouping from the `/unanswered` handler into `services/questions.js` so the
  digest and dashboard cannot drift. `runUnansweredDigestTick()` beside the existing hourly tick:
  **skip silently when the list is empty**, stamp `lastDigestSentAt` idempotently via the same
  atomic `findOneAndUpdate` the handoff follow-up uses. Default-off is what makes this shippable
  unattended — no entity can receive one until Daniel opts in.
  *Verify:* `node --test` on the due-date calculation (weekly and daily, DST-adjacent) and the
  body renderer (empty-list suppression). **Never trigger a real send.**

## Cluster: scrape-pipeline *(shared branch, built across multiple runs)*

**These three items share one branch, `leo-nightly/cluster/scrape-pipeline`, and merge to
`origin/main` only when all three verify green together.** They rewrite the same chunk-persistence
block; merging them one at a time creates windows where `scrape.js`, `leoRefresh.js` and the new
`scrapePersist.js` are half-unified — with a nightly LeoRefresh running through each one.

Cluster rules: at most one open cluster; hard cap of 3 items and 48 hours from the branch's first
commit; `origin/main` merged in at the **start of every run that touches it** with the full verify
gate re-run after each merge; any conflict the routine did not author aborts and notifies.

- [ ] **(LEO-027) Extract `scrapePersist.js` and unify LeoRefresh with the scrape route**
  `leoRefresh.js` still diverges from `routes/scrape.js` two ways after the P0 ordering fix: it
  ignores `thinGroupChunks`/`thinGroupUrls` entirely (group chunks are never refreshed by the
  nightly job) and it never calls `createSnapshot`, so a bad nightly run has no restore path.
  Extract the route's persistence block into `services/scrapePersist.js` exporting
  `persistRescrapeResult({ domain, result, io })` and call it from both. **Do not change
  `rescrapeSite` itself.** Riskiest item in the queue — snapshotting must land in the same change.
  *Verify:* seed synthetic chunks and ScrapedPage rows under a scratch domain, hand
  `persistRescrapeResult` a hand-built result, assert: chunk count never reaches zero, all four
  preserved sources survive, group chunks are replaced by group URL, a `ScrapeSnapshot` was
  written. Delete the scratch domain after.

- [ ] **(LEO-028) Attribute group-chunk counts to member thin pages**
  `chunkCountByUrl` is keyed by `chunk.url` and group chunks carry the *group* URL — so every thin
  page folded into a multi-URL group is written back with `chunkCount: 0` and Page Explorer
  reports it as having produced nothing. That is exactly the failure multi-URL chunking was built
  to fix. Credit each URL in a chunk's `sourceUrls`, in both the full-scrape and rescrape
  branches. Bookkeeping only — do not alter chunk content, URLs, or retrieval.
  *Verify:* `node --test` on the extracted tally function (single-URL chunks, a group chunk with
  three `sourceUrls`, mixed).

- [ ] **(LEO-029) Staleness-based force re-embed (per-entity `staleDays`)**
  `crawlSettings.staleDays` (Number, **default 0 = disabled**, so every existing entity is
  unaffected). In `rescrapeSite`, build a stale-URL set from `storedPages` and treat membership as
  a change signal alongside `hashChanged` and `isPriority`. Thread through exactly the way
  `variantPriceSweep` already is. Worst case is over-eager re-embedding.
  *Verify:* extract the staleness predicate as a pure function; assert 0/disabled, exactly N days,
  missing `lastScrapedAt`, a future date.

## Block G — Visitor-facing behavior (last, after a full track record)

- [ ] **(LEO-030) Widget "Clear conversation" does not reset the session token** *(needs LEO-003)*
  `sessionToken` is a `const` captured at load; the clear handler removes the localStorage key but
  cannot reassign it. The visitor sees an empty pane while the next message posts under the **old**
  token — Leo still has the old history, the dashboard transcript never breaks, and on next page
  load a new token is minted and the prior conversation is orphaned. Change to `let`, mint a fresh
  token, reset `historyLoaded`/`oldestTimestamp`/`hasMoreHistory`/`messageQueue`, re-join the
  socket room, append the first-visit greeting.
  *Verify:* `node widget/smoke.mjs` plus a grep audit that every read of `sessionToken` resolves
  through the mutable binding — specifically `initSocket`'s emit and `sendMessage`'s body.
  Post-deploy, fetch `/demo/chatbot.js`, assert 200, byte length within ±25% of the committed
  file, and `node --check` the **downloaded** body.

- [ ] **(LEO-031) Teach Leo to link the source page in his answer** *(needs LEO-025)*
  The plumbing exists and is unused: `rag.js` returns `sources[]`, `claude.js` injects them as a
  bare list, the widget already renders markdown links with a per-entity `linksOpenInNewTab`
  setting — and the prompt says nothing about links. Carry `pageH1` through the rag projection so
  each URL pairs with a page name, and add one prompt section (bump to v2.4 + a version-history
  row): when the answer came primarily from one page, end with **exactly one** markdown link using
  the page name as text; only ever use a URL from the supplied list; never invent one; never link
  when no context was retrieved; never link on handoff or clarifying-question replies.
  *Verify:* `node backend/src/scripts/verify-prompt.js` must pass — mandatory for any prompt edit.
  Then POST `/chat` with the admin API key (test mode) against the smoke entity for a fixed
  10-question set: replies with context contain exactly one link, every linked URL appears in that
  request's `sources`, an off-topic question yields zero links.

- [ ] **(LEO-032) Store section anchors on chunks** *(needs LEO-031)*
  Thread heading DOM ids through the existing `[H1]`/`[H2]`/`[H3]` scheme: `[H2#the-id] Title`.
  Widen the **four** marker regexes (`keepPara`, the chunkText H1/H2 split, `buildGroupChunks`,
  the `hasH1` Puppeteer trigger) to tolerate an optional `#anchor` and strip it when reading
  heading text — missing one silently degrades chunk labels for every entity on the next nightly
  LeoRefresh. Record `sectionAnchor` on Chunk and ArchivedChunk; emit `url#anchor` from rag
  sources when present.
  *Verify:* **record the baseline BEFORE editing.** Add `backend/src/scripts/test-chunking.js`
  with 3–4 committed static HTML fixtures; assert chunk count, `label`, `sectionH2` and `pageH1`
  are **byte-identical** to the pre-change baseline, and `sectionAnchor` populated where the
  fixture has ids. **Do NOT verify by running a real scrape.**

---

## Blocked Items

*(the routine moves items here after 2 failed attempts and notifies once)*

- [ ] **(LEO-002) Dashboard headless test harness (vitest)**
  Add `vitest` + `@vue/test-utils` + `happy-dom` to `dashboard/`, a `vitest.config.js` reusing
  the existing Vue plugin, and a `test` script. First specs against pure logic only:
  `Signup.vue`'s draft save/load, `UsagePanel.vue`'s burn-rate thresholds. Globally stub `v-*`
  components; do not attempt full Vuetify rendering.
  *Verify:* `yarn test` exits 0 and `yarn build` still succeeds. If vitest cannot resolve
  against Vite 8 within three attempts, revert everything and mark the item `blocked` with the
  resolution error. Do not force a version.
  **BLOCKED 2026-08-09 (leo-nightly):** not a version conflict — vitest 4.1.10 peer-supports
  vite ^8.0.0. All three install attempts failed on the same yarn 1.22.22 linker bug:
  `Invariant Violation: could not find a copy of vite to link in dashboard\node_modules\vitest\node_modules`.
  Attempted: (1) `yarn add -D vitest @vue/test-utils happy-dom`, (2) same after deleting
  `node_modules`, (3) deps written to package.json + `yarn install`. Everything reverted;
  `yarn install --frozen-lockfile` on the untouched tree still succeeds. Likely needs Daniel:
  yarn ≥1.22.x behaves the same — consider installing with `npm` once to generate the tree, or
  moving `dashboard/` to a newer package manager. Item selection skips `blocked`, so LEO-023
  (needs LEO-002) is parked until this is released.

## Completed Items

- [x] **(LEO-P0-1) Fix truncated system prompt** — `b7050b3`. Non-greedy fence regex delivered
  12,721 of 28,448 chars; RETURNING VISITORS, FORMATTING, all of Church Mode and A NOTE ON WHO
  YOU ARE never reached Claude. Added `verify-prompt.js`.
- [x] **(LEO-P0-2) Accept X-API-Key everywhere** — `01c2db6`. 5 of 8 MCP tools 401'd because the
  key path lived only in `admin.js`. Fails closed on an invalid key.
- [x] **(LEO-P0-3) Entity-scoped authorization guard** — `4480067`. Nine dashboard routes were
  readable and writable across entities by any authenticated user.
- [x] **(LEO-P0-4) LeoRefresh chunk preservation + ordering** — `79fd47d`. The nightly job deleted
  owner-authored chunks with no source filter, delete-before-insert, no snapshot.
- [x] **(LEO-P0-5) Preserve `unanswered_qa` across scrapes** — `2a22ec4`. `PRESERVED_SOURCES` now
  derived from the Chunk enum so it cannot drift again.
- [x] **(LEO-P0-6) `/health` reports the deployed commit** — a static `{status:'ok'}` cannot tell
  "new container live" from "build failed, old container still answering 200", which made any
  post-deploy verification meaningless.
