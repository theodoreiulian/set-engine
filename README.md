# SetEngine

A desktop toolkit for DJs. Download tracks, find out what's playing in a set, analyze your crate, and build setlists that mix in key.

Paste a link to a song, playlist, or album from YouTube, YouTube Music, or Spotify and the download starts. Beyond downloading, SetEngine fingerprints a recorded DJ set to recover its tracklist, detects BPM and musical key offline, surfaces harmonically compatible tracks for mixing, and sequences setlists by Camelot key compatibility.

It uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) and, for Spotify, [spotdl](https://github.com/spotDL/spotify-downloader) under the hood. The macOS app comes with everything it needs built in; on Windows and Linux you install the tools once during setup.

**macOS · Windows · Linux**

---

## What it does

SetEngine has four areas:

1. **Download.** Paste a link to a song, playlist, or album from YouTube, YouTube Music, or Spotify and it downloads MP3s. It works out the source and whether it's a single track or a full list from the link itself.
2. **Set Extraction** (beta). Paste a link to a recorded YouTube DJ set and it identifies the tracks that were played, then lets you download each one or grab the whole set.
3. **Set Maker.** Analyze a folder of your music for BPM and key, rate your tracks, and build a setlist that's ordered to mix in key. Import and export playlist files.
4. **Match Maker.** Load in your library and get mixing suggestions for any track you pick. Tier 1 is the same key, Tier 2 is one semitone away, and you choose how far apart the BPMs are allowed to be.

## Features

- **Paste and download.** Drop a link from YouTube, YouTube Music, or Spotify. SetEngine works out whether it's one track or a whole playlist or album.
- **Spotify too.** Spotify links download from the same box once spotdl is installed.
- **Download queue.** Up to 5 downloads run at once, and they go faster when aria2c is installed.
- **Set Extraction.** Point it at a recorded DJ set and it produces the tracklist, then you download the tracks individually or grab the whole set. It works in two stages: if the uploader already published a tracklist (YouTube chapters or timestamps in the description) SetEngine just uses it — that's exact, instant, and it doesn't even download the set. Otherwise it identifies tracks from the audio — **no API key, no account, no cost.** Your machine computes the fingerprint and sends only that; your audio is never uploaded.
- **BPM and key detection.** It works out the BPM and key of your local files right on your computer, double-checks the BPM against Deezer's free database, and writes both into the file's tags.
- **Match Maker.** Pick a track and see what mixes well in key, grouped by how close the keys sit on the Camelot wheel and filtered by how far apart the BPMs can be.
- **Set Maker.** Build setlists where every transition stays in key, star-rate your tracks, and import or export playlist files.

## Install on macOS

**[Download SetEngine.dmg](https://github.com/theodoreiulian/set-engine/releases/latest/download/SetEngine.dmg)**, open it, and drag **SetEngine** onto **Applications**. That's the whole install.

- Works on macOS 12 (Monterey) and later, on both Apple Silicon and Intel Macs. It is one download for both.
- Nothing else to install. yt-dlp, ffmpeg and a small JavaScript runtime are inside the app, and SetEngine keeps its yt-dlp up to date by itself.
- Spotify links are the one exception: they need [spotdl](https://github.com/spotDL/spotify-downloader), which the app can't include. SetEngine tells you how to add it the first time you paste a Spotify link. Everything else works without it.

### The first time you open it

SetEngine isn't signed with a paid Apple developer certificate, so macOS won't open it on a plain double-click the first time. You only do this once:

1. Double-click SetEngine. macOS says it could not verify the app. Click **Done**.
2. Open **System Settings → Privacy & Security** and scroll down to the message about SetEngine.
3. Click **Open Anyway**, then confirm.

On macOS 12–14 you can instead right-click the app and choose **Open**. After that it opens normally.

### Updating

Download the new `SetEngine.dmg` and drag it onto Applications again, replacing the old copy. Your settings are kept.

## Run from source (Windows, Linux, or development)

```bash
# macOS / Linux
git clone https://github.com/theodoreiulian/set-engine.git
cd set-engine
npm run setup

# Windows
.\scripts\setup.ps1
```

The setup script checks Node.js (18 or newer), installs the app's dependencies, and makes sure the tools SetEngine relies on are present:

| Tool    | Required | Purpose                                            |
|---------|----------|----------------------------------------------------|
| yt-dlp  | **yes**  | Downloads audio from YouTube                       |
| ffmpeg  | **yes**  | Converts downloads to MP3 and reads audio for BPM and key detection |
| aria2c  | optional | Faster downloads                                   |
| spotdl  | optional | Spotify downloads                                  |

Missing tools? The setup script prints the exact install commands for your platform. Once everything is green:

```bash
npm start
```

## Building the macOS installer

```bash
npm run dist:mac
```

This produces `out/make/SetEngine.dmg`, the same file the releases page serves. It runs three steps: `scripts/fetch-tools.mjs` downloads and checksums the tools that ship inside the app (and compiles QuickJS), Electron Forge builds one universal app for Apple Silicon and Intel, and `scripts/make-dmg.mjs` wraps it in a disk image with the styled install window. It needs macOS with the Xcode Command Line Tools and `python3`. The first run downloads about 150 MB of tools and sets up [dmgbuild](https://github.com/dmgbuild/dmgbuild); later runs reuse both from `vendor/`.

The install window's artwork lives in `assets/dmg/`. To change it, edit `scripts/icon/make-dmg-background.mjs` (or the positions in `assets/dmg/layout.json`) and run `node scripts/icon/make-dmg-background.mjs`.

To publish a release, push a tag that matches the version in `package.json`. The workflow in `.github/workflows/release.yml` builds the installer and attaches it to a GitHub Release:

```bash
npm version 1.0.1
git push --follow-tags
```

`npm run install-app` is the shortcut for your own machine: it builds for your Mac's architecture only and copies the app straight into `/Applications`.

### Signing

Without an Apple Developer ID the build is ad-hoc signed, which is why first launch needs the "Open Anyway" step above. With a Developer ID Application certificate in your keychain, set these before `npm run dist:mac` and the app is signed with the hardened runtime and notarized:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_APP_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
```

This path is configured in `forge.config.js` but **has not been run yet**, because it needs a paid Apple Developer account. Expect to adjust it the first time. The disk image itself then needs notarizing and stapling too (`xcrun notarytool submit out/make/SetEngine.dmg --wait`, then `xcrun stapler staple out/make/SetEngine.dmg`).

## Usage

1. **Download.** Paste a YouTube, YouTube Music, or Spotify link, pick where to save it, and hit DOWNLOAD.
2. **Download Queue.** Watch progress, retry anything that failed, cancel, or clear finished items.
3. **Set Extraction.** Paste a set link, let it work out the tracklist, then download individual tracks or the whole set.
4. **Set Maker.** Analyze a folder for BPM and key, rate your tracks, and build a setlist that's ordered to mix in key.
5. **Match Maker.** Load your library and see what mixes with any track.

Where downloads get saved is set right on the Download page. Everything else lives in **Settings**:

- **Bitrate.** 128, 192, or 320 kbps.
- **Filename format.** Either *Title* or *Title and Artist*. Either way, the artist is always saved into the file's tags.
- **Set Extraction.** A toggle for whether to use the uploader's own tracklist when one exists (leave it on), and how confident a match has to be before it's kept. There is no engine to choose and no key to enter — that's deliberate.

  A caveat worth knowing: identification talks to an endpoint that isn't a published API, so it can stop working without warning. If it does, sets with a published tracklist keep working; the rest can't be identified until it's fixed.

Downloads run 5 at a time. That's fixed, to stay under YouTube's limits, so it isn't something you set.

> **Heads up:** Set Extraction is still in beta. It names tracks by listening to the audio, which doesn't always get it right. Unreleased IDs, bootlegs, mashups, and heavily-edited tracks often can't be matched. Treat the tracklist as a starting point.

## Architecture

Electron app with strict context isolation across three tiers:

| Tier         | Path             | Role                                                        |
|--------------|------------------|-------------------------------------------------------------|
| Main process | `src/main.js` + `src/main/` | binary orchestration, IPC, recognition HTTP, local and stream audio protocols |
| Preload      | `src/preload.js` | `contextBridge` API contract (`window.setengine`)           |
| Renderer     | `src/renderer/`  | vanilla JS, no framework; a small page router                |

Key modules:

- `ytdlp-wrapper.js` / `spotdl-wrapper.js`: the only modules that spawn the binaries; shared output-filename templating
- `download-manager.js`: download queue and concurrency (engine chosen per item's source)
- `extraction-manager.js` + `set-extractor.js`: the Set Extraction job system and per-job pipeline
- `shazam/`: on-device fingerprinting + the recognition lookup
- `tracklist-sources.js`: pulls a published tracklist out of YouTube chapters / description
- `segmenter.js`: finds the transitions in a set so recognition only probes once or twice per track
- `track-match.js`: resolves a recognized "Artist Title" to a concrete YouTube URL
- `key-bpm-detector.js` / `audio-analyzer.js` / `dsp.js`: offline BPM and key detection and feature extraction
- `set-maker.js`: harmonic-mixing setlist algorithm
- `sources.js`: URL classification. `stream-resolver.js`: remote audio preview protocol

See [CLAUDE.md](CLAUDE.md) for detailed architecture notes.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
