// Generation-time dialogue repair pass. It retains the existing balanced-
// negation cleanup and now also repairs speaker switches that begin a separate
// monologue instead of answering the preceding host. The later quality gate is
// still authoritative and rejects the entire draft when repair is insufficient.

import {
  analyzeAntithesis,
  deterministicAntithesisFix,
  findAntithesis,
  type AntithesisLine,
  type AntithesisPolicy,
  type AntithesisReport,
} from "./scriptAntithesis";
import type { AntithesisRewriteItem, AntithesisRewriteOutcome } from "./scriptOutlineEngine";
import type { BatchLineRewriter, RewriteContext } from "./scriptSelfVerify";
import { stripAudioTags } from "../audio/speechText";
import { scoreConversationContinuity, type ConversationGateMetrics } from "./scriptConversationDirector";

export interface ScriptLineLike {
  lineIndex: number;
  speakerName?: string;
  text: string;
  tone?: string;
  energy?: string;
  pauseBefore?: string;
  isInterruption?: boolean;
  isFactualClaim?: boolean;
  evidenceRefs?: unknown[];
  needsHumanReview?: boolean;
}

export interface ScriptSegmentLike {
  type?: string;
  title?: string;
  lines?: ScriptLineLike[];
}

type RewriteResult = { text: string; evidenceRefs?: unknown[]; isFactualClaim?: boolean };

export interface ConversationRepairReport {
  ran: boolean;
  rounds: number;
  before: ConversationGateMetrics;
  after: ConversationGateMetrics;
  linesFlagged: number;
  linesRewritten: number;
  unresolvedLineIndexes: number[];
  reasons: string[];
}

export interface AntithesisPassReport {
  ran: boolean;
  rounds: number;
  before: { totalHits: number; hitsPerHundredLines: number };
  totalHits: number;
  hitsPerHundredLines: number;
  byKind: Record<string, number>;
  linesFlagged: number;
  linesCorrected: number;
  linesUnresolved: number;
  /** Repaired by regex alone, with no model call. */
  linesFixedDeterministically: number;
  /** The rewrite PROVIDER failed (not the model declining). Unresolved lines
   *  after this are unproven, not defiant. */
  rewriteUnavailable: boolean;
  corrections: Array<{
    lineIndex: number;
    round: number;
    kinds: string[];
    before: string;
    after: string;
  }>;
  unresolved: Array<{
    lineIndex: number;
    speakerName: string;
    text: string;
    kinds: string[];
    reason: string;
  }>;
  conversation: ConversationRepairReport;
  reasons: string[];
}

export interface AntithesisPassOptions {
  rewrite: BatchLineRewriter;
  /** Frame-specific rewriter. Falls back to nothing when absent — the
   *  deterministic cuts still run. */
  rewriteAntithesis?: (items: AntithesisRewriteItem[]) => Promise<AntithesisRewriteOutcome>;
  maxRounds?: number;
  policy?: AntithesisPolicy;
  evidenceTextFor?: (line: ScriptLineLike) => string;
  conversationRepair?: boolean;
  conversationRounds?: number;
}

const RESPONSE_START = /^(no\b|yes\b|yeah\b|right\b|exactly\b|wait\b|hold on\b|come on\b|okay\b|fine\b|but\b|because\b|so\b|then\b|what\b|why\b|how\b|you\b|your\b|that\b|this\b|which\b|except\b|still\b|actually\b|sure\b)/i;
const DIRECT_RESPONSE = /\b(you|your|you said|you keep saying|your point|that point|that argument|that take|what you just said|you mean|you called)\b/i;
const STOP = new Set(["the", "and", "that", "this", "with", "from", "have", "your", "you", "but", "for", "are", "was", "were", "they", "their", "what", "when", "where", "who", "how", "not", "just", "about", "into", "out", "all"]);
const endsWithDash = (value: string): boolean => /[—–-]\s*$/.test(String(value || "").trim());

function spoken(line: ScriptLineLike): string {
  return stripAudioTags(String(line.text || "")).replace(/\s+/g, " ").trim();
}

function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((word) => word.length >= 4 && !STOP.has(word)));
}

function overlap(leftText: string, rightText: string): number {
  const left = contentWords(leftText);
  const right = contentWords(rightText);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.max(1, Math.min(left.size, right.size));
}

