import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'extraction-cache-test-'));
after(() => rm(tmp, { recursive: true, force: true }));
const bundle = path.join(tmp, 'cache.mjs');
await build({
  stdin: { contents: `export { cacheTrack } from './src/main/extraction-cache.js';
    export { resolveBestVideo, verifyCandidate, coreTitle } from './src/main/track-match.js';`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', outfile: bundle,
  plugins: [{ name: 'verification', setup(b) {
    b.onResolve({ filter: /download-verify\.js$/ }, () => ({ path: 'verify', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      import { readFile } from 'node:fs/promises';
      export async function verifyDownloadedAudio(file) {
        try { return { ok: (await readFile(file, 'utf8')) === 'complete', reason: 'truncated audio' }; }
        catch { return { ok: false, reason: 'missing' }; }
      }` }));
  } }],
});
const { cacheTrack, resolveBestVideo, verifyCandidate, coreTitle } = await import(pathToFileURL(bundle));
const candidate = (id, provider = 'youtube') => ({ id, url: `https://${provider}.com/${id}`, title: 'Alpha - First', duration: 200, prefetched: true, provider });
const empty = async () => ({ ok: true, results: [] });
function wrapper({ youtube = [candidate('bad')], soundcloud = [candidate('good', 'soundcloud')], fail = true } = {}) {
  const downloads = [];
  return {
    downloads,
    searchMusic: async () => ({ ok: true, results: youtube }),
    searchYouTube: empty,
    searchSoundCloud: async () => ({ ok: true, results: soundcloud }),
    download(url, dir, opts) {
      downloads.push(url);
      const dl = new EventEmitter();
      dl.cancel = () => {};
      setImmediate(async () => {
        if (fail && url.endsWith('/bad')) { dl.emit('error', new Error('Media unavailable')); return; }
        await writeFile(path.join(dir, `${opts.filenameTemplate}.mp3`), url.endsWith('/short') ? 'truncated' : 'complete');
        dl.emit('complete');
      });
      return dl;
    },
  };
}
async function run(w) {
  const cacheDir = await mkdtemp(path.join(tmp, 'job-'));
  const track = { artist: 'Alpha', title: 'First' };
  await cacheTrack(track, { ytDlp: w, cacheDir });
  return { track, cacheDir };
}

test('failed YouTube media falls through to SoundCloud, publishes playable cache and reuses it', async () => {
  const w = wrapper();
  const { track, cacheDir } = await run(w);
  assert.equal(track.provider, 'soundcloud');
  assert.equal(await readFile(track.cachePath, 'utf8'), 'complete');
  assert.equal(w.downloads.length, 2);
  assert.equal((await readdir(cacheDir)).length, 1);
  await cacheTrack(track, { ytDlp: w, cacheDir });
  assert.equal(w.downloads.length, 2);
});

test('a truncated candidate is discarded before another YouTube upload succeeds', async () => {
  const w = wrapper({ youtube: [candidate('short'), candidate('good')], soundcloud: [] });
  const { track, cacheDir } = await run(w);
  assert.ok(track.sourceUrl.endsWith('/good'));
  assert.equal(w.downloads.length, 2);
  assert.equal((await readdir(cacheDir)).length, 1);
});

test('slow searches do not consume the next provider verification budget', async () => {
  const now = Date.now;
  let clock = now();
  Date.now = () => clock;
  try {
    const w = wrapper();
    w.searchMusic = async () => { clock += 90000; return { ok: true, results: [] }; };
    w.searchYouTube = async () => { clock += 90000; return { ok: true, results: [] }; };
    const target = await resolveBestVideo(w, 'Alpha First', 'First', 'Alpha');
    assert.equal(target.provider, 'soundcloud');
  } finally { Date.now = now; }
});

test('wrong artist and wrong remix are never downloaded to fill a missing cache', async () => {
  const w = wrapper({ youtube: [{ ...candidate('wrong'), title: 'Bravo - First' }, { ...candidate('remix'), title: 'Alpha - First (Other Remix)' }], soundcloud: [] });
  await assert.rejects(run(w), /No verified recording/);
  assert.deepEqual(w.downloads, []);
});

test('cancellation during download stops fallback and removes attempt files', async () => {
  const w = wrapper();
  const controller = new AbortController();
  let cancelled = false;
  w.download = () => {
    const dl = new EventEmitter();
    dl.cancel = () => { cancelled = true; };
    setImmediate(() => controller.abort());
    return dl;
  };
  const cacheDir = await mkdtemp(path.join(tmp, 'cancel-'));
  await assert.rejects(cacheTrack({ artist: 'Alpha', title: 'First' }, { ytDlp: w, cacheDir, signal: controller.signal }), /cancelled/);
  assert.equal(cancelled, true);
  assert.deepEqual(await readdir(cacheDir), []);
});


test('the reported mix: Rmx abbreviates Remix without allowing the wrong remixer or original', () => {
  const title = 'La Musika Tremenda (Yves Deruyter Remix)';
  const want = { artist: 'Ramirez', title, core: coreTitle(title) };
  const info = { title: 'Ramirez - La Musika Tremenda (Yves Deruyter Rmx)', duration: 300 };
  assert.equal(verifyCandidate(info, want).ok, true);
  assert.equal(verifyCandidate({ ...info, title: 'Ramirez - La Musika Tremenda (Other Rmx)' }, want).ok, false);
  assert.equal(verifyCandidate(info, { ...want, title: 'La Musika Tremenda', core: coreTitle('La Musika Tremenda') }).ok, false);
});


test('the reported mix: Rank1 matches Rank 1 while another artist or remix does not', () => {
  const title = 'Airwave (Radio Vocal Edit)';
  const want = { artist: 'Rank 1', title, core: coreTitle(title) };
  const info = { title: 'Rank1 : Airwave (Radio Vocal Edit)', duration: 180 };
  assert.equal(verifyCandidate(info, want).ok, true);
  assert.equal(verifyCandidate({ ...info, title: 'Frank1 : Airwave (Radio Vocal Edit)' }, want).ok, false);
  assert.equal(verifyCandidate({ ...info, title: 'Rank1 - Airwave (Matty remix)' }, want).ok, false);
});


test('the reported mix: searches without the quoted subtitle while enforcing the Heart Beat version', async () => {
  const title = 'Ambulance "Your Life Force Is Running Out!" (Heart Beat Mix)';
  const want = { artist: 'DJ AIRIC', title, core: coreTitle(title) };
  const info = { title: 'Ambulance (Heart Beat Mix)', artist: 'DJ Airic', duration: 300 };
  assert.equal(verifyCandidate(info, want).ok, true);
  assert.equal(verifyCandidate({ ...info, title: 'Ambulance (Central Seven Remix)' }, want).ok, false);
  assert.equal(verifyCandidate({ ...info, artist: 'Somebody Else' }, want).ok, false);
  const queries = [];
  const w = {
    searchMusic: async q => { queries.push(q); return { ok: true, results: q.includes('Your Life') ? [] : [{ url: 'https://youtube.com/ambulance', title: info.title }] }; },
    searchYouTube: empty, searchSoundCloud: empty, getVideoInfo: async () => info,
  };
  const result = await resolveBestVideo(w, `DJ AIRIC ${title}`, title, 'DJ AIRIC');
  assert.equal(result.url, 'https://youtube.com/ambulance');
  assert.deepEqual(queries, [`DJ AIRIC ${title}`, 'DJ AIRIC Ambulance (Heart Beat Mix)']);
});
