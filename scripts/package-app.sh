#!/usr/bin/env bash
set -euo pipefail

# SetEngine — build a double-clickable .app and install it into /Applications.
#
# What you get is a *snapshot*. The .app runs the code exactly as it was when
# this script last ran and nothing updates it afterwards, so re-run this
# whenever you want the Dock icon to catch up. Developing is unaffected:
# `npm start` from this directory still runs the live source, and the two are
# independent. They do share settings and the extraction cache (Electron
# derives userData from productName either way), so don't run both at once and
# expect settings writes to behave.
#
# macOS only — it installs into /Applications. On Windows/Linux use
# `npm run make` and install the artefact Forge leaves in out/make/.

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "package-app.sh installs into /Applications, so it is macOS-only." >&2
  echo "On Windows/Linux run 'npm run make' and install from out/make/." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEST="${SETENGINE_APP_DEST:-/Applications}"
if [[ ! -d "$DEST" ]]; then
  echo "Destination '$DEST' is not a directory." >&2
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules is missing — run 'npm run setup' first." >&2
  exit 1
fi

if pgrep -f "$DEST/SetEngine.app/Contents/MacOS/SetEngine" >/dev/null 2>&1; then
  echo "SetEngine is running from $DEST — quit it first, or the copy will be" >&2
  echo "replaced underneath the running process." >&2
  exit 1
fi

echo "==> Packaging the current state of $REPO_ROOT"
npm run package

# Newest first, so this keeps working on Intel (SetEngine-darwin-x64) and if an
# older architecture's output is still lying around.
APP_SRC="$(ls -dt out/SetEngine-darwin-*/SetEngine.app 2>/dev/null | head -1 || true)"
if [[ -z "$APP_SRC" ]]; then
  echo "Packaging finished but no .app appeared under out/. Nothing installed." >&2
  exit 1
fi

# Guard the one failure this build has actually had. The Vite plugin ships no
# node_modules, and shazamio-core is deliberately external (see the
# packageAfterCopy hook in forge.config.js), so it is one config slip away from
# vanishing again — and the symptom is invisible until an extraction reaches its
# first probe and Set Extraction quietly loses audio recognition. The asar header
# is plain JSON at the head of the file, so grep is enough to see it.
if ! grep -qa 'shazamio-core_bg.wasm' "$APP_SRC/Contents/Resources/app.asar"; then
  echo "shazamio-core is missing from the bundle — Set Extraction would lose audio" >&2
  echo "recognition in this build. Check the packageAfterCopy hook in" >&2
  echo "forge.config.js. Nothing installed." >&2
  exit 1
fi

echo "==> Installing to $DEST/SetEngine.app"
rm -rf "${DEST:?}/SetEngine.app"
cp -R "$APP_SRC" "$DEST/"

# Ad-hoc signed and built locally, so Gatekeeper would otherwise nag on first
# open even though the bits never left this machine.
xattr -dr com.apple.quarantine "$DEST/SetEngine.app" 2>/dev/null || true

echo
echo "Installed $DEST/SetEngine.app (snapshot of $(git rev-parse --short HEAD 2>/dev/null || echo 'working tree'))"
echo "Open it once, then right-click its Dock icon -> Options -> Keep in Dock."