function isResponsive(previous: ScriptLineLike, current: ScriptLineLike): boolean {
  const previousText = spoken(previous);
  const currentText = spoken(current);
  return current.isInterruption === true ||
    RESPONSE_START.test(currentText) ||
    DIRECT_RESPONSE.test(currentText) ||
    overlap(previousText, currentText) >= 0.12 ||
    (previousText.endsWith("?") && currentText.split(/\s+/).length <= 28) ||
    endsWithDash(previousText);
}

function collectLines(segments: ScriptSegmentLike[]): Array<{ line: ScriptLineLike; entry: AntithesisLine }> {
  const output: Array<{ line: ScriptLineLike; entry: AntithesisLine }> = [];
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (!segment || !Array.isArray(segment.lines)) continue;
    for (const line of segment.lines) {
      if (!line || typeof line.text !== "string") continue;
      output.push({
        line,
        entry: {
          lineIndex: line.lineIndex,
          speakerName: String(line.speakerName || "?"),
          text: line.text,
        },
      });
    }
  }
  return output;
}

function applyRewrite(line: ScriptLineLike, result: RewriteResult, before: string) {
  let text = result.text.trim();
  if ((endsWithDash(before) || line.isInterruption === true) && !endsWithDash(text)) {
    text = text.replace(/[.!?,;:]+$/, "").trimEnd() + "—";
  }
  line.text = text;
  if (Array.isArray(result.evidenceRefs)) line.evidenceRefs = result.evidenceRefs;
  if (result.isFactualClaim === false) {
    line.isFactualClaim = false;
    if (!Array.isArray(result.evidenceRefs)) line.evidenceRefs = [];
  }
}

function summarize(report: AntithesisReport) {
  return {
    totalHits: report.totalHits,
    hitsPerHundredLines: Number(report.hitsPerHundredLines.toFixed(1)),
  };
}

function findDisconnectedTurns(segments: ScriptSegmentLike[]): Array<{
  previous: ScriptLineLike;
  current: ScriptLineLike;
  segmentType: string;
}> {
  const failures: Array<{ previous: ScriptLineLike; current: ScriptLineLike; segmentType: string }> = [];
  for (const segment of segments) {
    const lines = Array.isArray(segment?.lines) ? segment.lines : [];
    for (let index = 1; index < lines.length; index++) {
      const previous = lines[index - 1];
      const current = lines[index];
      if (!previous || !current || previous.speakerName === current.speakerName) continue;
      if (!isResponsive(previous, current)) failures.push({ previous, current, segmentType: String(segment.type || "") });
    }
  }
  return failures;
}

async function repairConversation(
  segments: ScriptSegmentLike[],
  options: AntithesisPassOptions
): Promise<ConversationRepairReport> {
  const before = scoreConversationContinuity(segments as any);
  const enabled = options.conversationRepair !== false;
  const maxRounds = Math.max(1, Math.min(3, options.conversationRounds ?? 2));
  const everFlagged = new Set<number>();
  let linesRewritten = 0;
  let rounds = 0;

  if (enabled) {
    for (let round = 1; round <= maxRounds; round++) {
      const disconnected = findDisconnectedTurns(segments);
      if (disconnected.length === 0) break;
      rounds = round;
      const contexts: RewriteContext[] = [];
      for (const item of disconnected) {
        everFlagged.add(item.current.lineIndex);
        contexts.push({
          line: item.current,
          evidenceText: options.evidenceTextFor ? options.evidenceTextFor(item.current) : "",
          unsupportedFigures: [],
          unsupportedAttributions: [],
          semanticReason:
            `This line begins a parallel monologue instead of responding to the previous host. ` +
            `Previous host: "${spoken(item.previous)}" Current line: "${spoken(item.current)}". ` +
            `Rewrite ONLY the current line so it directly answers, challenges, extends, mocks, concedes, or interrupts the previous thought before advancing its own point. ` +
            `Keep the same speaker, lineIndex, factual meaning and evidence. Add no new fact, number, name, event, quote, or source. Sound spoken and emotionally specific, not polished prose.`,
          attempt: round,
        });
      }

      let rewrites: Map<number, RewriteResult>;
      try {
        rewrites = await options.rewrite(contexts);
      } catch {
        rewrites = new Map();
      }
      for (const item of disconnected) {
        const rewrite = rewrites.get(item.current.lineIndex);
        if (!rewrite || typeof rewrite.text !== "string" || !rewrite.text.trim()) continue;
        const beforeText = item.current.text;
        applyRewrite(item.current, rewrite, beforeText);
        if (item.current.text !== beforeText) linesRewritten++;
      }
    }
  }

  const unresolved = findDisconnectedTurns(segments);
  for (const item of unresolved) item.current.needsHumanReview = true;
  const after = scoreConversationContinuity(segments as any);
  return {
    ran: enabled,
    rounds,
    before,
    after,
    linesFlagged: everFlagged.size,
    linesRewritten,
    unresolvedLineIndexes: unresolved.map((item) => item.current.lineIndex),
    reasons: [
      `Conversation repair: ${before.score}/100 -> ${after.score}/100; ` +
      `responsive switches ${Math.round(before.responsiveSwitchRatio * 100)}% -> ${Math.round(after.responsiveSwitchRatio * 100)}%; ` +
      `${everFlagged.size} line(s) flagged, ${linesRewritten} rewritten, ${unresolved.length} still disconnected.`,
    ],
  };
}

