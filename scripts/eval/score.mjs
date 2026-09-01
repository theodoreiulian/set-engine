// SetEngine — offline evaluation of the recognition scan (dev only).
//
//   node scripts/eval/build.mjs && node scripts/eval/score.mjs [capture.json …]
//
// Replays a dense capture (see capture.mjs) through the REAL planner and the
// REAL acceptance rules, so a change to either can be measured in milliseconds
// instead of ~20 minutes of live requests — and measured against the identical
// audio evidence every time, which live runs can never guarantee.
//
// Three configurations are reported per set:
//
//   baseline — the scan and acceptance as they shipped before this work. The
//              acceptance half is pulled out of git HEAD (see build.mjs), not
//              rewritten from memory, because every "we improved it" claim is
//              measured against this number.
//   current  — the scan and acceptance in the working tree.
//   ceiling  — current acceptance over EVERY captured probe. The most any
//              scheduling change could possibly recover; the gap between
//              `current` and `ceiling` is what is still left on the table.
//
// Where a set has a known tracklist (corpus.json), precision and recall are
// reported against it. Precision is the number that must not fall: a wrong name
// is worse than a missing one, because download:tracks stamps the EXPECTED
// artist and title onto whatever audio it fetches.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(path.join(here, '.build', 'lib.mjs'));
const baseline = await import(path.join(here, '.build', 'anchor-baseline.mjs'));

// How the scan was configured before this work: one probe per 15 s of runtime
// capped at 340, and a single set of gap floors with no second pass.
const BASELINE_SCAN = {
  secondsPerProbe: 15,
  maxBudget: 340,
  minBudget: 60,
  phases: [{ confused: 18, silent: 100 }],
};
const CURRENT_SCAN = {
  secondsPerProbe: 8,
  maxBudget: 460,
  minBudget: 60,
  phases: lib.FLOOR_PHASES,
};

// Two tracklist entries describe the same record. Same rule the pipeline uses
// (track-merge.js) so the score grades the question the code answers.
const SAME = 0.6;
const same = (a, b) => lib.titleSimilarity(a, b) >= SAME;

/**
 * Replay the adaptive scan offline.
 *
 * Probes are served from the capture by nearest grid point. The capture step is
 * 8 s, so a served probe sits at most 4 s from where the planner asked — well
 * inside PROBE_SEC, and the same audio either way. Anything coarser than the
 * capture step would make this a model rather than a measurement.
 */
function simulate(capture, scan) {
  const grid = capture.observations.slice().sort((a, b) => a.t - b.t);
  // An interrupted capture covers only the head of the set. Simulating the full
  // runtime against it would serve the last captured probe for every later
  // moment — fabricating agreement out of nothing. Score the covered portion
  // instead, and let the header say the capture is partial.
  const total = capture.complete === false && grid.length
    ? Math.min(capture.durationSec, grid[grid.length - 1].t + capture.stepSec)
    : capture.durationSec;
  const budget = Math.max(scan.minBudget,
    Math.min(scan.maxBudget, Math.round(total / scan.secondsPerProbe)));

  // `spent` is what the PLANNER must not re-pick: both the moments it asked for
  // and the grid points actually served. `probes` is what the BUDGET counts —
  // only real lookups. Conflating the two made one simulated probe cost two.
  const spent = new Set();
  const observations = [];
  let probes = 0;
  const take = (rawT) => {
    const t = Math.max(1, Math.min(total - lib.PROBE_SEC - 1, Math.round(rawT)));
    if (spent.has(t)) return false;
    let best = null;
    for (const o of grid) {
      const d = Math.abs(o.t - t);
      if (best === null || d < Math.abs(best.t - t)) best = o;
    }
    // Order matters: test the served point against `spent` BEFORE marking the
    // requested one, or a probe that lands exactly on its own grid point sees
    // itself as already taken and silently serves nothing.
    const already = best && spent.has(best.t);
    spent.add(t);
    // Never serve a probe the capture doesn't actually cover. Marking it spent
    // anyway keeps the planner from re-picking the same gap forever.
    if (!best || already || Math.abs(best.t - t) > capture.stepSec) return true;
    // Serve the captured observation AT ITS OWN TIMESTAMP, never at the one the
    // planner asked for. `matches[].offset` is a position inside the reference
    // recording measured at the moment the probe was actually taken, so pairing
    // it with a different `t` shifts every anchor by up to half the grid step —
    // more than PROOF_TOL — and manufactures or destroys proofs that the real
    // scan would never have seen. The planner's request is an intent; the
    // capture is the evidence, and only the evidence goes in.
    spent.add(best.t);
    probes++;
    observations.push(best);
    observations.sort((a, b) => a.t - b.t);
    return true;
  };

  for (const t of lib.seedPoints(total)) {
    if (probes >= budget) break;
    take(t);
  }
  for (const floors of scan.phases) {
    while (probes < budget) {
      const next = lib.planNextProbe(observations, total, floors, spent);
      if (next === null) break;
      take(next);
    }
    if (probes >= budget) break;
  }
  return { observations, budget, spent: probes };
}

