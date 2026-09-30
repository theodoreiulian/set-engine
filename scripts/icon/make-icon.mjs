#!/usr/bin/env node
// SetEngine app icon — generates assets/icon/icon.svg, icon.png and icon.icns.
//
//   node scripts/icon/make-icon.mjs
//
// Needs rsvg-convert (`brew install librsvg`) and iconutil (ships with macOS).
// The outputs are committed, so this only has to run when the design changes.
//
// Drawn on the macOS icon grid: a 1024 canvas with the body inset to 824×824
// (100 px margin) and cut to Apple's continuous-corner squircle. That shape is
// what matters on macOS 26 Tahoe — an .icns whose artwork doesn't fill that
// exact silhouette gets shrunk onto a grey plate in the Dock ("icon jail"),
// while one that does is shown as-is. A layered Icon Composer .icon would add
// Liquid Glass tinting, but compiling it needs Xcode 26's actool, which
// @electron/packager calls unconditionally when a .icon sits next to the .icns
// — so it is deliberately not shipped.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'assets', 'icon');

const C = 512;      // canvas centre
const HALF = 412;   // half of the 824 px body

// Apple's continuous-corner rounded rect (the "squircle"), built with Figma's
// corner-smoothing construction: Bézier ramp, circular arc, Bézier ramp, so
// curvature has no jumps. Radius 184 with 60% smoothing on the 824 body is
// the fit to a system-accepted Tahoe icon mask (~140 px off at 1024, i.e.
// anti-aliasing). Tahoe is strict about this: a superellipse that looked
// identical by eye was jailed onto a grey plate.
function squircle(cx, cy, half, R = 184, xi = 0.6) {
  const x0 = cx - half, y0 = cy - half, x1 = cx + half, y1 = cy + half;
  const p = (1 + xi) * R;
  const arcDeg = 90 * (1 - xi);
  const arcLen = Math.sin(((arcDeg / 2) * Math.PI) / 180) * R * Math.SQRT2;
  const alpha = (((90 - arcDeg) / 2) * Math.PI) / 180;
  const beta = ((45 * xi) * Math.PI) / 180;
  const c = R * Math.tan(alpha / 2) * Math.cos(beta);
  const d = c * Math.tan(beta);
  const b = (p - arcLen - c - d) / 3;
  const a = 2 * b;
  // One corner in local coords (u = inward from the vertical edge, v = inward
  // from the horizontal edge), walked from the horizontal edge to the vertical.
  const corners = [
    (u, v) => [x1 - u, y0 + v], // top-right
    (u, v) => [x1 - v, y1 - u], // bottom-right
    (u, v) => [x0 + u, y1 - v], // bottom-left
    (u, v) => [x0 + v, y0 + u], // top-left
  ];
  const f = ([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  let path = '';
  corners.forEach((m, i) => {
    path += `${i === 0 ? 'M' : ' L'} ${f(m(p, 0))}`;
    path += ` C ${f(m(p - a, 0))}, ${f(m(p - a - b, 0))}, ${f(m(p - a - b - c, d))}`;
    path += ` A ${R} ${R} 0 0 1 ${f(m(d, p - a - b - c))}`;
    path += ` C ${f(m(0, p - a - b))}, ${f(m(0, p - a))}, ${f(m(0, p))}`;
  });
  return `${path} Z`;
}

// The mark: one white record under a tonearm, on a flat green field. Every
// "cut" (label, groove, the gap around the arm) is filled with the background
// gradient itself, in canvas space, so it reads as a hole rather than a colour.
const REC = { x: C, y: C, r: 330 };
const PIVOT = { x: 804, y: 220 };
const ARM = `M ${PIVOT.x} ${PIVOT.y} L 776 436 L 676 540`;

const body = squircle(C, C, HALF);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="180" y1="100" x2="844" y2="924">
      <stop offset="0" stop-color="#a8f04c"/>
      <stop offset="0.5" stop-color="#2fcf6a"/>
      <stop offset="1" stop-color="#067f55"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="10"/>
      <feOffset dy="10"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.3"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="lift" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="16"/>
      <feOffset dy="14"/>
      <feFlood flood-color="#034d25" flood-opacity="0.35"/>
      <feComposite operator="in" in2="SourceAlpha"/>
      <feComposite operator="in" in2="SourceAlpha"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <g filter="url(#shadow)">
    <path d="${body}" fill="url(#bg)"/>
  </g>

  <g filter="url(#lift)">
    <circle cx="${REC.x}" cy="${REC.y}" r="${REC.r}" fill="#fff"/>
    <circle cx="${REC.x}" cy="${REC.y}" r="${REC.r - 98}" fill="none" stroke="url(#bg)" stroke-width="12"/>
    <circle cx="${REC.x}" cy="${REC.y}" r="106" fill="url(#bg)"/>
    <circle cx="${REC.x}" cy="${REC.y}" r="24" fill="#fff"/>

    <path d="${ARM}" fill="none" stroke="url(#bg)" stroke-width="84" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${ARM}" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="50" fill="#fff"/>
    <circle cx="${PIVOT.x}" cy="${PIVOT.y}" r="16" fill="url(#bg)"/>
  </g>
</svg>
`;

fs.mkdirSync(OUT, { recursive: true });
const svgPath = path.join(OUT, 'icon.svg');
fs.writeFileSync(svgPath, svg);

const render = (size, file) =>
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svgPath, '-o', file]);

render(1024, path.join(OUT, 'icon.png'));

const iconset = fs.mkdtempSync(path.join(os.tmpdir(), 'setengine-')) + '/icon.iconset';
fs.mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  render(s, path.join(iconset, `icon_${s}x${s}.png`));
  render(s * 2, path.join(iconset, `icon_${s}x${s}@2x.png`));
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(OUT, 'icon.icns')]);
fs.rmSync(path.dirname(iconset), { recursive: true, force: true });

console.log(`Wrote ${path.relative(ROOT, OUT)}/icon.{svg,png,icns}`);
