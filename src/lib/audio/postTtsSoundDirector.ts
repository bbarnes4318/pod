// Post-TTS Sound Director (PR 3). PURE + deterministic.
//
// Runs AFTER the dialogue segments exist and their real timing is measured. It
// consumes the frozen snapshot-v5 sound profile (identity + selected bookends +
// permitted bed/transition/reaction pools), the ACTUAL dialogue timeline, the
// detected gaps, the protected speech regions, and the format policy, and emits
// a typed, versioned, FINGERPRINTED sound-direction plan: where each cue may go
// (or why not), how the intro/outro are treated, and how the bed behaves.
//
// Determinism: same inputs -> same plan + fingerprint. Selection among frozen
// pool assets uses a seeded mulberry32 stream (FNV-1a seed) — never Math.random,
// wall-clock, current podcast config, or assets outside the frozen profile.
// Cue DURATION FITTING and the FFmpeg execution are done by the executor (C4);
// this layer decides structure + placement.

import crypto from "crypto";
import type { FrozenSoundProfile, FrozenSoundAssetRef } from "@/lib/services/podcastSoundProfile";
import { DEFAULT_SONIC_IDENTITY, type SonicIdentity } from "@/lib/audio/sonicIdentity";
import type { ActualDialogueTimeline } from "@/lib/audio/dialogueTimeline";
import { type DetectedAudioGap, gapAllowsReaction, gapAllowsTransition } from "@/lib/audio/waveformAnalysis";
import { buildProtectedRegions, cueCollidesWithProtected, type ProtectedAudioRegion, type ProtectedLineInput } from "@/lib/audio/protectedRegions";
import { getFormatSoundPolicy, type FormatSoundPolicy, type IntroTimingStyle, type OutroTimingStyle } from "@/lib/audio/formatSoundPolicy";
import type { SoundDiversityPolicy } from "@/lib/audio/soundDiversityPolicy";
import { selectDiverseCue, recordCuePlacement, newWithinEpisodeCueState, type WithinEpisodeCueState, type CrossEpisodeCueHistory, type CueDiversityDecision } from "@/lib/audio/soundCueDiversity";
import { evaluateSequenceSimilarity, type SequenceSimilarityDecision } from "@/lib/audio/soundSequenceSimilarity";

// v2 (PR 3 review): intro/outro treatments now carry explicit, timeline-aware
// gain SEGMENTS that the executor renders verbatim (cold-open ducking, spoken
// cold open before theme, rise-under-final, reflective gap, hard close) — the
// treatment is executed on the real timeline, not merely recorded.
export const POST_TTS_DIRECTOR_VERSION = 2 as const;

/** Baseline bookend gains. A "clean"/"lead"/"tail"/"sting" segment plays at full
 *  bookend level; an "under_speech" segment is DUCKED so speech stays intelligible
 *  (and, being ducked, may legally overlap a hard-protected region). */
export const BOOKEND_FULL_GAIN_DB = -2;
export const BOOKEND_DUCK_GAIN_DB = -12;

export type BookendSegmentRole = "lead" | "under_speech" | "tail" | "clean" | "sting";
/** One rendered slice of a bookend asset with its own timeline position + gain.
 *  A treatment is one or more of these (e.g. cold_open_ducked = lead + ducked
 *  under_speech). Executed verbatim by the executor; stored for reproduce. */
export interface DirectedBookendSegment {
  role: BookendSegmentRole;
  sourceStartMs: number;    // excerpt start within the asset
  sourceEndMs: number;      // excerpt end within the asset
  timelineStartMs: number;  // where the slice sits on the master timeline
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  ducked: boolean;          // true => may overlap a hard-protected region
}

// --- Plan shapes -----------------------------------------------------------
export interface DirectedCuePlacement {
  kind: "transition" | "reaction";
  assetId: string;
  cueFamily: string | null;
  lineIndex: number;
  targetStartMs: number;   // where the cue should begin
  gapStartMs: number;
  gapEndMs: number;
  gapDurationMs: number;    // usable window for fitting (executor fits within this)
  gainDb: number;
  reason: string;
}

export interface DirectedIntroPlan {
  required: boolean;
  assetId: string | null;
  treatment: IntroTimingStyle | "none";
  introStartMs: number;
  introDurationMs: number;
  speechEntryMs: number;     // when dialogue enters (== dialogue offset)
  duckStartMs: number | null;
  duckGainDb: number | null;
  fadeMs: number;
  continuesUnderSpeech: boolean;
  segments: DirectedBookendSegment[];  // executed verbatim
  reason: string;
}
export interface DirectedOutroPlan {
  required: boolean;
  assetId: string | null;
  treatment: OutroTimingStyle | "none";
  speechEndMs: number;       // last audible spoken word
  outroStartMs: number;
  outroDurationMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  reflectiveGapMs: number;   // intentional gap before the outro (0 unless reflective)
  segments: DirectedBookendSegment[];  // executed verbatim
  reason: string;
}
export interface DirectedBookendPlan { intro: DirectedIntroPlan | null; outro: DirectedOutroPlan | null; }

