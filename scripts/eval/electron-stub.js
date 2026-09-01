// Stand-in for `electron` when the harness's scoring half runs under plain Node.
//
// score.mjs imports the real planner and acceptance code out of recognize.js,
// and that module imports `net` from electron for the lookup path. Scoring never
// makes a request — it replays a capture — so the import just needs to resolve.
// It throws rather than returning something plausible: if a scoring run ever
// does reach the network, that is a bug in the harness and it should say so
// loudly instead of quietly measuring live results as if they were captured.
export const net = {
  fetch() { throw new Error('scripts/eval/score.mjs must never make a live request — replay a capture instead.'); },
};
export default { net };
