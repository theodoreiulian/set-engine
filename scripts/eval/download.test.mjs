// Exercise the production URL classifier and queue with deterministic wrappers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'setengine-download-test-'));
after(() => rm(tmp, { recursive: true, force: true }));
const bundle = path.join(tmp, 'download.mjs');
await build({
  stdin: { contents: `export { default as Manager } from './src/main/download-manager.js';
    export * from './src/main/sources.js';
    export { fetchCatalog } from './src/main/catalog-sources.js';`, resolveDir: process.cwd() },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm',
});
const { Manager, classifyUrl, classifyExtractionUrl, fetchCatalog } = await import(pathToFileURL(bundle));
const albumId = '1234567890123456789012';
const spotify = `https://open.spotify.com/album/${albumId}`;
const sc = 'https://soundcloud.com/artist/song';
const scAlbum = 'https://soundcloud.com/artist/sets/album';
const ytAlbum = 'https://music.youtube.com/browse/MPREb_gTAcphH99wE';
const ytPlayAlbum = 'https://music.youtube.com/watch?v=abcdefghijk&list=OLAK5uy_album';

function wrapper(entries = [{ id: 'one', url: sc, title: 'First' }, { id: 'two', url: `${sc}2`, title: 'Second' }]) {
  const calls = { metadata: [], lists: [], downloads: [] };
  return {
    calls,
    getVersion: async () => '4.4.0',
    getVideoInfo: async (...args) => { calls.metadata.push(args); return { title: 'A song' }; },
    getPlaylistInfo: async (...args) => { calls.lists.push(args); return { title: 'An album', entries }; },
    download: (...args) => {
      calls.downloads.push(args);
      const dl = new EventEmitter();
      dl.cancel = () => {};
      setImmediate(() => dl.emit('complete'));
      return dl;
    },
  };
}
async function finished(manager, id) {
  for (let i = 0; i < 30; i++) {
    const item = manager.queue.get(id);
    if (item.status === 'complete' || item.status === 'error') return item;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Queue did not finish');
}

test('classifies SoundCloud songs, albums, playlists, mobile links, and API links', () => {
  for (const [url, kind] of [[sc, 'track'], [scAlbum, 'playlist'],
    ['https://m.soundcloud.com/artist/sets/playlist', 'playlist'],
    ['https://api.soundcloud.com/playlists/123', 'playlist']]) {
    assert.equal(classifyUrl(url).source, 'soundcloud');
    assert.equal(classifyUrl(url).kind, kind);
  }
});

test('recognizes Spotify albums in localized, embedded, and URI forms', () => {
  for (const url of [spotify, `https://open.spotify.com/intl-fr/album/${albumId}?si=test`,
    `https://open.spotify.com/embed/album/${albumId}`, `spotify:album:${albumId}`]) {
    assert.equal(classifyUrl(url).kind, 'playlist');
    assert.equal(classifyUrl(url).type, 'album');
  }
});

test('recognizes YouTube Music album pages, album playlists, and album playback links', () => {
  for (const url of [ytAlbum, ytPlayAlbum, 'https://www.youtube.com/playlist?list=OLAK5uy_album',
    'https://youtu.be/abcdefghijk?list=OLAK5uy_album']) {
    assert.equal(classifyUrl(url).kind, 'playlist', url);
    assert.equal(classifyUrl(url).type, 'album', url);
  }
  assert.equal(classifyExtractionUrl(ytPlayAlbum).kind, 'track');
  assert.equal(classifyExtractionUrl(ytAlbum), null);
  assert.equal(classifyUrl('https://notyoutube.com/watch?v=abcdefghijk'), null);
});

test('SoundCloud single songs use the direct downloader', async () => {
  const yt = wrapper(); const spot = wrapper(); const catalog = wrapper();
  const manager = new Manager(null, yt, spot, catalog);
  const item = await finished(manager, await manager.addDownload(sc, null));
  assert.equal(item.source, 'soundcloud');
  assert.equal(item.type, 'song');
  assert.equal(item.status, 'complete');
  assert.equal(yt.calls.downloads[0][0], sc);
  assert.equal(yt.calls.downloads[0][2].noPlaylist, true);
  assert.equal(spot.calls.downloads.length + catalog.calls.downloads.length, 0);
});

test('SoundCloud album / playlist expands every entry and keeps id-only entries on SoundCloud', async () => {
  const yt = wrapper([{ id: '123', title: 'One' }, { id: '456', url: sc, title: 'Two' }]);
  const manager = new Manager(null, yt, wrapper(), wrapper());
  const item = await finished(manager, await manager.addDownload(scAlbum, null));
  assert.equal(item.status, 'complete');
  assert.equal(item.children.length, 2);
  assert.equal(yt.calls.lists[0][0], scAlbum);
  assert.deepEqual(yt.calls.downloads.map(args => args[0]), ['https://api.soundcloud.com/tracks/123', sc]);
  assert.ok(item.children.every(child => child.source === 'soundcloud' && child.status === 'complete'));
});

for (const installed of [true, false]) {
  test(`Spotify album expands through ${installed ? 'spotdl' : 'the catalog fallback'}`, async () => {
    const yt = wrapper(); const spot = wrapper(); const catalog = wrapper();
    spot.getVersion = async () => installed ? '4.4.0' : null;
    const manager = new Manager(null, yt, spot, catalog);
    const item = await finished(manager, await manager.addDownload(`spotify:album:${albumId}`, null));
    assert.equal(item.status, 'complete');
    assert.equal(item.children.length, 2);
    const used = installed ? spot : catalog;
    assert.equal(used.calls.lists[0][0], spotify);
    assert.equal(used.calls.downloads.length, 2);
    assert.equal(yt.calls.downloads.length, 0);
  });
}

test('YouTube Music albums expand while radio links stay single songs', async () => {
  for (const url of [ytAlbum, ytPlayAlbum]) {
    const yt = wrapper(); const manager = new Manager(null, yt, wrapper(), wrapper());
    const item = await finished(manager, await manager.addDownload(url, null));
    assert.equal(item.status, 'complete');
    assert.equal(item.children.length, 2);
    assert.equal(yt.calls.lists[0][0], url);
    assert.equal(yt.calls.downloads.length, 2);
  }
  const yt = wrapper(); const manager = new Manager(null, yt, wrapper(), wrapper());
  const item = await finished(manager, await manager.addDownload('https://music.youtube.com/watch?v=abcdefghijk&list=RDAMVMabcdefghijk', null));
  assert.equal(item.type, 'song');
  assert.equal(yt.calls.lists.length, 0);
  assert.equal(yt.calls.downloads[0][0], 'https://music.youtube.com/watch?v=abcdefghijk');
});

test('Spotify catalog reader preserves album order, titles, and track URLs', async () => {
  const entity = { name: 'Test Album', subtitle: 'Test Artist', trackList: [
    { uri: `spotify:track:${'a'.repeat(22)}`, title: 'First', subtitle: 'Test Artist', duration: 180000 },
    { uri: `spotify:track:${'b'.repeat(22)}`, title: 'Second', subtitle: 'Test Artist', duration: 240000 },
  ] };
  const data = { props: { pageProps: { state: { data: { entity } } } } };
  const result = await fetchCatalog(spotify, { fetchImpl: async () => ({ ok: true,
    text: async () => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>` }) });
  assert.equal(result.tracks.length, 2);
  assert.deepEqual(result.tracks.map(t => t.title), ['First', 'Second']);
  assert.deepEqual(result.tracks.map(t => t.trackNumber), [1, 2]);
  assert.equal(result.tracks[0].album, 'Test Album');
  assert.equal(result.tracks[0].url, `https://open.spotify.com/track/${'a'.repeat(22)}`);
});
