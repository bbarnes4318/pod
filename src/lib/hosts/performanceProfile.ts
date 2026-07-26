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
    /** Which DIRECTION this character's anger moves. Opposite signatures on a
     *  two-host show make a heated stretch legible in mono. Three signatures,
     *  because volume and pace are independent axes:
     *    "louder_faster"  — escalates up on both (volume + pace).
     *    "slower_quieter" — escalates DOWN on both: slower, quieter, precise.
     *    "louder_slower"  — volume UP, pace DOWN. A trained-projection voice
     *      that stretches words and holds terminals instead of accelerating.
     *      This is what lets two LOUD hosts stay legible in mono: they can
     *      share a volume ceiling as long as they differ in pace direction.
     *  Engines map each to a genuinely different cue set — see fishDialogue. */
    angerStyle: z.enum(["louder_faster", "slower_quieter", "louder_slower"]).default("louder_faster"),
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
  /** Identity, for diagnostics only — never read by the derivation itself. */
  slug?: string | null;
  name?: string | null;
}

/** Volume and pace are independent axes, so the derivation reads them
 *  independently rather than as one binary. A style that is BOTH loud and slow
 *  (trained projection, stretched vowels, held terminals) is `louder_slower` —
 *  without this it would fall to `slower_quieter` on the "slow" match alone and
 *  the character would render quiet. */
const SLOW_STYLE_RE = /quiet|slow|precise|measured|deadpan|unhurried|gravell|stretch|elongat|drawl/;
const LOUD_STYLE_RE = /loud|enormous|booming|bellow|projection|shout|roar|barked|full volume|at volume/;

export function deriveAngerStyle(speakingStyle: string): HostPerformanceProfile["angerStyle"] {
  const style = (speakingStyle || "").toLowerCase();
  const slow = SLOW_STYLE_RE.test(style);
  const loud = LOUD_STYLE_RE.test(style);
  if (slow && loud) return "louder_slower";
  if (slow) return "slower_quieter";
  return "louder_faster";
}

// PERFORMANCE ENERGY IS NOT SEATING RANK.
//
// These three dials used to derive from `intensityLevel >= 7`, which is the
// same conflation that put a loud character in a quiet chair: intensityLevel
// decides WHICH SEAT a host takes (hostCasting sorts by it), not how big the
// performance is. A loud chair-B host at level 6 derived "rare" laughing,
// "rare" interrupting and "measured" kill shots — a quiet, non-interrupting,
// measured version of a character built to be none of those.
//
// Each dial now reads the STYLE TEXT, which is where the performance actually
// lives, checking restraint before expression so an explicit "rarely laughs"
// beats an incidental "laugh". intensityLevel is consulted only when the text
// says nothing either way.
const RESTRAINED_LAUGH_RE = /never laughs|rarely laughs|seldom laughs|humorless|mirthless|does not laugh|humourless/;
const EXPRESSIVE_LAUGH_RE = /laugh|haw|whoop|cackle|giggle|chuckle|guffaw|delighted|amused/;

const RESTRAINED_INTERRUPT_RE = /never interrupts|rarely interrupts|waits for (a|the) gap|waits his turn|waits her turn|lets (him|her|them|people) finish|does not interrupt|polite/;
const ASSERTIVE_INTERRUPT_RE = /interrupt|talks over|talk over|out-volume|out-volumeing|cuts (in|off)|arrives on top|barges|steps on/;

const RESTRAINED_KILLSHOT_RE = /understated|clinical|restrained|deadpan|clipped|matter-of-fact|never raises|dry delivery/;
const THEATRICAL_KILLSHOT_RE = /theatrical|showman|flourish|performs|for the room|announces|declares|enormous|whoop|slaps the desk|kill shot|devastating|big swing/;

/** Expressive/restrained/fallback resolution shared by the three energy dials. */
function deriveDial<T extends string>(
  style: string,
  restrained: RegExp,
  restrainedValue: T,
  expressive: RegExp,
  expressiveValue: T,
  fallback: T
): T {
  if (restrained.test(style)) return restrainedValue;
  if (expressive.test(style)) return expressiveValue;
  return fallback;
}

