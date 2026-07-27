// Targeted ROLE experiments. Run:
//
//   npm run test:role-experiments                        # all three, live
//   npm run test:role-experiments -- --experiment dialogue
//   npm run test:role-experiments -- --experiment outline
//   npm run test:role-experiments -- --experiment verification
//   npm run test:role-experiments -- --dry-run           # no API calls at all
//
// This is NOT "two arbitrary models across the whole pipeline". Each experiment
// isolates ONE role and gives every candidate byte-identical inputs, because a
// comparison whose inputs differ measures nothing.
//
// Candidates are instantiated DIRECTLY, bypassing the router, so a candidate's
// failure is recorded as that candidate's failure. Routing's fallback would
// quietly substitute another model and the table would then describe the wrong
// one. (This is also why paid fallback now defaults to forbidden — see
// routing.ts legacyFallbackAllowed.)
//
// HONESTY RULES BUILT IN:
//   - a candidate with no credential is reported SKIPPED, never as a low score;
//   - an incomplete or failed generation is reported as a FAILURE with its
//     error, never quietly retried into a win or dropped from the table;
//   - the deterministic scorer is used as-is and is never re-tuned here;
//   - the LLM judge is a separate column from the deterministic score, so a
//     disagreement between them is visible;
//   - no model may judge its own output.

import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
dotenv.config();

import { LLMProvider } from "../lib/providers/llm/interface";
import { instantiateProvider, providerCredentialPresent, resolveLegacyFamily } from "../lib/providers/llm/routing";
import {
  MODEL_IDS,
  modelCapabilities,
  shortVerificationLabel,
  verificationState,
} from "../lib/providers/llm/capabilities";
import { llmCostMark, llmCostSince } from "../lib/providers/llm/costLedger";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";
import { assessScriptQuality } from "../lib/services/scriptQualityJudge";
import { dedupeScriptSegments, normalizeLineIndexes, findRepetitions } from "../lib/services/scriptRepetition";
import { buildSemanticReviewPrompt, runSemanticReview } from "../lib/services/semanticReview";
import {
  FACT_CHECK_SCOPE_LINES,
  HOST_NAMES,
  OUT_OF_SCOPE_DEFECTS,
  PERSONA_PROMPT,
  SCOPE_BY_CATEGORY,
  SEEDED_LINES,
  type SeededLine,
  SITUATIONS,
  VERIFICATION_CATEGORIES,
  VERIFICATION_EVIDENCE,
  VERIFICATION_UNSAFE_CLAIMS,
  scopeOf,
} from "./roleExperimentFixtures";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY_RUN = argv.includes("--dry-run");
const WHICH = (flag("experiment") || "all").toLowerCase();
const ARTIFACT_DIR = path.join(process.cwd(), "artifacts");

let failures = 0;

// ---------------------------------------------------------------- candidates

interface Candidate {
  label: string;
  provider: string;
  model?: string;
}

const nv = (model: string): Candidate => ({ label: `nvidia/${model}`, provider: "nvidia", model });
const zaiFlash = (): Candidate => ({
  label: `zai/${MODEL_IDS.zai.glmFlash}`,
  provider: "zai",
  model: MODEL_IDS.zai.glmFlash,
});

/** The CURRENT model for a legacy family — the incumbent every candidate must beat. */
function incumbent(family: "script" | "verify"): Candidate {
  const cfg = resolveLegacyFamily(family);
  return {
    label: `${cfg.provider}/${cfg.model ?? "(provider default)"} [incumbent]`,
    provider: cfg.provider,
    model: cfg.model,
  };
}

const DIALOGUE_CANDIDATES = (): Candidate[] => [
  nv(MODEL_IDS.nvidia.mistral),
  zaiFlash(),
  incumbent("script"),
];

/**
 * Models excluded from the comparison because their ENDPOINT is unreachable, not
 * because their writing was judged. Reported separately and explicitly: listing
 * Kimi among the creative candidates with a zero score would libel a model that
 * never got to write a line.
 */
