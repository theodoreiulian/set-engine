// SetEngine — Shared DSP primitives
//
// A size-parameterized radix-2 FFT factory plus window helpers, shared by the
// audio analysis modules. `audio-analyzer.js` keeps its own hot-path FFT for
// the fixed 2048-point STFT it has always used; the BPM/key detector needs a
// few different sizes (1024 for the onset envelope, 8192 for chroma), so this
// module exists to avoid duplicating the bit-reversal / butterfly code per size.
//
// Each FFT instance precomputes its bit-reversal table and twiddle factors so
// the per-frame cost is just the butterflies. The transform is in-place on the
// caller's real/imag Float32Array pair (length === size).

// Build an in-place radix-2 Cooley–Tukey FFT for a fixed power-of-two size.
// Returns a `fft(re, im)` function. `re`/`im` are mutated in place.
export function makeFft(size) {
  if ((size & (size - 1)) !== 0 || size < 2) {
    throw new Error(`FFT size must be a power of two ≥ 2 (got ${size})`);
  }

  const bits = Math.log2(size) | 0;

  // Bit-reversal permutation indices.
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let x = i, y = 0;
    for (let j = 0; j < bits; j++) { y = (y << 1) | (x & 1); x >>= 1; }
    rev[i] = y;
  }

  // Precompute twiddle factors (cos/sin) for every stage. For stage with
  // `half` butterflies we need angles -2πj/(2·half) for j in [0, half).
  // Flattened across stages into two arrays, indexed by a running cursor.
  const cosTab = [];
  const sinTab = [];
  for (let s = 2; s <= size; s <<= 1) {
    const half = s >> 1;
    const step = (-2 * Math.PI) / s;
    for (let j = 0; j < half; j++) {
      cosTab.push(Math.cos(step * j));
      sinTab.push(Math.sin(step * j));
    }
  }
  const COS = Float64Array.from(cosTab);
  const SIN = Float64Array.from(sinTab);

  return function fft(re, im) {
    // Bit-reverse reorder.
    for (let i = 0; i < size; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    // Butterflies, reading precomputed twiddles in the same order they were built.
    let tw = 0;
    for (let s = 2; s <= size; s <<= 1) {
      const half = s >> 1;
      for (let j = 0; j < half; j++) {
        const cos = COS[tw];
        const sin = SIN[tw];
        tw++;
        for (let k = j; k < size; k += s) {
          const aRe = re[k];
          const aIm = im[k];
          const bRe = re[k + half];
          const bIm = im[k + half];
          const tRe = bRe * cos - bIm * sin;
          const tIm = bRe * sin + bIm * cos;
          re[k] = aRe + tRe;
          im[k] = aIm + tIm;
          re[k + half] = aRe - tRe;
          im[k + half] = aIm - tIm;
        }
      }
    }
  };
}

// Periodic-friendly Hann window of a given length.
export function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}
