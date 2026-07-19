// Protected speech regions (PR 3). PURE + deterministic.
//
// No stinger, reaction, transition, or UNDUCKED music may cover a HARD
// protected region. Protection is derived from the approved script's EXISTING
// line metadata (isFactualClaim, interruptions, first/last line) plus
// deterministic term detection (numbers, negations, scores/odds/injury/
// transaction language) — NOT from any transcript-verification architecture
// (that belongs to the premium-voice program, explicitly out of scope). A
// ducked bed may generally continue under ordinary speech; a hard region for a
// name/number/negation/odds/injury forbids ALL non-dialogue audio.

export type ProtectedSeverity = "hard" | "soft";

export interface ProtectedAudioRegion {
  startMs: number;
  endMs: number;
  paddingMs: number;
  reason: string;
  severity: ProtectedSeverity;
  /** A ducked (side-chained) bed may continue beneath this region. */
  allowDuckedBed: boolean;
  /** A decaying reaction TAIL from an earlier cue may overlap this region. */
  allowReactionTail: boolean;
  lineIndex: number;
}

export interface ProtectedLineInput {
  lineIndex: number;
  text: string;
  isInterruption: boolean;
  isFactualClaim?: boolean;
  emphasis?: boolean;
  speechStartMs: number;
  speechEndMs: number;
  appliedOverlapMs?: number;
  timelineStartMs: number;
}

export interface ProtectedRegionOptions {
  openingPaddingMs: number;   // format policy protectedOpeningPaddingMs
  closingPaddingMs: number;   // format policy protectedClosingPaddingMs
  speechPaddingMs: number;    // POST_TTS_PROTECTED_SPEECH_PADDING_MS
  /** May a ducked bed continue under a hard critical region? (format policy) */
  allowDuckedBedUnderHard: boolean;
}

const NEGATION = /\b(n't|not|never|no|none|nobody|nothing|neither|nor|isn't|won't|didn't|don't|doesn't|can't|cannot|wasn't|weren't|aren't|shouldn't|wouldn't|couldn't|ain't)\b/i;
const NUMBER = /(\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|percent|half|quarter)\b)/i;
const SCORE_ODDS = /\b(odds|spread|moneyline|over\/under|favorite|underdog|points?|score|final|lead|won|lost|beat|record|streak|margin|-\d|\+\d)\b/i;
const INJURY_TXN = /\b(injur(y|ed|ies)|questionable|doubtful|out|hamstring|acl|concussion|traded?|signed?|waived?|released?|deal|contract|suspend(ed)?|fined?)\b/i;

/** Deterministically detect whether a line carries critical content that must
 *  be hard-protected. Returns the reason, or null. */
export function criticalReason(line: ProtectedLineInput): string | null {
  if (line.isFactualClaim) return "factual claim (names/numbers/scores)";
  if (line.emphasis) return "script-marked emphasis";
  const t = line.text || "";
  if (NEGATION.test(t)) return "negation";
  if (NUMBER.test(t)) return "number";
  if (SCORE_ODDS.test(t)) return "score/odds";
  if (INJURY_TXN.test(t)) return "injury/transaction";
  return null;
}

/**
 * Build the protected regions for an episode. Every audible speech span is at
 * least SOFT-protected (no hard cue / unducked music over it; a ducked bed may
 * continue). Spans are escalated to HARD (no non-dialogue audio, no reaction
 * tail) for the opening, the closing, interruptions, and critical content.
 */
export function buildProtectedRegions(lines: ProtectedLineInput[], opts: ProtectedRegionOptions): ProtectedAudioRegion[] {
  const regions: ProtectedAudioRegion[] = [];
  const last = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const critical = criticalReason(l);
    const isOpen = i === 0;
    const isClose = i === last;
    const isHard = !!critical || isOpen || isClose || l.isInterruption;

    const pad = isOpen ? opts.openingPaddingMs : isClose ? opts.closingPaddingMs : opts.speechPaddingMs;
    const reason = l.isInterruption ? "interruption"
      : isOpen ? "critical opening words"
      : isClose ? "critical closing words"
      : critical ?? "speech";

    regions.push({
      lineIndex: l.lineIndex,
      startMs: Math.max(0, l.speechStartMs - pad),
      endMs: l.speechEndMs + pad,
      paddingMs: pad,
      reason,
      severity: isHard ? "hard" : "soft",
      // A ducked bed may continue under ordinary speech, and (per policy) even
      // under hard critical speech; it may NOT continue if the format forbids
      // under-hard beds. A hard region never allows a reaction TAIL to overlap.
      allowDuckedBed: isHard ? opts.allowDuckedBedUnderHard : true,
      allowReactionTail: !isHard,
    });

    // An interruption's overlap span is separately hard-protected (the incoming
    // voice starts before the previous line ends).
    if (l.isInterruption && (l.appliedOverlapMs ?? 0) > 0) {
      regions.push({
        lineIndex: l.lineIndex,
        startMs: Math.max(0, l.timelineStartMs - (l.appliedOverlapMs ?? 0)),
        endMs: l.speechStartMs + opts.speechPaddingMs,
        paddingMs: opts.speechPaddingMs,
        reason: "interruption overlap",
        severity: "hard",
        allowDuckedBed: opts.allowDuckedBedUnderHard,
        allowReactionTail: false,
      });
    }
  }
  return regions;
}

export type CueAudioKind = "hard" | "ducked_bed" | "reaction_tail";

/**
 * Does a cue [startMs,endMs) of the given audio kind collide with any protected
 * region it is not permitted to touch? Returns the first violated region, or
 * null when the placement is safe.
 *   - "hard": a stinger/transition/reaction/UNDUCKED music body -> forbidden in
 *     ANY region (soft or hard).
 *   - "ducked_bed": allowed unless a region sets allowDuckedBed = false.
 *   - "reaction_tail": a decaying tail -> allowed only where allowReactionTail.
 */
export function cueCollidesWithProtected(
  regions: ProtectedAudioRegion[],
  startMs: number,
  endMs: number,
  kind: CueAudioKind
): ProtectedAudioRegion | null {
  for (const r of regions) {
    const overlaps = startMs < r.endMs && endMs > r.startMs;
    if (!overlaps) continue;
    if (kind === "hard") return r;                     // never over any protected speech
    if (kind === "ducked_bed" && !r.allowDuckedBed) return r;
    if (kind === "reaction_tail" && !r.allowReactionTail) return r;
  }
  return null;
}
