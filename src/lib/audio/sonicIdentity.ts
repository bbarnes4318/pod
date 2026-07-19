// Podcast SONIC IDENTITY + CUE FAMILIES (PR 2).
//
// A podcast needs a coherent, recognizable sonic identity with CONTROLLED
// creative variation — not one universal house intro/outro. This module is the
// client-safe (no Node imports) vocabulary + validation for:
//   * the versioned SonicIdentity a producer configures on their show, and
//   * the CUE-FAMILY taxonomy (a creative purpose, not merely an asset kind).
//
// Rules honored here:
//   * validated enums + bounded values, never free-text-only;
//   * a cue family is only valid for a compatible role;
//   * the sonic identity may prohibit families (e.g. a news show forbids
//     comedy/arena) and rendering/selection must respect that;
//   * nothing here fabricates genre/mood/instrumentation — these are the
//     producer's declared creative intent for THEIR show, stored as their
//     configuration (not claimed facts about any third-party asset).

// ---------------------------------------------------------------------------
// Enums (validated, bounded)
// ---------------------------------------------------------------------------
export const PACES = ["slow", "measured", "medium", "fast", "rapid"] as const;
export type Pace = (typeof PACES)[number];

export const INTENSITIES = ["restrained", "light", "medium", "high", "extreme"] as const;
export type Intensity = (typeof INTENSITIES)[number];

export const BROADCAST_STYLES = [
  "minimal", "conversational", "sports_radio", "newsroom",
  "documentary", "cinematic", "analysis_desk", "entertainment",
] as const;
export type BroadcastStyle = (typeof BROADCAST_STYLES)[number];

export const TRANSITION_FREQUENCIES = ["sparse", "restrained", "standard", "active"] as const;
export type TransitionFrequency = (typeof TRANSITION_FREQUENCIES)[number];

export const BED_POLICIES = ["none", "intro_outro_only", "select_segments", "full_episode", "planner_decides"] as const;
export type BedPolicy = (typeof BED_POLICIES)[number];

export const VOICE_OVER_MUSIC_POLICIES = ["never", "bookends_only", "short_transitions", "allowed_when_ducked"] as const;
export type VoiceOverMusicPolicy = (typeof VOICE_OVER_MUSIC_POLICIES)[number];

// ---------------------------------------------------------------------------
// Cue families — a creative PURPOSE, grouped by the role they attach to.
// ---------------------------------------------------------------------------
export const INTRO_FAMILIES = ["brand_main", "brand_short", "brand_high_energy", "brand_breaking", "brand_minimal"] as const;
export const OUTRO_FAMILIES = ["close_main", "close_short", "close_reflective", "close_high_energy", "close_documentary"] as const;
export const TRANSITION_FAMILIES = [
  "hard_hit", "quick_sweep", "tension_rise", "topic_reset", "understated_transition",
  "breaking_news", "score_update", "data_reveal", "cinematic_bridge", "comedy_button",
] as const;
export const REACTION_FAMILIES = [
  "agreement", "disagreement", "surprise", "crowd_positive", "crowd_negative",
  "ticker", "alert", "comedy", "tension", "resolution",
] as const;
export const BED_FAMILIES = [
  "sports_drive", "newsroom_clean", "documentary_sparse", "cinematic_tension",
  "analysis_pulse", "reflective", "minimal_ambient",
] as const;

export type IntroFamily = (typeof INTRO_FAMILIES)[number];
export type OutroFamily = (typeof OUTRO_FAMILIES)[number];
export type TransitionFamily = (typeof TRANSITION_FAMILIES)[number];
export type ReactionFamily = (typeof REACTION_FAMILIES)[number];
export type BedFamily = (typeof BED_FAMILIES)[number];
export type CueFamily = IntroFamily | OutroFamily | TransitionFamily | ReactionFamily | BedFamily;

/** Compatibility contract: a SoundAssignment role -> the cue families it may
 *  legitimately carry. A `theme_intro` (role "intro") can never be a reaction,
 *  a reaction can never be an outro, etc. The stinger role uses the transition
 *  family taxonomy (a stinger IS the transition asset). */
