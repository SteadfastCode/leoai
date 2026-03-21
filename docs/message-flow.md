# LeoAI — Message Flow

From widget keystroke to rendered response.

---

## ASCII Flowchart

```
┌─────────────────────────────────────┐
│         VISITOR sends message        │
│   POST /chat {domain, sessionToken,  │
│               message}               │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│           VALIDATION                 │
│  Entity exists? ──No──► 404         │
│  Quota exceeded? ─Yes──► 402        │
│  Billing period reset?               │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│        LOAD CONVERSATION             │
│  MongoDB: findOne({sessionToken,     │
│  domain}) → messages, handoff state, │
│  pendingQuestions, lastTopic         │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│           RAG RETRIEVAL              │
│  1. embedQuery(message)              │
│     → Voyage AI → 384-dim vector     │
│  2. Atlas Vector Search              │
│     compare query vector against     │
│     all chunks for this domain       │
│     → top 10 by cosine similarity    │
│     → score threshold 0.75           │
│       (low-score chunks filtered)    │
│  3. Concatenate up to 6,000 chars    │
│     ragContext = joined chunk text   │
│     (empty string only if 0 chunks   │
│      exist — entity never scraped)   │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│          MODEL SELECTION             │
│                                      │
│  message > 150 chars? ──Yes──────┐   │
│  ragContext empty?    ──Yes──────┤   │
│  topScore < 0.75?     ──Yes──────┤   │
│                                  ▼   │
│                              SONNET  │
│                                      │
│  short + solid KB match ─────────┐   │
│                                  ▼   │
│                               HAIKU  │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│        BUILD SYSTEM PROMPT           │
│  leo-system-prompt.md v2.2 +         │
│  [BUSINESS_NAME], [AVG_WAIT_TIME],   │
│  [CHURCH_MODE_ENABLED], lastTopic,   │
│  handoff status + pending questions, │
│  current datetime                    │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│         BUILD MESSAGES               │
│  [0] user:  RAG context injection    │
│  [1] asst:  context acknowledgment   │
│  [2–n] conversation history (last10) │
│  [n+1] user: current message         │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│          CLAUDE API CALL             │
│  model: Haiku or Sonnet              │
│  max_tokens: 1024                    │
│  → raw reply text                    │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│         SIGNAL PROCESSING            │
│  [HANDOFF_REQUESTED: reason]         │
│    → add to pendingQuestions         │
│    → fire SMS/email (first handoff)  │
│  [HANDOFF_CANCEL: text]              │
│    → findIndex exact match           │
│    → splice from pendingQuestions    │
│  [OPTIONS: A | B | C]                │
│    → parse into options[]            │
└────────────────┬────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│         SAVE CONVERSATION            │
│  Push user + assistant messages      │
│  Update lastActiveAt                 │
└────────────────┬────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────┐
│              FIRE-AND-FORGET (non-blocking)           │
│  summarizeTopic (Haiku, 60 tokens) → lastTopic        │
│  quota warning notifications (50/75/90% thresholds)   │
└──────────────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│         RESPONSE TO WIDGET           │
│  { reply, options[], sources[] }     │
│  Widget: renders reply, pill         │
│  buttons if options, markdown fmt    │
└─────────────────────────────────────┘
```

---

## Full Flow