export interface DirectedBedSegment { startMs: number; endMs: number; reason: string; boundary: string; }
export interface DirectedBedPlan {
  assetId: string;
  policy: string;
  segments: DirectedBedSegment[];
  baseGainDb: number;
  duckedGainDb: number;
  duckAttackMs: number;
  duckReleaseMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  loopCrossfadeMs: number;
  reason: string;
}

export type SoundDirectionFailure =
  | "required_intro_no_safe_treatment"
  | "required_outro_no_safe_treatment"
  | "bed_policy_unsatisfied"
  | "format_policy_violation";

export interface SoundDirectionWarning { code: string; detail: string; lineIndex?: number }
export interface SoundDirectionDecision { subject: string; decision: "accepted" | "rejected" | "held" | "treated"; reason: string; lineIndex?: number }

export interface PostTtsSoundDirectionPlan {
  version: number;
  mode: "post_tts";
  episodeId: string;
  scriptId: string;
  seed: string;
  formatId: string;
  directorVersion: number;
  dialogueDurationMs: number;
  protectedRegions: ProtectedAudioRegion[];
  detectedGaps: DetectedAudioGap[];
  cuePlacements: DirectedCuePlacement[];
  bookendPlan: DirectedBookendPlan;
  bedPlan: DirectedBedPlan | null;
  failure: SoundDirectionFailure | null;
  warnings: SoundDirectionWarning[];
  decisions: SoundDirectionDecision[];
  /** PR 4: per-cue diversity decisions (which asset, why). Diagnostic only —
   *  EXCLUDED from the fingerprint (the chosen assets already live in
   *  cuePlacements). Empty when the diversity engine was not active. */
  cueDiversityDecisions?: CueDiversityDecision[];
  /** PR 4: this plan's cue-token sequence + its similarity vs recent episodes.
   *  Diagnostic only (excluded from the fingerprint). */
  cueSequence?: string[];
  sequenceSimilarity?: SequenceSimilarityDecision;
  fingerprint: string;
}

