/**
 * Antithesis / negation-contrast detection.
 *
 * The single loudest machine tell in generated dialogue is the balanced
 * negation: a clause negated, then immediately replaced by its "real" version.
 *
 *   "That's not a basketball game, that's a public dismantling."
 *   "That wasn't effort. That was a coaching decision."
 *   "Same roster. New excuse."
 *   "You didn't lose a game, you lost a locker room."
 *
 * Humans use this. They use it once, at a peak, when they mean it. A model
 * uses it as its default sentence shape, because the shape is cheap: it
 * manufactures the FEELING of an insight without requiring one. Once it
 * appears three times in an episode the show sounds written, and every line
 * after it is discounted by the listener.
 *
 * Two rules, both enforced here:
 *   1. HARD BAN inside the first `coldOpenLines` lines. The cold open is where
 *      a listener decides; it cannot open on the tell.
 *   2. BUDGET of `maxPerEpisode` for the rest. Over budget, the line is
 *      returned for rewrite with the offending span marked.
 *
 * This is deliberately NOT a banned-phrase list. Phrase lists are defeated by
 * synonyms. These match the syntactic frame, which is the thing that repeats.
 */

export type AntithesisKind =
  | "not_X_but_Y"        // "That's not X, that's Y" / "It isn't X. It's Y."
  | "not_a_X_a_Y"        // "Not a slump, a collapse."
  | "same_X_new_Y"       // "Same roster. New excuse."
  | "X_comma_not_Y"      // "That's a coaching decision, not a character flaw."
  | "didnt_X_you_Y"      // "You didn't lose a game, you lost a room."
  | "isnt_about_its_about" // "This isn't about money, it's about respect."
  | "not_just_but"       // "Not just bad, historically bad."
  | "less_X_more_Y"      // "Less a team than a rumor."
  | "you_just_X";        // "You just described a rebuild."

export interface AntithesisHit {
  kind: AntithesisKind;
  /** Character offsets into the line text. */
  start: number;
  end: number;
  /** The matched span, for logging and for the rewrite prompt. */
  span: string;
}

interface Rule {
  kind: AntithesisKind;
  re: RegExp;
  /**
   * Deterministic repair. The frame is a SYNTACTIC shape, so for the frames
   * that are pure syntax the correct edit is pure syntax too: delete the
   * negated half and keep the half the speaker actually means. No model is
   * needed or wanted for that — a regex removal always succeeds, where a
   * rewrite request can fail, time out, or come back with a fresh frame.
   * Returns null when the shape is too tangled to cut safely.
   */
  fix?: (match: RegExpExecArray, text: string) => string | null;
}

/** Re-capitalize after a cut so a deleted first clause does not leave "that's a collapse." */
function recapitalize(text: string, at: number): string {
  if (at !== 0) return text;
  return text.replace(/^(\s*)([a-z])/, (_all, space: string, ch: string) => space + ch.toUpperCase());
}

function cutBefore(match: RegExpExecArray, text: string, keepFrom: number): string | null {
  if (keepFrom <= match.index || keepFrom >= text.length) return null;
  const cut = (text.slice(0, match.index) + text.slice(keepFrom)).replace(/\s+/g, " ").trim();
  if (!cut) return null;
  return recapitalize(cut, match.index);
}