```
1. VISITOR sends a message
   Widget → POST /chat { domain, sessionToken, message }

2. VALIDATION (chat.js)
   ├── entity exists?         → 404 if not
   ├── quota check            → 402 if free tier limit hit (100 msg/month)
   └── billing period reset?  → roll over messageCountThisPeriod if needed

3. LOAD CONVERSATION (MongoDB)
   Conversation.findOne({ sessionToken, domain })
   → last 10 messages, handoffPending status, pendingQuestions[], lastTopic

4. RAG RETRIEVAL (rag.js)
   a. embedQuery(message) → Voyage AI API → 384-dim query vector
   b. Atlas Vector Search:
      - Scans 100 candidate chunks for this domain
      - Returns top 10 by cosine similarity
      - Score threshold: 0.75 — chunks below this are filtered out
      - If entity has 0 chunks OR no chunk scores ≥ 0.75 → context: ''
      - Returns topScore (best chunk's similarity) for routing
      - If entity has 0 chunks → returns { context: '', sources: [], topScore: 0 }
   c. Accumulate chunks up to 6,000 chars → ragContext string

   ragContext is non-empty  = at least one chunk scored ≥ 0.75
   ragContext is empty ('')  = no KB at all, OR query was too off-topic

5. MODEL SELECTION (claude.js — selectModel)
   message.length > 150?   → Sonnet  (long = complex)
   !ragContext?             → Sonnet  (no KB or no relevant chunks)
   topScore < 0.75?         → Sonnet  (belt-and-suspenders; filtered above but routing uses it too)
   else                     → Haiku   (short question + solid KB match)

6. BUILD SYSTEM PROMPT (claude.js — buildSystemPrompt)
   Base prompt (leo-system-prompt.md, v2.2) with runtime injections:
   ├── [BUSINESS_NAME]
   ├── [AVG_WAIT_TIME]
   ├── [CHURCH_MODE_ENABLED]
   ├── [PREVIOUS_TOPIC]        ← lastTopic from conversation
   ├── [HANDOFF_MODE_INSTRUCTION]
   ├── Church config vars      ← if churchModeEnabled
   ├── Current datetime        ← entity timezone
   └── Handoff status          ← pending questions list injected verbatim

7. BUILD MESSAGES ARRAY (claude.js — chat)
   [0] user:      RAG context injection
                  Standard mode: "Here is the ONLY information you may use..."
                  Church mode:   "Use this for church-specific questions;
                                  draw on theological knowledge for Scripture/history"
   [1] assistant: Context acknowledgment
   [2..n] user/assistant: last 10 conversation messages (owner_reply → assistant)
   [n+1] user:    current message

8. CLAUDE API CALL
   model: Haiku or Sonnet (from step 5)
   max_tokens: 1024
   → raw reply text

9. SIGNAL PROCESSING (chat.js)
   Strip and handle signals Leo appended:
   ├── [HANDOFF_REQUESTED: reason]  → add to pendingQuestions, fire SMS/email
   ├── [HANDOFF_CANCEL: text]       → findIndex exact match, splice from pendingQuestions
   └── [OPTIONS: A | B | C]         → parse into options[], render as pill buttons in widget

10. SAVE CONVERSATION (MongoDB)
    Push user message + assistant reply to conversation.messages
    Update lastActiveAt

11. FIRE-AND-FORGET (non-blocking)
    ├── summarizeTopic (Haiku, 60 tokens) → update conversation.lastTopic
    └── quota warning notifications if thresholds crossed (50/75/90%)

12. RESPONSE to widget
    { reply, options, sources }
    Widget renders reply, interactive buttons if options[], markdown formatting
```

---

## Model Selection Thresholds

| Condition | Model | Reasoning |
|---|---|---|
| `message.length > 150` | Sonnet | Long message = likely complex, multi-part, or nuanced |
| `!ragContext` | Sonnet | No KB at all, or no chunk scored ≥ 0.75 — needs stronger reasoning |
| `topScore < 0.75` | Sonnet | Best chunk is a weak match — KB won't help much |
| Short + solid KB match | Haiku | Simple factual lookup — Haiku handles well, ~20x cheaper |

RAG now applies a `MIN_SCORE = 0.75` threshold — chunks below this are discarded before context is built. `topScore` (best chunk's cosine similarity) is returned and used as a routing signal: if the closest match is weak, Leo falls back to Sonnet even if some chunks technically passed the filter.

---

## RAG Retrieval Detail

- **Embedding model:** Voyage AI `voyage-3-lite` (384 dimensions)
- **Index:** Atlas Vector Search, cosine similarity
- **Candidates scanned:** 100 per query
- **Chunks returned:** up to 10
- **Context size cap:** 6,000 chars
- **Chunk size:** 1,500 chars each
- **Score threshold:** `MIN_SCORE = 0.75` — chunks below this are discarded

---

## Latency Profile (approximate, sequential)

| Step | Time |
|---|---|
| Voyage AI embedding | ~100-200ms |
| Atlas Vector Search | ~50-150ms |
| Claude API (Haiku) | ~300-800ms |
| Claude API (Sonnet) | ~800-2,500ms |
| MongoDB reads/writes | ~20-50ms |
| **Total (Haiku path)** | **~500ms-1.2s** |
| **Total (Sonnet path)** | **~1-3s** |
