#!/usr/bin/env bash
set -euo pipefail

# ── SetEngine one-command setup ──────────────────────────────────────────────
# Usage:  ./scripts/setup.sh
#
# Checks for Node.js, installs npm dependencies, and verifies the system tools
# that SetEngine needs (yt-dlp, ffmpeg, aria2c, spotdl).  Attempts to install
# missing optional tools automatically when possible.
# ──────────────────────────────────────────────────────────────────────────────

BOLD=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="\033[1m"; RED="\033[31m"; GREEN="\033[32m"
  YELLOW="\033[33m"; CYAN="\033[36m"; RESET="\033[0m"
fi

ok()   { printf "%b" "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "%b" "  ${YELLOW}⚠${RESET} %s\n" "$1"; }
err()  { printf "%b" "  ${RED}✕${RESET} %s\n" "$1"; }
info() { printf "    %s\n" "$1"; }
hdr()  { printf "%b" "\n${BOLD}${CYAN}── %s${RESET}\n" "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Detect platform ──────────────────────────────────────────────────────────
OS="unknown"
case "$(uname -s)" in
  Darwin)  OS="macos" ;;
  Linux)   OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
esac

printf "%b" "\n${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════╗"
echo "║        SetEngine Setup                   ║"
echo "╚══════════════════════════════════════════╝"
printf "%b" "${RESET}\n"
if [ "$OS" = "windows" ]; then
  echo "This script is for macOS / Linux. Use scripts/setup.ps1 on Windows."
  exit 0
fi

# ── 1. Node.js ───────────────────────────────────────────────────────────────
hdr "1. Node.js"

NODE_MIN=18
if command -v node &>/dev/null; then
  NODE_VER=$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)
  if [ "${NODE_VER:-0}" -ge "$NODE_MIN" ]; then
    ok "node $(node -v)"
  else
    err "node $(node -v) — need ≥ v${NODE_MIN}"
    info "Install: https://nodejs.org  or  nvm install ${NODE_MIN}"
    exit 1
  fi
else
  err "Node.js not found"
  info "Install: https://nodejs.org/en/download"
  [ "$OS" = "macos" ] && info "   or:  brew install node"
  exit 1
fi

# ── 2. npm dependencies ──────────────────────────────────────────────────────
hdr "2. npm dependencies"

cd "$ROOT"
if [ ! -d "node_modules" ]; then
  echo "  Installing npm packages…"
  npm install --loglevel=warn 2>&1 | grep -v "^npm warn" | grep -v "^$" || true
  ok "npm packages installed"
else
  ok "node_modules/ exists"
fi

# ── 3. System tools ──────────────────────────────────────────────────────────
hdr "3. System tools"

missing=0
PIPX=""
command -v pipx &>/dev/null && PIPX="pipx"

check_binary() {
  local bin="$1" label="$2" install_hint="$3" auto_hint="${4:-}"
  if command -v "$bin" &>/dev/null; then
    local ver=""
    case "$bin" in
      yt-dlp) ver=$(yt-dlp --version 2>/dev/null | head -1) || true
              [ -n "$ver" ] && ver="  (${ver})" ;;
      ffmpeg) ver=$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}') || true
              [ -n "$ver" ] && ver="  (${ver})" ;;
    esac
    ok "${label}${ver}"
  else
    err "${label} — not found"
    missing=$((missing + 1))

    # Try auto-install for optional tools when we have a package manager
    if [ -n "$auto_hint" ]; then
      printf "    Attempting auto-install with ${auto_hint}…\n"
      if $auto_hint 2>&1; then
        if command -v "$bin" &>/dev/null; then
          ok "${label}  (auto-installed)"
          missing=$((missing - 1))
          return
        fi
      fi
      printf "    Auto-install failed.\n"
    fi
    info "Manual install: ${install_hint}"
  fi
}

if [ "$OS" = "macos" ]; then
  # Required tools — don't auto-install (may need sudo / user preference)
  check_binary "yt-dlp" "yt-dlp" "brew install yt-dlp"
  check_binary "ffmpeg" "ffmpeg" "brew install ffmpeg"
  # Optional tools — attempt auto-install
  check_binary "aria2c" "aria2c   (optional — ~2× faster downloads)" "brew install aria2" ""
  SPOTDL_AUTO=""
  [ -n "$PIPX" ] && SPOTDL_AUTO="$PIPX install spotdl"
  check_binary "spotdl" "spotdl   (optional — Spotify support)" "pipx install spotdl" "$SPOTDL_AUTO"
else
  check_binary "yt-dlp" "yt-dlp" "pipx install yt-dlp  (or: sudo apt install yt-dlp)"
  check_binary "ffmpeg" "ffmpeg" "sudo apt install ffmpeg"
  check_binary "aria2c" "aria2c   (optional — ~2× faster downloads)" "sudo apt install aria2" ""
  SPOTDL_AUTO=""
  [ -n "$PIPX" ] && SPOTDL_AUTO="$PIPX install spotdl"
  check_binary "spotdl" "spotdl   (optional — Spotify support)" "pipx install spotdl" "$SPOTDL_AUTO"
fi

# ── 4. Summary ───────────────────────────────────────────────────────────────
echo ""
if [ "$missing" -eq 0 ]; then
  printf "%b" "${BOLD}${GREEN}All dependencies ready. Run:${RESET}\n"
  echo ""
  echo "  npm start"
  echo ""
else
  printf "%b" "${BOLD}${YELLOW}${missing} tool(s) missing.${RESET} Install them with the commands shown above.\n"
  echo ""
  echo "Required:  yt-dlp + ffmpeg"
  echo "Optional:  aria2c (faster downloads), spotdl (Spotify support)"
  echo ""
  echo "After installing, re-run:  ./scripts/setup.sh"
fi