export const ROLE_CUE_FAMILIES: Record<string, readonly string[]> = {
  intro: INTRO_FAMILIES,
  outro: OUTRO_FAMILIES,
  bed: BED_FAMILIES,
  stinger: TRANSITION_FAMILIES,
  reaction: REACTION_FAMILIES,
};

export const ALL_CUE_FAMILIES: readonly string[] = [
  ...INTRO_FAMILIES, ...OUTRO_FAMILIES, ...TRANSITION_FAMILIES, ...REACTION_FAMILIES, ...BED_FAMILIES,
];

/** Families that carry a HUMOR/comedy purpose — prohibited when the identity
 *  sets humorEffectsAllowed = false (e.g. a news show). */
export const HUMOR_FAMILIES: readonly string[] = ["comedy_button", "comedy"];
/** Families that carry a CROWD/arena purpose — prohibited when the identity
 *  sets crowdEffectsAllowed = false (e.g. documentary/newsroom). */
export const CROWD_FAMILIES: readonly string[] = ["crowd_positive", "crowd_negative"];

export function isCueFamily(x: unknown): x is CueFamily {
  return typeof x === "string" && ALL_CUE_FAMILIES.includes(x);
}

/** Is `family` a legitimate cue family for `role`? (Family may be null/absent —
 *  a variant without an explicit family is allowed; it just carries no family
 *  targeting.) */
export function isCueFamilyValidForRole(role: string, family: string | null | undefined): boolean {
  if (family == null) return true;
  const allowed = ROLE_CUE_FAMILIES[role];
  return !!allowed && allowed.includes(family);
}

// ---------------------------------------------------------------------------
// Sonic identity
// ---------------------------------------------------------------------------
export const SONIC_IDENTITY_VERSION = 1 as const;

// Weight bounds (also enforced by a DB CHECK).
export const ASSIGNMENT_WEIGHT_MIN = 0;
export const ASSIGNMENT_WEIGHT_MAX = 100;
export const MUSIC_GAP_MS_MAX = 120_000;

export interface SonicIdentity {
  version: number;
  primaryGenre: string | null;
  secondaryGenres: string[];
  moods: string[];
  pace: Pace | null;
  intensity: Intensity | null;
  broadcastStyle: BroadcastStyle | null;
  preferredInstrumentation: string[];
  prohibitedInstrumentation: string[];
  allowedCueFamilies: string[];
  prohibitedCueFamilies: string[];
  allowedFormatIds: string[];
  prohibitedFormatIds: string[];
  humorEffectsAllowed: boolean;
  crowdEffectsAllowed: boolean;
  underSpeechEffectsAllowed: boolean;
  brandedMotifEnabled: boolean;
  transitionFrequency: TransitionFrequency | null;
  maximumEffectsIntensity: Intensity | null;
  bedPolicy: BedPolicy | null;
  introTreatment: IntroFamily | null;
  outroTreatment: OutroFamily | null;
  minimumMusicGapMs: number | null;
  maximumMusicGapMs: number | null;
  voiceOverMusicPolicy: VoiceOverMusicPolicy | null;
}

/** A deliberately permissive default identity: nothing prohibited, no genre
 *  claimed. Existing podcasts (no identity configured) resolve to this —
 *  behavior is unchanged (no family is prohibited, no format restricted). */
export const DEFAULT_SONIC_IDENTITY: SonicIdentity = {
  version: SONIC_IDENTITY_VERSION,
  primaryGenre: null, secondaryGenres: [], moods: [],
  pace: null, intensity: null, broadcastStyle: null,
  preferredInstrumentation: [], prohibitedInstrumentation: [],
  allowedCueFamilies: [], prohibitedCueFamilies: [],
  allowedFormatIds: [], prohibitedFormatIds: [],
  humorEffectsAllowed: true, crowdEffectsAllowed: true, underSpeechEffectsAllowed: true,
  brandedMotifEnabled: false,
  transitionFrequency: null, maximumEffectsIntensity: null, bedPolicy: null,
  introTreatment: null, outroTreatment: null,
  minimumMusicGapMs: null, maximumMusicGapMs: null, voiceOverMusicPolicy: null,
};

