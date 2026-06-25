// TuneMatch — Matching Engine (ES module port)

const CAMELOT_TO_PITCH = {
  '1A': 8,  '2A': 3,  '3A': 10, '4A': 5,  '5A': 0,  '6A': 7,
  '7A': 2,  '8A': 9,  '9A': 4,  '10A': 11,'11A': 6, '12A': 1,
  '1B': 11, '2B': 6,  '3B': 1,  '4B': 8,  '5B': 3,  '6B': 10,
  '7B': 5,  '8B': 0,  '9B': 7,  '10B': 2, '11B': 9, '12B': 4,
};

const PITCH_TO_CAMELOT = { A: {}, B: {} };
for (const [code, pitch] of Object.entries(CAMELOT_TO_PITCH)) {
  const letter = code.slice(-1);
  PITCH_TO_CAMELOT[letter][pitch] = code;
}

const VALID_CODES = new Set(Object.keys(CAMELOT_TO_PITCH));

const CAMELOT_TO_NAME = {
  '1A': 'Abm', '2A': 'Ebm', '3A': 'Bbm', '4A': 'Fm',
  '5A': 'Cm',  '6A': 'Gm',  '7A': 'Dm',  '8A': 'Am',
  '9A': 'Em',  '10A': 'Bm', '11A': 'F#m','12A': 'C#m',
  '1B': 'B',   '2B': 'F#',  '3B': 'Db',  '4B': 'Ab',
  '5B': 'Eb',  '6B': 'Bb',  '7B': 'F',   '8B': 'C',
  '9B': 'G',   '10B': 'D',  '11B': 'A',  '12B': 'E',
};

const NOTE_TO_PITCH = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Interpret a key-name mode suffix. CASE-SENSITIVE for the single-letter form
// ('m' = minor as in "Am", 'M' = major as in "CM"); case-insensitive for the
// spelled-out forms (min/minor, maj/major). An empty suffix defaults to major.
// Returns 'minor' | 'major' | null (unrecognized — caller should reject).
function parseModeSuffix(suffix) {
  if (suffix === '') return 'major';
  if (suffix === 'm') return 'minor';
  if (suffix === 'M') return 'major';
  const s = suffix.toLowerCase();
  if (s === 'min' || s === 'minor') return 'minor';
  if (s === 'maj' || s === 'major') return 'major';
  return null;
}

export function parseKey(raw) {
  if (!raw) return null;
  const str = raw.toString().trim();
  const upper = str.toUpperCase();

  const cm = upper.match(/^0?(\d{1,2})([AB])$/);
  if (cm) {
    const num = parseInt(cm[1], 10);
    const letter = cm[2];
    if (num >= 1 && num <= 12) {
      const code = num + letter;
      return {
        code,
        pitchClass: CAMELOT_TO_PITCH[code],
        mode: letter === 'A' ? 'minor' : 'major',
      };
    }
  }

  // Note-name keys (e.g. "Am", "C#m", "Db", "F major"). Match against the
  // ORIGINAL-case string: the note letter and accidental are case-insensitive,
  // but the mode suffix's case carries meaning (lowercase 'm' = minor, uppercase
  // 'M' = major). The accidental is '#' (sharp) or 'b'/'B' (flat).
  const sm = str.match(/^([A-Ga-g])([#bB]?)\s*([A-Za-z]*)$/);
  if (sm) {
    const base = NOTE_TO_PITCH[sm[1].toUpperCase()];
    if (base === undefined) return null;
    let pitch = base;
    if (sm[2] === '#') pitch = (pitch + 1) % 12;
    else if (sm[2] === 'b' || sm[2] === 'B') pitch = (pitch + 11) % 12;

    const mode = parseModeSuffix(sm[3]);
    if (!mode) return null;
    const letter = mode === 'minor' ? 'A' : 'B';
    const code = PITCH_TO_CAMELOT[letter][pitch];
    if (!code) return null;
    return {
      code,
      pitchClass: pitch,
      mode,
    };
  }

  return null;
}

export function semitoneDist(a, b) {
  const d = Math.abs(a - b);
  return Math.min(d, 12 - d);
}

export function buildIndex(songs) {
  const idx = {};
  for (const code of VALID_CODES) idx[code] = [];
  for (const song of songs) {
    if (song.parsedKey) {
      idx[song.parsedKey.code].push(song);
    }
  }
  return idx;
}

export function findMatches(song, index, bpmThreshold) {
  if (typeof bpmThreshold !== 'number') bpmThreshold = 10;
  const result = { tier1: [], tier2: [] };
  if (!song.parsedKey) return result;

  const { pitchClass, mode, code } = song.parsedKey;
  const letter = mode === 'minor' ? 'A' : 'B';

  const bucket = index[code];
  if (bucket) {
    for (let i = 0; i < bucket.length; i++) {
      const s = bucket[i];
      if (s._id === song._id) continue;
      const diff = Math.abs(s.bpm - song.bpm);
      if (diff <= bpmThreshold) {
        result.tier1.push(Object.assign({}, s, { bpmDiff: diff }));
      }
    }
  }

  const pitchUp = (pitchClass + 1) % 12;
  const pitchDown = (pitchClass + 11) % 12;
  const codeUp = PITCH_TO_CAMELOT[letter][pitchUp];
  const codeDown = PITCH_TO_CAMELOT[letter][pitchDown];

  const t2codes = [];
  if (codeUp) t2codes.push(codeUp);
  if (codeDown && codeDown !== codeUp) t2codes.push(codeDown);

  for (const c of t2codes) {
    const b = index[c];
    if (!b) continue;
    for (let i = 0; i < b.length; i++) {
      const s = b[i];
      if (s._id === song._id) continue;
      const diff = Math.abs(s.bpm - song.bpm);
      if (diff <= bpmThreshold) {
        result.tier2.push(Object.assign({}, s, { bpmDiff: diff }));
      }
    }
  }

  result.tier1.sort((a, b) => a.bpmDiff - b.bpmDiff);
  result.tier2.sort((a, b) => a.bpmDiff - b.bpmDiff);

  return result;
}

export function getAdjacentKeys(code) {
  const parsed = parseKey(code);
  if (!parsed) return [];
  const letter = parsed.mode === 'minor' ? 'A' : 'B';
  const up = (parsed.pitchClass + 1) % 12;
  const down = (parsed.pitchClass + 11) % 12;
  const results = [];
  if (PITCH_TO_CAMELOT[letter][up]) results.push(PITCH_TO_CAMELOT[letter][up]);
  if (PITCH_TO_CAMELOT[letter][down]) results.push(PITCH_TO_CAMELOT[letter][down]);
  return results;
}

export { CAMELOT_TO_PITCH, CAMELOT_TO_NAME, VALID_CODES };