// Every pattern is anchored on the FRAME, not on vocabulary.
//
// A pattern here must match the RHETORICAL frame and nothing else. An
// over-broad rule is worse than a missing one: the flagged line is handed to a
// rewriter with the instruction "delete one half of the contrast", which is
// incoherent for a sentence that has no contrast in it, so the model reshuffles
// a perfectly good line and often introduces a real frame doing it. Two rules
// used to match ordinary sports speech — "scored more points than Embiid",
// "he played well, not great" — and both are narrowed below.
const RULES: Rule[] = [
  {
    kind: "not_X_but_Y",
    re: /\b(?:that|this|it|he|she|they)(?:'s|s| is| was| are| were)?\s+(?:not|isn't|isn’t|wasn't|wasn’t|aren't|ain't)\b[^.!?;]{1,70}[,.;]\s*((?:that|this|it|he|she|they)(?:'s|s| is| was| are| were)\b)/gi,
    // "That's not a slump. That's a collapse." -> "That's a collapse."
    fix: (m, text) => cutBefore(m, text, m.index + m[0].lastIndexOf(m[1])),
  },
  {
    kind: "not_a_X_a_Y",
    re: /\b(?:not|no)\s+(?:a|an)\s+\w+(?:\s+\w+){0,3}\s*[,.;—-]\s*((?:a|an)\s+\w+)/gi,
    // "Not a slump, a collapse." -> "A collapse."
    fix: (m, text) => cutBefore(m, text, m.index + m[0].lastIndexOf(m[1])),
  },
  {
    kind: "same_X_new_Y",
    re: /\bsame\s+\w+(?:\s+\w+){0,2}\s*[,.;]\s*(?:same|new|different|another)\s+\w+/gi,
  },
  {
    // NARROWED: the tail must be a noun phrase ("..., not a character flaw."),
    // which is the frame. A bare adjective tail ("He played well, not great.")
    // is ordinary speech and is no longer matched.
    kind: "X_comma_not_Y",
    re: /\b(\w+(?:\s+\w+){0,3}),\s*not\s+(?:a|an|the)\s+\w+(?:\s+\w+){0,2}\s*([.!?])/gi,
    // "It's a coaching decision, not a character flaw." -> "It's a coaching decision."
    fix: (m, text) =>
      (text.slice(0, m.index) + m[1] + m[2] + text.slice(m.index + m[0].length))
        .replace(/\s+/g, " ")
        .trim() || null,
  },
  {
    kind: "didnt_X_you_Y",
    re: /\b(?:you|they|he|she|we)\s+(?:didn't|didn’t|don't|don’t|haven't|hasn't)\s+\w+[^.!?;]{0,50}[,;]\s*(?:you|they|he|she|we)\s+\w+/gi,
  },
  {
    kind: "isnt_about_its_about",
    re: /\b(?:isn't|isn’t|wasn't|wasn’t|is not|was not)\s+about\b[^.!?;]{0,50}[,.;]\s*((?:it|that|this)(?:'s|s| is| was)\s+about\b)/gi,
    // "This isn't about money, it's about respect." -> "It's about respect."
    fix: (m, text) => cutBefore(m, text, m.index + m[0].lastIndexOf(m[1])),
  },
  {
    kind: "not_just_but",
    re: /\bnot\s+just\s+\w+[^.!?;]{0,40}[,—-]\s*\w+/gi,
  },
  {
    kind: "you_just_X",
    re: /\b(?:you|that|what\s+you)\s+just\s+(?:described|said|made|gave|told|admitted|explained)\b/gi,
  },
  {
    // NARROWED: only the copular noun-phrase frame ("less a team than a rumor",
    // "more a rumor than a team"). The article is what separates the frame from
    // a plain comparative — "more points than Embiid" and "more range than
    // anyone" are measurements, not rhetoric, and were being failed as tells.
    kind: "less_X_more_Y",
    re: /\b(?:less|more)\s+(?:of\s+)?(?:a|an)\s+\w+(?:\s+\w+){0,2}\s+than\s+(?:a|an)\s+\w+/gi,
  },
];

/**
 * Try to remove one frame from a line without a model. Returns null when no
 * rule owns a deterministic cut for that span.
 */
export function deterministicAntithesisFix(text: string, kind: AntithesisKind): string | null {
  const rule = RULES.find((candidate) => candidate.kind === kind);
  if (!rule || !rule.fix) return null;
  rule.re.lastIndex = 0;
  const match = rule.re.exec(text);
  if (!match) return null;
  const cut = rule.fix(match, text);
  if (!cut || !cut.trim()) return null;
  // Never accept a "repair" that leaves a frame behind or invents a new one.
  if (findAntithesis(cut).length >= findAntithesis(text).length) return null;
  // Never accept one that guts the line.
  if (cut.split(/\s+/).length < 3) return null;
  return cut;
}

/** Find every antithesis frame in one spoken line. */
export function findAntithesis(text: string): AntithesisHit[] {
  const hits: AntithesisHit[] = [];
  const taken: Array<[number, number]> = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      // one hit per span — the frames overlap by design
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      taken.push([start, end]);
      hits.push({ kind: rule.kind, start, end, span: m[0].trim() });
      if (m[0].length === 0) rule.re.lastIndex++;
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

export interface AntithesisLine {
  lineIndex: number;
  speakerName: string;
  text: string;
}

export interface AntithesisViolation extends AntithesisLine {
  hits: AntithesisHit[];
  reason: string;
}

export interface AntithesisReport {
  totalHits: number;
  hitsPerHundredLines: number;
  byKind: Record<string, number>;
  bySpeaker: Record<string, number>;
  /** Lines that must be rewritten. */
  violations: AntithesisViolation[];
  passed: boolean;
  reasons: string[];
}

export interface AntithesisPolicy {
  /** Frames allowed in the whole episode, across all speakers. Default 1. */
  maxPerEpisode?: number;
  /** No frame may appear in the first N lines. Default 6. */
  coldOpenLines?: number;
  /** No speaker may exceed this. Default 1. */
  maxPerSpeaker?: number;
}

const DEFAULTS: Required<AntithesisPolicy> = {
  maxPerEpisode: 1,
  coldOpenLines: 6,
  maxPerSpeaker: 1,
};

export function analyzeAntithesis(
  lines: AntithesisLine[],
  policy: AntithesisPolicy = {},
): AntithesisReport {
  const p = { ...DEFAULTS, ...policy };
  const byKind: Record<string, number> = {};
  const bySpeaker: Record<string, number> = {};
  const violations: AntithesisViolation[] = [];
  const reasons: string[] = [];

  let total = 0;
  let budgetUsed = 0;
  const speakerUsed: Record<string, number> = {};

  for (const line of lines) {
    const hits = findAntithesis(line.text);
    if (hits.length === 0) continue;
    total += hits.length;
    for (const h of hits) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
    bySpeaker[line.speakerName] = (bySpeaker[line.speakerName] ?? 0) + hits.length;

    // rule 1 — cold open is absolute
    if (line.lineIndex < p.coldOpenLines) {
      violations.push({
        ...line,
        hits,
        reason: `Antithesis frame in the cold open (line ${line.lineIndex}). The first ${p.coldOpenLines} lines may not use it at all.`,
      });
      continue;
    }

    // rule 2 — more than one frame in a single line is never allowed
    if (hits.length > 1) {
      violations.push({
        ...line,
        hits,
        reason: `${hits.length} antithesis frames stacked in one line.`,
      });
      continue;
    }

    // rule 3 — episode and per-speaker budget
    const spk = (speakerUsed[line.speakerName] ?? 0);
    if (budgetUsed >= p.maxPerEpisode || spk >= p.maxPerSpeaker) {
      violations.push({
        ...line,
        hits,
        reason:
          budgetUsed >= p.maxPerEpisode
            ? `Episode antithesis budget (${p.maxPerEpisode}) already spent.`
            : `${line.speakerName} has already used their one antithesis frame.`,
      });
      continue;
    }
    budgetUsed += 1;
    speakerUsed[line.speakerName] = spk + 1;
  }

  if (violations.length) {
    reasons.push(
      `${violations.length} line(s) use the negation-contrast frame beyond budget (${total} total frames across ${lines.length} lines).`,
    );
  }

  return {
    totalHits: total,
    hitsPerHundredLines: lines.length ? (total / lines.length) * 100 : 0,
    byKind,
    bySpeaker,
    violations,
    passed: violations.length === 0,
    reasons,
  };
}

/**
 * The instruction handed to the rewrite pass. Deliberately does NOT tell the
 * model to "vary its phrasing" — that produces a different flavour of the same
 * frame. It tells it to delete one half, which forces the line to carry its
 * meaning some other way.
 */
export function rewriteInstruction(v: AntithesisViolation): string {
  const span = v.hits[0]?.span ?? v.text;
  return [
    "This line uses a balanced negation, the loudest tell that a machine wrote it:",
    `  "${span}"`,
    "",
    "Rewrite the line. Do not rebalance it and do not find a synonym for the frame.",
    "Delete one half of the contrast and keep only the half that is TRUE for this speaker.",
    "If the line then says too little, replace the deleted half with something concrete:",
    "a number, a name, a thing that happened, or the speaker interrupting themselves.",
    "",
    "Keep the speaker's voice. Keep the length within 20%. Keep any factual claim intact.",
    `Original: ${v.text}`,
  ].join("\n");
}