export function deriveLaughBehavior(speakingStyle: string, intensityLevel: number): HostPerformanceProfile["laughBehavior"] {
  return deriveDial(
    (speakingStyle || "").toLowerCase(),
    RESTRAINED_LAUGH_RE, "rare",
    EXPRESSIVE_LAUGH_RE, "natural",
    intensityLevel >= 7 ? "natural" : "rare"
  );
}

export function deriveInterruptionBehavior(speakingStyle: string, intensityLevel: number): HostPerformanceProfile["interruptionBehavior"] {
  return deriveDial(
    (speakingStyle || "").toLowerCase(),
    RESTRAINED_INTERRUPT_RE, "rare",
    ASSERTIVE_INTERRUPT_RE, "assertive",
    intensityLevel >= 7 ? "assertive" : "rare"
  );
}

export function deriveKillShotBehavior(speakingStyle: string, intensityLevel: number): HostPerformanceProfile["killShotBehavior"] {
  return deriveDial(
    (speakingStyle || "").toLowerCase(),
    RESTRAINED_KILLSHOT_RE, "measured",
    THEATRICAL_KILLSHOT_RE, "theatrical",
    intensityLevel >= 7 ? "theatrical" : "measured"
  );
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
    // Read from the style text, NOT from intensity rank — see the block comment
    // above deriveLaughBehavior. intensityLevel is the fallback only.
    laughBehavior: deriveLaughBehavior(style, level),
    concessionBehavior: /analy|measured|evidence/.test(style) ? "analytical" : "grudging",
    interruptionBehavior: deriveInterruptionBehavior(style, level),
    killShotBehavior: deriveKillShotBehavior(style, level),
    angerStyle: deriveAngerStyle(style),
    preferredPauseStyle: calm ? "spacious" : hot ? "tight" : "natural",
    maxCueDensity: 1,
    prohibitedTraits: [],
    providerOverrides: {},
  });
}

/**
 * Parse a profile for PERSISTENCE. Returns the validated profile or a list of
 * human-readable issues — never a silent substitution. Every write path (seed,
 * host create, host edit) must go through this so an invalid profile cannot
 * reach the database, which in turn means the runtime fallback below only ever
 * handles genuinely ABSENT profiles.
 */
export function parseHostPerformanceProfileForWrite(
  stored: unknown
): { ok: true; profile: HostPerformanceProfile } | { ok: false; issues: string[] } {
  if (stored === null || stored === undefined) {
    return { ok: false, issues: ["profile is missing"] };
  }
  const parsed = hostPerformanceProfileSchema.safeParse(stored);
  if (parsed.success) return { ok: true, profile: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/**
 * Resolve a host's effective performance profile.
 * - `stored` is whatever JSON the operator saved (unknown shape).
 * - A valid stored profile wins; anything else derives from the host fields.
 * Returns the profile plus where it came from (for diagnostics).
 *
 * IMPORTANT: a derived profile is the right answer for a host that never had
 * one AUTHORED. It is never the right answer for a host that has one which
 * fails to parse — that silently discards the whole authored performance and
 * substitutes defaults derived from intensityLevel, which can invert a
 * character wholesale (a loud host deriving as quiet). The two cases are
 * therefore logged differently: absence is silent, invalidity is loud.
 */
export function resolveHostPerformanceProfile(
  stored: unknown,
  host: HostProfileSource
): { profile: HostPerformanceProfile; source: "stored" | "derived" } {
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    const parsed = hostPerformanceProfileSchema.safeParse(stored);
    if (parsed.success) return { profile: parsed.data, source: "stored" };
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    console.warn(
      `[PerformanceProfile] Host '${host.slug ?? host.name ?? "(unknown)"}' has a STORED profile that failed validation; ` +
        `falling back to a profile derived from intensityLevel ${host.intensityLevel ?? "(unset)"}. ` +
        `The authored performance is being discarded — fix the stored profile. Issues: ${issues}`
    );
  }
  return { profile: deriveProfileFromHostFields(host), source: "derived" };
}
