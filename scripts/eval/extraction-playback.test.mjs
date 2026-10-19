import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'extraction-playback-'));
after(() => { delete globalThis.window; return rm(tmp, { recursive: true, force: true }); });
const bundle = path.join(tmp, 'page.mjs');
await build({ entryPoints: ['src/renderer/pages/extract.js'], bundle: true, format: 'esm', outfile: bundle,
  plugins: [{ name: 'toast', setup(b) {
    b.onResolve({ filter: /toast\.js$/ }, () => ({ path: 'toast', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export function showToast() {}' }));
  } }],
});
const { ExtractPage } = await import(pathToFileURL(bundle));
function page() {
  const requests = [];
  globalThis.window = { setengine: { cacheExtractionTrack: (jobId, index) => new Promise(resolve => requests.push({ jobId, index, resolve })) } };
  const p = Object.assign(Object.create(ExtractPage.prototype), {
    selectedJobId: 'job', view: 'detail', playingIndex: -1,
    audio: { src: '', paused: true, play: async function () { this.paused = false; }, pause() { this.paused = true; } },
    _updateTrackRows() {}, _renderView() {},
  });
  return { p, requests };
}
const prepared = file => ({ success: true, track: { cachePath: `/cache/${file}.mp3` } });

test('Play repairs uncached audio and uses the path returned by main', async () => {
  const { p, requests } = page();
  const pending = p._togglePlay(0, { title: 'First' });
  assert.equal(p.audio.src, '');
  requests[0].resolve(prepared('first'));
  await pending;
  assert.equal(p.playingIndex, 0);
  assert.equal(p.audio.paused, false);
  assert.ok(p.audio.src.endsWith(Buffer.from('/cache/first.mp3').toString('base64url')));
});

test('a slow cache repair cannot override a later Play click', async () => {
  const { p, requests } = page();
  const first = p._togglePlay(0, { title: 'First' });
  const second = p._togglePlay(1, { title: 'Second' });
  requests[1].resolve(prepared('second'));
  await second;
  requests[0].resolve(prepared('first'));
  await first;
  assert.equal(p.playingIndex, 1);
});

test('leaving and reopening a job does not start an old pending preview', async () => {
  const { p, requests } = page();
  const pending = p._togglePlay(0, { title: 'First' });
  p._goToList();
  p._openJob('job');
  requests[0].resolve(prepared('first'));
  await pending;
  assert.equal(p.audio.src, '');
  assert.equal(p.playingIndex, -1);
});
