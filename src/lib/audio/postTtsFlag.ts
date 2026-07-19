// Post-TTS sound-direction feature flag + planning-engine decision (PR 3, Part 12).
//
// The director is OFF by default: existing/historical renders keep their exact
// behavior, and enabling the flag later must NOT change already-published
// episodes (they reproduce their stored plan). A new eligible render uses the
// post-TTS director ONLY when the flag is on. There is never a SILENT fallback
// from the director to the legacy planner — the chosen engine + reason are
// recorded so an operator can see exactly what ran.

export const POST_TTS_FLAG_ENV = "POST_TTS_SOUND_DIRECTION_ENABLED";

export function isPostTtsSoundDirectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[POST_TTS_FLAG_ENV] ?? "").trim() === "true";
}

export type PlanningEngine = "post_tts" | "legacy_planner" | "reproduce";

export interface PlanningEngineDecision {
  engine: PlanningEngine;
  flagEnabled: boolean;
  reason: string;
  /** True when the caller EXPLICITLY chose legacy (not a silent fallback). */
  explicitLegacy: boolean;
}

/**
 * Decide which sound-planning engine a render will use. Reproduce mode always
 * replays the stored plan (never re-plans). Otherwise the director runs only
 * when the flag is on AND legacy was not explicitly requested. The decision is
 * deterministic given (renderMode, flag env, explicit-legacy) and is recorded
 * in diagnostics.
 */
export function decidePlanningEngine(opts: {
  renderMode: string;
  explicitLegacy?: boolean;
  env?: NodeJS.ProcessEnv;
}): PlanningEngineDecision {
  const flagEnabled = isPostTtsSoundDirectionEnabled(opts.env);
  if (opts.renderMode === "reproduce") {
    return { engine: "reproduce", flagEnabled, reason: "reproduce mode replays the stored plan", explicitLegacy: false };
  }
  if (opts.explicitLegacy) {
    return { engine: "legacy_planner", flagEnabled, reason: "legacy planner explicitly selected", explicitLegacy: true };
  }
  if (flagEnabled) {
    return { engine: "post_tts", flagEnabled, reason: `${POST_TTS_FLAG_ENV}=true`, explicitLegacy: false };
  }
  return { engine: "legacy_planner", flagEnabled, reason: `${POST_TTS_FLAG_ENV} not enabled (default legacy)`, explicitLegacy: false };
}