function unavailableCandidates(): { label: string; state: string; reason: string }[] {
  const out: { label: string; state: string; reason: string }[] = [];
  for (const model of Object.values(MODEL_IDS.nvidia)) {
    const caps = modelCapabilities("nvidia", model);
    if (caps.availability === "available") continue;
    out.push({
      label: `nvidia/${model}`,
      state: caps.availability,
      reason:
        caps.availability === "unavailable-for-account"
          ? "404 Not found for this account — the ID does not resolve for the credential in use"
          : "503 ResourceExhausted — the endpoint would not serve this account",
    });
  }
  return out;
}

const OUTLINE_CANDIDATES = (): Candidate[] => [
  nv(MODEL_IDS.nvidia.glm),
  nv(MODEL_IDS.nvidia.nemotron),
  zaiFlash(),
  incumbent("script"),
];

/** Print the unavailable set once per experiment, so it is never mistaken for a result. */
function reportUnavailable(): void {
  const unavailable = unavailableCandidates();
  if (unavailable.length === 0) return;
  console.log("\n  EXCLUDED — endpoint unreachable, NOT a quality judgement:");
  for (const u of unavailable) console.log(`    ${u.label.padEnd(44)} ${u.state}: ${u.reason}`);
}

const VERIFICATION_CANDIDATES = (): Candidate[] => [
  nv(MODEL_IDS.nvidia.deepseekPro),
  nv(MODEL_IDS.nvidia.nemotron),
  zaiFlash(),
  incumbent("verify"),
];

interface Resolved {
  candidate: Candidate;
  provider: LLMProvider | null;
  skipReason?: string;
}

function resolveCandidates(candidates: Candidate[]): Resolved[] {
  return candidates.map((candidate) => {
    if (DRY_RUN) return { candidate, provider: null, skipReason: "--dry-run" };
    if (candidate.provider === "stub") {
      return { candidate, provider: null, skipReason: "resolves to stub — nothing to measure" };
    }
    if (!providerCredentialPresent(candidate.provider)) {
      return { candidate, provider: null, skipReason: `no credential for ${candidate.provider}` };
    }
    try {
      return { candidate, provider: instantiateProvider(candidate.provider, candidate.model) };
    } catch (err: any) {
      return { candidate, provider: null, skipReason: err?.message || String(err) };
    }
  });
}

/** Verification state of a candidate's model, printed alongside every result. */
function verificationLabel(c: Candidate): string {
  if (!c.model) return "n/a";
  return shortVerificationLabel(verificationState(modelCapabilities(c.provider, c.model)));
}

// ---------------------------------------------------------------- reporting

function table(rows: Record<string, string | number>[], columns: string[]): void {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const line = (cells: (string | number)[]) =>
    cells.map((cell, i) => String(cell ?? "").padEnd(widths[i])).join("  ");
  console.log(line(columns));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(columns.map((c) => r[c] ?? "")));
}

function writeArtifact(name: string, data: unknown): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const p = path.join(ARTIFACT_DIR, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
  console.log(`\n  artifact: ${p}`);
}

/** Ledger delta for one candidate run: tokens, repairs, retries. */
function ledgerDelta(mark: number) {
  const { totals } = llmCostSince(mark);
  return {
    tkIn: totals.tkIn,
    tkOut: totals.tkOut,
    tkReasoning: totals.tkReasoning,
    calls: totals.calls,
    repairs: totals.repairs,
    retries: totals.retries,
    failures: totals.failures,
  };
}

// ---------------------------------------------------------------- dialogue

interface DialogueRun {
  situation: string;
  candidate: string;
  verification: string;
  status: string;
  error?: string;
  lines: number;
  words: number;
  validJson: boolean;
  repairs: number;
  retries: number;
  tkIn: number;
  tkOut: number;
  seconds: number;
  /** Wall time until the FIRST movement completed — the number that matters most
   *  for a slow model, because movements are sequential. */
  firstMovementSeconds?: number;
  perMovementSeconds?: number[];
  deterministic?: number;
  judgeOverall?: number;
  judgeAxes?: Record<string, number>;
  oneVoice?: boolean;
  repetitionPct?: number;
}

