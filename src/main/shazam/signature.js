// SetEngine — Shazam signature generation
//
// Wraps `shazamio-core`, a zero-dependency WASM port of Shazam's own signature
// generator, and keeps every WASM detail in this one file.
//
// Why a dependency at all, in a codebase that hand-rolls its DSP: the landmark
// scheme in dsp.js is *ours*, so we only had to be self-consistent. Shazam's
// wire format is *theirs* — a specific peak layout and binary serialization that
// has to be reproduced exactly or the endpoint silently returns no match, with
// no diagnostic. Reimplementing that from a reverse-engineered spec would be
// several hundred lines of guesswork with an opaque failure mode. The package
// has no dependencies of its own and ships one .wasm file, so the cost is small.
//
// Loaded through `createRequire`, not `import`, for two reasons: the package is
// CommonJS, and — more importantly — a runtime require is invisible to Vite, so
// the module is never bundled. That matters because its loader does
// `fs.readFileSync(path.join(__dirname, 'shazamio-core_bg.wasm'))`; bundling it
// would rewrite __dirname to `.vite/build` and the .wasm would not be found.
// Keeping it external means no vite.main.config.mjs change is needed.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let core = null;

function load() {
  if (core) return core;
  try {
    core = require('shazamio-core');
  } catch (err) {
    throw new Error(`Couldn't load the Shazam signature module (shazamio-core): ${err.message}`);
  }
  return core;
}

/**
 * Build a Shazam signature from mono PCM.
 *
 * @param {Float32Array} pcm mono samples
 * @param {number} sampleRate Hz
 * @returns {{ uri: string, samplems: number }} the two fields the endpoint wants
 */
export function signatureFor(pcm, sampleRate) {
  const mod = load();
  const sig = mod.DecodedSignature.new(pcm, sampleRate, 1);
  try {
    // Copy the fields out before freeing — they're views into WASM memory.
    return { uri: sig.uri, samplems: sig.samplems };
  } finally {
    // The WASM object holds a manual allocation; without this a long scan leaks
    // one signature buffer per probe.
    try { sig.free(); } catch (_) { /* already freed */ }
  }
}
