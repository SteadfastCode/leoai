# ops/leo-nightly

Machine state for the `leo-nightly` scheduled routine. Everything here except this README is
written by the routine — but it is committed to `main` deliberately, because each run starts
with **zero memory of any previous run**. Git is the only durable state that survives.

| File | Owner | Purpose |
|---|---|---|
| `state.json` | routine + `build-state.js` | The only machine-readable queue state. Item status, attempts, dependencies, cluster membership. |
| `build-state.js` | Daniel | Regenerates `state.json` from `FEATURES.md`, preserving run history. Run after editing the queue. `--check` verifies they are in sync. |
| `ledger.jsonl` | routine | Append-only event log: claims, completions, skips, crash recoveries. One JSON object per line. This is what the backpressure counter reads. |
| `last-run.json` | routine | Overwritten every run **including no-ops**. The heartbeat that distinguishes "the routine is working and had nothing to do" from "the routine has been silently dead for a fortnight." |

The run lock lives **outside** the repo, at `C:\Users\danie\.claude\leo-nightly\run.lock`, so
`git status` stays clean and it survives the worktree being recreated.

## Backpressure

The routine halts after **14 completed-but-unacknowledged items** and notifies once. The anchor
is the `leo-nightly-ack` tag on `origin/main`. Only Daniel moves it:

```bash
git tag -f -a leo-nightly-ack -m ack origin/main && git push -f origin leo-nightly-ack
```

The routine may never create, move, or delete that tag. That restriction is the whole mechanism:
every commit in this repo is authored `Daniel Ecker`, including ones written by agents, and the
bot pushes with Daniel's own GitHub token — so there is no signal in git or GitHub history the
bot could not forge. A tag it is forbidden to touch is the only trustworthy one.

## The smoke entity

Created 2026-08-07 by the routine, per STEP 14. Checks 3 and 4 of the production smoke run against it.

| | |
|---|---|
| Domain | `smoke.leo-ai.chat` |
| Name | Leo Nightly Smoke Shop |
| Plan | `infinity` — so an exhausted free-tier quota can never fail the smoke spuriously |
| `ownerPhone` / `ownerEmail` | **both blank, deliberately** — `chat.js` guards handoff on `if (entity.ownerPhone \|\| entity.ownerEmail)`, so with both empty no SMS or email can ever fire from a smoke run |
| `offerHandoffBeforeContact` | `false` |
| Chunks | 4, `source: 'manual'` — `Chunk.DESTROYABLE_SOURCES` is `['scraped']` only, so a rescrape can never delete them |

It is a fixture, not a site: the chunks were written by hand and embedded directly. **No scrape has
ever run against it and none should** — there is nothing at that hostname to crawl.

The seeded question the smoke asserts on is **"What are your opening hours?"**, which must return at
least one hit scoring >= 0.75. Measured 0.7912 on 2026-08-07 — that is only 0.04 above the bar, so if
this check starts flapping, the margin is the reason, not necessarily a RAG regression. Widen the
seeded content before lowering the threshold.

## Editing the queue

Edit `FEATURES.md`, then:

```bash
node ops/leo-nightly/build-state.js
```

Reordering items is safe — selection reads `state.json` by lowest id with satisfied
dependencies, never by position in the file.
