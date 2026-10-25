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

## Production baseline — record it, do not judge it (LEO-073)

Before touching code, record the baseline:

```
node ops/leo-nightly/smoke.mjs --baseline ops/leo-nightly/.baseline.json
```

It exits 0 whenever the checks were *collected*, whether or not they passed. **A red baseline is a
fact to write down, not a reason to stop.** The old rule here was default-deny — any failing check
blocked the item — and it cost 26 days: `POST /chat` answered 500 from 2026-09-09 because the
Anthropic credits ran out, and eight items that never touched the chat path sat blocked behind it,
three of them already built.

What the baseline is *for* is the comparison after deploy. Keeping it means a check that was
already red cannot be mistaken for something this run broke.

Only one thing still stops the run here: a baseline that could not be collected at all. With
nothing to compare against there is no way to tell a regression from a fault that was already
there, so block with `baseline-failed`, write `ops/leo-nightly/incident-<ts>.md`, and exit.

**Exit 2 is the script saying that itself** (LEO-095). A host that answered nothing at all leaves
its checks red about the network between here and there, not about production; the file then says
`"collected": false` and names the hosts in `"unreachable"`. The verdict is per host, so Railway
unreachable with Netlify up is still exit 2 — the four API checks can say nothing, and a baseline
recording them as red would later classify a failed deploy as pre-existing. A 500 or a 404 is an
answer and is never exit 2; that is the 26-day case above. Any other non-zero exit from this mode
is the script itself failing (the file could not be written) and blocks the same way.

A `--compare` against a `"collected": false` file refuses as well, so a leftover baseline from a
run that never reached production cannot quietly stand in for a missing one.

`LEO_SMOKE_LOG_LEVEL=light` (also `normal`, `verbose`) traces that decision on stderr, naming the
checks behind each host's verdict; stdout stays the JSON record.

Note the baseline file is gitignored — it belongs to one run, not to the repo.

## Verification (all must pass; state explicitly which gates did not run)

```
cd backend   && yarn install --frozen-lockfile && yarn verify && yarn test
cd dashboard && yarn install --frozen-lockfile && yarn build   && yarn test
node widget/smoke.mjs
node backend/src/scripts/verify-prompt.js
node --test "ops/leo-nightly/*.test.mjs"
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
- Railway and Netlify deploy on their own. **Post-deploy smoke**, compared against the baseline:

  ```
  node ops/leo-nightly/smoke.mjs --compare ops/leo-nightly/.baseline.json --expect-commit <merge-sha>
  ```

  Exit 0 means nothing regressed and the merge stands. Exit 1 means either a check that was green
  at baseline is now red — **that, and only that, is what auto-revert is for** — or the baseline
  was missing. Poll every 30 s up to 12 min for the deploy to land before treating a red `health`
  commit mismatch as final.

  Say in the run summary which checks were already red at baseline. A run that shipped under a
  known-broken production must never read as a clean one.

  The checks it runs, unchanged from what this section always described:
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
- **Auto-revert** on a *regression* — never on a pre-existing failure: `git checkout -B routine/revert-<sha> origin/main && git revert
  --no-edit -m 1 <merge-sha> && git push origin HEAD:main`, re-run the smoke. If the post-revert
  smoke also fails, stop: write the incident file, block the item, and exit. Never `reset --hard`
  plus force-push; main is deployed and shared.

## After a merge

Daniel's laptop `main` goes stale on every server-side merge; note in your report that it needs
`git pull --ff-only`. Do not edit `CLAUDE.md`'s Current State — put notes in the PR body.
