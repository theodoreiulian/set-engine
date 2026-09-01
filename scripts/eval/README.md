# Recognition evaluation harness

Dev-only. Nothing here ships: it is not referenced by `forge.config.js`, the Vite
configs, or any runtime code.

## Why it exists

Set Extraction's audio scan had no way to be measured. Every tuning decision was
therefore an argument, and the accuracy regressions recorded in CLAUDE.md are
what arguments produce. A 55-minute set returning 9 tracks — about half of what
was played — is what finally forced the issue.

The problem is that measuring the scan live costs ~20 minutes of rate-limited
requests per attempt, and the results are not reproducible: Shazam's answers
drift, so two runs of two different algorithms are not comparable.

So split it in two. **Capture once** — a dense, fixed grid of real probe results
for one set, including the raw `matches[]` that `anchor.js` reasons over. Then
**replay offline**, as often as you like, in milliseconds, against identical
evidence.

## Use

```bash
# 1. Build the bundles (also snapshots the pre-change acceptance code from git)
node scripts/eval/build.mjs

# 2. Capture a set — ~20 min for an hour of audio. MUST be run one at a time:
#    Shazam rate-limits per IP, so two concurrent captures just buy 429s.
npx electron scripts/eval/capture.mjs "https://www.youtube.com/watch?v=..."

# 3. Score every capture
node scripts/eval/score.mjs
EVAL_LIST=1 node scripts/eval/score.mjs      # also print each tracklist
```

`score.mjs` reports three configurations per set:

| | what it is |
|---|---|
| `baseline` | the scan and acceptance as they shipped before this work. The acceptance half is read out of `git HEAD`, not rewritten from memory — every "we improved it" claim is measured against this row. |
| `current` | the scan and acceptance in the working tree. |
| `ceiling` | current acceptance over *every* captured probe. The most any scheduling change could recover; the gap to `current` is what is still on the table. |

**Precision is the number that must not fall.** A wrong name is worse than a
missing one here, because `download:tracks` stamps the *expected* artist and
title onto whatever audio it fetches — so a bad row ships as a correctly-labelled
wrong recording.

## Ground truth

`corpus.json` maps a YouTube id to a known tracklist:

```json
{ "oy6uP0Ak8hI": { "title": "…", "tracks": [{ "artist": "…", "title": "…" }] } }
```

Prefer sets whose tracklist was published by the uploader as **chapters**, so the
truth is independent of the recognizer being graded. Captures without an entry
are still reported — track counts and tier mix — just without recall/precision.

## What the replay can and cannot tell you

The simulator runs the **real** planner (`planNextProbe`, `seedPoints`) and the
**real** acceptance rules, imported from `src/`, so it cannot drift away from the
shipped behaviour. Two limits are worth knowing:

- Probes are served from the capture grid, so the simulation cannot place two
  probes closer than `CAPTURE_STEP_SEC` (8 s). The `ceiling` row is the honest
  bound on what denser scheduling could buy.
- A served observation always keeps **its own** timestamp, never the one the
  planner asked for. `matches[].offset` is a position measured at the instant the
  probe was taken; pairing it with a different `t` would shift every anchor by up
  to half a grid step and manufacture proofs the real scan would never see.
