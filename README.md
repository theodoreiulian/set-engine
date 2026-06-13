# SetEngine

Download songs and playlists from YouTube Music as MP3s. Built for DJs who curate offline libraries.

SetEngine wraps [yt-dlp](https://github.com/yt-dlp/yt-dlp) in a native desktop app with an embedded YouTube Music browser. Sign in once, browse naturally, and download tracks (or full playlists) with one click. Built-in BPM/key detection, harmonic matching in real time, DJ rating workflow, and setlist builder make it more than a downloader — it's a library manager.

**macOS · Windows · Linux**  (Electron)

---

## Features

- **Authenticated downloads** — embedded YouTube Music WebContentsView preserves your session; cookies auto-forward to yt-dlp
- **Playlist support** — drop a playlist URL, see all tracks, download them all in parallel
- **Concurrent queue** — 5 simultaneous downloads, aria2c-accelerated when available (~2× speed)
- **BPM & key detection** — auto-tags audio files during download or after import (GetSongBPM + built-in DSP)
- **Match Maker** — harmonic mixing suggestions in real time (tier 1 = same key, tier 2 = ±1 semitone)
- **Set Maker** — drag-and-drop setlists with tour metadata, key-compatible sequencing, and inline playback
- **Rating workflow** — scrub through your library, rate tracks, auto-write rating/energy to file metadata
- **Spotify** — optional spotdl integration for Spotify-sourced downloads

## Quick Start

```bash
# macOS / Linux
git clone https://github.com/theodoreiulian/setengine.git
cd setengine
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

1. **Browser tab** — navigate to music.youtube.com, sign in, find the song or playlist you want
2. **Download button** — SetEngine detects the URL and offers to download the song or entire playlist
3. **Queue tab** — monitor download progress, retry failures, cancel
4. **Match Maker** — import your library, see harmonic matches for any track
5. **Set Maker** — tag BPM/key, build setlists, rate your tracks

### Settings

- **Download folder** — where MP3s land (defaults to system Music folder)
- **Bitrate** — 128, 192, 256, or 320 kbps
- **Filename template** — yt-dlp output template (default: `%(title)s`)
- **Concurrency** — hardcoded at 5 to stay under YouTube's per-IP rate limit

## Architecture

Electron app with strict context isolation. Three tiers:

| Tier             | Path                    | Role                                   |
|------------------|-------------------------|----------------------------------------|
| Main process     | `src/main.js`           | yt-dlp orchestration, IPC, WebContentsView |
| Preload          | `src/preload.js`        | contextBridge API contract             |
| Renderer         | `src/renderer/`         | vanilla JS SPA (no framework)          |

Key modules: `ytdlp-wrapper.js` (yt-dlp CLI), `download-manager.js` (queue & concurrency), `cookie-manager.js` (Netscape-format session export), `key-bpm-detector.js` (DSP analysis), `audio-analyzer.js` (librosa-style feature extraction).

See [CLAUDE.md](CLAUDE.md) for detailed architecture notes.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
