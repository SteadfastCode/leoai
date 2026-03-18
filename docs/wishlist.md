# LeoAI — Ideas & Wishlist

Post-MVP concepts. Nothing here is a commitment. Add freely.

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
