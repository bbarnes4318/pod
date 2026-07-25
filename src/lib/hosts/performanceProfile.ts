// Versioned, validated host performance profiles.
//
// The AiHost row's role/speakingStyle/intensityLevel describe a CHARACTER; a
// performance profile describes how that character should be PERFORMED by a
// TTS engine — bounded, typed, and versioned so an engine never receives an
// unchecked bag of JSON. A missing/invalid profile always derives safely from
// the existing host fields; the pipeline never hard-fails on profile absence.
//
// IMPORTANT SEMANTICS: `baselineIntensity`/`peakIntensity` are the character's
// RANGE, not a per-line volume command. An intensityLevel-9 host does not
// shout every sentence — the scene planner and adapters treat the peak as a
// ceiling reached only at genuine emotional peaks.

import { z } from "zod";

export const PERFORMANCE_PROFILE_VERSION = 1;

const pace = z.number().min(0.5).max(2.0);
const intensity = z.number().int().min(1).max(10);

/** Per-provider knob overrides. Only keys a provider adapter explicitly
 *  understands are ever read; unknown keys are dropped at validation. */
const elevenLabsOverrides = z
  .object({
    /** v3 stability is a mode selector: 0 Creative / 0.5 Natural / 1 Robust. */
    stability: z.number().min(0).max(1).optional(),
  })
  .strict();

const fishOverrides = z
  .object({
    temperature: z.number().min(0).max(1).optional(),
    topP: z.number().min(0).max(1).optional(),
  })
  .strict();

export const hostPerformanceProfileSchema = z
  .object({
    version: z.literal(PERFORMANCE_PROFILE_VERSION),
    /** Words-per-minute multipliers relative to the voice's natural pace. */
    baselinePace: pace.default(1.0),
    maxEscalationPace: pace.default(1.15),
    baselineIntensity: intensity.default(4),
    peakIntensity: intensity.default(8),
    /** Free-text NOTES (never sent verbatim to engines without direction support). */
    vocalTextureNotes: z.string().max(300).default(""),
    accentNotes: z.string().max(300).default(""),
    /** Behavioral dials. */
    sarcasmBehavior: z.enum(["never", "dry", "open"]).default("dry"),
    laughBehavior: z.enum(["never", "rare", "natural"]).default("rare"),
    concessionBehavior: z.enum(["grudging", "gracious", "analytical"]).default("analytical"),
    interruptionBehavior: z.enum(["never", "rare", "assertive"]).default("rare"),
    killShotBehavior: z.enum(["never", "measured", "theatrical"]).default("measured"),
    preferredPauseStyle: z.enum(["tight", "natural", "spacious"]).default("natural"),
    /** Hard cap on inline delivery cues per utterance an adapter may add. */
    maxCueDensity: z.number().int().min(0).max(2).default(1),
    /** Traits an adapter must never perform for this host. */
    prohibitedTraits: z.array(z.string().max(60)).max(20).default([]),
    providerOverrides: z
      .object({
        elevenlabs: elevenLabsOverrides.optional(),
        fish: fishOverrides.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();

export type HostPerformanceProfile = z.infer<typeof hostPerformanceProfileSchema>;

export interface HostProfileSource {
  role?: string | null;
  speakingStyle?: string | null;
  intensityLevel?: number | null;
}

/** Safe derivation from the legacy host fields — the migration behavior for
 *  every host without a stored profile. Deterministic and bounded. */
export function deriveProfileFromHostFields(host: HostProfileSource): HostPerformanceProfile {
  const level = Math.max(1, Math.min(10, Math.round(host.intensityLevel ?? 5)));
  const style = (host.speakingStyle || "").toLowerCase();
  const hot = level >= 7;
  const calm = level <= 3;
  return hostPerformanceProfileSchema.parse({
    version: PERFORMANCE_PROFILE_VERSION,
    baselinePace: hot ? 1.05 : calm ? 0.95 : 1.0,
    maxEscalationPace: hot ? 1.2 : 1.1,
    // Baseline sits BELOW the character ceiling: range, not constant shouting.
    baselineIntensity: Math.max(1, Math.min(10, level - 2)),
    peakIntensity: level,
    vocalTextureNotes: "",
    accentNotes: "",
    sarcasmBehavior: /sarcas|dry|deadpan/.test(style) ? "open" : "dry",
    laughBehavior: hot ? "natural" : "rare",
    concessionBehavior: /analy|measured|evidence/.test(style) ? "analytical" : "grudging",
    interruptionBehavior: hot ? "assertive" : "rare",
    killShotBehavior: hot ? "theatrical" : "measured",
    preferredPauseStyle: calm ? "spacious" : hot ? "tight" : "natural",
    maxCueDensity: 1,
    prohibitedTraits: [],
    providerOverrides: {},
  });
}

/**
 * Resolve a host's effective performance profile.
 * - `stored` is whatever JSON the operator saved (unknown shape).
 * - A valid stored profile wins; anything else derives from the host fields.
 * Returns the profile plus where it came from (for diagnostics).
 */
export function resolveHostPerformanceProfile(
  stored: unknown,
  host: HostProfileSource
): { profile: HostPerformanceProfile; source: "stored" | "derived" } {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const parsed = hostPerformanceProfileSchema.safeParse(stored);
    if (parsed.success) return { profile: parsed.data, source: "stored" };
  }
  return { profile: deriveProfileFromHostFields(host), source: "derived" };
}