async function dialogueExperiment(): Promise<void> {
  console.log("\n=== DIALOGUE EXPERIMENT (role: script_movement) ===");
  console.log(
    "Three episode situations x every candidate. Identical outline, evidence, character prompt, continuity\n" +
      "state, previous-movement transcript, target duration, prompt, schema and 16,000-token allowance.\n"
  );

  reportUnavailable();
  const resolved = resolveCandidates(DIALOGUE_CANDIDATES());
  // One outline model for ALL candidates, so the dialogue comparison is not
  // contaminated by different episode plans.
  const outlineHost = resolved.find((r) => r.provider);
  // The judge is a model that is NOT a dialogue candidate wherever possible.
  const judgeResolved = resolveCandidates([nv(MODEL_IDS.nvidia.nemotron)])[0];

  const runs: DialogueRun[] = [];
  const artifacts: unknown[] = [];

  for (const situation of SITUATIONS) {
    console.log(`\n--- ${situation.label} ---`);
    console.log(`    testing: ${situation.tests}`);
    for (const r of resolved) {
      if (!r.provider) {
        runs.push({
          situation: situation.key,
          candidate: r.candidate.label,
          verification: verificationLabel(r.candidate),
          status: `SKIPPED (${r.skipReason})`,
          lines: 0,
          words: 0,
          validJson: false,
          repairs: 0,
          retries: 0,
          tkIn: 0,
          tkOut: 0,
          seconds: 0,
        });
        continue;
      }

      const mark = llmCostMark();
      const startedAt = Date.now();
      const movementTimings: { first?: number; each: number[] } = { each: [] };
      try {
        const out = await generateOutlineDrivenScript(r.provider, {
          systemPrompt: `${PERSONA_PROMPT}\n\n=== CARRIED-IN STATE ===\n${situation.continuityState}\n\n=== PREVIOUS MOVEMENT ===\n${situation.previousMovement}`,
          episodeTitle: situation.episodeTitle,
          topicsPrompts: situation.topicsPrompts,
          targetDuration: situation.targetDuration,
          version: 1,
          temperature: 0.85,
          // The production allowance, unchanged. A candidate that cannot honor it
          // is a finding, not something to work around.
          maxTokens: 16000,
          speakerNames: HOST_NAMES,
          outlineLlm: outlineHost?.provider ?? r.provider,
          onMovementComplete: (info) => {
            if (info.movement === 1) movementTimings.first = info.msSinceStart;
            movementTimings.each.push(info.msForMovement);
          },
          log: () => {},
        });
        const { segments } = dedupeScriptSegments(out.segments);
        normalizeLineIndexes(segments);
        const texts: string[] = [];
        for (const seg of segments) for (const l of seg.lines || []) texts.push(String(l.text || ""));
        const rep = findRepetitions(texts);
        const assessed = await assessScriptQuality(
          judgeResolved.provider && judgeResolved.provider !== r.provider ? judgeResolved.provider : null,
          segments,
          {
            episodeTitle: situation.episodeTitle,
            hostNames: HOST_NAMES,
            evidenceSummary: situation.topicsPrompts,
          }
        );
        const delta = ledgerDelta(mark);
        runs.push({
          situation: situation.key,
          candidate: r.candidate.label,
          verification: verificationLabel(r.candidate),
          status: "ok",
          lines: assessed.lineCount,
          words: assessed.wordCount,
          validJson: true,
          repairs: delta.repairs,
          retries: delta.retries,
          tkIn: delta.tkIn,
          tkOut: delta.tkOut,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          firstMovementSeconds:
            movementTimings.first !== undefined ? Math.round(movementTimings.first / 1000) : undefined,
          perMovementSeconds: movementTimings.each.map((ms) => Math.round(ms / 1000)),
          deterministic: assessed.deterministic.total,
          judgeOverall: assessed.judge?.overall,
          judgeAxes: assessed.judge?.axes,
          oneVoice: assessed.judge?.bothHostsSoundLikeOneModel,
          repetitionPct: Number((rep.repetitionRatio * 100).toFixed(1)),
        });
        artifacts.push({
          situation: situation.key,
          candidate: r.candidate.label,
          // Representative excerpts sit at the TOP of each artifact entry: the
          // point of a dialogue comparison is that a human reads the dialogue.
          excerpts: assessed.excerpts,
          judgeStrengths: assessed.judge?.strengths,
          judgeWeaknesses: assessed.judge?.weaknesses,
          judgeEvidenceQuotes: assessed.judge?.evidenceQuotes,
          perMovementSeconds: movementTimings.each.map((ms) => Math.round(ms / 1000)),
          segments,
          assessment: assessed,
        });
        console.log(
          `    ${r.candidate.label}: ${assessed.lineCount} lines, det ${assessed.deterministic.total}/100, ` +
            `first movement ${movementTimings.first !== undefined ? Math.round(movementTimings.first / 1000) : "?"}s, ` +
            `total ${Math.round((Date.now() - startedAt) / 1000)}s`
        );
        for (const line of assessed.excerpts.slice(0, 4)) console.log(`        | ${line.slice(0, 150)}`);
      } catch (err: any) {
        failures++;
        const delta = ledgerDelta(mark);
        runs.push({
          situation: situation.key,
          candidate: r.candidate.label,
          verification: verificationLabel(r.candidate),
          status: "FAILED",
          error: (err?.message || String(err)).slice(0, 300),
          lines: 0,
          words: 0,
          validJson: false,
          repairs: delta.repairs,
          retries: delta.retries,
          tkIn: delta.tkIn,
          tkOut: delta.tkOut,
          seconds: Math.round((Date.now() - startedAt) / 1000),
        });
        artifacts.push({ situation: situation.key, candidate: r.candidate.label, error: err?.message || String(err) });
        console.log(`    ${r.candidate.label}: FAILED — ${(err?.message || "").slice(0, 120)}`);
      }
    }
  }

  // Per-candidate rollup across all three situations: completion and valid-JSON
  // rates only mean something across a set.
  const byCandidate = new Map<string, DialogueRun[]>();
  for (const run of runs) {
    if (!byCandidate.has(run.candidate)) byCandidate.set(run.candidate, []);
    byCandidate.get(run.candidate)!.push(run);
  }
  const rollup = [...byCandidate.entries()].map(([candidate, rs]) => {
    const attempted = rs.filter((r) => !r.status.startsWith("SKIPPED"));
    const ok = rs.filter((r) => r.status === "ok");
    const judged = ok.filter((r) => typeof r.judgeOverall === "number");
    const avg = (pick: (r: DialogueRun) => number | undefined) => {
      const vals = ok.map(pick).filter((v): v is number => typeof v === "number");
      return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : "—";
    };
    const axis = (name: string) => {
      const vals = judged.map((r) => r.judgeAxes?.[name]).filter((v): v is number => typeof v === "number");
      return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(1) : "—";
    };
    return {
      candidate,
      verify: rs[0].verification,
      completion: attempted.length ? `${ok.length}/${attempted.length}` : "0/0 (skipped)",
      validJson: attempted.length ? `${ok.filter((r) => r.validJson).length}/${attempted.length}` : "—",
      repairs: rs.reduce((s, r) => s + r.repairs, 0),
      det: avg((r) => r.deterministic),
      judge: avg((r) => r.judgeOverall),
      distinct: axis("hostDistinctness"),
      causal: axis("conversationalCausality"),
      filler: axis("genericFiller"),
      mech: axis("mechanicalAlternation"),
      repeat: axis("repetition"),
      character: axis("characterConsistency"),
      grounding: axis("evidenceGrounding"),
      continuity: axis("movementContinuity"),
      natural: axis("spokenNaturalness"),
      oneVoice: judged.length ? `${judged.filter((r) => r.oneVoice).length}/${judged.length}` : "—",
      firstMv: avg((r) => r.firstMovementSeconds),
      secs: avg((r) => r.seconds),
      tkOut: rs.reduce((s, r) => s + r.tkOut, 0),
    };
  });

  console.log("\nPer-candidate rollup across all three situations (judge axes 0-10, higher is better):");
  table(rollup, [
    "candidate", "verify", "completion", "validJson", "repairs", "det", "judge",
    "distinct", "causal", "filler", "mech", "repeat", "character", "grounding",
    "continuity", "natural", "oneVoice", "firstMv", "secs", "tkOut",
  ]);
  console.log(
    "\n  firstMv = seconds to the FIRST completed movement; secs = the full three-movement episode.\n" +
      "  Movements are SEQUENTIAL, so a slow model multiplies — judge latency on firstMv x3, not on one prompt."
  );

  console.log("\nPer-situation detail:");
  table(
    runs.map((r) => ({
      situation: r.situation,
      candidate: r.candidate,
      status: r.status + (r.error ? `: ${r.error.slice(0, 60)}` : ""),
      lines: r.lines,
      words: r.words,
      rep: r.repetitionPct !== undefined ? `${r.repetitionPct}%` : "—",
      det: r.deterministic ?? "—",
      judge: r.judgeOverall ?? "—",
      secs: r.seconds,
    })),
    ["situation", "candidate", "status", "lines", "words", "rep", "det", "judge", "secs"]
  );

  writeArtifact("role-experiment-dialogue.json", { experiment: "dialogue", runs, rollup, artifacts });
}