export async function antithesisPassAndCorrect(
  segments: ScriptSegmentLike[],
  options: AntithesisPassOptions
): Promise<AntithesisPassReport> {
  const maxRounds = Math.max(1, options.maxRounds ?? 2);
  const collected = collectLines(segments);
  const lineByIndex = new Map<number, ScriptLineLike>(collected.map((item) => [item.entry.lineIndex, item.line]));
  let report = analyzeAntithesis(collected.map((item) => item.entry), options.policy);

  const pass: AntithesisPassReport = {
    ran: true,
    rounds: 0,
    before: summarize(report),
    ...summarize(report),
    byKind: report.byKind,
    linesFlagged: 0,
    linesCorrected: 0,
    linesUnresolved: 0,
    linesFixedDeterministically: 0,
    rewriteUnavailable: false,
    corrections: [],
    unresolved: [],
    conversation: {
      ran: false,
      rounds: 0,
      before: scoreConversationContinuity(segments as any),
      after: scoreConversationContinuity(segments as any),
      linesFlagged: 0,
      linesRewritten: 0,
      unresolvedLineIndexes: [],
      reasons: [],
    },
    reasons: [],
  };

  const everFlagged = new Set<number>();

  /**
   * Apply a candidate line, but never accept one that made the line WORSE.
   * A rewrite that swaps "that's not X, that's Y" for "same X, new Y" has
   * traded one frame for another, and keeping it is how a 5-violation script
   * became a 15-violation script between rounds.
   */
  const applyGuarded = (line: ScriptLineLike, candidate: string, before: string): boolean => {
    const hitsBefore = findAntithesis(before).length;
    applyRewrite(line, { text: candidate }, before);
    if (findAntithesis(line.text).length > hitsBefore) {
      line.text = before;
      return false;
    }
    return line.text !== before;
  };

  let attempts = 0;
  // One spare attempt, so a single dead provider call cannot silently eat a
  // whole round and leave the script looking uncooperative.
  const maxAttempts = maxRounds + 1;

  while (report.violations.length > 0 && pass.rounds < maxRounds && attempts < maxAttempts) {
    attempts++;

    // ---- 1. Deterministic cuts. No model, no network, cannot fail. ----
    const needsModel: Array<{ line: ScriptLineLike; item: AntithesisRewriteItem; kinds: string[] }> = [];
    for (const violation of report.violations) {
      everFlagged.add(violation.lineIndex);
      const line = lineByIndex.get(violation.lineIndex);
      if (!line || typeof line.text !== "string") continue;
      const kinds = violation.hits.map((hit) => hit.kind);
      const primary = violation.hits[0];
      const before = line.text;
      const cut = primary ? deterministicAntithesisFix(before, primary.kind) : null;
      if (cut && applyGuarded(line, cut, before)) {
        pass.linesFixedDeterministically++;
        pass.corrections.push({ lineIndex: line.lineIndex, round: pass.rounds + 1, kinds, before, after: line.text });
        continue;
      }
      needsModel.push({
        line,
        item: {
          lineIndex: line.lineIndex,
          speakerName: String(line.speakerName || "?"),
          text: before,
          span: primary?.span ?? before,
          kind: primary?.kind ?? "not_X_but_Y",
        },
        kinds,
      });
    }

    if (needsModel.length === 0) {
      report = analyzeAntithesis(collectLines(segments).map((entry) => entry.entry), options.policy);
      continue;
    }

    // ---- 2. What regex could not cut, the model rewrites. ----
    if (!options.rewriteAntithesis) break;

    let outcome: AntithesisRewriteOutcome;
    try {
      outcome = await options.rewriteAntithesis(needsModel.map((entry) => entry.item));
    } catch (error: unknown) {
      outcome = {
        rewrites: new Map(),
        hardFailure: true,
        failureMessage: error instanceof Error ? error.message : String(error),
      };
    }

    if (outcome.hardFailure && outcome.rewrites.size === 0) {
      // The call never ran. Do NOT spend a round on it.
      pass.rewriteUnavailable = true;
      pass.reasons.push(
        `Antithesis rewrite call failed and was retried (${outcome.failureMessage ?? "unknown error"}).`
      );
      continue;
    }

    pass.rounds++;
    for (const { line, kinds } of needsModel) {
      const rewrite = outcome.rewrites.get(line.lineIndex);
      if (!rewrite || typeof rewrite.text !== "string" || !rewrite.text.trim()) continue;
      const before = line.text;
      if (applyGuarded(line, rewrite.text, before)) {
        pass.corrections.push({ lineIndex: line.lineIndex, round: pass.rounds, kinds, before, after: line.text });
      }
    }
    report = analyzeAntithesis(collectLines(segments).map((entry) => entry.entry), options.policy);
  }

  for (const violation of report.violations) {
    everFlagged.add(violation.lineIndex);
    const line = lineByIndex.get(violation.lineIndex);
    if (line) line.needsHumanReview = true;
    pass.unresolved.push({
      lineIndex: violation.lineIndex,
      speakerName: violation.speakerName,
      text: violation.text,
      kinds: violation.hits.map((hit) => hit.kind),
      reason: violation.reason,
    });
  }

  const finalSummary = summarize(report);
  pass.totalHits = finalSummary.totalHits;
  pass.hitsPerHundredLines = finalSummary.hitsPerHundredLines;
  pass.byKind = report.byKind;
  pass.linesFlagged = everFlagged.size;
  pass.linesUnresolved = report.violations.length;
  pass.linesCorrected = everFlagged.size - report.violations.length;
  pass.reasons.push(
    `Antithesis: ${pass.before.totalHits} frame(s) at generation (${pass.before.hitsPerHundredLines} per 100 lines) -> ` +
    `${pass.totalHits} after ${pass.rounds} rewrite round(s) (${pass.hitsPerHundredLines} per 100 lines); ` +
    `${pass.linesCorrected}/${pass.linesFlagged} flagged line(s) fixed, ${pass.linesUnresolved} left for human review.`
  );

  pass.conversation = await repairConversation(segments, options);
  pass.reasons.push(...pass.conversation.reasons);

  // Conversation repair REWRITES dialogue, so it can hand back a line carrying
  // the very frame this pass exists to remove. It used to run after the final
  // count was taken, which meant a frame this stage introduced itself was never
  // counted and shipped silently. Re-check, cut what regex can cut, and let the
  // numbers reflect the script that actually leaves here.
  const postRepair = analyzeAntithesis(collectLines(segments).map((entry) => entry.entry), options.policy);
  if (postRepair.violations.length > 0) {
    for (const violation of postRepair.violations) {
      const line = lineByIndex.get(violation.lineIndex);
      if (!line || typeof line.text !== "string") continue;
      const primary = violation.hits[0];
      const before = line.text;
      const cut = primary ? deterministicAntithesisFix(before, primary.kind) : null;
      if (cut && applyGuarded(line, cut, before)) {
        pass.linesFixedDeterministically++;
        pass.corrections.push({
          lineIndex: line.lineIndex,
          round: pass.rounds,
          kinds: violation.hits.map((hit) => hit.kind),
          before,
          after: line.text,
        });
      }
    }
    const settled = analyzeAntithesis(collectLines(segments).map((entry) => entry.entry), options.policy);
    const reintroduced = settled.violations.filter(
      (violation) => !pass.unresolved.some((entry) => entry.lineIndex === violation.lineIndex)
    );
    for (const violation of reintroduced) {
      const line = lineByIndex.get(violation.lineIndex);
      if (line) line.needsHumanReview = true;
      pass.unresolved.push({
        lineIndex: violation.lineIndex,
        speakerName: violation.speakerName,
        text: violation.text,
        kinds: violation.hits.map((hit) => hit.kind),
        reason: `Introduced by conversation repair: ${violation.reason}`,
      });
    }
    const finalReport = summarize(settled);
    pass.totalHits = finalReport.totalHits;
    pass.hitsPerHundredLines = finalReport.hitsPerHundredLines;
    pass.byKind = settled.byKind;
    pass.linesUnresolved = settled.violations.length;
    if (reintroduced.length) {
      pass.reasons.push(
        `${reintroduced.length} frame(s) were reintroduced by conversation repair and re-checked here.`
      );
    }
  }

  return pass;
}
