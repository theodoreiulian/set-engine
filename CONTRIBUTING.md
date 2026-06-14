# Contributing to SetEngine

Thanks for contributing! Here's how to get set up and submit changes.

## Getting Started

```bash
git clone https://github.com/theodoreiulian/set-engine.git
cd setengine
npm run setup
```

See the [README](README.md) for system dependency details.

## Development

```
npm start         # dev build with hot-reload for renderer
npm run package   # produce an unpacked app in out/
npm run make      # produce platform installers
```

- Renderer changes hot-reload automatically.
- Main process changes require restarting `npm start`.

## Code conventions

- Vanilla JS — no framework in the renderer.
- ES modules throughout (`"type": "module"` is implicit via `.js` extensions).
- `contextIsolation` is on. All main ↔ renderer communication goes through `src/preload.js` → `src/main/ipc-handlers.js`.
- No external dependencies for the renderer (no jQuery, no React). Keep it that way.
- CSS is in `src/renderer/styles/`. Dark mode only.

## Before submitting

- Run `npm start` and exercise the feature you changed. There's no test suite — manual verification is the QA process.
- Check for leftover `console.log` debug lines.
- Make sure your changes work on at least one platform (macOS, Windows, or Linux).

## Pull requests

- One feature or fix per PR.
- Reference the issue number if applicable.
- Keep PRs focused — refactors unrelated to the described change belong in separate PRs.
