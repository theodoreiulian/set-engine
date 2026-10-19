// Run the actual orchestration with deterministic recognition/network boundaries.
// No Electron window, external tools, or live provider requests are needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'setengine-extraction-test-'));
after(() => rm(tmp, { recursive: true, force: true }));
const bundle = path.join(tmp, 'extraction.mjs');
await build({
  stdin: {
    contents: `export { extractSet } from './src/main/set-extractor.js';
      export { default as Manager } from './src/main/extraction-manager.js';
      export { registerIpcHandlers } from './src/main/ipc-handlers.js';
      export { default as Wrapper } from './src/main/ytdlp-wrapper.js';
      export * from './src/main/sources.js';`,
    resolveDir: process.cwd(),
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm',
  plugins: [{ name: 'test-boundaries', setup(b) {
    const stubs = {
      'electron': `export const app = { getPath: () => ${JSON.stringify(tmp)} };
        export const ipcMain = { handle: (name, fn) => { (globalThis.extractionHandlers ||= {})[name] = fn; } };
        export const dialog = {}, net = {}, shell = {};`,
      'node-id3': `export default { update: () => true };`,
      './shazam/recognize.js': `export const recognize = (...args) => globalThis.extractionTest.recognize(...args);
        export const spotCheck = (...args) => globalThis.extractionTest.spotCheck(...args);`,
      './mixesdb.js': `export const lookupByVideoId = (...args) => globalThis.extractionTest.mixesdb(...args);`,
      './track-match.js': `export const resolveBestVideo = (...args) => globalThis.extractionTest.match(...args);`,
      './download-verify.js': `export const verifyDownloadedAudio = (...args) => globalThis.extractionTest.verify(...args);`,
    };
    b.onResolve({ filter: /^(electron|node-id3|\.\/shazam\/recognize\.js|\.\/mixesdb\.js|\.\/track-match\.js|\.\/download-verify\.js)$/ },
      ({ path }) => ({ path, namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: stubs[path], loader: 'js' }));
  } }],
});
const { extractSet, Manager, Wrapper, registerIpcHandlers, classifyExtractionUrl, expandShortLink } = await import(pathToFileURL(bundle));
const sc = 'https://soundcloud.com/dj/a-recorded-mix';
const yt = 'https://www.youtube.com/watch?v=abcdefghijk';
const entries = [
  { artist: 'Alpha', title: 'First', offsetSec: 0 },
  { artist: 'Bravo', title: 'Second', offsetSec: 200 },
  { artist: 'Charlie', title: 'Third', offsetSec: 400 },
];
const description = '00:00 Alpha - First\n03:20 Bravo - Second\n06:40 Charlie - Third';

function harness(info = {}) {
  const calls = { info: [], downloads: [], downloadOptions: [], verifications: [], scans: 0, spots: 0, mixes: 0, matches: 0, cancelled: 0 };
  globalThis.extractionTest = {
    recognize: async () => { calls.scans++; return { tracks: entries, gaps: [] }; },
    spotCheck: async () => { calls.spots++; return { answered: 0, observations: [] }; },
    mixesdb: async () => { calls.mixes++; return null; },
    match: async (...args) => { calls.matches++; const target = { url: 'https://soundcloud.com/artist/verified-track', durationSec: 200, provider: 'soundcloud' }; return !args[4]?.accept || await args[4].accept(target) ? target : null; },
    verify: async (...args) => { calls.verifications.push(args); try { await stat(args[0]); return { ok: true }; } catch { return { ok: false, reason: 'missing' }; } },
  };
  const ytDlp = {
    getVideoInfo: async (...args) => {
      calls.info.push(args);
      return { id: '123456789', title: 'A DJ mix', duration: 600, ...info };
    },
    download: (url, dir, options) => {
      calls.downloads.push(url);
      calls.downloadOptions.push(options);
      const dl = new EventEmitter();
      dl.cancel = () => { calls.cancelled++; };
      setImmediate(async () => {
        await writeFile(path.join(dir, `${options.filenameTemplate}.mp3`), 'fixture');
        dl.emit('complete');
      });
      return dl;
    },
  };
  return { calls, ytDlp, run: (url = sc, extra = {}) => extractSet(url, {
    ytDlp, cacheDir: path.join(tmp, `cache-${Math.random()}`), ...extra,
  }) };
}

test('accepts individual SoundCloud recordings and YouTube links; rejects collections and other services', () => {
  for (const url of [sc, 'soundcloud.com/dj/mix?si=abc', 'https://m.soundcloud.com/dj/mix',
    'https://soundcloud.com/dj/mix/s-secret', 'https://api.soundcloud.com/tracks/123',
    yt, `${yt}&list=PLabc`, 'https://youtu.be/abcdefghijk', 'https://music.youtube.com/watch?v=abcdefghijk']) {
    assert.ok(classifyExtractionUrl(url), url);
  }
  for (const url of ['https://soundcloud.com/dj', 'https://soundcloud.com/dj/sets/mixes',
    'https://soundcloud.com/dj/likes', 'https://soundcloud.com/search?q=mix',
    'https://api.soundcloud.com/playlists/123', 'https://youtube.com/playlist?list=PLabc',
    'https://notyoutube.com/watch?v=abcdefghijk', 'https://soundcloud.com.evil.com/dj/mix',
    'https://open.spotify.com/track/1234567890123456789012', '', null]) {
    assert.equal(classifyExtractionUrl(url), null, String(url));
  }
});

test('expands a SoundCloud mobile share link, including Electron responses with an empty URL', async () => {
  for (const response of [{ url: sc }, { url: '', text: async () => `<link rel="canonical" href="${sc}">` }]) {
    const expanded = await expandShortLink('https://on.soundcloud.com/example', { fetchImpl: async () => response });
    assert.equal(expanded, sc);
    assert.equal(classifyExtractionUrl(expanded).source, 'soundcloud');
  }
  assert.equal(await expandShortLink('https://on.soundcloud.com/broken', {
    fetchImpl: async () => { throw new Error('offline'); },
  }), 'https://on.soundcloud.com/broken');
});

test('SoundCloud description → spot check → ordered, verified downloadable tracks', async () => {
  const h = harness({ description });
  const result = await h.run();
  assert.equal(result.engine, 'published-description');
  assert.equal(result.tracks.length, 3);
  assert.deepEqual(result.tracks.map(t => t.title), ['First', 'Second', 'Third']);
  assert.ok(result.tracks.every(t => t.cachePath && t.sourceUrl && t.provider === 'soundcloud'));
  assert.equal(h.calls.spots, 1);
  assert.equal(h.calls.scans, 0);
  assert.equal(h.calls.mixes, 0);
  assert.equal(h.calls.info.length, 1); // No pointless YouTube comment pass.
  assert.equal(h.calls.downloads[0], sc);
  assert.equal(h.calls.downloads.length, 4);
  assert.equal(h.calls.info[0][2].noPlaylist, true);
  assert.equal(h.calls.downloadOptions[0].noPlaylist, true);
  const downloadedChecks = h.calls.verifications.filter(([file]) => file.includes('.track-'));
  assert.equal(downloadedChecks.length, 3);
  assert.ok(downloadedChecks.every(([, opts]) => opts.expectedDurationSec === 200));
});

test('SoundCloud without a published list scans audio and caches recognized tracks', async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.engine, 'shazam');
  assert.equal(h.calls.scans, 1);
  assert.equal(h.calls.spots, 0);
  assert.equal(h.calls.mixes, 0);
  assert.equal(h.calls.info.length, 1);
  assert.ok(result.tracks.every(t => t.source === 'shazam' && t.cachePath));
});

