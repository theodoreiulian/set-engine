// SetEngine website. No dependencies, no build step.
//
// One idea drives the page: a cable leaves the turntable in the hero and is
// drawn down the page as you scroll. Each panel it reaches draws itself while
// the cable's tip is passing through it, and the cable ends at the download.

(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------------------------------------------------------------- drawing

  const n1 = (v) => Math.round(v * 10) / 10;

  // A stroke that draws itself between progress `s` and `s + w` of its module.
  const P = (d, cls, s = 0, w = 0.2) =>
    `<path class="d ${cls}" pathLength="1" d="${d}" data-s="${s}" data-w="${w}"/>`;

  // Text that fades in at progress `s`.
  const T = (x, y, text, cls = '', s = 0) =>
    `<text class="f ${cls}" x="${x}" y="${y}" data-s="${s}">${text}</text>`;

  const roundRect = (x, y, w, h, r) =>
    `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}` +
    `a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}` +
    `v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;

  const circle = (cx, cy, r) =>
    `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

  // Seeded, so the waveforms are the same on every load.
  const rng = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Several strokes drawn one after another across `w`. They have to be
  // separate paths: a dash pattern restarts on every subpath, so one path
  // holding all of them would draw them all at once.
  const sweep = (ds, cls, s, w) =>
    ds.map((d, i) => P(d, cls, n3(s + (w * i) / ds.length), n3((w / ds.length) * 4))).join('');
  const n3 = (v) => Math.round(v * 1000) / 1000;

  // A bar waveform, one stroke per bar, so it can be swept left to right.
  function wave(x0, x1, cy, maxH, bars, seed) {
    const rand = rng(seed);
    const step = (x1 - x0) / (bars - 1);
    const out = [];
    for (let i = 0; i < bars; i++) {
      const env = 0.35 + 0.65 * Math.abs(Math.sin(i * 0.17 + seed));
      const h = Math.max(2, maxH * env * (0.3 + 0.7 * rand()));
      const x = n1(x0 + i * step);
      out.push(`M${x} ${n1(cy + h)}V${n1(cy - h)}`);
    }
    return out;
  }

  const builders = {
    download() {
      let s = P(roundRect(40, 34, 520, 54, 12), 'm', 0, 0.14);
      s += T(64, 66, 'music.youtube.com/playlist?list=PL…', '', 0.06);
      s += T(540, 66, 'PLAYLIST · 24', 'grn end', 0.16);
      s += P('M300 88V120', 'g', 0.14, 0.06);
      s += sweep(wave(40, 560, 170, 42, 105, 7), 'g bar', 0.2, 0.34);
      const rows = [
        ['Halden — Night Bus', '320 KBPS', 560],
        ['Mira Sol — Low Tide', '320 KBPS', 560],
        ['Kessel — Ferrous', '62%', 362],
      ];
      rows.forEach(([title, status, end], i) => {
        const y = 262 + i * 58;
        const at = 0.56 + i * 0.09;
        s += T(40, y, title, 'big', at);
        s += T(560, y, status, `end ${end < 560 ? 'grn' : 'dim'}`, at + 0.08);
        s += P(`M40 ${y + 17}H560`, 'm', at, 0.1);
        s += P(`M40 ${y + 17}H${end}`, 'gh', at + 0.04, 0.2);
      });
      return s;
    },

    extract() {
      let s = T(40, 36, '0:00', 'dim', 0) + T(560, 36, '1:02:14', 'dim end', 0);
      s += sweep(wave(40, 560, 78, 24, 105, 3), 'm bar', 0, 0.22);
      const probes = [];
      for (let i = 0; i < 16; i++) probes.push(`M${n1(56 + i * 32.5)} 46V110`);
      s += sweep(probes, 'gh thin', 0.18, 0.26);

      const bounds = [40, 122, 214, 290, 388, 470, 560];
      for (let i = 0; i < bounds.length - 1; i++) {
        const d = `M${bounds[i] + 4} 126H${bounds[i + 1] - 4}`;
        s += i === 3
          ? `<path class="dash f" d="${d}" data-s="0.52"/>`
          : P(d, 'g', 0.42 + i * 0.025, 0.08);
      }

      const rows = [
        ['0:00', 'Halden — Night Bus', 'PUBLISHED'],
        ['9:41', 'Mira Sol — Low Tide (Dub)', 'PUBLISHED'],
        ['20:15', 'Kessel — Ferrous', 'HEARD'],
        ['29:02', null, ''],
        ['40:30', 'Oda Lindqvist — Parallel', 'HEARD'],
        ['50:12', 'Halden — Second Skin', 'PUBLISHED'],
      ];
      rows.forEach(([time, title, badge], i) => {
        const y = 172 + i * 46;
        const at = 0.5 + i * 0.07;
        s += T(40, y, time, 'dim', at);
        if (title) {
          s += T(108, y, title, 'big', at);
          s += T(560, y, badge, `end ${badge === 'HEARD' ? 'grn' : 'dim'}`, at + 0.05);
          s += P(`M40 ${y + 17}H560`, 'm thin', at, 0.1);
        } else {
          s += T(108, y, 'Unidentified · 11 min', 'dim', at);
          s += `<path class="dash f" d="M40 ${y + 17}H560" data-s="${at}"/>`;
        }
      });
      return s;
    },

    setmaker() {
      const keys = ['8A', '8A', '9A', '9B', '10B', '10A', '11A'];
      const bpms = [122, 122, 123, 124, 126, 126, 127];
      const ys = [318, 286, 240, 206, 150, 122, 170];
      const xs = keys.map((_, i) => 60 + i * 80);

      let s = T(40, 40, 'SETLIST · 7 TRACKS', 'dim', 0.02);
      s += T(560, 40, '6 / 6 TRANSITIONS IN KEY', 'grn end', 0.86);
      [120, 190, 260, 330].forEach((y, i) => {
        s += P(`M40 ${y}H560`, 'm thin', i * 0.02, 0.14);
      });

      let curve = `M${xs[0]} ${ys[0]}`;
      for (let i = 1; i < xs.length; i++) {
        curve += `C${xs[i - 1] + 40} ${ys[i - 1]},${xs[i] - 40} ${ys[i]},${xs[i]} ${ys[i]}`;
      }
      s += `<path class="d g" style="stroke-width:3" pathLength="1" d="${curve}" data-s="0.1" data-w="0.62"/>`;

      xs.forEach((x, i) => {
        const at = n1((0.1 + (0.62 * i) / (xs.length - 1)) * 100) / 100;
        s += P(`M${x} ${ys[i] + 12}V366`, 'm thin', at, 0.1);
        s += `<circle class="f node" cx="${x}" cy="${ys[i]}" r="7" data-s="${at}" data-w="0.05"/>`;
        s += T(x, ys[i] - 20, keys[i], 'key mid', at);
        s += T(x, 390, bpms[i], 'dim mid', at);
      });
      s += T(40, 424, 'KEY ABOVE · BPM BELOW', 'dim', 0.9);
      return s;
    },

    sorter() {
      let s = T(40, 44, 'Kessel — Ferrous.mp3', 'big', 0.02);
      s += T(560, 44, '14 / 212', 'dim end', 0.02);
      s += sweep(wave(40, 298, 98, 26, 52, 11), 'g bar', 0.05, 0.18);
      s += sweep(wave(304, 560, 98, 26, 52, 12), 'm bar', 0.2, 0.14);
      s += P('M301 60V138', 'gh', 0.3, 0.08);
      s += T(40, 150, '2:41', 'dim', 0.3) + T(560, 150, '6:08', 'dim end', 0.3);

      s += P('M301 138C301 214,97 190,97 268', 'g', 0.4, 0.24);
      s += P('M301 138C301 204,367 204,367 268', 'g', 0.4, 0.24);

      const names = ['WARM-UP', 'PEAK', 'CLOSING', 'TOOLS'];
      names.forEach((name, i) => {
        const x = 40 + i * 135;
        const picked = i === 0 || i === 2;
        const at = 0.55 + i * 0.04;
        s += P(roundRect(x, 268, 115, 98, 10), picked ? 'g' : 'm', at, 0.2);
        s += P(roundRect(x + 12, 280, 24, 24, 5), 'm thin', at, 0.15);
        s += T(x + 24, 296.5, i + 1, 'key mid', at + 0.08);
        s += T(x + 12, 330, name, 'key', at + 0.1);
        if (picked) s += T(x + 12, 350, 'COPIED', 'grn', 0.86);
      });
      s += T(40, 420, 'SPACE play · 1–9 crate · ENTER next', 'dim', 0.9);
      return s;
    },
  };

  // The Camelot wheel is the one panel you can play with.
  const MINOR = ['A♭m', 'E♭m', 'B♭m', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F♯m', 'D♭m'];
  const MAJOR = ['B', 'F♯', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E'];
  const keyName = (n, l) =>
    l === 'A' ? `${MINOR[n - 1].replace('m', '')} minor` : `${MAJOR[n - 1]} major`;

  function buildWheel(svg) {
    const cx = 300, cy = 252, R = [50, 108, 166];
    const polar = (r, deg) => {
      const a = (deg * Math.PI) / 180;
      return [n1(cx + r * Math.cos(a)), n1(cy + r * Math.sin(a))];
    };
    const sector = (r0, r1, a0, a1) => {
      const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a1);
      const [x2, y2] = polar(r0, a1), [x3, y3] = polar(r0, a0);
      return `M${x0} ${y0}A${r1} ${r1} 0 0 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 0 0 ${x3} ${y3}z`;
    };

    let s = R.map((r, i) => P(circle(cx, cy, r), 'm', i * 0.08, 0.3)).join('');
    const spokes = [];
    for (let k = 0; k < 12; k++) {
      const [x0, y0] = polar(R[0], k * 30 - 105), [x1, y1] = polar(R[2], k * 30 - 105);
      spokes.push(`M${x0} ${y0}L${x1} ${y1}`);
    }
    s += sweep(spokes, 'm thin', 0.25, 0.3);

    s += '<g class="f" data-s="0.5" data-w="0.25">';
    for (let n = 1; n <= 12; n++) {
      const mid = (n % 12) * 30 - 90;
      for (const l of ['A', 'B']) {
        const [r0, r1] = l === 'A' ? [R[0], R[1]] : [R[1], R[2]];
        const [tx, ty] = polar((r0 + r1) / 2, mid);
        s += `<g class="seg" tabindex="0" role="button" data-n="${n}" data-l="${l}" aria-label="${n}${l}, ${keyName(n, l)}">` +
          `<path d="${sector(r0 + 1, r1 - 1, mid - 14.4, mid + 14.4)}"/>` +
          `<text x="${tx}" y="${ty}">${n}${l}</text></g>`;
      }
    }
    s += '</g>';
    s += `<text class="f big" x="40" y="38" data-s="0.6" id="wheel-key"></text>`;
    s += `<text class="f" x="40" y="60" data-s="0.66" id="wheel-mix"></text>`;
    svg.innerHTML = s;

    const segs = $$('.seg', svg);
    const select = (n, l) => {
      const near = [
        [((n + 10) % 12) + 1, l],
        [(n % 12) + 1, l],
        [n, l === 'A' ? 'B' : 'A'],
      ];
      for (const seg of segs) {
        const sn = +seg.dataset.n, sl = seg.dataset.l;
        const isSel = sn === n && sl === l;
        seg.classList.toggle('sel', isSel);
        seg.classList.toggle('near', near.some(([a, b]) => a === sn && b === sl));
        seg.setAttribute('aria-pressed', isSel);
      }
      $('#wheel-key', svg).textContent = `${n}${l} · ${keyName(n, l)}`;
      $('#wheel-mix', svg).textContent = `MIXES WITH ${near.map(([a, b]) => a + b).join(' · ')}`;
    };
    for (const seg of segs) {
      const pick = () => select(+seg.dataset.n, seg.dataset.l);
      seg.addEventListener('click', pick);
      seg.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    }
    select(8, 'A');
  }

  for (const svg of $$('svg[data-art]')) {
    const name = svg.dataset.art;
    if (name === 'match') buildWheel(svg);
    else if (builders[name]) svg.innerHTML = builders[name]();
  }

  // ------------------------------------------------------------- the cable

  const page = $('.page');
  const ghost = $('.wire-ghost');
  const liveGroup = $('.wire-live');
  const head = $('.wire-head');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const modules = $$('.module[data-module]').map((el) => ({
    el,
    jackIn: $('.jack-in', el),
    jackOut: $('.jack-out', el),
    items: $$('.d, .f', el).map((node) => ({
      node,
      draws: node.classList.contains('d'),
      s: +node.dataset.s || 0,
      w: +node.dataset.w || 0.12,
    })),
    top: 0,
    height: 1,
    p: -1,
  }));

  // The cable is a list of runs, one per gap between panels. Each run is its
  // own path (a dash pattern restarts on every subpath, so a single path could
  // not be drawn progressively), with `start` = the cable length before it.
  let runs = [];
  let total = 0;
  let table = new Float32Array(0); // table[i] = the cable's y at length i * STEP
  const STEP = 4;

  function build() {
    const origin = page.getBoundingClientRect();
    const at = (el) => {
      const r = el.getBoundingClientRect();
      return [n1(r.left + r.width / 2 - origin.left), n1(r.top + r.height / 2 - origin.top)];
    };

    // Jacks alternate out → in down the page; the cable runs between each pair
    // and skips the panel in between, which draws itself instead.
    const jacks = $$('[data-jack]');
    const ds = [];
    for (let i = 0; i + 1 < jacks.length; i++) {
      if (jacks[i].dataset.jack !== 'out' || jacks[i + 1].dataset.jack !== 'in') continue;
      const [x1, y1] = at(jacks[i]);
      const [x2, y2] = at(jacks[i + 1]);
      const dy = y2 - y1;
      ds.push(Math.abs(x2 - x1) < 2
        ? `M${x1} ${y1}L${x2} ${y2}`
        : `M${x1} ${y1}C${x1} ${n1(y1 + dy * 0.62)},${x2} ${n1(y1 + dy * 0.38)},${x2} ${y2}`);
    }
    ghost.setAttribute('d', ds.join(''));

    liveGroup.textContent = '';
    total = 0;
    runs = ds.map((d) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      liveGroup.append(path);
      const run = { path, start: total, length: path.getTotalLength() };
      total += run.length;
      return run;
    });

    const count = Math.ceil(total / STEP) + 1;
    table = new Float32Array(count);
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      // y never decreases along the cable; enforce it against rounding.
      maxY = Math.max(maxY, pointAt(Math.min(total, i * STEP)).y);
      table[i] = maxY;
    }

    for (const m of modules) {
      const r = m.el.getBoundingClientRect();
      m.top = r.top - origin.top;
      m.height = r.height;
      m.p = -1;
    }
    schedule();
  }

  function pointAt(len) {
    let run = runs[runs.length - 1];
    for (const r of runs) {
      if (len <= r.start + r.length) { run = r; break; }
    }
    return run.path.getPointAtLength(Math.max(0, len - run.start));
  }

  // How much cable is drawn when its tip has reached document y `tip`.
  function lengthAt(tip) {
    let lo = 0, hi = table.length - 1;
    if (!runs.length || table[0] > tip) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (table[mid] <= tip) lo = mid; else hi = mid - 1;
    }
    return lo === table.length - 1 ? total : lo * STEP;
  }

  // The tip sits a little past mid-screen, and reaches the very bottom of the
  // page by the time scrolling runs out, so the last panel always completes.
  function tipTarget() {
    if (reduceMotion) return 1e9;
    const max = document.documentElement.scrollHeight - innerHeight;
    const t = max > 0 ? clamp01(scrollY / max) : 1;
    return scrollY + innerHeight * (0.6 + 0.4 * t * t * t);
  }

  function render(tip) {
    const len = lengthAt(tip);
    for (const run of runs) {
      const drawn = Math.min(run.length, len - run.start);
      run.path.style.visibility = drawn > 0 ? 'visible' : 'hidden';
      run.path.style.strokeDasharray = `${Math.max(0, drawn)} ${run.length + 10}`;
    }
    head.classList.toggle('on', len > 0 && !reduceMotion);
    if (len > 0) {
      const pt = pointAt(len);
      head.setAttribute('transform', `translate(${n1(pt.x)} ${n1(pt.y)})`);
    }

    for (const m of modules) {
      const p = clamp01((tip - m.top) / m.height);
      if (p === m.p) continue;
      m.p = p;
      m.el.style.setProperty('--p', p.toFixed(4));
      m.el.classList.toggle('live', p > 0);
      m.jackIn?.classList.toggle('live', p > 0);
      m.jackOut?.classList.toggle('live', p >= 1);
      for (const it of m.items) {
        const local = clamp01((p - it.s) / it.w);
        if (it.draws) it.node.style.strokeDashoffset = 1 - local;
        else it.node.style.opacity = local;
      }
    }
  }

  let current = null;
  let raf = 0;
  function frame() {
    raf = 0;
    const target = tipTarget();
    if (current === null || reduceMotion) current = target;
    current += (target - current) * 0.14;
    if (Math.abs(target - current) < 0.5) current = target;
    render(current);
    if (current !== target) schedule();
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  addEventListener('scroll', schedule, { passive: true });
  new ResizeObserver(build).observe(page);
  document.fonts?.ready.then(build);
  build();

  // ------------------------------------------------------------------ extras

  const nav = $('#nav');
  const onScroll = () => nav.classList.toggle('scrolled', scrollY > 24);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const revealer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add('in');
      revealer.unobserve(e.target);
    }
  }, { rootMargin: '0px 0px -12% 0px' });
  $$('.reveal').forEach((el) => revealer.observe(el));

  // The platter turns slowly (one turn every 7.2 s), and scrolling scratches it.
  const platter = $('.platter');
  if (platter && !reduceMotion) {
    let angle = 0, last = 0, lastScroll = scrollY, spinning = false, visible = true;
    const spin = (now) => {
      if (!visible) { spinning = false; return; }
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      angle = (angle + dt * 0.05 + (scrollY - lastScroll) * 0.7) % 360;
      lastScroll = scrollY;
      platter.setAttribute('transform', `rotate(${n1(angle)} 320 360)`);
      requestAnimationFrame(spin);
    };
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !spinning) {
        spinning = true;
        last = 0;
        lastScroll = scrollY;
        requestAnimationFrame(spin);
      }
    }).observe($('.hero-art'));
  }
})();