// --- Seeded PRNG (same family as the planner/variant selector) -------------
function fnv1a(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function pickWeighted(rand: () => number, pool: FrozenSoundAssetRef[]): FrozenSoundAssetRef | null {
  const c = pool.filter((r) => (r.weight ?? 1) > 0);
  if (!c.length) return null;
  const total = c.reduce((a, r) => a + (r.weight ?? 1), 0);
  let roll = rand() * total;
  for (const r of c) { roll -= (r.weight ?? 1); if (roll <= 0) return r; }
  return c[c.length - 1];
}

// --- Script trigger metadata (from the approved script) --------------------
export interface DirectorScriptLine { lineIndex: number; text: string; tone?: string | null; energy?: string | null; isFactualClaim?: boolean; isInterruption?: boolean; emphasis?: boolean; }

export interface PostTtsDirectorInput {
  episodeId: string;
  scriptId: string;
  seed: string;
  formatId: string;
  frozenProfile: FrozenSoundProfile;
  timeline: ActualDialogueTimeline;
  scriptLines: DirectorScriptLine[];
  introAssetDurationMs: number | null;   // measured intro asset duration (loaded)
  outroAssetDurationMs: number | null;   // measured outro asset duration (loaded)
  includeIntro: boolean;
  includeOutro: boolean;
  protectedSpeechPaddingMs: number;
  /** PR 4: when present (and mode soft/enforce), WHICH eligible cue asset is
   *  placed becomes diversity-aware (within-episode + recent-catalog). Absent =
   *  exact PR 3 behavior (weighted pick). Reproduce never sets this. */
  diversity?: {
    policy: SoundDiversityPolicy;
    mode: "soft" | "enforce";
    transitionHistory: CrossEpisodeCueHistory;
    reactionHistory: CrossEpisodeCueHistory;
    /** Recent episodes' ROLE:family cue-token sequences, for sequence-similarity
     *  scoring of THIS episode's plan against the catalog. */
    historyCueSequences?: string[][];
  };
}

const REACTION_TONES = new Set(["amused", "heated", "surprised", "hype", "dismissive"]);

/** Is a cue family permitted by BOTH the format policy and the frozen identity? */
function familyPermitted(family: string | null, policy: FormatSoundPolicy, identity: SonicIdentity): { ok: boolean; reason: string } {
  if (!family) return { ok: true, reason: "no family" };
  if (policy.prohibitedCueFamilies.includes(family)) return { ok: false, reason: `format prohibits ${family}` };
  if (identity.prohibitedCueFamilies.includes(family)) return { ok: false, reason: `identity prohibits ${family}` };
  if (identity.allowedCueFamilies.length > 0 && !identity.allowedCueFamilies.includes(family)) return { ok: false, reason: `${family} not in identity allow-list` };
  if (!identity.humorEffectsAllowed && (family === "comedy_button" || family === "comedy")) return { ok: false, reason: "humor disabled" };
  if (!identity.crowdEffectsAllowed && (family === "crowd_positive" || family === "crowd_negative")) return { ok: false, reason: "crowd disabled" };
  return { ok: true, reason: "permitted" };
}

export function directPostTtsSound(input: PostTtsDirectorInput): PostTtsSoundDirectionPlan {
  const policy = getFormatSoundPolicy(input.formatId);
  const identity = input.frozenProfile.sonicIdentity ?? DEFAULT_SONIC_IDENTITY;
  const warnings: SoundDirectionWarning[] = [];
  const decisions: SoundDirectionDecision[] = [];
  const lineById = new Map(input.scriptLines.map((l) => [l.lineIndex, l]));

  // Protected regions (identity may forbid beds under hard speech).
  const protLines: ProtectedLineInput[] = input.timeline.lines.map((l) => {
    const s = lineById.get(l.lineIndex);
    return {
      lineIndex: l.lineIndex, text: s?.text ?? "", isInterruption: !!(s?.isInterruption ?? l.isInterruption),
      isFactualClaim: s?.isFactualClaim, emphasis: s?.emphasis,
      speechStartMs: l.speechStartMs, speechEndMs: l.speechEndMs, appliedOverlapMs: l.appliedOverlapMs, timelineStartMs: l.timelineStartMs,
    };
  });
  const protectedRegions = buildProtectedRegions(protLines, {
    openingPaddingMs: policy.protectedOpeningPaddingMs,
    closingPaddingMs: policy.protectedClosingPaddingMs,
    speechPaddingMs: input.protectedSpeechPaddingMs,
    allowDuckedBedUnderHard: policy.allowUnderSpeechBeds && identity.underSpeechEffectsAllowed,
  });

  // --- Bookends ------------------------------------------------------------
  let failure: SoundDirectionFailure | null = null;
  const bookendPlan: DirectedBookendPlan = {
    intro: directIntro(input, policy, decisions, warnings, (f) => { failure = failure ?? f; }),
    outro: directOutro(input, policy, decisions, warnings, (f) => { failure = failure ?? f; }),
  };

  // --- Transitions + reactions (structural placement) ----------------------
  const cuePlacements: DirectedCuePlacement[] = [];
  let transitions = 0, reactions = 0;
  const rand = mulberry32(fnv1a(input.seed + ":cues"));

  // PR 4: within-episode cue state + per-cue diversity decisions (fresh renders
  // only; `input.diversity` is unset on reproduce and in PR 3 tests).
  const withinTransition = newWithinEpisodeCueState();
  const withinReaction = newWithinEpisodeCueState();
  const cueDiversityDecisions: CueDiversityDecision[] = [];
  const divFor = (kind: "transition" | "reaction"): CueDiversityContext | undefined => input.diversity && {
    policy: input.diversity.policy, mode: input.diversity.mode, seed: input.seed,
    within: kind === "transition" ? withinTransition : withinReaction,
    history: kind === "transition" ? input.diversity.transitionHistory : input.diversity.reactionHistory,
    sink: cueDiversityDecisions,
  };

  for (const gap of input.timeline.gaps) {
    const beforeLine = lineById.get(gap.lineIndex - 1);  // the line JUST SPOKEN (reaction subject)
    // TRANSITION: only at a real structural boundary (the new topic at gap.lineIndex),
    // with a transition-sized gap.
    const structural = gap.boundary === "segment" || gap.boundary === "topic";
    if (structural && gapAllowsTransition(gap.classification) && transitions < policy.maxTransitionsPerEpisode) {
      const placed = placeCue("transition", input.frozenProfile.stingers, gap, gap.lineIndex, policy, identity, protectedRegions, rand, decisions, divFor("transition"));
      if (placed) { cuePlacements.push(placed); transitions++; }
    }
    // REACTION: reacts to the PRECEDING line; needs a semantic trigger (tone/
    // energy) AND a reaction-sized gap. A gap alone is never enough; not after
    // every line, and never at a structural boundary (that is a transition).
    const tone = (beforeLine?.tone ?? "").toLowerCase();
    const trigger = REACTION_TONES.has(tone) || beforeLine?.energy === "high";
    if (!structural && trigger && gapAllowsReaction(gap.classification) && reactions < policy.maxReactionsPerEpisode) {
      const subject = beforeLine?.lineIndex ?? gap.lineIndex;
      if (gap.overlapMs > 0 && !policy.allowReactionsDuringOverlap) {
        decisions.push({ subject: `reaction@line${subject}`, decision: "rejected", reason: "no reactions during overlap", lineIndex: subject });
      } else {
        const placed = placeCue("reaction", input.frozenProfile.reactions, gap, subject, policy, identity, protectedRegions, rand, decisions, divFor("reaction"));
        if (placed) { cuePlacements.push(placed); reactions++; }
      }
    }
  }

  // --- Bed -----------------------------------------------------------------
  const bedPlan = directBed(input, policy, identity, decisions, warnings, (f) => { failure = failure ?? f; });

  // --- Cue-sequence similarity vs recent episodes (diagnostic) -------------
  let cueSequence: string[] | undefined;
  let sequenceSimilarity: SequenceSimilarityDecision | undefined;
  if (input.diversity?.historyCueSequences && input.diversity.historyCueSequences.length) {
    const seq: string[] = [];
    if (bookendPlan.intro?.assetId) seq.push(`INTRO:${input.frozenProfile.intro?.cueFamily ?? "none"}`);
    if (bedPlan) seq.push(`BED:${input.frozenProfile.bed?.cueFamily ?? "none"}`);
    for (const c of [...cuePlacements].sort((a, b) => a.targetStartMs - b.targetStartMs)) seq.push(`${c.kind === "transition" ? "TRANSITION" : "REACTION"}:${c.cueFamily ?? "none"}`);
    if (bookendPlan.outro?.assetId) seq.push(`OUTRO:${input.frozenProfile.outro?.cueFamily ?? "none"}`);
    cueSequence = seq;
    sequenceSimilarity = evaluateSequenceSimilarity(seq, input.diversity.historyCueSequences, input.diversity.policy.maximumCueSequenceSimilarity);
  }

  const plan: PostTtsSoundDirectionPlan = {
    version: 1, mode: "post_tts", episodeId: input.episodeId, scriptId: input.scriptId, seed: input.seed,
    formatId: input.formatId, directorVersion: POST_TTS_DIRECTOR_VERSION,
    dialogueDurationMs: input.timeline.dialogueDurationMs,
    protectedRegions, detectedGaps: input.timeline.gaps, cuePlacements, bookendPlan, bedPlan,
    failure, warnings, decisions, ...(cueDiversityDecisions.length ? { cueDiversityDecisions } : {}),
    ...(cueSequence ? { cueSequence, sequenceSimilarity } : {}), fingerprint: "",
  };
  plan.fingerprint = fingerprintDirectionPlan(plan);
  return plan;
}

/** The largest sub-window of a gap that no protected region covers (the safe
 *  interior after the surrounding speech padding is excluded). */
function freeWindow(gap: DetectedAudioGap, regions: ProtectedAudioRegion[]): { startMs: number; endMs: number } {
  let start = gap.startMs;
  let end = gap.startMs + gap.durationMs;
  for (const r of regions) {
    if (r.endMs <= start || r.startMs >= end) continue; // outside the gap
    if (r.startMs <= start) start = Math.max(start, r.endMs);   // eats the left edge
    else end = Math.min(end, r.startMs);                        // eats the right edge
  }
  return { startMs: start, endMs: Math.max(start, end) };
}
const MIN_FREE_TRANSITION_MS = 700;
const MIN_FREE_REACTION_MS = 300;

/** PR 4 within-episode cue-diversity context threaded into placeCue. */
interface CueDiversityContext { policy: SoundDiversityPolicy; mode: "soft" | "enforce"; seed: string; within: WithinEpisodeCueState; history: CrossEpisodeCueHistory; sink: CueDiversityDecision[] }

function placeCue(
  kind: "transition" | "reaction",
  pool: FrozenSoundAssetRef[],
  gap: DetectedAudioGap,
  subjectLineIndex: number,
  policy: FormatSoundPolicy,
  identity: SonicIdentity,
  protectedRegions: ProtectedAudioRegion[],
  rand: () => number,
  decisions: SoundDirectionDecision[],
  div?: CueDiversityContext
): DirectedCuePlacement | null {
  const tag = `${kind}@line${subjectLineIndex}`;
  const eligible = pool.filter((r) => familyPermitted(r.cueFamily ?? null, policy, identity).ok);
  if (!eligible.length) { decisions.push({ subject: tag, decision: "rejected", reason: "no permitted asset in frozen pool", lineIndex: subjectLineIndex }); return null; }
  // The safe interior of the gap (protected speech padding removed at both edges).
  const win = freeWindow(gap, protectedRegions);
  const freeLen = win.endMs - win.startMs;
  const minLen = kind === "transition" ? MIN_FREE_TRANSITION_MS : MIN_FREE_REACTION_MS;
  if (freeLen < minLen) { decisions.push({ subject: tag, decision: "rejected", reason: `gap too short after protecting speech (${Math.round(freeLen)}ms < ${minLen}ms)`, lineIndex: subjectLineIndex }); return null; }
  // A hard cue must never touch protected speech; the safe interior cannot.
  if (cueCollidesWithProtected(protectedRegions, win.startMs, win.endMs, "hard")) {
    decisions.push({ subject: tag, decision: "rejected", reason: "would collide with protected speech", lineIndex: subjectLineIndex }); return null;
  }
  // PR 4: diversity-aware pick among the eligible cues (within-episode + recent
  // catalog). Absent `div` = exact PR 3 weighted pick. The eligible set is the
  // SAME (family/format/identity already applied) — diversity only reorders it,
  // never admits an incompatible family. A cue opportunity may be left empty.
  let asset: FrozenSoundAssetRef | null;
  if (div) {
    const res = selectDiverseCue({ role: kind, lineIndex: subjectLineIndex, candidates: eligible, policy: div.policy, mode: div.mode, seed: div.seed, within: div.within, history: div.history });
    div.sink.push(res.decision);
    asset = res.selected;
    if (!asset) { decisions.push({ subject: tag, decision: "held", reason: `diversity left the ${kind} empty (all options capped/cooled)`, lineIndex: subjectLineIndex }); return null; }
    recordCuePlacement(div.within, asset.assetId, asset.cueFamily ?? null);
  } else {
    asset = pickWeighted(rand, eligible);
  }
  if (!asset) { decisions.push({ subject: tag, decision: "rejected", reason: "no weighted candidate", lineIndex: subjectLineIndex }); return null; }
  decisions.push({ subject: tag, decision: "accepted", reason: `${asset.cueFamily ?? "cue"} in ${gap.classification} gap`, lineIndex: subjectLineIndex });
  return {
    kind, assetId: asset.assetId, cueFamily: asset.cueFamily ?? null, lineIndex: subjectLineIndex,
    targetStartMs: win.startMs, gapStartMs: win.startMs, gapEndMs: win.endMs, gapDurationMs: freeLen,
    gainDb: asset.gainDb ?? (kind === "transition" ? -5 : -12), reason: `${kind} in ${gap.boundary} gap`,
  };
}

const INTRO_FALLBACK_ORDER: IntroTimingStyle[] = ["short_sting_then_clean", "full_before", "minimal"];

/** Select the intro treatment for an asset of `dur` ms under `policy`, falling
 *  back to a shorter TREATMENT (never another asset) when the asset is too short
 *  for the preferred one. Pure + timeline-independent for the treatment choice;
 *  `timeline` only positions the spoken-cold-open theme. */
function selectIntroTreatment(dur: number, policy: FormatSoundPolicy, timeline: ActualDialogueTimeline | null): { treatment: IntroTimingStyle; timings: IntroTimings } | null {
  for (const treatment of [policy.introStyle, ...INTRO_FALLBACK_ORDER]) {
    const timings = introTreatmentTimings(treatment, dur, policy, timeline);
    if (timings) return { treatment, timings };
  }
  return null;
}

/** Dialogue offset (ms) the intro treatment imposes — the point at which the
 *  first spoken word enters. Used by the stitcher to place the dialogue timeline
 *  BEFORE the director runs; the director then reproduces the identical value.
 *  0 when there is no intro (clean/disabled/no asset) or a spoken cold open. */
export function resolveIntroDialogueStartMs(profile: FrozenSoundProfile, formatId: string, includeIntro: boolean, introDurationMs: number | null): number {
  if (profile.mode === "clean" || !includeIntro || profile.introEnabled === false) return 0;
  if (!profile.intro || !introDurationMs) return 0;
  const sel = selectIntroTreatment(introDurationMs, getFormatSoundPolicy(formatId), null);
  return sel ? Math.max(0, sel.timings.speechEntryMs) : 0;
}

function directIntro(input: PostTtsDirectorInput, policy: FormatSoundPolicy, decisions: SoundDirectionDecision[], warnings: SoundDirectionWarning[], fail: (f: SoundDirectionFailure) => void): DirectedIntroPlan | null {
  const clean = input.frozenProfile.mode === "clean";
  const enabled = !clean && input.includeIntro && input.frozenProfile.introEnabled !== false;
  const asset = input.frozenProfile.intro;
  if (!enabled) { decisions.push({ subject: "intro", decision: "held", reason: clean ? "clean profile" : "intro disabled" }); return null; }
  if (!asset || !input.introAssetDurationMs) {
    // Required (frozen intent enabled) but no usable asset -> PR1 render gate + here.
    fail("required_intro_no_safe_treatment");
    warnings.push({ code: "intro_missing", detail: "intro enabled but no usable asset/duration" });
    return { required: true, assetId: asset?.assetId ?? null, treatment: "none", introStartMs: 0, introDurationMs: 0, speechEntryMs: 0, duckStartMs: null, duckGainDb: null, fadeMs: 0, continuesUnderSpeech: false, segments: [], reason: "required intro has no usable asset" };
  }
  const dur = input.introAssetDurationMs;
  const sel = selectIntroTreatment(dur, policy, input.timeline);
  if (sel) {
    decisions.push({ subject: "intro", decision: "treated", reason: `${sel.treatment} (asset ${dur}ms)` });
    return { required: true, assetId: asset.assetId, treatment: sel.treatment, introDurationMs: dur, ...sel.timings, reason: `${sel.treatment} intro` };
  }
  fail("required_intro_no_safe_treatment");
  return { required: true, assetId: asset.assetId, treatment: "none", introStartMs: 0, introDurationMs: dur, speechEntryMs: 0, duckStartMs: null, duckGainDb: null, fadeMs: 0, continuesUnderSpeech: false, segments: [], reason: "no safe intro treatment for this asset length" };
}

type IntroTimings = Omit<DirectedIntroPlan, "required" | "assetId" | "treatment" | "introDurationMs" | "reason">;

function introTreatmentTimings(treatment: IntroTimingStyle, dur: number, policy: FormatSoundPolicy, timeline: ActualDialogueTimeline | null): IntroTimings | null {
  const fadeMs = Math.min(900, Math.max(200, Math.round(dur * 0.25)));
  const openPad = policy.protectedOpeningPaddingMs;
  const full = BOOKEND_FULL_GAIN_DB, duck = BOOKEND_DUCK_GAIN_DB;
  switch (treatment) {
    case "full_before": {
      if (dur < 1200) return null;
      // The whole theme plays, fades out, THEN speech enters after the opening
      // pad — the intro is entirely before the protected first words.
      const speechEntryMs = dur + openPad;
      return { introStartMs: 0, speechEntryMs, duckStartMs: null, duckGainDb: null, fadeMs, continuesUnderSpeech: false,
        segments: [{ role: "clean", sourceStartMs: 0, sourceEndMs: dur, timelineStartMs: 0, gainDb: full, fadeInMs: 20, fadeOutMs: fadeMs, ducked: false }] };
    }
    case "short_sting_then_clean": {
      if (dur < 300) return null;
      const stingMs = Math.min(dur, 2500);
      const cleanFade = Math.min(fadeMs, 400);
      const speechEntryMs = stingMs + openPad;
      return { introStartMs: 0, speechEntryMs, duckStartMs: null, duckGainDb: null, fadeMs: cleanFade, continuesUnderSpeech: false,
        segments: [{ role: "sting", sourceStartMs: 0, sourceEndMs: stingMs, timelineStartMs: 0, gainDb: full, fadeInMs: 20, fadeOutMs: cleanFade, ducked: false }] };
    }
    case "cold_open_ducked": {
      if (dur < 1500) return null;
      // Theme opens at full; the host enters at ~35%. The theme DUCKS a hair
      // BEFORE the host so it is already ducked when the opening protected region
      // begins (speech-entry minus the opening pad) — the full-gain lead never
      // covers protected words, and measurable ducked theme sits under the open.
      const entry = Math.round(dur * 0.35);
      const duckPoint = Math.max(1, entry - openPad);
      return { introStartMs: 0, speechEntryMs: entry, duckStartMs: duckPoint, duckGainDb: duck, fadeMs, continuesUnderSpeech: true,
        segments: [
          { role: "lead", sourceStartMs: 0, sourceEndMs: duckPoint, timelineStartMs: 0, gainDb: full, fadeInMs: 20, fadeOutMs: 0, ducked: false },
          { role: "under_speech", sourceStartMs: duckPoint, sourceEndMs: dur, timelineStartMs: duckPoint, gainDb: duck, fadeInMs: 0, fadeOutMs: fadeMs, ducked: true },
        ] };
    }
    case "spoken_cold_open_then_theme": {
      if (dur < 800) return null;
      // Dialogue LEADS (speechEntry 0); the theme enters ducked only AFTER the
      // first spoken line, using the real timeline. It is ducked, so it may sit
      // under the following speech without covering protected words unducked.
      const coldOpenEndMs = timeline && timeline.lines.length ? timeline.lines[0].speechEndMs : 1500;
      const cross = Math.min(700, fadeMs);
      return { introStartMs: coldOpenEndMs, speechEntryMs: 0, duckStartMs: coldOpenEndMs, duckGainDb: duck, fadeMs, continuesUnderSpeech: true,
        segments: [
          { role: "under_speech", sourceStartMs: 0, sourceEndMs: dur, timelineStartMs: coldOpenEndMs, gainDb: duck, fadeInMs: cross, fadeOutMs: fadeMs, ducked: true },
        ] };
    }
    case "minimal": {
      if (dur < 150) return null;
      const cleanMs = Math.min(dur, 1200);
      const speechEntryMs = cleanMs + openPad;
      return { introStartMs: 0, speechEntryMs, duckStartMs: null, duckGainDb: null, fadeMs: 150, continuesUnderSpeech: false,
        segments: [{ role: "clean", sourceStartMs: 0, sourceEndMs: cleanMs, timelineStartMs: 0, gainDb: full, fadeInMs: 20, fadeOutMs: 150, ducked: false }] };
    }
  }
}

function directOutro(input: PostTtsDirectorInput, policy: FormatSoundPolicy, decisions: SoundDirectionDecision[], warnings: SoundDirectionWarning[], fail: (f: SoundDirectionFailure) => void): DirectedOutroPlan | null {
  const clean = input.frozenProfile.mode === "clean";
  const enabled = !clean && input.includeOutro && input.frozenProfile.outroEnabled !== false;
  const asset = input.frozenProfile.outro;
  const speechEndMs = input.timeline.speechEndMs;
  if (!enabled) { decisions.push({ subject: "outro", decision: "held", reason: clean ? "clean profile" : "outro disabled" }); return null; }
  if (!asset || !input.outroAssetDurationMs) {
    fail("required_outro_no_safe_treatment");
    warnings.push({ code: "outro_missing", detail: "outro enabled but no usable asset/duration" });
    return { required: true, assetId: asset?.assetId ?? null, treatment: "none", speechEndMs, outroStartMs: speechEndMs, outroDurationMs: 0, fadeInMs: 0, fadeOutMs: 0, reflectiveGapMs: 0, segments: [], reason: "required outro has no usable asset" };
  }
  const dur = input.outroAssetDurationMs;
  const lastLine = input.timeline.lines[input.timeline.lines.length - 1];
  const unresolvedOverlap = !!lastLine?.isInterruption && (lastLine.appliedOverlapMs ?? 0) > 0;
  // Never begin the outro during unresolved overlapping speech: start cleanly
  // after the last audible word for those.
  let treatment = policy.outroStyle;
  if (unresolvedOverlap && treatment === "rise_under_final") { treatment = "clean_then_outro"; decisions.push({ subject: "outro", decision: "treated", reason: "unresolved overlap -> clean close" }); }
  const timings = outroTreatmentTimings(treatment, dur, input.timeline, policy);
  decisions.push({ subject: "outro", decision: "treated", reason: `${treatment} (asset ${dur}ms)` });
  return { required: true, assetId: asset.assetId, treatment, speechEndMs, outroDurationMs: dur, ...timings, reason: `${treatment} outro` };
}

type OutroTimings = Pick<DirectedOutroPlan, "outroStartMs" | "fadeInMs" | "fadeOutMs" | "reflectiveGapMs" | "segments">;

function outroTreatmentTimings(treatment: OutroTimingStyle, dur: number, timeline: ActualDialogueTimeline, policy: FormatSoundPolicy): OutroTimings {
  const speechEndMs = timeline.speechEndMs;
  const closePad = policy.protectedClosingPaddingMs;
  const cross = Math.min(900, Math.round(dur * 0.25));
  const full = BOOKEND_FULL_GAIN_DB, duck = BOOKEND_DUCK_GAIN_DB;
  // A single full-level clean segment beginning `gapMs` after the last audible
  // word (never inside the protected closing region). speechEndMs already
  // excludes trailing silence, so `gapMs` is a genuine gap (no double-count).
  const cleanAfter = (gapMs: number, fadeInMs: number, fadeOutMs: number): OutroTimings => {
    const start = speechEndMs + Math.max(gapMs, closePad);
    return { outroStartMs: start, fadeInMs, fadeOutMs, reflectiveGapMs: start - speechEndMs,
      segments: [{ role: "clean", sourceStartMs: 0, sourceEndMs: dur, timelineStartMs: start, gainDb: full, fadeInMs, fadeOutMs, ducked: false }] };
  };
  switch (treatment) {
    case "rise_under_final": {
      // Ducked outro rises UNDER the final sentence, then swells to full only
      // AFTER the protected closing region ends (speechEndMs + closePad).
      const lastLine = timeline.lines[timeline.lines.length - 1];
      const lastSpeechStart = lastLine ? lastLine.speechStartMs : speechEndMs;
      const riseUnderMs = Math.max(0, Math.min(1200, Math.round(dur * 0.4), speechEndMs - lastSpeechStart));
      const duckedMs = riseUnderMs + closePad;                 // ducked span (final sentence + closing pad)
      const outroStartMs = Math.max(0, speechEndMs - riseUnderMs);
      const tailStart = speechEndMs + closePad;
      const segments: DirectedBookendSegment[] = [];
      if (duckedMs > 0 && duckedMs < dur) segments.push({ role: "under_speech", sourceStartMs: 0, sourceEndMs: duckedMs, timelineStartMs: outroStartMs, gainDb: duck, fadeInMs: cross, fadeOutMs: 0, ducked: true });
      const tailSourceStart = segments.length ? duckedMs : 0;
      segments.push({ role: "tail", sourceStartMs: tailSourceStart, sourceEndMs: dur, timelineStartMs: tailStart, gainDb: full, fadeInMs: segments.length ? 0 : cross, fadeOutMs: 400, ducked: false });
      return { outroStartMs, fadeInMs: cross, fadeOutMs: 400, reflectiveGapMs: 0, segments };
    }
    case "short_pause_then_outro": return cleanAfter(400, Math.min(cross, 500), 400);
    case "reflective_gap_then_outro": return cleanAfter(900, Math.min(cross, 700), 500);
    case "hard_branded_close": {
      // A short, bounded, punchy close (sports/rapid). Bounded excerpt so a long
      // theme cannot run past a hard close; no abrupt edge (fades on both ends).
      const closeMs = Math.min(dur, 2500);
      const start = speechEndMs + Math.max(120, closePad);
      return { outroStartMs: start, fadeInMs: 60, fadeOutMs: 300, reflectiveGapMs: 0,
        segments: [{ role: "clean", sourceStartMs: 0, sourceEndMs: closeMs, timelineStartMs: start, gainDb: full, fadeInMs: 60, fadeOutMs: 300, ducked: false }] };
    }
    case "clean_then_outro":
    default: return cleanAfter(200, Math.min(cross, 600), 400);
  }
}

function directBed(input: PostTtsDirectorInput, policy: FormatSoundPolicy, identity: SonicIdentity, decisions: SoundDirectionDecision[], warnings: SoundDirectionWarning[], fail: (f: SoundDirectionFailure) => void): DirectedBedPlan | null {
  const clean = input.frozenProfile.mode === "clean";
  // Effective bed policy: the identity's bedPolicy, unless the format forbids
  // beds entirely (rapid_fire) which overrides to "none".
  let bedPolicy = identity.bedPolicy ?? (policy.bedBehavior === "identity_decides" ? "intro_outro_only" : policy.bedBehavior);
  if (policy.bedBehavior === "none") bedPolicy = "none";
  if (clean || bedPolicy === "none") { decisions.push({ subject: "bed", decision: "held", reason: clean ? "clean profile" : `bed policy ${bedPolicy}` }); return null; }
  const bed = input.frozenProfile.bed;
  if (!bed) { decisions.push({ subject: "bed", decision: "held", reason: "bed policy set but no frozen bed" }); return null; }

  const t = input.timeline;
  const segments: DirectedBedSegment[] = [];
  if (bedPolicy === "full_episode") {
    segments.push({ startMs: 0, endMs: t.dialogueDurationMs, reason: "full-episode bed (ducked under speech)", boundary: "episode" });
  } else if (bedPolicy === "intro_outro_only") {
    segments.push({ startMs: 0, endMs: Math.min(t.speechStartMs + 1500, t.dialogueDurationMs), reason: "intro bed", boundary: "intro" });
    segments.push({ startMs: Math.max(0, t.speechEndMs - 500), endMs: t.dialogueDurationMs, reason: "outro bed", boundary: "outro" });
  } else {
    // select_segments / planner_decides: bed under topic segments only, changing
    // at safe topic boundaries (never restarting every line).
    const topicStarts = [t.speechStartMs, ...t.gaps.filter((g) => g.boundary === "topic").map((g) => g.startMs + g.durationMs)];
    for (let i = 0; i < topicStarts.length; i++) {
      const start = topicStarts[i];
      const end = i + 1 < topicStarts.length ? topicStarts[i + 1] : t.speechEndMs;
      if (end - start > 4000) segments.push({ startMs: start, endMs: end, reason: "selected topic-segment bed", boundary: "topic" });
    }
    if (!segments.length) { warnings.push({ code: "bed_no_segments", detail: "no topic segment long enough for a bed" }); }
  }
  void fail;
  return {
    assetId: bed.assetId, policy: bedPolicy, segments,
    baseGainDb: bed.gainDb ?? -6, duckedGainDb: -18, duckAttackMs: 120, duckReleaseMs: 750,
    fadeInMs: 900, fadeOutMs: 900, loopCrossfadeMs: 400, reason: `bed policy ${bedPolicy} (${policy.formatId})`,
  };
}

/** Compact, order-stable encoding of a bookend's executed segments. */
function segFp(segs: DirectedBookendSegment[]): Array<Array<number | string | boolean>> {
  return segs.map((s) => [s.role, s.sourceStartMs, s.sourceEndMs, s.timelineStartMs, s.gainDb, s.fadeInMs, s.fadeOutMs, s.ducked]);
}

/** Deterministic fingerprint of the plan's decision content (excludes the
 *  fingerprint field itself). Same inputs -> same hash. */
export function fingerprintDirectionPlan(plan: PostTtsSoundDirectionPlan): string {
  const canonical = {
    v: plan.version, dv: plan.directorVersion, ep: plan.episodeId, sc: plan.scriptId, seed: plan.seed, fmt: plan.formatId,
    dur: plan.dialogueDurationMs,
    cues: plan.cuePlacements.map((c) => [c.kind, c.assetId, c.cueFamily, c.lineIndex, c.targetStartMs, c.gainDb]),
    intro: plan.bookendPlan.intro && [plan.bookendPlan.intro.treatment, plan.bookendPlan.intro.assetId, plan.bookendPlan.intro.speechEntryMs, plan.bookendPlan.intro.duckStartMs, segFp(plan.bookendPlan.intro.segments)],
    outro: plan.bookendPlan.outro && [plan.bookendPlan.outro.treatment, plan.bookendPlan.outro.assetId, plan.bookendPlan.outro.outroStartMs, plan.bookendPlan.outro.reflectiveGapMs, segFp(plan.bookendPlan.outro.segments)],
    bed: plan.bedPlan && [plan.bedPlan.assetId, plan.bedPlan.policy, plan.bedPlan.segments.map((s) => [s.startMs, s.endMs])],
    fail: plan.failure,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
