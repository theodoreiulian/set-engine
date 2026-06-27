// SetEngine — shared recognizer helpers
//
// Small bits of logic common to both recognizers (AudD / ACRCloud), kept here so
// the clamp/default lives in exactly one place.

// User-configured confidence floor (0–100), clamped. Defaults to 60 when unset.
export function minConfidenceOf(settings) {
  const v = Number(settings && settings.recognizerMinConfidence);
  if (!Number.isFinite(v)) return 60;
  return Math.min(100, Math.max(0, v));
}
