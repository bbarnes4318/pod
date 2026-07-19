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

export const POST_TTS_DIRECTOR_VERSION = 1 as const;

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
  speechEntryMs: number;     // when dialogue enters
  duckStartMs: number | null;
  duckGainDb: number | null;
  fadeMs: number;
  continuesUnderSpeech: boolean;
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

  for (const gap of input.timeline.gaps) {
    const beforeLine = lineById.get(gap.lineIndex - 1);  // the line JUST SPOKEN (reaction subject)
    // TRANSITION: only at a real structural boundary (the new topic at gap.lineIndex),
    // with a transition-sized gap.
    const structural = gap.boundary === "segment" || gap.boundary === "topic";
    if (structural && gapAllowsTransition(gap.classification) && transitions < policy.maxTransitionsPerEpisode) {
      const placed = placeCue("transition", input.frozenProfile.stingers, gap, gap.lineIndex, policy, identity, protectedRegions, rand, decisions);
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
        const placed = placeCue("reaction", input.frozenProfile.reactions, gap, subject, policy, identity, protectedRegions, rand, decisions);
        if (placed) { cuePlacements.push(placed); reactions++; }
      }
    }
  }

  // --- Bed -----------------------------------------------------------------
  const bedPlan = directBed(input, policy, identity, decisions, warnings, (f) => { failure = failure ?? f; });

  const plan: PostTtsSoundDirectionPlan = {
    version: 1, mode: "post_tts", episodeId: input.episodeId, scriptId: input.scriptId, seed: input.seed,
    formatId: input.formatId, directorVersion: POST_TTS_DIRECTOR_VERSION,
    dialogueDurationMs: input.timeline.dialogueDurationMs,
    protectedRegions, detectedGaps: input.timeline.gaps, cuePlacements, bookendPlan, bedPlan,
    failure, warnings, decisions, fingerprint: "",
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

function placeCue(
  kind: "transition" | "reaction",
  pool: FrozenSoundAssetRef[],
  gap: DetectedAudioGap,
  subjectLineIndex: number,
  policy: FormatSoundPolicy,
  identity: SonicIdentity,
  protectedRegions: ProtectedAudioRegion[],
  rand: () => number,
  decisions: SoundDirectionDecision[]
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
  const asset = pickWeighted(rand, eligible);
  if (!asset) { decisions.push({ subject: tag, decision: "rejected", reason: "no weighted candidate", lineIndex: subjectLineIndex }); return null; }
  decisions.push({ subject: tag, decision: "accepted", reason: `${asset.cueFamily ?? "cue"} in ${gap.classification} gap`, lineIndex: subjectLineIndex });
  return {
    kind, assetId: asset.assetId, cueFamily: asset.cueFamily ?? null, lineIndex: subjectLineIndex,
    targetStartMs: win.startMs, gapStartMs: win.startMs, gapEndMs: win.endMs, gapDurationMs: freeLen,
    gainDb: asset.gainDb ?? (kind === "transition" ? -5 : -12), reason: `${kind} in ${gap.boundary} gap`,
  };
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
    return { required: true, assetId: asset?.assetId ?? null, treatment: "none", introStartMs: 0, introDurationMs: 0, speechEntryMs: 0, duckStartMs: null, duckGainDb: null, fadeMs: 0, continuesUnderSpeech: false, reason: "required intro has no usable asset" };
  }
  const dur = input.introAssetDurationMs;
  // Choose a treatment permitted by the format; if the asset is too short for
  // the preferred treatment, fall back to another TREATMENT (never another asset).
  const order: IntroTimingStyle[] = [policy.introStyle, "short_sting_then_clean", "full_before", "minimal"];
  for (const treatment of order) {
    const t = introTreatmentTimings(treatment, dur);
    if (t) {
      decisions.push({ subject: "intro", decision: "treated", reason: `${treatment} (asset ${dur}ms)` });
      return { required: true, assetId: asset.assetId, treatment, introDurationMs: dur, ...t, reason: `${treatment} intro` };
    }
  }
  fail("required_intro_no_safe_treatment");
  return { required: true, assetId: asset.assetId, treatment: "none", introStartMs: 0, introDurationMs: dur, speechEntryMs: 0, duckStartMs: null, duckGainDb: null, fadeMs: 0, continuesUnderSpeech: false, reason: "no safe intro treatment for this asset length" };
}

