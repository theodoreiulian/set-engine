#!/usr/bin/env bash
set -euo pipefail

# ── SetEngine one-command setup ──────────────────────────────────────────────
# Usage:  ./scripts/setup.sh
#
# Checks for Node.js, installs npm dependencies, and verifies the system tools
# that SetEngine needs (yt-dlp, ffmpeg, aria2c, spotdl).  Gives you clear
# copy-pasteable install commands for anything that's missing.
# ──────────────────────────────────────────────────────────────────────────────

BOLD=""; RED=""; GREEN=""; YELLOW=""; CYAN=""; RESET=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="\033[1m"; RED="\033[31m"; GREEN="\033[32m"
  YELLOW="\033[33m"; CYAN="\033[36m"; RESET="\033[0m"
fi

ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}⚠${RESET} %s\n" "$1"; }
err()  { printf "  ${RED}✕${RESET} %s\n" "$1"; }
info() { printf "    %s\n" "$1"; }
hdr()  { printf "\n${BOLD}${CYAN}── %s${RESET}\n" "$1"; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Detect platform ──────────────────────────────────────────────────────────
OS="unknown"
case "$(uname -s)" in
  Darwin)  OS="macos" ;;
  Linux)   OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
esac

echo ""
echo "${BOLD}${CYAN}╔══════════════════════════════════════════╗${RESET}"
echo "${BOLD}${CYAN}║        SetEngine Setup                   ║${RESET}"
echo "${BOLD}${CYAN}╚══════════════════════════════════════════╝${RESET}"
echo ""
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
  fi
else
  err "Node.js not found"
  info "Install: https://nodejs.org/en/download"
  if [ "$OS" = "macos" ]; then
    info "   or:  brew install node"
  fi
  echo ""
  echo "${RED}Node.js is required. Install it, then re-run this script.${RESET}"
  exit 1
fi

# ── 2. npm dependencies ──────────────────────────────────────────────────────
hdr "2. npm dependencies"

cd "$ROOT"
if [ ! -d "node_modules" ]; then
  echo "  Installing npm packages…"
  npm install --loglevel=warn
  ok "npm packages installed"
else
  ok "node_modules/ exists"
fi

# ── 3. System tools ──────────────────────────────────────────────────────────
hdr "3. System tools"

missing=0

check_binary() {
  local bin="$1" label="$2" install_hint="$3"
  if command -v "$bin" &>/dev/null; then
    local ver=""
    if [ "$bin" = "yt-dlp" ]; then
      ver=$(yt-dlp --version 2>/dev/null | head -1) || true
      [ -n "$ver" ] && ver="  (${ver})"
    elif [ "$bin" = "ffmpeg" ]; then
      ver=$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}') || true
      [ -n "$ver" ] && ver="  (${ver})"
    fi
    ok "${label}${ver}"
  else
    err "${label} — not found"
    info "Install: ${install_hint}"
    missing=$((missing + 1))
  fi
}

if [ "$OS" = "macos" ]; then
  check_binary "yt-dlp" "yt-dlp" "brew install yt-dlp"
  check_binary "ffmpeg" "ffmpeg" "brew install ffmpeg"
  check_binary "aria2c" "aria2c   (optional — ~2× faster downloads)" "brew install aria2"
  check_binary "spotdl" "spotdl   (optional — Spotify support)"   "pipx install spotdl"
else
  check_binary "yt-dlp" "yt-dlp" "pipx install yt-dlp  (or: sudo apt install yt-dlp)"
  check_binary "ffmpeg" "ffmpeg" "sudo apt install ffmpeg"
  check_binary "aria2c" "aria2c   (optional — ~2× faster downloads)" "sudo apt install aria2"
  check_binary "spotdl" "spotdl   (optional — Spotify support)"      "pipx install spotdl"
fi

# ── 4. Summary ───────────────────────────────────────────────────────────────
echo ""
if [ "$missing" -eq 0 ]; then
  echo "${BOLD}${GREEN}All dependencies ready. Run:${RESET}"
  echo ""
  echo "  ${BOLD}npm start${RESET}"
  echo ""
else
  echo "${BOLD}${YELLOW}${missing} tool(s) missing.${RESET} Install them with the commands shown above."
  echo ""
  echo "Required:  yt-dlp + ffmpeg"
  echo "Optional:  aria2c (faster downloads), spotdl (Spotify support)"
  echo ""
  echo "After installing, re-run:  ${BOLD}./scripts/setup.sh${RESET}"
fi
