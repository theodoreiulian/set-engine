# SetEngine

Download songs, playlists, and albums as MP3s. Built for DJs who curate offline libraries.

SetEngine wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) (and [spotdl](https://github.com/spotDL/spotify-downloader) for Spotify) in a native desktop app. Paste a link to a song, playlist, or album from YouTube / YouTube Music or Spotify and the download starts — no browser, no sign-in. Built-in BPM/key detection, harmonic matching in real time, DJ rating workflow, and setlist builder make it more than a downloader — it's a library manager.

**macOS · Windows · Linux**  (Electron)

---

## Features

- **Paste-and-download** — drop a YouTube / YouTube Music or Spotify link; source and shape (song vs. playlist/album) are auto-detected
- **Playlist & album support** — paste a playlist/album URL and every track downloads in parallel
- **Spotify** — Spotify links download through spotdl from the same box (install spotdl once)
- **Concurrent queue** — 5 simultaneous downloads, aria2c-accelerated when available (~2× speed)
- **BPM & key detection** — auto-tags audio files during download or after import (Deezer cross-check + built-in DSP)
- **Match Maker** — harmonic mixing suggestions in real time (tier 1 = same key, tier 2 = ±1 semitone)
- **Set Maker** — drag-and-drop setlists with tour metadata, key-compatible sequencing, and inline playback
- **Rating workflow** — scrub through your library, rate tracks, auto-write rating/energy to file metadata

## Quick Start

```bash
# macOS / Linux
git clone https://github.com/theodoreiulian/set-engine.git
cd set-engine
npm run setup

# Windows
.\scripts\setup.ps1
```

The setup script checks Node.js (≥18), installs npm dependencies, and verifies system tools:

| Tool    | Required | Purpose                              |
|---------|----------|--------------------------------------|
| yt-dlp  | **yes**  | Downloads audio from YouTube Music   |
| ffmpeg  | **yes**  | Converts audio to MP3                |
| aria2c  | optional | ~2× faster multi-connection HTTP     |
| spotdl  | optional | Spotify downloads                    |

Missing tools? The setup script prints platform-specific install commands.

Once everything is green:

```bash
npm start
```

## Usage

1. **Download tab** — paste a YouTube / YouTube Music or Spotify link (song, playlist, or album), pick a destination folder, hit DOWNLOAD
2. **Queue tab** — monitor download progress, retry failures, cancel
3. **Match Maker** — import your library, see harmonic matches for any track
4. **Set Maker** — tag BPM/key, build setlists, rate your tracks

The destination folder lives right on the Download tab. Other preferences are in Settings:

- **Bitrate** — 128, 192, or 320 kbps
- **Filename template** — yt-dlp output template (default: `%(title)s`)
- **Concurrency** — hardcoded at 5 to stay under YouTube's per-IP rate limit

## Architecture

Electron app with strict context isolation. Three tiers:

| Tier             | Path                    | Role                                   |
|------------------|-------------------------|----------------------------------------|
| Main process     | `src/main.js`           | yt-dlp/spotdl orchestration, IPC, local audio protocol |
| Preload          | `src/preload.js`        | contextBridge API contract             |
| Renderer         | `src/renderer/`         | vanilla JS SPA (no framework)          |

Key modules: `ytdlp-wrapper.js` (yt-dlp CLI), `spotdl-wrapper.js` (Spotify via spotdl), `download-manager.js` (queue & concurrency), `sources.js` (URL classification), `key-bpm-detector.js` (DSP analysis), `audio-analyzer.js` (librosa-style feature extraction).

See [CLAUDE.md](CLAUDE.md) for detailed architecture notes.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
