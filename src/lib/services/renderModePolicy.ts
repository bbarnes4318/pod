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

/** The dead outer candidate knobs. Setting one is a startup error.
 *
 * `TTS_SCENE_CANDIDATES_COLD_OPEN` / `_PEAK` / `_DEFAULT` looked like the
 * best-of-N quality dial and were not. They drove an OUTER loop that writes one
 * DialogueSceneAudio row per candidate; the row it kept was simply the first
 * that succeeded, because nothing at this layer can compare two renders. Real
 * best-of-N lives one level down in `synthesizeFishDialogueScene`, which
 * requests 3 candidates on cold_open/argument_escalation and 2 elsewhere — in
 * CODE, not env — and selects on an acoustic QA score.
 *
 * Raising an outer knob therefore multiplied spend (outer x inner) for a pick
 * that was arbitrary. Deleting it silently would leave the same trap for the
 * next operator who finds the name in a runbook, so setting one now refuses to
 * start and names the knob that actually works. */
export const DEAD_SCENE_CANDIDATE_VARS = [
  "TTS_SCENE_CANDIDATES_COLD_OPEN",
  "TTS_SCENE_CANDIDATES_PEAK",
  "TTS_SCENE_CANDIDATES_DEFAULT",
] as const;

export function assertNoDeadSceneCandidateVars(env: NodeJS.ProcessEnv = process.env): void {
  const set = DEAD_SCENE_CANDIDATE_VARS.filter((name) => (env[name] ?? "").toString().trim() !== "");
  if (set.length === 0) return;
  throw new Error(
    `${set.join(", ")} ${set.length === 1 ? "is" : "are"} set but ${set.length === 1 ? "does" : "do"} nothing. ` +
      `Scene best-of-N selection is FISH_PERFORMANCE_CANDIDATES (1-4), which selects on acoustic QA inside the ` +
      `Fish adapter and defaults to 3 on cold opens and argument peaks. Unset ${set.join(", ")}.`
  );
}
