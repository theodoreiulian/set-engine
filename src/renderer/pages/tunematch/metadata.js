// TuneMatch — Audio Metadata Parser (ES module port)
//
// Aggressive, fault-tolerant metadata extraction.
// If structured parsing fails, falls back to raw byte scanning.

const AUDIO_EXTS = new Set([
  'mp3', 'flac', 'wav', 'wave', 'aiff', 'aif',
  'ogg', 'm4a', 'mp4', 'aac', 'alac', 'wma', 'opus',
]);

export function isAudioFile(name) {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return AUDIO_EXTS.has(name.substring(dot + 1).toLowerCase());
}

function getExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot !== -1 ? name.substring(dot + 1).toLowerCase() : '';
}

// ---- Binary helpers ----

function readSlice(file, start, size) {
  return new Promise((resolve, reject) => {
    if (start >= file.size) { resolve(new Uint8Array(0)); return; }
    const end = Math.min(start + size, file.size);
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(new Error('FileReader error'));
    reader.readAsArrayBuffer(file.slice(start, end));
  });
}

function ascii(b, off, len) {
  let s = '';
  for (let i = 0; i < len && off + i < b.length; i++) {
    const c = b[off + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function u32be(b, o) { return ((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0; }
function u32le(b, o) { return (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0; }
function u24be(b, o) { return (b[o] << 16) | (b[o+1] << 8) | b[o+2]; }
function u16be(b, o) { return (b[o] << 8) | b[o+1]; }

function syncsafe(b, o) {
  return ((b[o] & 0x7F) << 21) |
         ((b[o+1] & 0x7F) << 14) |
         ((b[o+2] & 0x7F) << 7) |
         (b[o+3] & 0x7F);
}

function isFrameIdChar(c) {
  return (c >= 0x41 && c <= 0x5A) || (c >= 0x30 && c <= 0x39);
}

function isValidFrameId4(b, pos) {
  return pos + 4 <= b.length &&
    isFrameIdChar(b[pos]) && isFrameIdChar(b[pos+1]) &&
    isFrameIdChar(b[pos+2]) && isFrameIdChar(b[pos+3]);
}

function isValidFrameId3(b, pos) {
  return pos + 3 <= b.length &&
    isFrameIdChar(b[pos]) && isFrameIdChar(b[pos+1]) && isFrameIdChar(b[pos+2]);
}

// ---- Text decoding ----

function decodeID3Text(b, off, len) {
  if (len < 1) return '';
  const enc = b[off];
  const raw = b.subarray(off + 1, off + len);
  let str;
  try {
    switch (enc) {
      case 1:  str = new TextDecoder('utf-16').decode(raw); break;
      case 2:  str = new TextDecoder('utf-16be').decode(raw); break;
      case 3:  str = new TextDecoder('utf-8').decode(raw); break;
      default: str = new TextDecoder('iso-8859-1').decode(raw); break;
    }
  } catch (_) {
    str = '';
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] >= 32 && raw[i] < 127) str += String.fromCharCode(raw[i]);
    }
  }
  return str.replace(/\0+/g, '').trim();
}

function decodeTXXX(b, off, len) {
  if (len < 2) return { desc: '', value: '' };
  const enc = b[off];
  const nullSz = (enc === 1 || enc === 2) ? 2 : 1;
  let pos = off + 1;
  const end = off + len;

  let descEnd = pos;
  if (nullSz === 1) {
    while (descEnd < end && b[descEnd] !== 0) descEnd++;
  } else {
    while (descEnd + 1 < end) {
      if (b[descEnd] === 0 && b[descEnd+1] === 0) break;
      descEnd += 2;
    }
  }

  let decoder;
  try {
    switch (enc) {
      case 1: decoder = new TextDecoder('utf-16'); break;
      case 2: decoder = new TextDecoder('utf-16be'); break;
      case 3: decoder = new TextDecoder('utf-8'); break;
      default: decoder = new TextDecoder('iso-8859-1'); break;
    }
  } catch (_) {
    decoder = new TextDecoder('iso-8859-1');
  }

  const desc = decoder.decode(b.subarray(pos, descEnd)).replace(/\0/g, '').trim();
  const valStart = Math.min(descEnd + nullSz, end);
  const value = decoder.decode(b.subarray(valStart, end)).replace(/\0/g, '').trim();
  return { desc, value };
}

function decodeCOMM(b, off, len) {
  if (len < 5) return '';
  const enc = b[off];
  let pos = off + 4;
  const end = off + len;
  const nullSz = (enc === 1 || enc === 2) ? 2 : 1;

  if (nullSz === 1) {
    while (pos < end && b[pos] !== 0) pos++;
    pos++;
  } else {
    while (pos + 1 < end) {
      if (b[pos] === 0 && b[pos+1] === 0) break;
      pos += 2;
    }
    pos += 2;
  }
  if (pos >= end) return '';

  try {
    let decoder;
    switch (enc) {
      case 1: decoder = new TextDecoder('utf-16'); break;
      case 2: decoder = new TextDecoder('utf-16be'); break;
      case 3: decoder = new TextDecoder('utf-8'); break;
      default: decoder = new TextDecoder('iso-8859-1'); break;
    }
    return decoder.decode(b.subarray(pos, end)).replace(/\0+/g, '').trim();
  } catch (_) { return ''; }
}

function utf8(b, off, len) {
  try { return new TextDecoder('utf-8').decode(b.subarray(off, off + len)); }
  catch (_) { return ''; }
}

function latin1(b, off, len) {
  let s = '';
  for (let i = 0; i < len && off + i < b.length; i++) s += String.fromCharCode(b[off + i]);
  return s;
}

// ---- ID3v2 ----

function findID3v2(b) {
  for (let i = 0; i <= b.length - 10; i++) {
    if (b[i] === 0x49 && b[i+1] === 0x44 && b[i+2] === 0x33) {
      const ver = b[i+3];
      if (ver >= 2 && ver <= 4) return i;
    }
  }
  return -1;
}

function parseID3v2(b, offset) {
  if (!offset) offset = 0;
  if (offset + 10 > b.length) return null;
  if (b[offset] !== 0x49 || b[offset+1] !== 0x44 || b[offset+2] !== 0x33) return null;

  const ver = b[offset + 3];
  const flags = b[offset + 5];
  const tagSize = syncsafe(b, offset + 6);
  if (ver < 2 || ver > 4 || tagSize <= 0) return null;

  let pos = offset + 10;

  if ((flags & 0x40) && ver >= 3) {
    if (pos + 4 > b.length) return null;
    try {
      const ext = ver === 4 ? syncsafe(b, pos) : u32be(b, pos) + 4;
      pos += ext;
    } catch (_) { /* skip */ }
  }

  const r = { title: '', artist: '', bpm: 0, key: '' };
  const tagEnd = Math.min(offset + 10 + tagSize, b.length);
  const idLen = ver === 2 ? 3 : 4;
  const hdrLen = ver === 2 ? 6 : 10;

  while (pos + hdrLen < tagEnd) {
    if (ver === 2) { if (!isValidFrameId3(b, pos)) break; }
    else { if (!isValidFrameId4(b, pos)) break; }

    const id = ascii(b, pos, idLen);
    const fsize = computeFrameSize(b, pos, ver, idLen, hdrLen, tagEnd);
    if (fsize <= 0 || pos + hdrLen + fsize > tagEnd) break;

    const doff = pos + hdrLen;
    extractFromFrame(id, b, doff, fsize, r);
    pos += hdrLen + fsize;
  }

  if (!r.bpm || !r.key) {
    bruteForceFrameScan(b, offset + 10, tagEnd, ver, hdrLen, r);
  }

  return r;
}

function computeFrameSize(b, pos, ver, idLen, hdrLen, tagEnd) {
  if (ver === 2) return u24be(b, pos + 3);

  const ssSz = syncsafe(b, pos + 4);
  const regSz = u32be(b, pos + 4);

  if (ssSz === regSz) return ssSz;

  const primary = ver === 4 ? ssSz : regSz;
  const alt = ver === 4 ? regSz : ssSz;

  const nextPrimary = pos + hdrLen + primary;
  const nextAlt = pos + hdrLen + alt;

  if (primary > 0 && primary < 10000000) {
    if (nextPrimary >= tagEnd || nextPrimary + 4 > b.length) return primary;
    if (isValidFrameId4(b, nextPrimary) || b[nextPrimary] === 0) return primary;
  }
  if (alt > 0 && alt < 10000000) {
    if (nextAlt >= tagEnd || nextAlt + 4 > b.length) return alt;
    if (isValidFrameId4(b, nextAlt) || b[nextAlt] === 0) return alt;
  }

  return primary > 0 ? primary : alt;
}

function extractFromFrame(id, b, doff, fsize, r) {
  if (id === 'APIC' || id === 'PIC' || id === 'GEOB' ||
      id === 'PRIV' || id === 'MCDI' || id === 'UFID' ||
      id === 'USLT' || id === 'SYLT') return;

  try {
    if (id === 'TIT2' || id === 'TT2') {
      if (!r.title) r.title = decodeID3Text(b, doff, fsize);
    } else if (id === 'TPE1' || id === 'TP1') {
      if (!r.artist) r.artist = decodeID3Text(b, doff, fsize);
    } else if (id === 'TBPM' || id === 'TBP') {
      const v = parseFloat(decodeID3Text(b, doff, fsize));
      if (v > 0 && !r.bpm) r.bpm = v;
    } else if (id === 'TKEY' || id === 'TKE') {
      const k = decodeID3Text(b, doff, fsize);
      if (k && !r.key) r.key = k;
    } else if (id === 'TXXX' || id === 'TXX') {
      const tx = decodeTXXX(b, doff, fsize);
      const d = tx.desc.toUpperCase().replace(/[\s_\-]/g, '');
      if (!r.bpm && (d === 'BPM' || d === 'TEMPO' || d === 'BEATSPERMINUTE')) {
        const v = parseFloat(tx.value); if (v > 0) r.bpm = v;
      }
      if (!r.key && (d === 'KEY' || d === 'INITIALKEY' || d === 'MUSICALKEY' ||
          d === 'CAMELOT' || d === 'CAMELOTKEY' || d === 'OPENKEY')) {
        if (tx.value) r.key = tx.value;
      }
    } else if (id === 'COMM' || id === 'COM') {
      if (!r.key) {
        const comment = decodeCOMM(b, doff, fsize);
        if (comment) {
          const m = comment.match(/\b(\d{1,2}[ABab])\b/);
          if (m) r.key = m[1];
        }
      }
    }
  } catch (_) { /* skip */ }
}

function bruteForceFrameScan(b, start, end, ver, hdrLen, r) {
  for (let i = start; i < end - 10; i++) {
    if (b[i] === 0x54) {
      const id4 = ascii(b, i, 4);
      if (id4 === 'TBPM' || id4 === 'TKEY' || id4 === 'TXXX') {
        for (const sz of [u32be(b, i + 4), syncsafe(b, i + 4)]) {
          if (sz > 0 && sz < 500 && i + 10 + sz <= end) {
            extractFromFrame(id4, b, i + 10, sz, r);
            if (r.bpm && r.key) return;
          }
        }
      }
      const id3 = ascii(b, i, 3);
      if (id3 === 'TBP' || id3 === 'TKE' || id3 === 'TXX') {
        const sz = u24be(b, i + 3);
        if (sz > 0 && sz < 500 && i + 6 + sz <= end) {
          extractFromFrame(id3, b, i + 6, sz, r);
          if (r.bpm && r.key) return;
        }
      }
    }
  }
}

// ---- Vorbis Comments ----

function parseVorbisComments(b, off) {
  if (off + 8 > b.length) return null;
  const r = { title: '', artist: '', bpm: 0, key: '' };

  try {
    let pos = off;
    const vendorLen = u32le(b, pos);
    if (vendorLen > 10000) return null;
    pos += 4 + vendorLen;
    if (pos + 4 > b.length) return r;

    const count = u32le(b, pos);
    if (count > 100000) return null;
    pos += 4;

    for (let i = 0; i < count && pos + 4 < b.length; i++) {
      const len = u32le(b, pos);
      pos += 4;
      if (len > 100000 || pos + len > b.length) break;

      const line = utf8(b, pos, len);
      pos += len;

      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const field = line.substring(0, eq).toUpperCase().replace(/[\s_\-]/g, '');
      const val = line.substring(eq + 1);

      if (field === 'TITLE') r.title = val;
      else if (field === 'ARTIST') r.artist = val;
      else if (field === 'BPM' || field === 'TEMPO' || field === 'BEATSPERMINUTE') {
        const v = parseFloat(val); if (v > 0) r.bpm = v;
      }
      else if (field === 'KEY' || field === 'INITIALKEY' || field === 'MUSICALKEY' ||
               field === 'CAMELOT' || field === 'CAMELOTKEY') {
        r.key = val.trim();
      }
    }
  } catch (_) { /* partial parse ok */ }
  return r;
}

// ---- Universal raw text scanner ----

function universalScan(b) {
  const r = { title: '', artist: '', bpm: 0, key: '' };
  const text = latin1(b, 0, b.length);

  if (!r.bpm) {
    const bpmPatterns = [
      /BPM=(\d+\.?\d*)/i,
      /TEMPO=(\d+\.?\d*)/i,
      /BEATSPERMINUTE=(\d+\.?\d*)/i,
      /TBPM[^\d]{0,10}(\d{2,3}\.?\d*)/,
      /TBP[^\d]{0,10}(\d{2,3}\.?\d*)/,
    ];
    for (const pat of bpmPatterns) {
      const m = text.match(pat);
      if (m) {
        const v = parseFloat(m[1]);
        if (v >= 40 && v <= 300) { r.bpm = v; break; }
      }
    }
  }

  if (!r.key) {
    const keyPatterns = [
      /(?:INITIAL_?KEY|MUSICALKEY|CAMELOT(?:KEY)?|^KEY)\s*=\s*(\d{1,2}[ABab])\b/im,
      /TKEY[^\x20-\x7E]{0,10}(\d{1,2}[ABab])/,
      /TKE[^\x20-\x7E]{0,10}(\d{1,2}[ABab])/,
      /(?:INITIAL_?KEY|KEY)\s*=\s*([A-G][#b]?m?\s*(?:min|maj|minor|major)?)/im,
      /TKEY[^\x20-\x7E]{0,10}([A-G][#b]?m)/,
    ];
    for (const pat of keyPatterns) {
      const m = text.match(pat);
      if (m) { r.key = m[1].trim(); break; }
    }
  }

  if (!r.key) {
    const camelotRe = /\b(\d{1,2}[ABab])\b/g;
    let match;
    while ((match = camelotRe.exec(text)) !== null) {
      const num = parseInt(match[1]);
      if (num >= 1 && num <= 12) {
        const start = Math.max(0, match.index - 50);
        const context = text.substring(start, match.index + match[0].length + 50);
        if (/(?:key|KEY|TKEY|TKE|initial|camelot)/i.test(context) ||
            /(?:bpm|BPM|TBPM|tempo)/i.test(context)) {
          r.key = match[1].toUpperCase();
          break;
        }
      }
    }
  }

  return r;
}

// ---- Format-specific entry points ----

async function parseMP3(file) {
  const searchSize = Math.min(file.size, 1024 * 1024);
  const data = await readSlice(file, 0, searchSize);

  if (data.length < 10) return fallback(file.name);

  const id3Offset = findID3v2(data);

  if (id3Offset >= 0) {
    const r = parseID3v2(data, id3Offset);
    if (r) {
      if (!r.title) r.title = nameFromFile(file.name);
      if (r.bpm || r.key) return r;
      const u = universalScan(data);
      if (u.bpm && !r.bpm) r.bpm = u.bpm;
      if (u.key && !r.key) r.key = u.key;
      return r;
    }
  }

  const u = universalScan(data);
  if (u.bpm || u.key) {
    u.title = u.title || nameFromFile(file.name);
    return u;
  }

  return fallback(file.name);
}

async function parseFLAC(file) {
  const hdr = await readSlice(file, 0, 4);
  if (hdr.length < 4 || ascii(hdr, 0, 4) !== 'fLaC') {
    return await parseGeneric(file);
  }

  let pos = 4;
  let last = false;
  while (!last && pos < Math.min(file.size, 10 * 1024 * 1024)) {
    const bh = await readSlice(file, pos, 4);
    if (bh.length < 4) break;
    last = (bh[0] & 0x80) !== 0;
    const type = bh[0] & 0x7F;
    const size = u24be(bh, 1);
    if (size <= 0) break;

    if (type === 4) {
      const data = await readSlice(file, pos + 4, size);
      const r = parseVorbisComments(data, 0);
      if (r) { if (!r.title) r.title = nameFromFile(file.name); return r; }
    }
    pos += 4 + size;
  }
  return await parseGeneric(file);
}

async function parseOGG(file) {
  const data = await readSlice(file, 0, Math.min(file.size, 256 * 1024));
  const sig = [0x03, 0x76, 0x6F, 0x72, 0x62, 0x69, 0x73];
  for (let i = 0; i < data.length - 7; i++) {
    let ok = true;
    for (let j = 0; j < 7; j++) { if (data[i+j] !== sig[j]) { ok = false; break; } }
    if (ok) {
      const r = parseVorbisComments(data, i + 7);
      if (r) { if (!r.title) r.title = nameFromFile(file.name); return r; }
    }
  }
  const opusSig = [0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73];
  for (let i = 0; i < data.length - 8; i++) {
    let ok = true;
    for (let j = 0; j < 8; j++) { if (data[i+j] !== opusSig[j]) { ok = false; break; } }
    if (ok) {
      const r = parseVorbisComments(data, i + 8);
      if (r) { if (!r.title) r.title = nameFromFile(file.name); return r; }
    }
  }
  return await parseGeneric(file);
}

async function parseWAV(file) {
  const data = await readSlice(file, 0, Math.min(file.size, 1024 * 1024));
  if (data.length < 12 || ascii(data, 0, 4) !== 'RIFF') return await parseGeneric(file);

  let pos = 12;
  while (pos + 8 < data.length) {
    const chunkId = ascii(data, pos, 4).toLowerCase();
    const chunkSz = u32le(data, pos + 4);
    if (chunkSz <= 0 || chunkSz > data.length) break;

    if (chunkId === 'id3 ' || chunkId === 'id3\0') {
      const r = parseID3v2(data, pos + 8);
      if (r) { if (!r.title) r.title = nameFromFile(file.name); return r; }
    }
    pos += 8 + chunkSz + (chunkSz % 2);
  }

  const id3Off = findID3v2(data);
  if (id3Off >= 0) {
    const r = parseID3v2(data, id3Off);
    if (r) { if (!r.title) r.title = nameFromFile(file.name); return r; }
  }

  return await parseGeneric(file);
}

async function parseAIFF(file) {
  const data = await readSlice(file, 0, Math.min(file.size, 1024 * 1024));
  if (data.length < 12 || ascii(data, 0, 4) !== 'FORM') return await parseGeneric(file);

  let pos = 12;
  while (pos + 8 < data.length) {
    const chunkId = ascii(data, pos, 4);
    const chunkSz = u32be(data, pos + 4);
    if (chunkSz <= 0 || chunkSz > data.length) break;

    if (chunkId === 'ID3 ' || chunkId === 'id3 ') {
      const r = parseID3v2(data, pos + 8);
      if (r) { if (!r.title) r.title = nameFromFile(file.name); return r; }
    }
    pos += 8 + chunkSz + (chunkSz % 2);
  }

  const id3Off = findID3v2(data);
  if (id3Off >= 0) {
    const r = parseID3v2(data, id3Off);
    if (r) { if (!r.title) r.title = nameFromFile(file.name); return r; }
  }

  return await parseGeneric(file);
}

async function parseM4A(file) {
  const r = { title: '', artist: '', bpm: 0, key: '' };

  let moovPos = -1;
  let moovSize = 0;
  let pos = 0;

  while (pos < file.size - 8) {
    const hdr = await readSlice(file, pos, 16);
    if (hdr.length < 8) break;

    let sz = u32be(hdr, 0);
    const type = ascii(hdr, 4, 4);

    if (sz === 1 && hdr.length >= 16) {
      const hi = u32be(hdr, 8);
      const lo = u32be(hdr, 12);
      sz = hi * 0x100000000 + lo;
    }
    if (sz === 0) sz = file.size - pos;
    if (sz < 8) break;

    if (type === 'moov') {
      moovPos = pos;
      moovSize = sz;
      break;
    }

    pos += sz;
  }

  if (moovPos < 0) {
    if (!r.title) r.title = nameFromFile(file.name);
    return r;
  }

  const moovData = await readSlice(file, moovPos, Math.min(moovSize, 10 * 1024 * 1024));
  if (moovData.length < 16) {
    if (!r.title) r.title = nameFromFile(file.name);
    return r;
  }

  function findAtom(data, start, end, name) {
    let p = start;
    while (p + 8 <= end) {
      const sz = u32be(data, p);
      if (sz < 8) { p += 4; continue; }
      if (p + sz > end) break;
      const t = ascii(data, p + 4, 4);
      if (t === name) return { pos: p, size: sz, data: p + 8 };
      p += sz;
    }
    return null;
  }

  try {
    const moovEnd = moovData.length;
    const udta = findAtom(moovData, 8, moovEnd, 'udta');
    if (!udta) { if (!r.title) r.title = nameFromFile(file.name); return r; }

    const meta = findAtom(moovData, udta.data, udta.pos + udta.size, 'meta');
    if (!meta) { if (!r.title) r.title = nameFromFile(file.name); return r; }

    // mdta key/value metadata (what ffmpeg writes with -movflags use_metadata_tags).
    // Stored as a `keys` table of names plus an `ilst` whose entries are indexed
    // into that table — distinct from the classic ©-atom / `----` freeform layout
    // handled below. SetEngine tags M4A files this way, so reading it back is what
    // makes a re-imported, freshly-tagged M4A show up as already tagged.
    const keysAtom = findAtom(moovData, meta.data + 4, meta.pos + meta.size, 'keys');
    if (keysAtom) {
      try {
        const keyNames = [];
        const kEnd = keysAtom.pos + keysAtom.size;
        let kp = keysAtom.data + 4;                 // skip version + flags
        const count = u32be(moovData, kp); kp += 4;
        for (let i = 0; i < count && kp + 8 <= kEnd; i++) {
          const ksz = u32be(moovData, kp);
          if (ksz < 8 || kp + ksz > kEnd) break;
          keyNames.push(ascii(moovData, kp + 8, ksz - 8));
          kp += ksz;
        }
        const ilstM = findAtom(moovData, meta.data + 4, meta.pos + meta.size, 'ilst');
        if (ilstM && keyNames.length) {
          let mp = ilstM.data;
          const mEnd = ilstM.pos + ilstM.size;
          while (mp + 8 <= mEnd) {
            const sz = u32be(moovData, mp);
            if (sz < 8 || mp + sz > mEnd) break;
            const idx = u32be(moovData, mp + 4);     // 1-based index into keyNames
            const dAtom = findAtom(moovData, mp + 8, mp + sz, 'data');
            if (idx >= 1 && idx <= keyNames.length && dAtom && dAtom.size > 16) {
              const val = utf8(moovData, dAtom.data + 8, dAtom.size - 16).trim();
              const key = keyNames[idx - 1].toUpperCase().replace(/[\s_\-]/g, '');
              if (!r.key && (key === 'INITIALKEY' || key === 'KEY' || key === 'MUSICALKEY' || key === 'TKEY' || key === 'CAMELOT')) {
                r.key = val;
              }
              if (!r.bpm && (key === 'BPM' || key === 'TBPM' || key === 'TEMPO' || key === 'BEATSPERMINUTE')) {
                const v = parseFloat(val); if (v > 0) r.bpm = v;
              }
            }
            mp += sz;
          }
        }
      } catch (_) {}
    }

    const ilst = findAtom(moovData, meta.data + 4, meta.pos + meta.size, 'ilst');
    if (!ilst) { if (!r.title) r.title = nameFromFile(file.name); return r; }

    let p = ilst.data;
    const ilEnd = ilst.pos + ilst.size;
    while (p + 8 <= ilEnd) {
      const iSz = u32be(moovData, p);
      if (iSz < 8) break;
      if (p + iSz > ilEnd) break;
      const iType = ascii(moovData, p + 4, 4);

      const dAtom = findAtom(moovData, p + 8, p + iSz, 'data');
      if (dAtom && dAtom.size > 16) {
        const vStart = dAtom.data + 8;
        const vLen = dAtom.size - 16;
        try {
          if (iType === '\xA9nam') {
            if (!r.title) r.title = utf8(moovData, vStart, vLen);
          } else if (iType === '\xA9ART') {
            if (!r.artist) r.artist = utf8(moovData, vStart, vLen);
          } else if (iType === 'tmpo') {
            if (!r.bpm) {
              if (vLen >= 4) r.bpm = u32be(moovData, vStart);
              else if (vLen >= 2) r.bpm = u16be(moovData, vStart);
            }
          }
        } catch (_) {}
      }

      if (iType === '----') {
        try {
          const nameAtom = findAtom(moovData, p + 8, p + iSz, 'name');
          if (nameAtom && nameAtom.size > 12) {
            const atomName = utf8(moovData, nameAtom.data + 4, nameAtom.size - 12)
              .toUpperCase().replace(/[\s_\-]/g, '');
            const valAtom = findAtom(moovData, p + 8, p + iSz, 'data');
            if (valAtom && valAtom.size > 16) {
              const valText = utf8(moovData, valAtom.data + 8, valAtom.size - 16).trim();
              if (!r.key && (atomName === 'INITIALKEY' || atomName === 'KEY' || atomName === 'MUSICALKEY')) {
                r.key = valText;
              }
              if (!r.bpm && (atomName === 'BPM' || atomName === 'TEMPO' || atomName === 'BEATSPERMINUTE')) {
                const v = parseFloat(valText);
                if (v > 0) r.bpm = v;
              }
            }
          }
        } catch (_) {}
      }

      p += iSz;
    }
  } catch (_) {}

  if (!r.bpm || !r.key) {
    const u = universalScan(moovData);
    if (u.bpm && !r.bpm) r.bpm = u.bpm;
    if (u.key && !r.key) r.key = u.key;
  }

  if (!r.title) r.title = nameFromFile(file.name);
  return r;
}

async function parseGeneric(file) {
  const data = await readSlice(file, 0, Math.min(file.size, 1024 * 1024));
  if (data.length < 10) return fallback(file.name);

  const id3Off = findID3v2(data);
  if (id3Off >= 0) {
    const r = parseID3v2(data, id3Off);
    if (r && (r.bpm || r.key)) {
      if (!r.title) r.title = nameFromFile(file.name);
      return r;
    }
  }

  for (let i = 0; i < data.length - 11; i++) {
    if (data[i] === 0x03 && data[i+1] === 0x76 && data[i+2] === 0x6F &&
        data[i+3] === 0x72 && data[i+4] === 0x62 && data[i+5] === 0x69 && data[i+6] === 0x73) {
      const r = parseVorbisComments(data, i + 7);
      if (r && (r.bpm || r.key)) {
        if (!r.title) r.title = nameFromFile(file.name);
        return r;
      }
    }
  }

  const u = universalScan(data);
  if (u.bpm || u.key) {
    if (!u.title) u.title = nameFromFile(file.name);
    return u;
  }

  return fallback(file.name);
}

// ---- Filename fallback ----

function nameFromFile(name) {
  const dot = name.lastIndexOf('.');
  let base = dot !== -1 ? name.substring(0, dot) : name;
  base = base.replace(/^\d{1,3}[\.\-\)\s]+\s*/, '');
  return base.trim() || 'Untitled';
}

function fallback(name) {
  const title = nameFromFile(name);
  const dash = title.indexOf(' - ');
  if (dash !== -1) {
    return { title: title.substring(dash + 3).trim(), artist: title.substring(0, dash).trim(), bpm: 0, key: '' };
  }
  return { title, artist: '', bpm: 0, key: '' };
}

export async function parse(file) {
  const ext = getExtension(file.name);
  try {
    switch (ext) {
      case 'mp3':                return await parseMP3(file);
      case 'flac':               return await parseFLAC(file);
      case 'ogg': case 'opus':   return await parseOGG(file);
      case 'wav': case 'wave':   return await parseWAV(file);
      case 'aiff': case 'aif':   return await parseAIFF(file);
      case 'm4a': case 'mp4':
      case 'aac': case 'alac':   return await parseM4A(file);
      case 'wma':                return await parseGeneric(file);
      default:                   return await parseGeneric(file);
    }
  } catch (e) {
    try { return await parseGeneric(file); }
    catch (_) { return fallback(file.name); }
  }
}

export { AUDIO_EXTS };
