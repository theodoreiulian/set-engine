// Backwards-compatible re-export. The real implementation now lives in
// tool-update.js, which serves both yt-dlp and spotdl with one parameterised
// flow. Existing imports of runYtdlpUpdateFlow keep working unchanged.
export { runYtdlpUpdateFlow, runSpotdlUpdateFlow, runToolUpdateFlow } from './tool-update.js';