test('a partial SoundCloud list is supplemented by recognition', async () => {
  const h = harness({ duration: 4000, description });
  globalThis.extractionTest.recognize = async () => {
    h.calls.scans++;
    return { tracks: [{ artist: 'Delta', title: 'Missing Track', offsetSec: 1000 }], gaps: [] };
  };
  const result = await h.run();
  assert.equal(result.engine, 'published-description + shazam');
  assert.equal(result.supplemented, true);
  assert.equal(h.calls.scans, 1);
  assert.equal(result.tracks.length, 4);
  assert.equal(result.tracks[3].title, 'Missing Track');
  assert.equal(result.tracks[3].source, 'shazam');
});

test('unverifiable downloaded files are excluded from the prepared SoundCloud tracks', async () => {
  const h = harness({ description });
  globalThis.extractionTest.verify = async () => ({ ok: false, reason: 'truncated audio' });
  const result = await h.run();
  assert.equal(result.tracks.length, 3);
  assert.ok(result.tracks.every(t => !t.cachePath));
});

test('disabling published tracklists still scans SoundCloud', async () => {
  const h = harness({ description });
  const result = await h.run(sc, { settings: { usePublishedTracklist: false } });
  assert.equal(result.engine, 'shazam');
  assert.equal(h.calls.scans, 1);
});

test('YouTube retains MixesDB and comment fallback', async () => {
  const h = harness();
  h.ytDlp.getVideoInfo = async (...args) => {
    h.calls.info.push(args);
    return { id: 'abcdefghijk', duration: 600, description: args[2]?.withComments ? description : '' };
  };
  const result = await h.run(yt);
  assert.equal(result.engine, 'published-description');
  assert.equal(h.calls.mixes, 1);
  assert.equal(h.calls.info.length, 2);
  assert.equal(h.calls.info[1][2].withComments, true);
});

