// SetEngine — build step for the recognition evaluation harness (dev only).
//
// The harness has to run the app's OWN recognition code, not a copy of it — a
// copy would drift and then measure the wrong thing. But `src/` is ESM `.js`
// with no `"type": "module"` in package.json (deliberately: the Vite builds
// handle module format, and CLAUDE.md says not to rely on it), so plain Node
// cannot import those files directly.
//
// So bundle them with esbuild, ESM output, every node_modules import left
// EXTERNAL.
//
// ESM output specifically, not CJS: signature.js does
// `createRequire(import.meta.url)`, and esbuild cannot give `import.meta` a
// value in a CJS bundle — it compiles to `{}`, createRequire('') throws, and
// every probe fails with "Couldn't load the Shazam signature module".
//
// Leaving node_modules external is equally load-bearing —
// `shazamio-core` reads its .wasm relative to its own __dirname, so it must stay
// unbundled (see the long comment in src/main/shazam/signature.js), and
// `electron` must stay external because only the real Electron runtime provides
// `net.fetch`, which is the only client Shazam's edge answers.

import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

// The BASELINE bundle is the acceptance code as it was before this work, pulled
// straight out of git rather than re-implemented from memory. A hand-written
// "what it used to do" would be the one part of the measurement nobody could
// check, and it is precisely the number every claim of improvement rests on.
async function writeBaseline() {
  const src = execSync('git show HEAD:src/main/shazam/anchor.js', { cwd: path.join(here, '..', '..') }).toString();
  await mkdir(path.join(here, '.build'), { recursive: true });
  await writeFile(path.join(here, '.build', 'anchor-baseline.mjs'), src);
  console.log('[eval] wrote scripts/eval/.build/anchor-baseline.mjs (from git HEAD)');
}

const only = process.argv[2];                       // 'capture' | 'lib' | undefined
const entries = ['capture-entry', 'lib-entry'].filter((e) => !only || e.startsWith(only));

// The scoring half runs under plain Node, where `import { net } from 'electron'`
// cannot resolve. It never makes a request (it replays a capture), so point that
// one import at a stub that throws if anything ever calls it.
const stubElectron = {
  name: 'stub-electron',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: path.join(here, 'electron-stub.js') }));
  },
};

for (const name of entries) {
  await build({
    entryPoints: [path.join(here, `${name}.js`)],
    plugins: name === 'lib-entry' ? [stubElectron] : [],
    outfile: path.join(here, '.build', `${name.replace('-entry', '')}.mjs`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    target: 'node20',
    logLevel: 'warning',
  });
  console.log(`[eval] built scripts/eval/.build/${name.replace('-entry', '')}.mjs`);
}

if (!only || only === 'lib') await writeBaseline();