// A chapter tracklist writes "ID" where the uploader could not name a track, and
// the recogniser sometimes CAN. Scoring those rows as wrong would penalise it
// for succeeding exactly where the human gave up — measured, one such row was a
// 22-sighting, chain-linear identification of a chapter marked "ID". So an ID
// entry becomes a window that is neither right nor wrong, and it is excluded
// from the recall denominator, since there is no name there to find.
const IS_ID = (g) => /^\s*ID\s*$/i.test(g.title || '');
// ±90 s: a chapter marks where the uploader thinks a track starts; the anchor is
// an independent estimate of the same boundary and they disagree by a little.
const ID_SLACK = 90;

function idWindows(truth, durationSec) {
  const w = [];
  truth.forEach((g, i) => {
    if (!IS_ID(g)) return;
    const end = i + 1 < truth.length ? truth[i + 1].offsetSec : durationSec;
    w.push([g.offsetSec - ID_SLACK, end + ID_SLACK]);
  });
  return w;
}

function scoreAgainst(tracks, truth, durationSec, coveredSec) {
  if (!truth || !truth.length) return null;
  const windows = idWindows(truth, durationSec);
  // Only grade against tracks the capture actually reached. An interrupted
  // capture would otherwise score every later track as a recall miss.
  const named = truth.filter((g) => !IS_ID(g) && g.offsetSec <= coveredSec);
  if (!named.length) return null;

  const hit = (t) => named.some((g) => same(t.title, g.title));
  const neutral = (t) => windows.some(([a, b]) => t.offsetSec >= a && t.offsetSec < b);

  // Precision is measured on the rows the UI presents as FACT. An `uncertain`
  // row is badged and left out of DOWNLOAD WHOLE SET, so scoring it as a
  // confident claim measures a promise the product does not make. They are not
  // swept away, though — `badged` is reported alongside, and a rule that hides
  // its mistakes by calling everything uncertain shows up there immediately.
  const judged = tracks.filter((t) => !neutral(t));
  const confident = judged.filter((t) => t.confidence !== 'uncertain');
  const found = named.filter((g) => tracks.some((t) => same(t.title, g.title)));
  return {
    recall: found.length / named.length,
    precision: confident.length ? confident.filter(hit).length / confident.length : 1,
    found: found.length,
    truth: named.length,
    unnamed: tracks.length - judged.length,
    badged: judged.length - confident.length,
  };
}

const pct = (x) => (x == null ? '  —  ' : `${(100 * x).toFixed(1).padStart(5)}%`);

