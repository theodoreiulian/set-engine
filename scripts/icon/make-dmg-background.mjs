#!/usr/bin/env node
// Background for the installer's disk-image window — generates
// assets/dmg/background.png and background@2x.png.
//
//   node scripts/icon/make-dmg-background.mjs
//
// Needs rsvg-convert (`brew install librsvg`). The outputs are committed, so
// this only has to run when the design changes; scripts/make-dmg.mjs combines
// the two sizes into one Retina-aware TIFF at build time.
//
// The geometry is shared with scripts/dmg-settings.py through
// assets/dmg/layout.json: the window size and where Finder puts the two icons.
// The artwork is drawn around those positions, so change them there, not here.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'assets', 'dmg');
const L = JSON.parse(fs.readFileSync(path.join(OUT, 'layout.json'), 'utf8'));

const W = L.window.width, H = L.window.height;
const APP = L.app, APPS = L.applications;
const TEXT_Y = 322;
// The first-launch steps sit under the drag instruction. The build is not
// notarized, so Gatekeeper refuses the first launch and the way through is
// three screens away in System Settings — this is the one place every new user
// is guaranteed to be looking. Wording follows Apple's own support page ("Open
// a Mac app from an unknown developer"). The last line must stay clear of the
// bottom strip a path bar can hide.
const RULE_Y = 354;
const STEPS_Y = 388;
const STEP_GAP = 28;
const STEPS_X = 86;

// Same palette as the app icon (scripts/icon/make-icon.mjs): flat, no glow.
const BG = '#1d1e20';
const INK = '#3f9d68';
const FONT = `font-family="Helvetica Neue, Helvetica, Arial, sans-serif"`;

// Record grooves spreading out from the app icon, as if it sat on a platter.
const grooves = [];
for (let r = 104; r < W; r += 20) {
  grooves.push(`<circle cx="${APP.x}" cy="${APP.y}" r="${r}" fill="none" stroke="#fff" stroke-opacity="${r % 60 === 44 ? 0.055 : 0.028}" stroke-width="1"/>`);
}

// A waveform rising from the bottom edge. The picture is taller than the window
// (see dmg-settings.py), so how much of this shows depends on the title bar and
// on whether the user's Finder has a path bar — it is decoration, and it is the
// only thing allowed in the bottom ~60 pt. Deterministic, so rebuilding the
// artwork doesn't change it: two sines and a slow swell, no random numbers.
const bars = [];
const BAR = 3, STEP = 6;
for (let i = 0, x = 24; x <= W - 24; i++, x += STEP) {
  const swell = 0.55 + 0.45 * Math.sin(i / 9.5);
  const h = 22 + 56 * swell * Math.abs(Math.sin(i * 0.62) * 0.6 + Math.sin(i * 0.23 + 1) * 0.4);
  bars.push(`<rect x="${x}" y="${(H - h).toFixed(1)}" width="${BAR}" height="${(h + 4).toFixed(1)}" rx="1.5"/>`);
}

// Finder draws each icon's name under it, and picks black or white text from
// the system appearance — not from this picture. On a dark background that
// means unreadable black labels for anyone in light mode. A mid-grey plate
// behind each label keeps both colours legible (≈4.5:1 either way).
const plate = ({ x, y }) =>
  `<rect x="${x - L.plate.width / 2}" y="${y + L.plate.offsetY - L.plate.height / 2}" width="${L.plate.width}" height="${L.plate.height}" rx="${L.plate.height / 2}" fill="#70747a"/>`;

// Bold white for the things the user has to find and click on screen.
const b = (t) => `<tspan font-weight="700" fill="#fff">${t}</tspan>`;
const STEPS = [
  `Open SetEngine. macOS says it could not verify it. Click ${b('Done')}.`,
  `Open ${b('System Settings')}, then ${b('Privacy &amp; Security')}, and scroll down to ${b('Security')}.`,
  `Click ${b('Open Anyway')} next to SetEngine, then enter your password.`,
];
const steps = STEPS.map((line, i) => {
  const y = STEPS_Y + 30 + i * STEP_GAP;
  return `<circle cx="${STEPS_X + 9}" cy="${y - 4.5}" r="9" fill="none" stroke="${INK}" stroke-width="1.5"/>
  <text x="${STEPS_X + 9}" y="${y}" text-anchor="middle" ${FONT} font-size="11" font-weight="700" fill="${INK}">${i + 1}</text>
  <text x="${STEPS_X + 30}" y="${y}" ${FONT} font-size="13" fill="#c5c8cd">${line}</text>`;
});
const NOTE_Y = STEPS_Y + 30 + STEPS.length * STEP_GAP + 6;
// Being told to override a security warning feels sketchy, so say why.
const WHY_Y = NOTE_Y + 40;

// The arrow sits between the two icons, clear of both.
const half = L.iconSize / 2;
const ax0 = APP.x + half + 26, ax1 = APPS.x - half - 26, ay = APP.y;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  ${grooves.join('\n  ')}
  <g fill="#fff" fill-opacity="0.06">${bars.join('')}</g>

  <text x="${W / 2}" y="46" text-anchor="middle" ${FONT} font-size="13" font-weight="700" letter-spacing="5" fill="${INK}">SETENGINE</text>

  <g fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M ${ax0} ${ay} H ${ax1}"/>
    <path d="M ${ax1 - 16} ${ay - 16} L ${ax1} ${ay} L ${ax1 - 16} ${ay + 16}"/>
  </g>

  ${plate(APP)}
  ${plate(APPS)}

  <text x="${W / 2}" y="${TEXT_Y}" text-anchor="middle" ${FONT} font-size="13" font-weight="500" letter-spacing="0.4" fill="#9a9ea4">Drag SetEngine into the Applications folder</text>

  <path d="M ${STEPS_X} ${RULE_Y} H ${W - STEPS_X}" stroke="#fff" stroke-opacity="0.1" stroke-width="1"/>
  <text x="${STEPS_X}" y="${STEPS_Y}" ${FONT} font-size="11" font-weight="700" letter-spacing="2.5" fill="${INK}">THE FIRST TIME YOU OPEN IT</text>
  ${steps.join('\n  ')}
  <text x="${STEPS_X + 30}" y="${NOTE_Y}" ${FONT} font-size="12" fill="#8a8e94">Only needed once. After that SetEngine opens normally.</text>

  <text x="${STEPS_X}" y="${WHY_Y}" ${FONT} font-size="11" font-weight="700" letter-spacing="2.5" fill="${INK}">WHY?</text>
  <text x="${STEPS_X}" y="${WHY_Y + 24}" ${FONT} font-size="13" fill="#c5c8cd">Apple charges $99 a year to verify an app, and I am too broke to afford it.</text>
  <text x="${STEPS_X}" y="${WHY_Y + 46}" ${FONT} font-size="13" fill="#c5c8cd">SetEngine is free and open source: <tspan fill="#fff">github.com/theodoreiulian/set-engine</tspan></text>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
const svgPath = path.join(OUT, 'background.svg');
fs.writeFileSync(svgPath, svg);
for (const [scale, name] of [[1, 'background.png'], [2, 'background@2x.png']]) {
  execFileSync('rsvg-convert', ['-w', String(W * scale), '-h', String(H * scale), svgPath, '-o', path.join(OUT, name)]);
}
console.log(`Wrote ${path.relative(ROOT, OUT)}/background.{svg,png,@2x.png} (${W}×${H})`);
