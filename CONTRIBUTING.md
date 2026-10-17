# Contributing to SetEngine

Thanks for contributing! Here's how to get set up and submit changes.

## Getting Started

```bash
git clone https://github.com/theodoreiulian/set-engine.git
cd set-engine
npm run setup
```

See the [README](README.md) for system dependency details.

## Development

```
npm start         # dev build with hot-reload for renderer
npm run package   # produce an unpacked app in out/
npm run make      # produce platform installers (Windows / Linux)
npm run dist:mac  # produce the macOS installer, out/make/SetEngine.dmg
```

- Renderer changes hot-reload automatically.
- Main process changes require restarting `npm start`.

## Code conventions

- Vanilla JS, no framework in the renderer.
- ES modules throughout. Vite compiles the build; `package.json` deliberately has no `"type": "module"`.
- `contextIsolation` is on. All main and renderer communication goes through `src/preload.js` and `src/main/ipc-handlers.js`.
- No external dependencies for the renderer (no jQuery, no React). Keep it that way.
- CSS is in `src/renderer/styles/`. Dark mode only.

## Before submitting

- Run `npm start` and exercise the feature you changed. Run `node --test scripts/eval/*.test.mjs` for the regression checks that exist; beyond those, manual verification is the QA process.
- Check for leftover `console.log` debug lines.
- Make sure your changes work on at least one platform (macOS, Windows, or Linux).

## Pull requests

- One feature or fix per PR.
- Reference the issue number if applicable.
- Keep PRs focused. Refactors unrelated to the described change belong in separate PRs.

## Merging ships to everyone

Every merge to `master` is built and released automatically, and every installed copy of SetEngine offers it to its user within the hour. So:

- **Write the PR title for users.** It becomes a line under "What's new" in the app's update prompt (squash merge, so the title is the commit subject). "Accept SoundCloud album links", not "fix regex in sources.js". Prefix with `docs:`, `ci:`, `test:` or `chore:` to keep a change out of the notes.
- **Keep `master` releasable.** If a new version can't draw its first page, the app puts the previous one back by itself, but a version that starts and is broken inside a feature reaches everyone.
- Changes that only touch `site/`, Markdown files or `scripts/eval/` don't publish a release.
