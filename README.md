# SetEngine

A desktop toolkit for DJs. Download tracks, find out what's playing in a set, analyze your crate, and build setlists that mix in key.

Paste a link to a song, playlist, or album from YouTube, YouTube Music, or Spotify and the download starts. Beyond downloading, SetEngine fingerprints a recorded DJ set to recover its tracklist, detects BPM and musical key offline, surfaces harmonically compatible tracks for mixing, and sequences setlists by Camelot key compatibility.

It uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) and, for Spotify, [spotdl](https://github.com/spotDL/spotify-downloader) under the hood. You install those once during setup.

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
- **Set Extraction.** Point it at a recorded DJ set and it identifies the tracks using AudD or ACRCloud (you bring your own account key), then you download them individually or grab the whole set.
- **BPM and key detection.** It works out the BPM and key of your local files right on your computer, double-checks the BPM against Deezer's free database, and writes both into the file's tags.
- **Match Maker.** Pick a track and see what mixes well in key, grouped by how close the keys sit on the Camelot wheel and filtered by how far apart the BPMs can be.
- **Set Maker.** Build setlists where every transition stays in key, star-rate your tracks, and import or export playlist files.

## Quick Start

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

## Usage

1. **Download.** Paste a YouTube, YouTube Music, or Spotify link, pick where to save it, and hit DOWNLOAD.
2. **Download Queue.** Watch progress, retry anything that failed, cancel, or clear finished items.
3. **Set Extraction.** Paste a set link, let it work out the tracklist, then download individual tracks or the whole set.
4. **Set Maker.** Analyze a folder for BPM and key, rate your tracks, and build a setlist that's ordered to mix in key.
5. **Match Maker.** Load your library and see what mixes with any track.

Where downloads get saved is set right on the Download page. Everything else lives in **Settings**:

- **Bitrate.** 128, 192, or 320 kbps.
- **Filename format.** Either *Title* or *Title and Artist*. Either way, the artist is always saved into the file's tags.
- **Set Extraction engine.** AudD (the default) or ACRCloud, plus the account key for whichever you choose. ACRCloud also lets you set how confident a match has to be before it's kept.

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
- `recognizers/`: AudD and ACRCloud fingerprint engines
- `track-match.js`: resolves a recognized "Artist Title" to a concrete YouTube URL
- `key-bpm-detector.js` / `audio-analyzer.js` / `dsp.js`: offline BPM and key detection and feature extraction
- `set-maker.js`: harmonic-mixing setlist algorithm
- `sources.js`: URL classification. `stream-resolver.js`: remote audio preview protocol

See [CLAUDE.md](CLAUDE.md) for detailed architecture notes.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
