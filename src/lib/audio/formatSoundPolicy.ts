// Format-specific sound-direction policies (PR 3). Client-safe, deterministic.
//
// The show-format registry (src/lib/formats/showFormatRegistry.ts) is the
// source of truth for WHICH formats exist. This module attaches a typed
// SOUND-DIRECTION POLICY to each canonical format so different shows receive
// meaningfully different intro/outro treatments, transition/reaction ceilings,
// bed behavior, and cue-family permissions — instead of one generic timing
// strategy. Policies are STRUCTURAL defaults; the frozen sonic identity still
// overrides (a family the identity prohibits is never allowed even if the
// format would permit it).

import { canonicalFormatId, isRegisteredFormat } from "@/lib/formats/showFormatRegistry";

export type IntroTimingStyle =
  | "full_before"                // full intro plays, then speech
  | "cold_open_ducked"           // host enters over the intro's ducked tail
  | "short_sting_then_clean"     // brief branded sting, then clean speech
  | "spoken_cold_open_then_theme"// a spoken cold open, then the branded theme
  | "minimal";                   // barely-there open

export type OutroTimingStyle =
  | "clean_then_outro"           // speech ends clean, then the outro
  | "rise_under_final"           // outro rises under the final sentence
  | "short_pause_then_outro"
  | "reflective_gap_then_outro"  // a deliberate reflective gap, then the outro
  | "hard_branded_close";        // a punchy branded close (sports/rapid)

export type BedBehavior = "none" | "intro_outro_only" | "select_segments" | "full_episode" | "identity_decides";

export interface FormatSoundPolicy {
  formatId: string;
  introStyle: IntroTimingStyle;
  outroStyle: OutroTimingStyle;
  bedBehavior: BedBehavior;
  /** Max transitions per episode (structural ceiling; identity may lower). */
  maxTransitionsPerEpisode: number;
  maxReactionsPerEpisode: number;
  minTransitionGapMs: number;
  allowUnderSpeechBeds: boolean;
  allowHardHits: boolean;
  allowComedy: boolean;
  allowCrowd: boolean;
  allowDataReveal: boolean;
  allowBreakingNews: boolean;
  allowChapterBridge: boolean;
  allowScoreUpdate: boolean;
  allowReactionsDuringOverlap: boolean;
  preferredCueFamilies: string[];
  prohibitedCueFamilies: string[];
  /** Extra protection padding (ms) around the opening / closing words. */
  protectedOpeningPaddingMs: number;
  protectedClosingPaddingMs: number;
}

const base = (o: Partial<FormatSoundPolicy> & { formatId: string }): FormatSoundPolicy => ({
  introStyle: "full_before", outroStyle: "clean_then_outro", bedBehavior: "identity_decides",
  maxTransitionsPerEpisode: 6, maxReactionsPerEpisode: 6, minTransitionGapMs: 1200,
  allowUnderSpeechBeds: true, allowHardHits: true, allowComedy: true, allowCrowd: false,
  allowDataReveal: false, allowBreakingNews: false, allowChapterBridge: false, allowScoreUpdate: false,
  allowReactionsDuringOverlap: false, preferredCueFamilies: [], prohibitedCueFamilies: [],
  protectedOpeningPaddingMs: 250, protectedClosingPaddingMs: 250, ...o,
});

