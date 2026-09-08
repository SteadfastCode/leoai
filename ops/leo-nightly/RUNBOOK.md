# LeoAI — routine runbook (repo-specific)

Read after the shared runbook. Where they conflict, this file wins. This is the distilled
repo-specific half of the retired `leo-nightly` task; the mechanics it used to spell out (locks,
queue, ledger, budget, usage) now live in the orchestrator.

## What this app is

An AI chatbot widget: Node/Express backend on Railway (`api.leo-ai.chat`), Vue 3 dashboard on
Netlify (`leo-ai.app`), MongoDB Atlas, Claude API, Voyage embeddings. **Pre-alpha — every entity in
the database is Daniel's own test entity, no customers, no financial exposure.** Production is
effectively staging, which is why merge-to-main with auto-deploy is authorised. If `CLAUDE.md` ever
says alpha has begun, stop and block the item instead.

`FEATURES.md` is your only source of work. Never read `docs/wishlist.md` for items — it still holds
full specs for features that already shipped. Never trigger a real SMS or email send. Never run a
scrape against a real entity.

## Production baseline — default deny

Before touching code, run the full smoke (below) against current production. If it fails, block
the item with `baseline-failed`, write `ops/leo-nightly/incident-<ts>.md`, and exit — an Anthropic
529 or Atlas maintenance would otherwise make your post-deploy smoke fail and you would revert
healthy code.

## Verification (all must pass; state explicitly which gates did not run)

```
cd backend   && yarn install --frozen-lockfile && yarn verify && yarn test
cd dashboard && yarn install --frozen-lockfile && yarn build   && yarn test
node widget/smoke.mjs
node backend/src/scripts/verify-prompt.js
```

Mechanical diff gates, any of which fails the item:
- No route removed or renamed: `git diff origin/main --unified=0 -- backend/src/routes | grep -E
  "^-\s*router\.(get|post|put|patch|delete|use)\("` must be empty. Response fields may be added,
  never deleted; a rename spans two merges (add alongside, remove after the first is confirmed live).
- No new `required: true` or `unique: true` on an existing model field, no removed enum value.
  A new required field validates the ENTIRE subdocument array on save — a new visitor works while
  every returning visitor breaks, which a fresh-session smoke cannot catch.
- Every newly referenced `process.env.X` under `backend/src` appears in `backend/.env.example`.
- A modified `package.json` requires a modified `yarn.lock` in the same commit.

After any `git merge origin/main` touching a restricted file, `git diff --stat HEAD@{1} HEAD`; if a
restricted file changed IN THE MERGE, dump both parents and hand-verify — a textually clean 3-way
merge can produce a semantically broken hybrid.

## Denylist rationale (the orchestrator enforces the list; this is why)

- `backend/index.js` — route mounts, middleware order, CORS. The wildcard CORS is deliberate: the
  widget is embedded on arbitrary customer domains. A "harden CORS" change kills every embedded
  widget, and a curl smoke sends no Origin header so it would report green.
- `routes/webhooks.js`, `routes/billing.js` — anything above the Stripe raw-body mount makes
  `constructEvent` throw on every event.
- `services/embeddings.js` and the `$vectorSearch` stage in `rag.js` — the 512-dim model is pinned
  against an Atlas index defined OUTSIDE this repo; change it and every RAG result silently empties.
- `nixpacks.toml`, the `resolutions` block, the `puppeteer` version specifier.
- `backend/prompts/leo-system-prompt.md` — allowed ONLY when `verify-prompt.js` passes and the item
  is explicitly a prompt item.
- Restricted (≤30 changed lines): `routes/chat.js`, `services/rag.js`, `services/scraper.js`; never
  touch the quota block, the handoff atomic test-and-set, or `conversation.save()`.

## Merge, deploy, smoke, revert

- **Blackout:** do not merge between 02:50 and 04:10 UTC (LeoRefresh's hour ±1). Check
  `GET /scrape/active` with the admin API key; if non-empty, defer the MERGE (record the item with
  a deferred-deploy note), not the run.
- `main` is branch-protected on `backend`, `dashboard`, `widget` checks, but the token can bypass:
  `gh pr checks <n> --watch`, merge only when all three pass, `--merge` never squash.
- Railway and Netlify deploy on their own. **Post-deploy smoke**, polling every 30 s up to 12 min:
  1. `GET https://api.leo-ai.chat/health` → `commit` equals the merge sha and `mongo` is 1. A failed
     Railway build keeps serving the previous container, which returns 200 just as happily.
  2. `GET https://leo-ai.app` → 200, and the hashed `/assets/index-*.js` it references → 200.
  3. `POST /chat` against the smoke entity with header `Origin: https://dosiedough.com` and the admin
     API key → 200, non-empty reply, and an `access-control-allow-origin` header.
  4. `GET /api/admin/search?domain=<smoke>&query=What are your opening hours?` → a hit scoring
     ≥ 0.75 (measured 0.79 on 2026-08-07; if this flaps, widen the seeded content before lowering
     the bar).
  5. `GET https://api.leo-ai.chat/demo/chatbot.js` → 200, byte length within ±25% of the committed
     file, `node --check` on the downloaded body.
  The smoke entity is `smoke.leo-ai.chat` (plan `infinity`, blank ownerPhone/ownerEmail so no
  notification can fire, 4 manual chunks; never scrape it) — see `ops/leo-nightly/README.md`.
- **Auto-revert** on smoke failure: `git checkout -B routine/revert-<sha> origin/main && git revert
  --no-edit -m 1 <merge-sha> && git push origin HEAD:main`, re-run the smoke. If the post-revert
  smoke also fails, stop: write the incident file, block the item, and exit. Never `reset --hard`
  plus force-push; main is deployed and shared.

## After a merge

Daniel's laptop `main` goes stale on every server-side merge; note in your report that it needs
`git pull --ff-only`. Do not edit `CLAUDE.md`'s Current State — put notes in the PR body.
