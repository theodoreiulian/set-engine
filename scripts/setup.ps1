<#
.SYNOPSIS
  SetEngine one-command setup for Windows
.DESCRIPTION
  Checks for Node.js, installs npm dependencies, and verifies system tools
  (yt-dlp, ffmpeg, aria2c, spotdl). Prints copy-pasteable install commands
  for anything that's missing.
.EXAMPLE
  .\scripts\setup.ps1
#>

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot

Write-Host ""
Write-Host "╔══════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║        SetEngine Setup                   ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── 1. Node.js ───────────────────────────────────────────────────────────────
Write-Host "── 1. Node.js" -ForegroundColor Cyan

$NodeMin = 18
$nodeOk = $false
try {
  $nodeVer = (node -v) -replace '^v', ''
  $nodeMajor = [int]($nodeVer -split '\.')[0]
  if ($nodeMajor -ge $NodeMin) {
    Write-Host "  ✓ node $nodeVer" -ForegroundColor Green
    $nodeOk = $true
  } else {
    Write-Host "  ✕ node $nodeVer — need ≥ v$NodeMin" -ForegroundColor Red
    Write-Host "    Install: https://nodejs.org  or  winget install OpenJS.NodeJS"
  }
} catch {
  Write-Host "  ✕ Node.js not found" -ForegroundColor Red
  Write-Host "    Install: https://nodejs.org/en/download  or  winget install OpenJS.NodeJS"
}

if (-not $nodeOk) {
  Write-Host ""
  Write-Host "Node.js is required. Install it, then re-run this script." -ForegroundColor Red
  exit 1
}

# ── 2. npm dependencies ──────────────────────────────────────────────────────
Write-Host ""
Write-Host "── 2. npm dependencies" -ForegroundColor Cyan

Push-Location $Root
if (-not (Test-Path "node_modules")) {
  Write-Host "  Installing npm packages…"
  npm install --loglevel=warn
  Write-Host "  ✓ npm packages installed" -ForegroundColor Green
} else {
  Write-Host "  ✓ node_modules/ exists" -ForegroundColor Green
}
Pop-Location

# ── 3. System tools ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "── 3. System tools" -ForegroundColor Cyan

function Check-Binary($name, $label, $hint) {
  $found = Get-Command $name -ErrorAction SilentlyContinue
  if ($found) {
    Write-Host "  ✓ $label" -ForegroundColor Green
  } else {
    Write-Host "  ✕ $label — not found" -ForegroundColor Red
    Write-Host "    Install: $hint" -ForegroundColor Gray
    $script:missing++
  }
}

$script:missing = 0

Check-Binary "yt-dlp" "yt-dlp" "winget install yt-dlp.yt-dlp"
Check-Binary "ffmpeg" "ffmpeg" "winget install Gyan.FFmpeg"
Check-Binary "aria2c" "aria2c   (optional)" "winget install aria2"
Check-Binary "spotdl" "spotdl   (optional — Spotify)" "pip install spotdl"

# ── 4. Summary ───────────────────────────────────────────────────────────────
Write-Host ""
if ($missing -eq 0) {
  Write-Host "All dependencies ready. Run:" -ForegroundColor Green
  Write-Host ""
  Write-Host "  npm start" -ForegroundColor White
} else {
  Write-Host "$missing tool(s) missing." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Required:  yt-dlp + ffmpeg"
  Write-Host "Optional:  aria2c (faster downloads), spotdl (Spotify support)"
  Write-Host ""
  Write-Host "After installing, re-run:  .\scripts\setup.ps1" -ForegroundColor White
}
Write-Host ""
