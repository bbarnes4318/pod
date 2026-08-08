// Deterministic, listener-facing invariants that a script must satisfy before
// it is allowed to cost TTS money.
//
// These exist because the independent LLM judge is a *scorer*: it returns an
// aggregate a bad episode can hide inside. Episode e7867729 scored ~66/100 and
// shipped, while simultaneously carrying a 233-word cold open, an exact 33/33
// line split, 85% strict alternation, a host arguing the opponent's position in
// the final topic, and retired host names in its own metadata. Every one of
// those is mechanically checkable, so none of them should ever have depended on
// a model's opinion.
//
// Each invariant maps to a named critical axis. A failing critical axis is a
// hold on its own — it cannot be averaged away (see scriptEditorialGate).

import { stripAudioTags } from "../audio/speechText";

export type InvariantAxis =
  | "coldOpenQuality"
  | "hostBalance"
  | "mechanicalAlternation"
  | "positionConsistency"
  | "castIntegrity"
  | "argumentProgression";

export type InvariantSeverity = "pass" | "review" | "hold";

export interface InvariantFinding {
  axis: InvariantAxis;
  severity: InvariantSeverity;
  message: string;
  /** Machine-readable measurement so Studio can show the number, not prose. */
  observed?: Record<string, number | string | boolean>;
}

export interface InvariantReport {
  findings: InvariantFinding[];
  /** Axes that failed at hold severity. */
  failedCriticalAxes: InvariantAxis[];
  worstSeverity: InvariantSeverity;
  measurements: {
    lineCount: number;
    coldOpenWords: number;
    coldOpenLines: number;
    strictAlternationRatio: number;
    perSpeakerLines: Record<string, number>;
    positionSwapCount: number;
  };
}

export interface ScriptLineLike {
  lineIndex?: number;
  speakerName?: string;
  text?: string;
}

export interface ScriptSegmentLike {
  type?: string;
  title?: string;
  lines?: ScriptLineLike[];
}

export interface InvariantOptions {
  /** Names of the hosts actually cast on this episode. */
  activeHostNames?: string[];
  /**
   * Host names that must never appear again (retired cast). Supplied by the
   * caller from the roster so this module never hardcodes a person's name.
   */
  retiredHostNames?: string[];
  /** Spoken-word bounds for the cold open. */
  coldOpenMinWords?: number;
  coldOpenMaxWords?: number;
  /** Above this ratio, A/B/A/B alternation reads as a machine taking turns. */
  maxStrictAlternationRatio?: number;
}

export const COLD_OPEN_MIN_WORDS = 80;
export const COLD_OPEN_MAX_WORDS = 120;
export const MAX_STRICT_ALTERNATION_RATIO = 0.65;

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "for", "with", "at", "by",
  "from", "is", "are", "was", "were", "be", "been", "being", "it", "its", "that", "this", "these",
  "those", "you", "your", "i", "im", "ive", "me", "my", "we", "our", "they", "them", "their", "he",
  "she", "his", "her", "not", "no", "so", "as", "than", "then", "there", "here", "what", "which",
  "who", "when", "where", "how", "why", "all", "any", "just", "like", "get", "got", "do", "does",
  "did", "have", "has", "had", "can", "could", "would", "should", "will", "about", "into", "out",
  "up", "down", "over", "under", "thats", "youre", "dont", "im", "hes", "shes", "theyre", "were",
]);

