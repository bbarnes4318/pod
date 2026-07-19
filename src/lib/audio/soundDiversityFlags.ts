// Sound-diversity ROLLOUT flags (PR 4, Part 12). Server-side, fail-safe.
//
//   SOUND_DIVERSITY_ENGINE_ENABLED         "true" to turn the engine on
//   SOUND_DIVERSITY_ENFORCEMENT_MODE       off | observe | soft | enforce
//   SOUND_DIVERSITY_SYSTEM_HISTORY_ENABLED "true" for opt-in cross-podcast history
//
// off      -> prior behavior, no diversity enforcement.
// observe  -> compute the decision but keep the plain (v5) selection; record
//             what WOULD have changed.
// soft     -> apply penalties + soft cooldowns; relax when necessary; never fail
//             solely for diversity.
// enforce  -> apply hard constraints; fail only when explicit policy requires.
//
// No silent mode switching: an invalid mode fails SAFE to "off" and the raw
// value is recorded so an operator can see it. REPRODUCE ignores these flags
// entirely — it replays the stored plan/decision.

import { type DiversityMode, isDiversityMode } from "@/lib/audio/soundDiversityPolicy";

export const DIVERSITY_ENGINE_FLAG = "SOUND_DIVERSITY_ENGINE_ENABLED";
export const DIVERSITY_MODE_FLAG = "SOUND_DIVERSITY_ENFORCEMENT_MODE";
export const DIVERSITY_SYSTEM_HISTORY_FLAG = "SOUND_DIVERSITY_SYSTEM_HISTORY_ENABLED";

export interface DiversityRollout {
  /** The raw engine flag. */
  engineEnabled: boolean;
  /** The EFFECTIVE mode actually applied (off when disabled or invalid). */
  mode: DiversityMode;
  /** Opt-in cross-podcast (shared-system) history. */
  systemHistoryEnabled: boolean;
  /** The raw invalid mode value, if one was configured (recorded, never silent). */
  invalidMode: string | null;
  /** Human-safe explanation for diagnostics. */
  reason: string;
}

export function resolveDiversityRollout(env: NodeJS.ProcessEnv = process.env): DiversityRollout {
  const engineEnabled = (env[DIVERSITY_ENGINE_FLAG] ?? "").trim() === "true";
  const systemHistoryEnabled = (env[DIVERSITY_SYSTEM_HISTORY_FLAG] ?? "").trim() === "true";
  const raw = (env[DIVERSITY_MODE_FLAG] ?? "").trim();

  if (!engineEnabled) {
    return { engineEnabled: false, mode: "off", systemHistoryEnabled, invalidMode: null, reason: `${DIVERSITY_ENGINE_FLAG} not enabled (diversity off)` };
  }
  if (raw === "") {
    // Enabled but no mode configured -> the SAFE default is observe (no change
    // to selection, decisions recorded), never a silent enforce.
    return { engineEnabled: true, mode: "observe", systemHistoryEnabled, invalidMode: null, reason: `${DIVERSITY_MODE_FLAG} unset — defaulting to observe` };
  }
  if (isDiversityMode(raw)) {
    return { engineEnabled: true, mode: raw, systemHistoryEnabled, invalidMode: null, reason: `${DIVERSITY_MODE_FLAG}=${raw}` };
  }
  // Invalid mode -> fail SAFE to off, record the bad value.
  return { engineEnabled: true, mode: "off", systemHistoryEnabled, invalidMode: raw, reason: `invalid ${DIVERSITY_MODE_FLAG}="${raw}" — failing safe to off` };
}
