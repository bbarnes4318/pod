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
import { MODEL_IDS, modelCapabilities, verificationState } from "../lib/providers/llm/capabilities";
import { llmCostMark, llmCostSince } from "../lib/providers/llm/costLedger";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";
import { assessScriptQuality } from "../lib/services/scriptQualityJudge";
import { dedupeScriptSegments, normalizeLineIndexes, findRepetitions } from "../lib/services/scriptRepetition";
import { runSemanticReview } from "../lib/services/semanticReview";
import {
  HOST_NAMES,
  PERSONA_PROMPT,
  SEEDED_LINES,
  SITUATIONS,
  VERIFICATION_CATEGORIES,
  VERIFICATION_EVIDENCE,
  VERIFICATION_UNSAFE_CLAIMS,
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
  nv(MODEL_IDS.nvidia.kimi),
  zaiFlash(),
  incumbent("script"),
];

const OUTLINE_CANDIDATES = (): Candidate[] => [
  nv(MODEL_IDS.nvidia.glm),
  nv(MODEL_IDS.nvidia.nemotron),
  zaiFlash(),
  incumbent("script"),
];

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
  const state = verificationState(modelCapabilities(c.provider, c.model));
  return state === "live-contract-verified"
    ? "live-verified"
    : state === "catalog-verified-live-untested"
    ? "catalog-only"
    : "unconfirmed";
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
          deterministic: assessed.deterministic.total,
          judgeOverall: assessed.judge?.overall,
          judgeAxes: assessed.judge?.axes,
          oneVoice: assessed.judge?.bothHostsSoundLikeOneModel,
          repetitionPct: Number((rep.repetitionRatio * 100).toFixed(1)),
        });
        artifacts.push({ situation: situation.key, candidate: r.candidate.label, segments, assessment: assessed });
        console.log(`    ${r.candidate.label}: ${assessed.lineCount} lines, det ${assessed.deterministic.total}/100`);
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
      secs: avg((r) => r.seconds),
      tkOut: rs.reduce((s, r) => s + r.tkOut, 0),
    };
  });

  console.log("\nPer-candidate rollup across all three situations (judge axes 0-10, higher is better):");
  table(rollup, [
    "candidate", "verify", "completion", "validJson", "repairs", "det", "judge",
    "distinct", "causal", "filler", "mech", "repeat", "character", "grounding",
    "continuity", "natural", "oneVoice", "secs", "tkOut",
  ]);

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

async function verificationExperiment(): Promise<void> {
  console.log("\n=== VERIFICATION EXPERIMENT (roles: script_verification / fact_check) ===");
  const mustFlag = SEEDED_LINES.filter((l) => l.shouldFlag);
  const mustNotFlag = SEEDED_LINES.filter((l) => !l.shouldFlag);
  console.log(
    `Seeded set: ${SEEDED_LINES.length} lines across ${VERIFICATION_CATEGORIES.length} labelled categories — ` +
      `${mustFlag.length} genuinely defective, ${mustNotFlag.length} legitimate.\n` +
      `False positives are weighted heavily in the read-out: an overactive verifier rewrites valid dialogue.\n`
  );

  const resolved = resolveCandidates(VERIFICATION_CANDIDATES());
  const rows: Record<string, string | number>[] = [];
  const artifacts: unknown[] = [];

  for (const r of resolved) {
    if (!r.provider) {
      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: `SKIPPED (${r.skipReason})`,
        schema: "—", caught: "—", missed: "—", falsePos: "—",
        precision: "—", recall: "—", fpRate: "—", fnRate: "—", secs: "—",
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

      const flagged = new Set<number>();
      for (const lr of Array.isArray(result?.lineResults) ? result.lineResults : []) {
        if (lr?.status === "unsupported" || lr?.status === "needs_review") flagged.add(Number(lr.lineIndex));
      }
      const truePos = mustFlag.filter((l) => flagged.has(l.lineIndex));
      const falseNeg = mustFlag.filter((l) => !flagged.has(l.lineIndex));
      const falsePos = mustNotFlag.filter((l) => flagged.has(l.lineIndex));
      const precision = truePos.length + falsePos.length > 0 ? truePos.length / (truePos.length + falsePos.length) : 0;
      const recall = truePos.length / mustFlag.length;
      const fpRate = falsePos.length / mustNotFlag.length;
      const fnRate = falseNeg.length / mustFlag.length;
      // Schema completion: did every line come back with an auditable verdict?
      const returned = new Set(
        (Array.isArray(result?.lineResults) ? result.lineResults : []).map((lr: any) => Number(lr?.lineIndex))
      );
      const schemaPct = Math.round((SEEDED_LINES.filter((l) => returned.has(l.lineIndex)).length / SEEDED_LINES.length) * 100);
      const delta = ledgerDelta(mark);

      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: "ok",
        schema: `${schemaPct}%`,
        caught: truePos.length,
        missed: falseNeg.length,
        falsePos: falsePos.length,
        precision: `${(precision * 100).toFixed(0)}%`,
        recall: `${(recall * 100).toFixed(0)}%`,
        fpRate: `${(fpRate * 100).toFixed(0)}%`,
        fnRate: `${(fnRate * 100).toFixed(0)}%`,
        secs: Math.round((Date.now() - startedAt) / 1000),
      });
      artifacts.push({
        candidate: r.candidate.label,
        repairs: delta.repairs,
        missed: falseNeg.map((l) => ({ line: l.lineIndex, category: l.category, note: l.note })),
        falsePositives: falsePos.map((l) => ({ line: l.lineIndex, category: l.category, note: l.note })),
        byCategory: VERIFICATION_CATEGORIES.map((cat) => {
          const lines = SEEDED_LINES.filter((l) => l.category === cat);
          const correct = lines.filter((l) => flagged.has(l.lineIndex) === l.shouldFlag).length;
          return { category: cat, correct, total: lines.length };
        }),
        raw: result,
      });
    } catch (err: any) {
      failures++;
      rows.push({
        candidate: r.candidate.label,
        verify: verificationLabel(r.candidate),
        status: `FAILED: ${(err?.message || String(err)).slice(0, 80)}`,
        schema: "0%", caught: 0, missed: "—", falsePos: "—",
        precision: "—", recall: "—", fpRate: "—", fnRate: "—",
        secs: Math.round((Date.now() - startedAt) / 1000),
      });
      artifacts.push({ candidate: r.candidate.label, error: err?.message || String(err) });
    }
  }

  table(rows, [
    "candidate", "verify", "status", "schema", "caught", "missed", "falsePos",
    "precision", "recall", "fpRate", "fnRate", "secs",
  ]);

  console.log("\n  Ground truth — must be flagged:");
  for (const l of mustFlag) console.log(`    line ${String(l.lineIndex).padStart(2)} [${l.category}] ${l.note}`);
  console.log("  Ground truth — must NOT be flagged:");
  for (const l of mustNotFlag) console.log(`    line ${String(l.lineIndex).padStart(2)} [${l.category}] ${l.note}`);

  writeArtifact("role-experiment-verification.json", {
    experiment: "verification",
    categories: VERIFICATION_CATEGORIES,
    rows,
    artifacts,
    groundTruth: SEEDED_LINES,
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