// ---------------------------------------------------------------- outline

async function outlineExperiment(): Promise<void> {
  console.log("\n=== OUTLINE EXPERIMENT (role: script_outline) ===");
  console.log("Same evidence and episode requirements for every candidate; 7,000-token outline allowance.\n");

  reportUnavailable();
  const resolved = resolveCandidates(OUTLINE_CANDIDATES());
  const rows: Record<string, string | number>[] = [];
  const artifacts: unknown[] = [];
  const situation = SITUATIONS[0];

  const OUTLINE_PROMPT = `You are showrunning episode "${situation.episodeTitle}" (roughly ${situation.targetDuration} minutes).

TOPICS & EVIDENCE:
${situation.topicsPrompts}

Build a SMALL story spine, not a rundown checklist. Use 6 to 8 beats. Beat 1 is a cold open already in motion; the final beat is a closing payoff. Organize around ONE unresolved central question. Every beat must change something. Plan at least one genuine position shift. Assign each evidence fact to at most one beat. A callback note is allowed only when a concrete earlier phrase could naturally return.

Return valid JSON only:
{ "beats": [ { "beatIndex": 0, "segmentType": "cold_open|intro|topic|transition|closing", "title": "...", "goal": "what changes", "angle": "specific pressure/question", "factRefs": [{"type":"newsItem","id":"news-1"}], "escalation": "...", "callback": "optional concrete phrase" } ] }`;

  for (const r of resolved) {
    if (!r.provider) {
      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: `SKIPPED (${r.skipReason})`,
        beats: "—", movements: "—", facts: "—", dupFacts: "—", shifts: "—",
        escalation: "—", callbacks: "—", coldOpen: "—", payoff: "—", repairs: "—", secs: "—",
      });
      continue;
    }
    const mark = llmCostMark();
    const startedAt = Date.now();
    try {
      const res = await r.provider.generateStructuredOutput<any>({
        prompt: OUTLINE_PROMPT,
        systemPrompt: PERSONA_PROMPT,
        temperature: 0.7,
        maxTokens: 7000,
        reasoning: "on",
        validate: (v) =>
          Array.isArray((v as { beats?: unknown })?.beats) ? null : "Outline is missing the required 'beats' array.",
      });
      const beats: any[] = Array.isArray(res?.beats) ? res.beats : [];
      const refKeys = beats.flatMap((b) =>
        (Array.isArray(b?.factRefs) ? b.factRefs : []).map((f: any) => `${f?.type}:${f?.id}`)
      );
      // Structural measures only — no rubric invented to favor any candidate.
      const dupFacts = refKeys.length - new Set(refKeys).size;
      const shifts = beats.filter((b) => /shift|change|concede|admit|reverse|gives? up|backs? down/i.test(`${b?.goal} ${b?.escalation}`)).length;
      const escalations = beats.filter((b) => typeof b?.escalation === "string" && b.escalation.trim().length > 8).length;
      const callbacks = beats.filter((b) => typeof b?.callback === "string" && b.callback.trim().length > 3).length;
      // Three-movement architecture: the engine splits the spine into three, so a
      // spine that cannot be split into three non-empty parts is a structural miss.
      const movements = beats.length >= 4 ? 3 : 1;
      const delta = ledgerDelta(mark);
      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: beats.length >= 5 ? "ok" : `INCOMPLETE (${beats.length} beats, 5 required)`,
        beats: beats.length,
        movements,
        facts: new Set(refKeys).size,
        dupFacts,
        shifts,
        escalation: escalations,
        callbacks,
        coldOpen: beats[0]?.segmentType === "cold_open" ? "yes" : "no",
        payoff: beats[beats.length - 1]?.segmentType === "closing" ? "yes" : "no",
        repairs: delta.repairs,
        secs: Math.round((Date.now() - startedAt) / 1000),
      });
      if (beats.length < 5) failures++;
      artifacts.push({ candidate: r.candidate.label, beats });
    } catch (err: any) {
      failures++;
      const delta = ledgerDelta(mark);
      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: `FAILED: ${(err?.message || String(err)).slice(0, 80)}`,
        beats: 0, movements: 0, facts: "—", dupFacts: "—", shifts: "—",
        escalation: "—", callbacks: "—", coldOpen: "—", payoff: "—",
        repairs: delta.repairs,
        secs: Math.round((Date.now() - startedAt) / 1000),
      });
      artifacts.push({ candidate: r.candidate.label, error: err?.message || String(err) });
    }
  }

  table(rows, [
    "candidate", "verify", "status", "beats", "movements", "facts", "dupFacts",
    "shifts", "escalation", "callbacks", "coldOpen", "payoff", "repairs", "secs",
  ]);
  console.log("\n  dupFacts = the same evidence ref assigned to more than one beat (repetition risk).");
  writeArtifact("role-experiment-outline.json", { experiment: "outline", rows, artifacts });
}

