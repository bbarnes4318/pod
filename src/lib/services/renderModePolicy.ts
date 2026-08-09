// Render-mode policy — pure configuration logic, no DB and no provider imports.
//
// Kept separate from ttsSceneService deliberately: that module pulls in the
// Prisma client, which asserts production env at import time, so policy that
// must be unit-testable cannot live there.
//
// The policy itself is the point: scene rendering is the ONLY production render
// mode. `legacy_line` synthesizes every line in isolation with no conversational
// context — that IS the "both hosts sound like they are reading it cold"
// symptom — and `mixed_fallback` ships an episode that is part performed and
// part cold-read, which is worse still because nobody can hear where the seam
// is. Neither is reachable in production by any env value, typo, or omission.

export type TtsRenderModeSetting = "legacy_line" | "scene" | "auto";
export type PersistedRenderMode = "legacy_line" | "scene" | "mixed_fallback" | "performance_conversion";

/** Degraded render outcomes are DEV-ONLY and must be opted into explicitly.
 *
 * Gating on `TTS_RENDER_MODE` alone would not be enough — production sets that
 * variable, so the cold-reading path would sit one env edit away from the
 * owner's ears. This requires a SEPARATE variable that production never sets,
 * and refuses it outright when NODE_ENV is production. */
export function degradedRenderModesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.TTS_ALLOW_DEGRADED_RENDER_MODES === "true";
}

/** Resolve the render mode. In production this is always `scene`. */
export function readRenderModeSetting(env: NodeJS.ProcessEnv = process.env): TtsRenderModeSetting {
  if (!degradedRenderModesAllowed(env)) return "scene";
  const v = (env.TTS_RENDER_MODE || "legacy_line").trim().toLowerCase();
  return v === "scene" || v === "auto" ? (v as TtsRenderModeSetting) : "legacy_line";
}