export function spokenWords(text: string): string[] {
  return stripAudioTags(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function contentTokens(text: string): Set<string> {
  return new Set(spokenWords(text).filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

function cosineish(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / Math.sqrt(a.size * b.size);
}

function flatten(segments: ScriptSegmentLike[]): Array<{ speaker: string; text: string; segType: string }> {
  const out: Array<{ speaker: string; text: string; segType: string }> = [];
  for (const seg of segments || []) {
    for (const line of seg?.lines || []) {
      const speaker = (line?.speakerName || "").trim();
      const text = (line?.text || "").trim();
      if (!speaker || !text) continue;
      out.push({ speaker, text, segType: (seg?.type || "").trim() });
    }
  }
  return out;
}

/**
 * Position ledger. Builds each host's stance profile from the first half of the
 * episode, then flags later lines that sit closer to the OPPONENT's stance than
 * to the speaker's own — i.e. a host arguing the other host's case without an
 * authored change of mind.
 *
 * This is deliberately lexical and offline so it runs identically in CI and in
 * production, and so a judge outage cannot disable it.
 */
export function detectPositionSwaps(
  lines: Array<{ speaker: string; text: string }>,
  opts: { minMargin?: number } = {}
): Array<{ index: number; speaker: string; ownScore: number; opponentScore: number; text: string }> {
  const minMargin = opts.minMargin ?? 0.08;
  const speakers = Array.from(new Set(lines.map((l) => l.speaker)));
  if (speakers.length !== 2) return [];

  const half = Math.max(2, Math.floor(lines.length / 2));
  const profile = new Map<string, Set<string>>();
  for (const s of speakers) profile.set(s, new Set());
  for (const line of lines.slice(0, half)) {
    const bag = profile.get(line.speaker);
    if (!bag) continue;
    for (const t of contentTokens(line.text)) bag.add(t);
  }
  // Only tokens UNIQUE to one host characterise a position. Shared topic
  // vocabulary ("game", "pitching") says nothing about who believes what.
  const exclusive = new Map<string, Set<string>>();
  for (const s of speakers) {
    const mine = profile.get(s)!;
    const other = profile.get(speakers.find((x) => x !== s)!)!;
    exclusive.set(s, new Set(Array.from(mine).filter((t) => !other.has(t))));
  }

  const swaps: Array<{ index: number; speaker: string; ownScore: number; opponentScore: number; text: string }> = [];
  for (let i = half; i < lines.length; i++) {
    const line = lines[i];
    const opponent = speakers.find((x) => x !== line.speaker);
    if (!opponent) continue;
    const tokens = contentTokens(line.text);
    if (tokens.size < 4) continue;
    const ownScore = cosineish(tokens, exclusive.get(line.speaker) || new Set());
    const opponentScore = cosineish(tokens, exclusive.get(opponent) || new Set());
    if (opponentScore > ownScore + minMargin) {
      swaps.push({ index: i, speaker: line.speaker, ownScore, opponentScore, text: line.text });
    }
  }
  return swaps;
}

export function evaluateProductionInvariants(
  segments: ScriptSegmentLike[],
  opts: InvariantOptions = {}
): InvariantReport {
  const coldOpenMin = opts.coldOpenMinWords ?? COLD_OPEN_MIN_WORDS;
  const coldOpenMax = opts.coldOpenMaxWords ?? COLD_OPEN_MAX_WORDS;
  const maxAlternation = opts.maxStrictAlternationRatio ?? MAX_STRICT_ALTERNATION_RATIO;

  const findings: InvariantFinding[] = [];
  const lines = flatten(segments);
  const perSpeaker: Record<string, number> = {};
  for (const l of lines) perSpeaker[l.speaker] = (perSpeaker[l.speaker] || 0) + 1;

  // --- coldOpenQuality -----------------------------------------------------
  const coldOpen = lines.filter((l) => l.segType === "cold_open");
  const coldOpenWords = coldOpen.reduce((n, l) => n + spokenWords(l.text).length, 0);
  if (!coldOpen.length) {
    findings.push({ axis: "coldOpenQuality", severity: "hold", message: "Script has no cold_open segment." });
  } else if (coldOpenWords > coldOpenMax || coldOpenWords < coldOpenMin) {
    findings.push({
      axis: "coldOpenQuality",
      severity: "hold",
      message:
        `Cold open is ${coldOpenWords} spoken words; the accepted range is ${coldOpenMin}-${coldOpenMax}. ` +
        `A cold open outside this range cannot perform in 30-45 seconds.`,
      observed: { words: coldOpenWords, min: coldOpenMin, max: coldOpenMax },
    });
  }
  // Throat-clearing: a cold open that greets or describes the show is not a
  // cold open, whatever its length.
  const coldOpenText = coldOpen.map((l) => l.text).join(" ").toLowerCase();
  const greetingRe = /\b(welcome (back )?to|you're listening to|thanks for (tuning|joining)|hello and welcome|i'm your host|on today's (show|episode)|coming up on)\b/;
  if (greetingRe.test(coldOpenText)) {
    findings.push({
      axis: "coldOpenQuality",
      severity: "hold",
      message: "Cold open contains a greeting/show description; it must open mid-argument.",
    });
  }

  // --- hostBalance ---------------------------------------------------------
  const counts = Object.values(perSpeaker);
  if (counts.length === 2 && counts[0] === counts[1] && counts[0] >= 8) {
    findings.push({
      axis: "hostBalance",
      severity: "hold",
      message:
        `Both hosts have exactly ${counts[0]} lines. An exact split is the signature of a balancing rule, ` +
        `not of a conversation; line count must follow who has something to say.`,
      observed: { ...perSpeaker },
    });
  }

  // --- mechanicalAlternation ----------------------------------------------
  let switches = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].speaker !== lines[i - 1].speaker) switches += 1;
  const alternation = lines.length > 1 ? switches / (lines.length - 1) : 0;
  if (alternation > maxAlternation) {
    findings.push({
      axis: "mechanicalAlternation",
      severity: "hold",
      message:
        `${(alternation * 100).toFixed(1)}% of turns are strict A/B alternation; the ceiling is ` +
        `${(maxAlternation * 100).toFixed(0)}%. Hosts must be able to build a point across consecutive lines.`,
      observed: { ratio: Number(alternation.toFixed(4)), ceiling: maxAlternation },
    });
  }

  // --- positionConsistency -------------------------------------------------
  const swaps = detectPositionSwaps(lines);
  if (swaps.length) {
    findings.push({
      axis: "positionConsistency",
      severity: swaps.length >= 2 ? "hold" : "review",
      message:
        `${swaps.length} line(s) argue the opposing host's position without an authored change of mind ` +
        `(first at line ${swaps[0].index}: "${swaps[0].text.slice(0, 90)}").`,
      observed: { swaps: swaps.length, firstIndex: swaps[0].index },
    });
  }

  // --- castIntegrity -------------------------------------------------------
  const retired = (opts.retiredHostNames || []).filter(Boolean);
  if (retired.length) {
    const haystack = segments
      .map((s) => `${s.title || ""} ${(s.lines || []).map((l) => l.text || "").join(" ")}`)
      .join(" ")
      .toLowerCase();
    const found = retired.filter((name) => new RegExp(`\\b${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(haystack));
    if (found.length) {
      findings.push({
        axis: "castIntegrity",
        severity: "hold",
        message: `Script references retired host name(s): ${found.join(", ")}.`,
        observed: { names: found.join(",") },
      });
    }
  }
  const active = (opts.activeHostNames || []).filter(Boolean);
  if (active.length) {
    const unknown = Object.keys(perSpeaker).filter(
      (s) => !active.some((a) => a.toLowerCase() === s.toLowerCase())
    );
    if (unknown.length) {
      findings.push({
        axis: "castIntegrity",
        severity: "hold",
        message: `Script contains speaker(s) not in the episode cast: ${unknown.join(", ")}.`,
      });
    }
  }

  // --- argumentProgression -------------------------------------------------
  // Require at least one authored movement: a concession, a correction, or an
  // explicit change of mind. Without one, the episode is two positions held
  // flat for the full runtime, which is what shipped.
  const movementRe = /\b(you'?re right|fair point|i'?ll give you|okay,? i|i was wrong|that changes|i hadn'?t|point taken|i'?ll concede|actually,? no|i take that back|alright,? then)\b/i;
  const hasMovement = lines.some((l) => movementRe.test(l.text));
  if (lines.length >= 12 && !hasMovement) {
    findings.push({
      axis: "argumentProgression",
      severity: "hold",
      message:
        "No line contains a concession, correction, or change of mind. At least one genuine shift in " +
        "position, understanding, or leverage is required.",
    });
  }

  const holdAxes = Array.from(new Set(findings.filter((f) => f.severity === "hold").map((f) => f.axis)));
  const worstSeverity: InvariantSeverity = holdAxes.length
    ? "hold"
    : findings.some((f) => f.severity === "review")
      ? "review"
      : "pass";

  return {
    findings,
    failedCriticalAxes: holdAxes,
    worstSeverity,
    measurements: {
      lineCount: lines.length,
      coldOpenWords,
      coldOpenLines: coldOpen.length,
      strictAlternationRatio: Number(alternation.toFixed(4)),
      perSpeakerLines: perSpeaker,
      positionSwapCount: swaps.length,
    },
  };
}