// ---------------------------------------------------------------- verification

/**
 * Top-level fields the reviewer's own schema declares required. Read off
 * buildSemanticReviewPrompt so this can never drift from the production
 * contract — a schema verdict computed from a stale hand-copied list would be
 * exactly the kind of invented metric this experiment is being fixed to remove.
 */
function requiredTopLevelFields(): string[] {
  const { jsonSchema } = buildSemanticReviewPrompt({
    reviewLines: [],
    evidencePanelItems: [],
    unsafeClaims: [],
    rumorKeywords: [],
  });
  return Array.isArray(jsonSchema?.required) ? (jsonSchema.required as string[]) : [];
}

async function verificationExperiment(): Promise<void> {
  console.log("\n=== VERIFICATION EXPERIMENT (roles: script_verification / fact_check) ===");

  // SCOPED GROUND TRUTH. The reviewer under test is the semantic FACT-CHECK
  // reviewer, and its prompt forbids it from flagging non-factual lines and
  // tells it to omit supported ones. It is therefore scored ONLY on defects
  // its production contract makes it responsible for. Defects owned by the
  // repetition checker and by character/continuity validation stay visible in
  // the read-out, reported as not_applicable — never as false negatives.
  const inScope = FACT_CHECK_SCOPE_LINES;
  const mustFlag = inScope.filter((l) => l.shouldFlag);
  const mustNotFlag = inScope.filter((l) => !l.shouldFlag);
  const requiredFields = requiredTopLevelFields();

  console.log(
    `Seeded set: ${SEEDED_LINES.length} lines across ${VERIFICATION_CATEGORIES.length} labelled categories.\n` +
      `In scope for the fact-check contract: ${inScope.length} lines — ${mustFlag.length} genuinely defective, ` +
      `${mustNotFlag.length} legitimate.\n` +
      `Out of scope (other pipeline stages own these, scored not_applicable): ` +
      `${OUT_OF_SCOPE_DEFECTS.map((l) => `line ${l.lineIndex} [${l.category}] → ${scopeOf(l)}`).join(", ")}\n` +
      `False positives are weighted heavily in the read-out: an overactive verifier rewrites valid dialogue.\n`
  );

  reportUnavailable();
  const resolved = resolveCandidates(VERIFICATION_CANDIDATES());
  const rows: Record<string, string | number>[] = [];
  const artifacts: unknown[] = [];

  for (const r of resolved) {
    if (!r.provider) {
      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: `SKIPPED (${r.skipReason})`,
        validResponseSchema: "—", requiredTopLevelFieldsPresent: "—", returnedFindings: "—",
        caught: "—", missed: "—", notApplicable: OUT_OF_SCOPE_DEFECTS.length, falsePos: "—",
        precision: "—", recall: "—", falsePositiveRate: "—", falseNegativeRate: "—", secs: "—",
      });
      continue;
    }
    const mark = llmCostMark();
    const startedAt = Date.now();
    try {
      const result = await runSemanticReview(r.provider, {
        reviewLines: SEEDED_LINES.map((l) => ({
          lineIndex: l.lineIndex,
          speakerName: l.speakerName,
          text: l.text,
          isFactualClaim: l.isFactualClaim,
          tone: l.tone,
          isInterruption: l.isInterruption === true,
          isFragment: false,
        })),
        evidencePanelItems: VERIFICATION_EVIDENCE,
        unsafeClaims: VERIFICATION_UNSAFE_CLAIMS,
        rumorKeywords: ["sources tell me", "sources say", "i'm hearing"],
      });

      const findings = Array.isArray(result?.lineResults) ? result.lineResults : [];
      const flagged = new Set<number>();
      for (const lr of findings) {
        if (lr?.status === "unsupported" || lr?.status === "needs_review") flagged.add(Number(lr.lineIndex));
      }

      // Scored ONLY over the fact-check contract's own lines.
      const truePos = mustFlag.filter((l) => flagged.has(l.lineIndex));
      const falseNeg = mustFlag.filter((l) => !flagged.has(l.lineIndex));
      const falsePos = mustNotFlag.filter((l) => flagged.has(l.lineIndex));
      const precision = truePos.length + falsePos.length > 0 ? truePos.length / (truePos.length + falsePos.length) : 0;
      const recall = mustFlag.length > 0 ? truePos.length / mustFlag.length : 0;
      const fpRate = mustNotFlag.length > 0 ? falsePos.length / mustNotFlag.length : 0;
      const fnRate = mustFlag.length > 0 ? falseNeg.length / mustFlag.length : 0;

      // Out-of-scope defects: recorded, never counted against the reviewer.
      // Whether it happened to flag one is informational only.
      const notApplicable = OUT_OF_SCOPE_DEFECTS.map((l) => ({
        line: l.lineIndex,
        category: l.category,
        ownedBy: scopeOf(l),
        result: "not_applicable" as const,
        incidentallyFlagged: flagged.has(l.lineIndex),
        note: l.note,
      }));

      // SCHEMA CONFORMANCE — replaces the old "schema" column, which measured
      // what fraction of all 14 seeded lines came back and so scored a
      // perfectly-obedient reviewer at ~36%. The production prompt tells the
      // model to return flagged lines ONLY and omit supported ones, so an
      // omitted line is compliance, not a schema defect. What actually matters
      // is whether the envelope parsed and carried its required fields.
      const validResponseSchema =
        result != null && typeof result === "object" && Array.isArray(result.lineResults);
      const missingFields = requiredFields.filter(
        (f) => !(result != null && typeof result === "object" && f in result)
      );
      const delta = ledgerDelta(mark);

      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: "ok",
        validResponseSchema: validResponseSchema ? "yes" : "no",
        requiredTopLevelFieldsPresent: `${requiredFields.length - missingFields.length}/${requiredFields.length}`,
        returnedFindings: findings.length,
        caught: `${truePos.length}/${mustFlag.length}`,
        missed: falseNeg.length,
        notApplicable: notApplicable.length,
        falsePos: falsePos.length,
        precision: `${(precision * 100).toFixed(0)}%`,
        recall: `${(recall * 100).toFixed(0)}%`,
        falsePositiveRate: `${(fpRate * 100).toFixed(0)}%`,
        falseNegativeRate: `${(fnRate * 100).toFixed(0)}%`,
        secs: Math.round((Date.now() - startedAt) / 1000),
      });
      artifacts.push({
        candidate: r.candidate.label,
        repairs: delta.repairs,
        scoredScope: "fact_check",
        validResponseSchema,
        missingTopLevelFields: missingFields,
        returnedFindings: findings.length,
        missed: falseNeg.map((l) => ({ line: l.lineIndex, category: l.category, note: l.note })),
        falsePositives: falsePos.map((l) => ({ line: l.lineIndex, category: l.category, note: l.note })),
        notApplicable,
        byCategory: VERIFICATION_CATEGORIES.map((cat) => {
          const lines = SEEDED_LINES.filter((l) => l.category === cat);
          const scope = SCOPE_BY_CATEGORY[cat as SeededLine["category"]];
          if (scope !== "fact_check") {
            return { category: cat, scope, result: "not_applicable", total: lines.length };
          }
          const correct = lines.filter((l) => flagged.has(l.lineIndex) === l.shouldFlag).length;
          return { category: cat, scope, correct, total: lines.length };
        }),
        raw: result,
      });
    } catch (err: any) {
      failures++;
      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: `FAILED: ${(err?.message || String(err)).slice(0, 80)}`,
        validResponseSchema: "no", requiredTopLevelFieldsPresent: "—", returnedFindings: "—",
        caught: "—", missed: "—", notApplicable: OUT_OF_SCOPE_DEFECTS.length, falsePos: "—",
        precision: "—", recall: "—", falsePositiveRate: "—", falseNegativeRate: "—",
        secs: Math.round((Date.now() - startedAt) / 1000),
      });
      artifacts.push({ candidate: r.candidate.label, error: err?.message || String(err) });
    }
  }

  table(rows, [
    "candidate", "verify", "status",
    "validResponseSchema", "requiredTopLevelFieldsPresent", "returnedFindings",
    "caught", "missed", "notApplicable", "falsePos",
    "precision", "recall", "falsePositiveRate", "falseNegativeRate", "secs",
  ]);

  console.log("\n  Ground truth — IN SCOPE (fact_check), must be flagged:");
  for (const l of mustFlag) console.log(`    line ${String(l.lineIndex).padStart(2)} [${l.category}] ${l.note}`);
  console.log("  Ground truth — IN SCOPE (fact_check), must NOT be flagged:");
  for (const l of mustNotFlag) console.log(`    line ${String(l.lineIndex).padStart(2)} [${l.category}] ${l.note}`);
  console.log("  OUT OF SCOPE — real defects owned by another stage, scored not_applicable:");
  for (const l of OUT_OF_SCOPE_DEFECTS) {
    console.log(`    line ${String(l.lineIndex).padStart(2)} [${l.category}] owned by ${scopeOf(l)} — ${l.note}`);
  }

  writeArtifact("role-experiment-verification.json", {
    experiment: "verification",
    scoredScope: "fact_check",
    scopeByCategory: SCOPE_BY_CATEGORY,
    categories: VERIFICATION_CATEGORIES,
    inScopeMustFlag: mustFlag.map((l) => ({ line: l.lineIndex, category: l.category })),
    inScopeMustNotFlag: mustNotFlag.map((l) => ({ line: l.lineIndex, category: l.category })),
    outOfScope: OUT_OF_SCOPE_DEFECTS.map((l) => ({
      line: l.lineIndex,
      category: l.category,
      ownedBy: scopeOf(l),
      result: "not_applicable",
    })),
    rows,
    artifacts,
    groundTruth: SEEDED_LINES.map((l) => ({ ...l, scope: scopeOf(l) })),
  });
}

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log("Role experiments — one role at a time, identical inputs per candidate.");
  if (DRY_RUN) {
    console.log("\n--dry-run: no API calls. Every candidate is reported SKIPPED. This verifies harness wiring only.");
  }

  if (WHICH === "all" || WHICH === "dialogue") await dialogueExperiment();
  if (WHICH === "all" || WHICH === "outline") await outlineExperiment();
  if (WHICH === "all" || WHICH === "verification") await verificationExperiment();

  console.log(
    `\n${failures} candidate run(s) failed or came back incomplete. ` +
      `A failure here is a RESULT — it means that model could not do this role's job on this application's real work.`
  );
  console.log(
    "\nPROMOTION RULE — a model may retain or take a primary role ONLY if it:\n" +
      "  1. accepts the real request contract (see `npm run probe:llm-contract`),\n" +
      "  2. reliably completes the required JSON,\n" +
      "  3. accepts the required output allowance,\n" +
      "  4. meets or exceeds the incumbent on role-specific quality,\n" +
      "  5. does not introduce unacceptable latency,\n" +
      "  6. does not require frequent repair,\n" +
      "  7. does not trigger frequent fallback,\n" +
      "  8. does not materially damage character voice or factual accuracy.\n" +
      "A model that fails these stays INTEGRATED as an optional candidate but must not remain the default\n" +
      "primary merely because the original specification named it. Document any change in profiles.ts with\n" +
      "the evidence that justified it."
  );
}

main().catch((err) => {
  console.error("Role experiments failed to run:", err);
  process.exit(1);
});