function report(label, tracks, sim, truth, durationSec, coveredSec) {
  const tiers = { proven: 0, likely: 0, uncertain: 0 };
  for (const t of tracks) if (tiers[t.confidence] != null) tiers[t.confidence]++;
  const sc = scoreAgainst(tracks, truth, durationSec, coveredSec);
  const tierStr = tracks[0] && tracks[0].confidence
    ? `  ${tiers.proven}p/${tiers.likely}l/${tiers.uncertain}u` : '';
  console.log(
    `  ${label.padEnd(9)} ${String(tracks.length).padStart(3)} tracks   `
    + `probes ${String(sim.spent).padStart(3)}/${String(sim.budget).padStart(3)}   `
    + `recall ${pct(sc && sc.recall)}   precision ${pct(sc && sc.precision)}`
    + `${sc && sc.badged ? `  (+${sc.badged} badged)` : ''}`
    + `${sc && sc.unnamed ? `  +${sc.unnamed} in ID window` : ''}${tierStr}`,
  );
  return { tracks, sc };
}

async function main() {
  const corpusPath = path.join(here, 'corpus.json');
  const corpus = existsSync(corpusPath) ? JSON.parse(await readFile(corpusPath, 'utf8')) : {};

  let files = process.argv.slice(2);
  if (!files.length) {
    const dir = path.join(here, 'captures');
    const { readdir } = await import('node:fs/promises');
    files = existsSync(dir)
      ? (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f))
      : [];
  }
  if (!files.length) {
    console.error('No captures. Run: npx electron scripts/eval/capture.mjs <url>');
    process.exit(1);
  }

  // A capture still being written has too little of the set to mean anything;
  // averaging it in would quietly drag every headline number down.
  const MIN_USABLE_PROBES = 40;

  const totals = { baseline: [], current: [], ceiling: [] };
  for (const file of files) {
    const capture = JSON.parse(await readFile(file, 'utf8'));
    if (capture.observations.length < MIN_USABLE_PROBES) {
      console.log(`\n${capture.title || capture.id}  ·  only ${capture.observations.length} probes captured so far — skipped`);
      continue;
    }
    const entry = corpus[capture.id] || {};
    const truth = entry.tracks || null;
    console.log(`\n${capture.title || capture.id}  ·  ${Math.round(capture.durationSec / 60)} min  `
      + `·  ${capture.observations.length} captured probes`
      + `${truth ? ` · ${truth.length} known tracks` : ' · no ground truth'}`
      + `${capture.complete === false ? '  [PARTIAL CAPTURE]' : ''}`);
    // Ground truth is not automatically trustworthy just because a human wrote
    // it. Say so loudly rather than let a bad denominator quietly become the
    // number someone tunes against.
    if (entry.caveat) console.log(`  ⚠ ${entry.caveat}`);

    const b = simulate(capture, BASELINE_SCAN);
    const c = simulate(capture, CURRENT_SCAN);
    const all = { observations: capture.observations, budget: capture.observations.length, spent: capture.observations.length };

    const covered = capture.observations[capture.observations.length - 1].t;
    const r1 = report('baseline', baseline.tracklistFrom(b.observations, { minUnprovenHits: 3 }).tracks, b, truth, capture.durationSec, covered);
    const r2 = report('current', lib.tracklistFrom(c.observations, {}).tracks, c, truth, capture.durationSec, covered);
    const r3 = report('ceiling', lib.tracklistFrom(all.observations, {}).tracks, all, truth, capture.durationSec, covered);
    if (r1.sc) totals.baseline.push(r1.sc);
    if (r2.sc) totals.current.push(r2.sc);
    if (r3.sc) totals.ceiling.push(r3.sc);

    if (process.env.EVAL_LIST) {
      console.log('  ── current tracklist ──');
      for (const t of lib.tracklistFrom(c.observations, {}).tracks) {
        const m = Math.floor(t.offsetSec / 60);
        const s = String(t.offsetSec % 60).padStart(2, '0');
        const known = truth ? (truth.some((g) => same(t.title, g.title)) ? ' ' : '✗') : ' ';
        console.log(`   ${known} ${m}:${s}  [${t.confidence[0]}×${t.hits}] ${t.artist} — ${t.title}`);
      }
    }
  }

  for (const [name, rows] of Object.entries(totals)) {
    if (!rows.length) continue;
    const avg = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
    console.log(`\n${name.padEnd(9)} mean recall ${pct(avg('recall'))}   mean precision ${pct(avg('precision'))}  (${rows.length} sets)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
