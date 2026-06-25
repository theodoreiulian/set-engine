// SetEngine — Recognizer factory
//
// Song identification needs a fingerprinting service with a reference database
// (local DSP can't name an unknown track). We support two engines, picked in
// Settings, behind one tiny interface:
//
//   recognize(audioPath, { signal, durationSec, onProgress })
//     → Promise<{ tracks: Array<{ artist, title, album, offsetSec }> }>
//
// The factory validates that the selected engine's credentials are present and
// throws a clear, user-facing error *before* any expensive work (download /
// scan) happens, so the orchestrator can surface it immediately.

import * as audd from './audd.js';
import * as acrcloud from './acrcloud.js';

export function getRecognizer(settings) {
  const engine = (settings && settings.recognizer) || 'audd';

  if (engine === 'acrcloud') {
    if (!settings.acrHost || !settings.acrAccessKey || !settings.acrAccessSecret) {
      throw new Error('ACRCloud is selected but its credentials are incomplete. Add the host, access key, and access secret in Settings.');
    }
    return {
      name: 'acrcloud',
      recognize: (audioPath, opts) => acrcloud.recognize(audioPath, { ...opts, settings }),
    };
  }

  // Default: AudD.
  if (!settings.auddApiToken) {
    throw new Error('AudD is selected but no API token is set. Add your AudD API token in Settings (or switch the engine to ACRCloud).');
  }
  return {
    name: 'audd',
    recognize: (audioPath, opts) => audd.recognize(audioPath, { ...opts, settings }),
  };
}