// Exactly the ten canonical formats. Kept in sync with the registry by
// assertFormatPolicyCoverage() (called from a test).
export const FORMAT_SOUND_POLICIES: Record<string, FormatSoundPolicy> = {
  solo_commentary: base({
    formatId: "solo_commentary", introStyle: "short_sting_then_clean", outroStyle: "clean_then_outro",
    bedBehavior: "identity_decides", maxTransitionsPerEpisode: 3, maxReactionsPerEpisode: 1, minTransitionGapMs: 1600,
    allowHardHits: false, allowComedy: false, allowCrowd: false, preferredCueFamilies: ["understated_transition", "topic_reset"],
    prohibitedCueFamilies: ["comedy_button", "crowd_positive", "crowd_negative", "score_update", "breaking_news"],
    protectedOpeningPaddingMs: 300, protectedClosingPaddingMs: 300,
  }),
  two_host_debate: base({
    formatId: "two_host_debate", introStyle: "full_before", outroStyle: "rise_under_final",
    maxTransitionsPerEpisode: 5, maxReactionsPerEpisode: 4, minTransitionGapMs: 1300,
    allowHardHits: true, allowComedy: true, allowReactionsDuringOverlap: false,
    preferredCueFamilies: ["topic_reset", "quick_sweep", "disagreement", "agreement"],
    prohibitedCueFamilies: ["score_update", "breaking_news", "ticker"],
  }),
  sports_radio: base({
    formatId: "sports_radio", introStyle: "cold_open_ducked", outroStyle: "hard_branded_close",
    bedBehavior: "select_segments", maxTransitionsPerEpisode: 8, maxReactionsPerEpisode: 8, minTransitionGapMs: 900,
    allowHardHits: true, allowCrowd: true, allowDataReveal: true, allowScoreUpdate: true,
    preferredCueFamilies: ["hard_hit", "score_update", "data_reveal", "crowd_positive", "quick_sweep"],
    prohibitedCueFamilies: ["cinematic_bridge"],
  }),
  news_roundup: base({
    formatId: "news_roundup", introStyle: "short_sting_then_clean", outroStyle: "clean_then_outro",
    bedBehavior: "intro_outro_only", maxTransitionsPerEpisode: 5, maxReactionsPerEpisode: 1, minTransitionGapMs: 1400,
    allowHardHits: false, allowComedy: false, allowCrowd: false, allowBreakingNews: true, allowDataReveal: true,
    preferredCueFamilies: ["understated_transition", "topic_reset", "breaking_news", "data_reveal"],
    prohibitedCueFamilies: ["comedy_button", "crowd_positive", "crowd_negative", "score_update"],
    protectedOpeningPaddingMs: 300, protectedClosingPaddingMs: 300,
  }),
  host_and_expert: base({
    formatId: "host_and_expert", introStyle: "full_before", outroStyle: "clean_then_outro",
    maxTransitionsPerEpisode: 4, maxReactionsPerEpisode: 3, minTransitionGapMs: 1500,
    allowHardHits: false, allowComedy: true, preferredCueFamilies: ["understated_transition", "topic_reset", "agreement"],
    prohibitedCueFamilies: ["hard_hit", "score_update", "crowd_positive"], protectedOpeningPaddingMs: 300, protectedClosingPaddingMs: 300,
  }),
  three_person_panel: base({
    formatId: "three_person_panel", introStyle: "full_before", outroStyle: "clean_then_outro",
    maxTransitionsPerEpisode: 6, maxReactionsPerEpisode: 5, minTransitionGapMs: 1300,
    preferredCueFamilies: ["topic_reset", "quick_sweep", "agreement", "disagreement"], prohibitedCueFamilies: ["score_update", "breaking_news"],
  }),
  interview: base({
    formatId: "interview", introStyle: "spoken_cold_open_then_theme", outroStyle: "reflective_gap_then_outro",
    maxTransitionsPerEpisode: 4, maxReactionsPerEpisode: 2, minTransitionGapMs: 1600,
    allowHardHits: false, preferredCueFamilies: ["understated_transition", "topic_reset"],
    prohibitedCueFamilies: ["hard_hit", "comedy_button", "score_update", "crowd_positive"], protectedOpeningPaddingMs: 350, protectedClosingPaddingMs: 350,
  }),
  documentary: base({
    formatId: "documentary", introStyle: "spoken_cold_open_then_theme", outroStyle: "reflective_gap_then_outro",
    bedBehavior: "select_segments", maxTransitionsPerEpisode: 4, maxReactionsPerEpisode: 1, minTransitionGapMs: 2500,
    allowHardHits: false, allowComedy: false, allowCrowd: false, allowChapterBridge: true, allowUnderSpeechBeds: true,
    preferredCueFamilies: ["cinematic_bridge", "tension_rise", "understated_transition"],
    prohibitedCueFamilies: ["hard_hit", "score_update", "crowd_positive", "crowd_negative", "comedy_button"],
    protectedOpeningPaddingMs: 400, protectedClosingPaddingMs: 400,
  }),
  betting_desk: base({
    formatId: "betting_desk", introStyle: "cold_open_ducked", outroStyle: "clean_then_outro",
    bedBehavior: "select_segments", maxTransitionsPerEpisode: 6, maxReactionsPerEpisode: 4, minTransitionGapMs: 1200,
    allowHardHits: true, allowDataReveal: true, allowCrowd: false, allowComedy: false,
    preferredCueFamilies: ["data_reveal", "tension_rise", "topic_reset"],
    prohibitedCueFamilies: ["crowd_positive", "crowd_negative", "comedy_button"], protectedOpeningPaddingMs: 300, protectedClosingPaddingMs: 350,
  }),
  rapid_fire: base({
    formatId: "rapid_fire", introStyle: "short_sting_then_clean", outroStyle: "hard_branded_close",
    bedBehavior: "none", maxTransitionsPerEpisode: 4, maxReactionsPerEpisode: 2, minTransitionGapMs: 700,
    allowHardHits: true, allowUnderSpeechBeds: false, preferredCueFamilies: ["quick_sweep", "hard_hit"],
    prohibitedCueFamilies: ["cinematic_bridge", "tension_rise"], protectedOpeningPaddingMs: 200, protectedClosingPaddingMs: 200,
  }),
};

/** The policy for a format (canonicalized). Falls back to two_host_debate's
 *  policy for any unknown id (the registry default), never to a generic blank. */
export function getFormatSoundPolicy(formatId: string): FormatSoundPolicy {
  const id = canonicalFormatId(formatId);
  return FORMAT_SOUND_POLICIES[id] ?? FORMAT_SOUND_POLICIES.two_host_debate;
}

/** Test hook: every registered, generation-ready format has a policy, and no
 *  policy references an unregistered format. */
export function assertFormatPolicyCoverage(registeredIds: string[]): { ok: boolean; missing: string[]; extra: string[] } {
  const missing = registeredIds.filter((id) => !FORMAT_SOUND_POLICIES[id]);
  const extra = Object.keys(FORMAT_SOUND_POLICIES).filter((id) => !isRegisteredFormat(id));
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}
