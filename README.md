# SetEngine

A desktop toolkit for DJs: download tracks, identify what's playing in a set, analyze your library, and build harmonically-mixed setlists.

SetEngine wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) (and [spotdl](https://github.com/spotDL/spotify-downloader) for Spotify) in a native desktop app. Paste a link to a song, playlist, or album from YouTube / YouTube Music or Spotify and the download starts — no embedded browser, no sign-in. On top of downloading, it identifies the tracklist of a DJ set by audio fingerprinting, detects BPM/key offline, suggests harmonic matches, and sequences setlists — so it's a library manager, not just a downloader.

**macOS · Windows · Linux**  (Electron)

---

## What it does

SetEngine has four areas:

1. **Download** — paste a YouTube / YouTube Music or Spotify link (song, playlist, or album) and it downloads MP3s. The link's source and shape are auto-detected from the URL.
2. **Set Extraction** *(beta)* — paste a YouTube DJ-set link and it fingerprint-identifies the tracks played, lists them in play order, and lets you download each one (or the whole set plus an `.m3u` playlist).
3. **Set Maker** — analyze a folder of local audio (offline BPM + key detection), rate tracks, and build a harmonically-ordered setlist; import/export `.m3u`.
4. **Match Maker** — import a local library and get harmonic-mixing match suggestions for any selected track (Tier 1 = same key, Tier 2 = ±1 semitone), filtered by a BPM tolerance.

## Features

- **Paste-and-download** — drop a YouTube / YouTube Music or Spotify link; source and shape (song vs. playlist/album) are auto-detected
- **Playlist & album support** — paste a playlist/album URL and every track downloads
- **Spotify** — Spotify links download through spotdl from the same box (install spotdl once)
- **Concurrent queue** — up to 5 simultaneous downloads, aria2c-accelerated when available (~2× speed)
- **Set Extraction** — fingerprint a DJ set into a track-by-track tracklist using [AudD](https://audd.io/) or [ACRCloud](https://www.acrcloud.com/) (your API key required), then download tracks individually or as a set
- **Offline BPM & key detection** — built-in DSP analysis (with a free Deezer BPM cross-check) for files in Set Maker / Match Maker, written back into file tags
- **Match Maker** — real-time harmonic-mixing suggestions tiered by Camelot key distance and filtered by a BPM tolerance slider
- **Set Maker** — build key-compatible setlists with 2-opt tour sequencing, star-rate tracks, and import/export `.m3u`

## Quick Start

```bash
# macOS / Linux
git clone https://github.com/theodoreiulian/set-engine.git
cd set-engine
npm run setup

# Windows
.\scripts\setup.ps1
```

The setup script checks Node.js (≥18), installs npm dependencies, and verifies the system tools SetEngine needs:

| Tool    | Required | Purpose                                            |
|---------|----------|----------------------------------------------------|
| yt-dlp  | **yes**  | Downloads audio from YouTube                       |
| ffmpeg  | **yes**  | Converts audio to MP3; decodes audio for BPM/key analysis |
| aria2c  | optional | ~2× faster downloads (multi-connection HTTP)       |
| spotdl  | optional | Spotify downloads                                  |

Missing tools? The setup script prints platform-specific install commands. Once everything is green:

```bash
npm start
```

## Usage

1. **Download** — paste a YouTube / YouTube Music or Spotify link (song, playlist, or album), pick a destination folder, hit DOWNLOAD
2. **Download Queue** — monitor progress, retry failures, cancel, clear
3. **Set Extraction** — paste a DJ-set link, let it identify the tracklist, then download individual tracks or the whole set + `.m3u`
4. **Set Maker** — analyze a folder for BPM/key, rate tracks, and build a harmonically-ordered setlist
5. **Match Maker** — import your library and see harmonic matches for any track

The destination folder lives right on the Download page. Other preferences are in **Settings**:

- **Bitrate** — 128, 192, or 320 kbps
- **Filename format** — *Title* or *Title and artist* (the artist is always embedded as metadata regardless)
- **Set Extraction engine** — AudD (default) or ACRCloud, plus the API key for whichever you pick; ACRCloud also exposes a minimum match-confidence threshold

Download concurrency is hardcoded at 5 to stay under YouTube's per-IP rate limit, so it isn't a user-facing setting.

> **Note:** Set Extraction is a beta feature. Tracklists are identified by audio fingerprinting, which is not always accurate — unreleased IDs, bootlegs, mashups, and heavily-edited tracks often can't be matched. Treat the output as a starting point, not a definitive tracklist.

## Architecture

Electron app with strict context isolation across three tiers:

| Tier         | Path             | Role                                                        |
|--------------|------------------|-------------------------------------------------------------|
| Main process | `src/main.js` + `src/main/` | binary orchestration, IPC, recognition HTTP, local + stream audio protocols |
| Preload      | `src/preload.js` | `contextBridge` API contract (`window.setengine`)           |
| Renderer     | `src/renderer/`  | vanilla JS, no framework — a small page router               |

Key modules:

- `ytdlp-wrapper.js` / `spotdl-wrapper.js` — the only modules that spawn the binaries; shared output-filename templating
- `download-manager.js` — download queue & concurrency (engine chosen per item's source)
- `extraction-manager.js` + `set-extractor.js` — the Set Extraction job system and per-job pipeline
- `recognizers/` — AudD and ACRCloud fingerprint engines
- `track-match.js` — resolves a recognized "Artist – Title" to a concrete YouTube URL
- `key-bpm-detector.js` / `audio-analyzer.js` / `dsp.js` — offline BPM + key detection and feature extraction
- `set-maker.js` — harmonic-mixing setlist algorithm
- `sources.js` — URL classification; `stream-resolver.js` — remote audio preview protocol

See [CLAUDE.md](CLAUDE.md) for detailed architecture notes.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
