// Deterministic cue duration fitting (PR 3, Part 9). PURE.
//
// A cue must fit the real available window. This decides HOW: use it whole, take
// a faded excerpt, apply a bounded time-stretch, or REJECT it (never force a
// 2s cue into a 500ms gap, never create an abrupt waveform edge). It never
// selects an asset outside the frozen profile — that is the director's job; this
// only shapes a chosen cue to a window. Any excerpting/stretching is reported so
// the plan + diagnostics record it.

export interface CueFitConfig {
  maxStretchPercent: number; // max |time-stretch| allowed
  minCueAudibleMs: number;   // shortest audible cue worth placing
  minFadeMs: number;
  maxFadeMs: number;
}

const num = (name: string, dflt: number) => { const v = Number(process.env[name]); return Number.isFinite(v) ? v : dflt; };
export function resolveCueFitConfig(): CueFitConfig {
  return {
    maxStretchPercent: num("POST_TTS_MAX_TIME_STRETCH_PERCENT", 6),
    minCueAudibleMs: num("POST_TTS_MIN_CUE_AUDIBLE_MS", 400),
    minFadeMs: num("POST_TTS_MIN_FADE_MS", 30),
    maxFadeMs: num("POST_TTS_MAX_FADE_MS", 1200),
  };
}

export type CueFitStrategy = "full" | "faded_excerpt" | "time_stretch" | "reject";
export type CueFitRequest = "auto" | "full" | "faded_excerpt" | "time_stretch";

export interface CueFitResult {
  ok: boolean;
  strategy: CueFitStrategy;
  audibleMs: number;       // resulting audible cue length in the mix
  sourceStartMs: number;   // excerpt start within the source asset
  sourceEndMs: number;     // excerpt end within the source asset
  fadeInMs: number;
  fadeOutMs: number;
  stretchPercent: number;  // 0 = none; negative = compressed to fit
  reason: string;
}

const clampFade = (v: number, cfg: CueFitConfig) => Math.max(cfg.minFadeMs, Math.min(cfg.maxFadeMs, Math.round(v)));

function reject(reason: string): CueFitResult {
  return { ok: false, strategy: "reject", audibleMs: 0, sourceStartMs: 0, sourceEndMs: 0, fadeInMs: 0, fadeOutMs: 0, stretchPercent: 0, reason };
}

/**
 * Fit a cue of `cueDurationMs` into a safe `windowMs`. Deterministic.
 *   auto:         full if it fits, else a faded leading excerpt, else reject.
 *   time_stretch: compress to the window ONLY within the bounded percent, else reject.
 */
export function fitCue(cueDurationMs: number, windowMs: number, cfg: CueFitConfig, request: CueFitRequest = "auto"): CueFitResult {
  if (!Number.isFinite(cueDurationMs) || cueDurationMs <= 0) return reject("invalid cue duration");
  if (!Number.isFinite(windowMs) || windowMs < cfg.minCueAudibleMs) return reject(`window ${Math.round(windowMs)}ms below minimum audible cue ${cfg.minCueAudibleMs}ms`);

  const wantFade = clampFade(Math.min(cueDurationMs * 0.2, windowMs * 0.2, 400), cfg);

  // Explicit bounded time-stretch.
  if (request === "time_stretch") {
    if (cueDurationMs <= windowMs) return { ok: true, strategy: "full", audibleMs: cueDurationMs, sourceStartMs: 0, sourceEndMs: cueDurationMs, fadeInMs: wantFade, fadeOutMs: wantFade, stretchPercent: 0, reason: "fits without stretch" };
    const stretchPct = ((cueDurationMs - windowMs) / cueDurationMs) * 100; // % to remove
    if (stretchPct > cfg.maxStretchPercent) return reject(`time-stretch ${stretchPct.toFixed(1)}% exceeds bound ${cfg.maxStretchPercent}%`);
    return { ok: true, strategy: "time_stretch", audibleMs: windowMs, sourceStartMs: 0, sourceEndMs: cueDurationMs, fadeInMs: wantFade, fadeOutMs: wantFade, stretchPercent: -Number(stretchPct.toFixed(2)), reason: `bounded time-stretch -${stretchPct.toFixed(1)}%` };
  }

  // Fits whole (exact or shorter than the window).
  if (cueDurationMs <= windowMs) {
    return { ok: true, strategy: "full", audibleMs: cueDurationMs, sourceStartMs: 0, sourceEndMs: cueDurationMs, fadeInMs: wantFade, fadeOutMs: wantFade, stretchPercent: 0, reason: cueDurationMs === windowMs ? "exact fit" : "cue shorter than window" };
  }

  // Too long: a faded leading excerpt. Requires room for BOTH fades so the edit
  // is never an abrupt waveform edge.
  if (windowMs < 2 * cfg.minFadeMs) return reject(`window ${Math.round(windowMs)}ms too short to fade an excerpt (needs >= ${2 * cfg.minFadeMs}ms)`);
  if (request === "full") return reject("cue longer than window and full requested");
  const fade = clampFade(Math.min(windowMs * 0.25, 400), cfg);
  return { ok: true, strategy: "faded_excerpt", audibleMs: windowMs, sourceStartMs: 0, sourceEndMs: windowMs, fadeInMs: fade, fadeOutMs: fade, stretchPercent: 0, reason: `faded leading excerpt (${Math.round(cueDurationMs)}ms -> ${Math.round(windowMs)}ms)` };
}
