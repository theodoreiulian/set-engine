// Re-export exactly the app modules the harness measures. Bundled by build.mjs.
// Nothing here is a re-implementation: the planner, the acceptance rules and the
// title comparison are the shipped ones, so a measurement can't drift away from
// what the app actually does.
export {
  planNextProbe, seedPoints, probeBudgetFor, PROBE_SEC, FLOOR_PHASES,
} from '../../src/main/shazam/recognize.js';
export * from '../../src/main/shazam/anchor.js';
export { titleSimilarity, identityKey } from '../../src/main/track-merge.js';