export type SonicIdentityValidationError =
  | { code: "not_object" }
  | { code: "invalid_enum"; field: string; value: string }
  | { code: "invalid_cue_family"; value: string }
  | { code: "invalid_music_gap"; field: string }
  | { code: "music_gap_order" }
  | { code: "invalid_tag"; field: string };

const TAG = /^[a-z0-9][a-z0-9 _/&-]{0,39}$/i;
const isTagArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string" && TAG.test(s));

/**
 * Validate + normalize a producer-supplied sonic identity into the canonical
 * shape. Unknown/malformed enum values are rejected (structured error), never
 * silently coerced. Returns the normalized identity on success.
 */
export function validateSonicIdentity(
  input: unknown
): { ok: true; identity: SonicIdentity } | { ok: false; error: SonicIdentityValidationError } {
  if (!input || typeof input !== "object") return { ok: false, error: { code: "not_object" } };
  const i = input as Record<string, unknown>;

  const enumField = <T extends string>(field: string, allowed: readonly T[]): T | null | SonicIdentityValidationError => {
    const v = i[field];
    if (v == null) return null;
    if (typeof v !== "string" || !allowed.includes(v as T)) return { code: "invalid_enum", field, value: String(v) };
    return v as T;
  };

  const pace = enumField("pace", PACES);
  if (pace && typeof pace === "object") return { ok: false, error: pace };
  const intensity = enumField("intensity", INTENSITIES);
  if (intensity && typeof intensity === "object") return { ok: false, error: intensity };
  const broadcastStyle = enumField("broadcastStyle", BROADCAST_STYLES);
  if (broadcastStyle && typeof broadcastStyle === "object") return { ok: false, error: broadcastStyle };
  const transitionFrequency = enumField("transitionFrequency", TRANSITION_FREQUENCIES);
  if (transitionFrequency && typeof transitionFrequency === "object") return { ok: false, error: transitionFrequency };
  const maximumEffectsIntensity = enumField("maximumEffectsIntensity", INTENSITIES);
  if (maximumEffectsIntensity && typeof maximumEffectsIntensity === "object") return { ok: false, error: maximumEffectsIntensity };
  const bedPolicy = enumField("bedPolicy", BED_POLICIES);
  if (bedPolicy && typeof bedPolicy === "object") return { ok: false, error: bedPolicy };
  const introTreatment = enumField("introTreatment", INTRO_FAMILIES);
  if (introTreatment && typeof introTreatment === "object") return { ok: false, error: introTreatment };
  const outroTreatment = enumField("outroTreatment", OUTRO_FAMILIES);
  if (outroTreatment && typeof outroTreatment === "object") return { ok: false, error: outroTreatment };
  const voiceOverMusicPolicy = enumField("voiceOverMusicPolicy", VOICE_OVER_MUSIC_POLICIES);
  if (voiceOverMusicPolicy && typeof voiceOverMusicPolicy === "object") return { ok: false, error: voiceOverMusicPolicy };

  const strArr = (field: string): string[] | SonicIdentityValidationError => {
    const v = i[field] ?? [];
    if (!isTagArray(v)) return { code: "invalid_tag", field };
    return v as string[];
  };
  const secondaryGenres = strArr("secondaryGenres");
  if (!Array.isArray(secondaryGenres)) return { ok: false, error: secondaryGenres };
  const moods = strArr("moods");
  if (!Array.isArray(moods)) return { ok: false, error: moods };
  const preferredInstrumentation = strArr("preferredInstrumentation");
  if (!Array.isArray(preferredInstrumentation)) return { ok: false, error: preferredInstrumentation };
  const prohibitedInstrumentation = strArr("prohibitedInstrumentation");
  if (!Array.isArray(prohibitedInstrumentation)) return { ok: false, error: prohibitedInstrumentation };
  const allowedFormatIds = strArr("allowedFormatIds");
  if (!Array.isArray(allowedFormatIds)) return { ok: false, error: allowedFormatIds };
  const prohibitedFormatIds = strArr("prohibitedFormatIds");
  if (!Array.isArray(prohibitedFormatIds)) return { ok: false, error: prohibitedFormatIds };

  const cueFamilyArr = (field: string): string[] | SonicIdentityValidationError => {
    const v = i[field] ?? [];
    if (!Array.isArray(v)) return { code: "invalid_tag", field };
    for (const f of v) if (!isCueFamily(f)) return { code: "invalid_cue_family", value: String(f) };
    return v as string[];
  };
  const allowedCueFamilies = cueFamilyArr("allowedCueFamilies");
  if (!Array.isArray(allowedCueFamilies)) return { ok: false, error: allowedCueFamilies };
  const prohibitedCueFamilies = cueFamilyArr("prohibitedCueFamilies");
  if (!Array.isArray(prohibitedCueFamilies)) return { ok: false, error: prohibitedCueFamilies };

  const gap = (field: string): number | null | SonicIdentityValidationError => {
    const v = i[field];
    if (v == null) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MUSIC_GAP_MS_MAX) return { code: "invalid_music_gap", field };
    return v;
  };
  const minimumMusicGapMs = gap("minimumMusicGapMs");
  if (minimumMusicGapMs && typeof minimumMusicGapMs === "object") return { ok: false, error: minimumMusicGapMs };
  const maximumMusicGapMs = gap("maximumMusicGapMs");
  if (maximumMusicGapMs && typeof maximumMusicGapMs === "object") return { ok: false, error: maximumMusicGapMs };
  if (typeof minimumMusicGapMs === "number" && typeof maximumMusicGapMs === "number" && minimumMusicGapMs > maximumMusicGapMs) {
    return { ok: false, error: { code: "music_gap_order" } };
  }

  const bool = (field: string, dflt: boolean): boolean => (typeof i[field] === "boolean" ? (i[field] as boolean) : dflt);

  return {
    ok: true,
    identity: {
      version: SONIC_IDENTITY_VERSION,
      primaryGenre: typeof i.primaryGenre === "string" && TAG.test(i.primaryGenre) ? i.primaryGenre : null,
      secondaryGenres, moods,
      pace: pace as Pace | null,
      intensity: intensity as Intensity | null,
      broadcastStyle: broadcastStyle as BroadcastStyle | null,
      preferredInstrumentation, prohibitedInstrumentation,
      allowedCueFamilies, prohibitedCueFamilies, allowedFormatIds, prohibitedFormatIds,
      humorEffectsAllowed: bool("humorEffectsAllowed", true),
      crowdEffectsAllowed: bool("crowdEffectsAllowed", true),
      underSpeechEffectsAllowed: bool("underSpeechEffectsAllowed", true),
      brandedMotifEnabled: bool("brandedMotifEnabled", false),
      transitionFrequency: transitionFrequency as TransitionFrequency | null,
      maximumEffectsIntensity: maximumEffectsIntensity as Intensity | null,
      bedPolicy: bedPolicy as BedPolicy | null,
      introTreatment: introTreatment as IntroFamily | null,
      outroTreatment: outroTreatment as OutroFamily | null,
      minimumMusicGapMs: minimumMusicGapMs as number | null,
      maximumMusicGapMs: maximumMusicGapMs as number | null,
      voiceOverMusicPolicy: voiceOverMusicPolicy as VoiceOverMusicPolicy | null,
    },
  };
}

/** Is `family` permitted by this identity? A family is prohibited when it is in
 *  prohibitedCueFamilies, OR excluded by a non-empty allow-list, OR a
 *  humor/crowd family the identity disables. Returns a safe reason when not. */
export function cueFamilyAllowedByIdentity(
  identity: SonicIdentity,
  family: string | null | undefined
): { ok: true } | { ok: false; reason: string } {
  if (family == null) return { ok: true };
  if (identity.prohibitedCueFamilies.includes(family)) return { ok: false, reason: `cue family '${family}' is prohibited by the sonic identity` };
  if (identity.allowedCueFamilies.length > 0 && !identity.allowedCueFamilies.includes(family)) {
    return { ok: false, reason: `cue family '${family}' is not in the identity's allowed families` };
  }
  if (!identity.humorEffectsAllowed && HUMOR_FAMILIES.includes(family)) return { ok: false, reason: `humor effects are disabled ('${family}')` };
  if (!identity.crowdEffectsAllowed && CROWD_FAMILIES.includes(family)) return { ok: false, reason: `crowd effects are disabled ('${family}')` };
  return { ok: true };
}