test('unexpected playlist metadata cannot start downloading or scanning', async () => {
  const h = harness({ _type: 'playlist', entries: [] });
  await assert.rejects(h.run(), /playlist/);
  assert.equal(h.calls.downloads.length, 0);
});

test('cancellation reaches the initial metadata request', async () => {
  const h = harness();
  const controller = new AbortController();
  h.ytDlp.getVideoInfo = async (_url, _cookies, opts) => {
    assert.equal(opts.signal, controller.signal);
    controller.abort();
    throw new Error('cancelled');
  };
  await assert.rejects(h.run(sc, { signal: controller.signal }), /cancelled/);
  assert.equal(h.calls.downloads.length, 0);
});

test('the job manager accepts SoundCloud, normalizes a schemeless link, and rejects playlists', async () => {
  harness({ description });
  const manager = new Manager(null, { getVideoInfo: async () => { throw new Error('fixture stop'); } }, { getAll: () => ({}) });
  const added = manager.addJob('soundcloud.com/dj/mix');
  assert.equal(added.success, true);
  assert.equal(manager.jobs.get(added.id).url, 'https://soundcloud.com/dj/mix');
  assert.equal(manager.addJob('https://soundcloud.com/dj/sets/mixes').success, false);
  assert.equal(manager.addJob(null).success, false);
  await new Promise(resolve => setImmediate(resolve));
});

test('metadata wrapper limits extraction to one recording without changing other lookups', () => {
  const wrapper = new Wrapper();
  assert.ok(wrapper.buildUrlInfoArgs({ url: sc, noPlaylist: true }).includes('--no-playlist'));
  assert.ok(!wrapper.buildUrlInfoArgs({ url: sc }).includes('--no-playlist'));
  assert.ok(wrapper.buildSongArgs({ url: yt, outputFolder: tmp, noPlaylist: true }).includes('--no-playlist'));
});


test('Play and Save share one cache repair and publish the result on the job', async () => {
  const h = harness();
  const manager = new Manager(null, h.ytDlp, { getAll: () => ({}) });
  const cacheDir = path.join(tmp, 'repair-job');
  manager.jobs.set('repair', { id: 'repair', status: 'done', cacheDir, tracks: [{ artist: 'Alpha', title: 'First' }] });
  const [play, save] = await Promise.all([manager.ensureTrackCache('repair', 0), manager.ensureTrackCache('repair', 0)]);
  assert.equal(play.cachePath, save.cachePath);
  assert.equal(h.calls.downloads.length, 1);
  assert.equal(manager.getJobs()[0].tracks[0].cachePath, play.cachePath);
  await rm(play.cachePath);
  await manager.ensureTrackCache('repair', 0);
  assert.equal(h.calls.downloads.length, 2);
  await manager.deleteJob('repair');
  await assert.rejects(stat(cacheDir));
  await assert.rejects(manager.ensureTrackCache('repair', 0), /no longer available/);
});


test('extraction Play, single Save and whole-set Save repair the cache and copy its audio', async () => {
  const h = harness();
  const outputDir = path.join(tmp, 'saved-tracks');
  const settings = { getAll: () => ({ downloadFolder: outputDir }) };
  const manager = new Manager(null, h.ytDlp, settings);
  const cacheDir = path.join(tmp, 'ipc-job');
  manager.jobs.set('ipc', { id: 'ipc', status: 'done', cacheDir,
    tracks: [{ artist: 'Alpha', title: 'First' }, { artist: 'Bravo', title: 'Second' }], trackDownloads: {} });
  registerIpcHandlers(null, h.ytDlp, null, { addDownload: () => assert.fail('Extraction must save through its cache') }, settings, manager, null);
  const handlers = globalThis.extractionHandlers;
  const played = await handlers['extract:cache-track'](null, { jobId: 'ipc', trackIndex: 0 });
  assert.equal(played.success, true);
  const saved = await handlers['download:track'](null, { jobId: 'ipc', trackIndex: 0, title: 'First', query: 'Alpha First', outputDir });
  assert.equal(saved.copied, true);
  assert.deepEqual(await readFile(path.join(outputDir, 'First.mp3')), await readFile(played.track.cachePath));
  const batch = await handlers['download:tracks'](null, { jobId: 'ipc', indices: [1], tracks: [{ artist: 'Bravo', title: 'Second' }], outputDir });
  assert.equal(batch.success, true);
  assert.deepEqual(await readFile(path.join(outputDir, 'Second.mp3')), await readFile(manager.jobs.get('ipc').tracks[1].cachePath));
  assert.equal(h.calls.downloads.length, 2);
  assert.deepEqual(manager.jobs.get('ipc').trackDownloads, { 0: 'copied-0', 1: 'copied-1' });
});
