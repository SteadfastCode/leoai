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

## Editing the queue

Edit `FEATURES.md`, then:

```bash
node ops/leo-nightly/build-state.js
```

Reordering items is safe — selection reads `state.json` by lowest id with satisfied
dependencies, never by position in the file.