function introTreatmentTimings(treatment: IntroTimingStyle, dur: number): Omit<DirectedIntroPlan, "required" | "assetId" | "treatment" | "introDurationMs" | "reason"> | null {
  const fadeMs = Math.min(900, Math.max(200, Math.round(dur * 0.25)));
  switch (treatment) {
    case "full_before":
      if (dur < 1200) return null;
      return { introStartMs: 0, speechEntryMs: Math.max(0, dur - fadeMs), duckStartMs: null, duckGainDb: null, fadeMs, continuesUnderSpeech: false };
    case "cold_open_ducked":
      if (dur < 1500) return null;
      return { introStartMs: 0, speechEntryMs: Math.round(dur * 0.35), duckStartMs: Math.round(dur * 0.35), duckGainDb: -12, fadeMs, continuesUnderSpeech: true };
    case "short_sting_then_clean":
      if (dur < 300) return null;
      return { introStartMs: 0, speechEntryMs: Math.min(dur, 2500), duckStartMs: null, duckGainDb: null, fadeMs: Math.min(fadeMs, 400), continuesUnderSpeech: false };
    case "spoken_cold_open_then_theme":
      if (dur < 800) return null;
      // A spoken cold open: dialogue first, theme after ~1.2s of speech. Executor
      // shifts the intro later; here speechEntry is 0 (dialogue leads).
      return { introStartMs: 1200, speechEntryMs: 0, duckStartMs: null, duckGainDb: null, fadeMs, continuesUnderSpeech: false };
    case "minimal":
      if (dur < 150) return null;
      return { introStartMs: 0, speechEntryMs: Math.min(dur, 1200), duckStartMs: null, duckGainDb: null, fadeMs: 150, continuesUnderSpeech: false };
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
    return { required: true, assetId: asset?.assetId ?? null, treatment: "none", speechEndMs, outroStartMs: speechEndMs, outroDurationMs: 0, fadeInMs: 0, fadeOutMs: 0, reason: "required outro has no usable asset" };
  }
  const dur = input.outroAssetDurationMs;
  const lastLine = input.timeline.lines[input.timeline.lines.length - 1];
  const unresolvedOverlap = !!lastLine?.isInterruption && (lastLine.appliedOverlapMs ?? 0) > 0;
  // Never begin the outro during unresolved overlapping speech: start cleanly
  // after the last audible word for those.
  let treatment = policy.outroStyle;
  if (unresolvedOverlap && treatment === "rise_under_final") { treatment = "clean_then_outro"; decisions.push({ subject: "outro", decision: "treated", reason: "unresolved overlap -> clean close" }); }
  const timings = outroTreatmentTimings(treatment, dur, speechEndMs);
  decisions.push({ subject: "outro", decision: "treated", reason: `${treatment} (asset ${dur}ms)` });
  return { required: true, assetId: asset.assetId, treatment, speechEndMs, outroDurationMs: dur, ...timings, reason: `${treatment} outro` };
}

function outroTreatmentTimings(treatment: OutroTimingStyle, dur: number, speechEndMs: number): Pick<DirectedOutroPlan, "outroStartMs" | "fadeInMs" | "fadeOutMs"> {
  const cross = Math.min(900, Math.round(dur * 0.25));
  switch (treatment) {
    case "rise_under_final": return { outroStartMs: Math.max(0, speechEndMs - 1200), fadeInMs: cross, fadeOutMs: 400 };
    case "short_pause_then_outro": return { outroStartMs: speechEndMs + 400, fadeInMs: Math.min(cross, 500), fadeOutMs: 400 };
    case "reflective_gap_then_outro": return { outroStartMs: speechEndMs + 900, fadeInMs: Math.min(cross, 700), fadeOutMs: 500 };
    case "hard_branded_close": return { outroStartMs: speechEndMs + 120, fadeInMs: 60, fadeOutMs: 300 };
    case "clean_then_outro":
    default: return { outroStartMs: speechEndMs + 200, fadeInMs: Math.min(cross, 600), fadeOutMs: 400 };
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

/** Deterministic fingerprint of the plan's decision content (excludes the
 *  fingerprint field itself). Same inputs -> same hash. */
export function fingerprintDirectionPlan(plan: PostTtsSoundDirectionPlan): string {
  const canonical = {
    v: plan.version, dv: plan.directorVersion, ep: plan.episodeId, sc: plan.scriptId, seed: plan.seed, fmt: plan.formatId,
    dur: plan.dialogueDurationMs,
    cues: plan.cuePlacements.map((c) => [c.kind, c.assetId, c.cueFamily, c.lineIndex, c.targetStartMs, c.gainDb]),
    intro: plan.bookendPlan.intro && [plan.bookendPlan.intro.treatment, plan.bookendPlan.intro.assetId, plan.bookendPlan.intro.speechEntryMs, plan.bookendPlan.intro.duckStartMs],
    outro: plan.bookendPlan.outro && [plan.bookendPlan.outro.treatment, plan.bookendPlan.outro.assetId, plan.bookendPlan.outro.outroStartMs],
    bed: plan.bedPlan && [plan.bedPlan.assetId, plan.bedPlan.policy, plan.bedPlan.segments.map((s) => [s.startMs, s.endMs])],
    fail: plan.failure,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
