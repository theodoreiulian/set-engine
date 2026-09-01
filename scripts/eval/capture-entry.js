// Probe surface only — what capture.cjs needs. Kept separate from lib-entry.js
// so a capture (which costs ~20 min of real requests) never has to wait on the
// scoring code building.
export { probeMoment, newProbeState, runtimeOf, PROBE_SEC } from '../../src/main/shazam/recognize.js';
