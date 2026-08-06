// BLIND MODEL EVALUATION — the runner.
//
//   npm run eval:models -- --dry-run          protocol only, no API calls
//   npm run eval:models                       live, every configured candidate
//   npm run eval:models -- --candidates nvidia/nemotron-3-ultra,zai/glm-4.7-flash
//   npm run eval:models -- --role script_host_a_writer
//   npm run eval:models -- --decide           read STORED runs, print the verdict
//
// The rules this obeys are in modelEvaluation.ts. What lives here is the part
// that touches the world: instantiating candidates, writing the same fixed
// fixtures at each of them, measuring, and storing the record.
//
// FOUR HONESTY PROPERTIES, all of them structural rather than promised:
//
//   IDENTICAL INPUTS   every candidate writes the SAME checked-in fixtures. Live
//                      material would hand each candidate different source
//                      facts, and a comparison across different inputs measures
//                      the inputs.
//   NO ROUTER          candidates are instantiated directly, so a candidate's
//                      failure is recorded as that candidate's failure. Routing
//                      would substitute a fallback and the table would then
//                      describe a model that was never on trial.
//   BLIND JUDGING      scripts reach the judge as "Candidate A/B/C" with every
//                      provider and model token scrubbed from the text.
//   FAILURE IS A RESULT a candidate that errors gets a row saying so, never a
//                      zero and never a silent omission.
//
// Nothing here promotes anything. `--decide` prints what the stored evidence
// supports; changing a route is still a human editing a variable.

import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
dotenv.config();

import type { LLMProvider } from "../lib/providers/llm/interface";
import { instantiateProvider, providerCredentialPresent, resolveRolePlan, candidateKey } from "../lib/providers/llm/routing";
import { llmCostMark, llmCostSince } from "../lib/providers/llm/costLedger";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";
import { findRepetitions } from "../lib/services/scriptRepetition";
import { stripAudioTags } from "../lib/audio/speechText";
import {
  DIMENSIONS,
  JUDGED_DIMENSIONS,
  assignBlindLabels,
  decidePromotion,
  fixtureDigest,
  renderSummaryTable,
  scrubCandidateIdentity,
  summarizeRun,
  type CandidateFixtureResult,
  type EvaluationDimension,
  type EvaluationRun,
} from "../lib/services/modelEvaluation";
import { HOST_NAMES, PERSONA_PROMPT, SITUATIONS } from "./roleExperimentFixtures";
import type { LLMRole } from "../lib/providers/llm/roles";

const OUT_DIR = path.resolve(process.cwd(), process.env.MODEL_EVAL_DIR || "artifacts/model-evaluation");

// ---------------------------------------------------------------- flattening

interface FlatLine {
  speakerName: string;
  text: string;
  isFactualClaim: boolean;
  evidenceRefs: string[];
}

function flatten(segments: any[]): FlatLine[] {
  const out: FlatLine[] = [];
  for (const segment of segments || []) {
    for (const line of segment?.lines || []) {
      out.push({
        speakerName: String(line?.speakerName || ""),
        text: stripAudioTags(String(line?.text || "")),
        isFactualClaim: Boolean(line?.isFactualClaim),
        evidenceRefs: Array.isArray(line?.evidenceRefs) ? line.evidenceRefs.map(String) : [],
      });
    }
  }
  return out;
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------- deterministic

/**
 * HOST DISTINCTNESS — Jaccard distance between the two hosts' vocabularies.
 *
 * The same measure `episodeQualityService` already uses in production, kept
 * identical on purpose: a harness that scores distinctness differently from the
 * gate would promote a model the gate then rejects.
 */
function scoreHostDistinctness(lines: FlatLine[], hosts: string[]): number {
  const sets = hosts.map(
    (host) =>
      new Set(
        lines
          .filter((l) => l.speakerName === host)
          .flatMap((l) => words(l.text).filter((w) => w.length > 3))
      )
  );
  if (sets.length < 2 || !sets[0].size || !sets[1].size) return 0;
  let intersection = 0;
  for (const w of sets[0]) if (sets[1].has(w)) intersection++;
  const union = sets[0].size + sets[1].size - intersection;
  return union ? Math.round((1 - intersection / union) * 100) : 0;
}

/**
 * FACTUAL SUPPORT — what share of factual claims carry an evidence reference
 * that actually appears in the fixture's evidence.
 *
 * The second half is the point. Counting `evidenceRefs.length > 0` rewards a
 * model that invents a citation, which is the failure mode that damages a
 * script most and the one a fluent model is best at hiding.
 */
function scoreFactualSupport(lines: FlatLine[], evidence: string): number {
  const claims = lines.filter((l) => l.isFactualClaim);
  if (!claims.length) return 0;
  const haystack = evidence.toLowerCase();
  const supported = claims.filter((l) =>
    l.evidenceRefs.some((ref) => ref.trim().length > 0 && haystack.includes(ref.trim().toLowerCase()))
  );
  return Math.round((supported.length / claims.length) * 100);
}

/** FREEDOM FROM REPETITION — 100 minus the share of lines flagged as repeats. */
function scoreRepetition(lines: FlatLine[]): number {
  if (!lines.length) return 0;
  const report = findRepetitions(lines.map((l) => l.text));
  const repeated = new Set((report.repeats || []).map((r: { index: number }) => r.index)).size;
  return Math.round(Math.max(0, 1 - repeated / lines.length) * 100);
}

// ---------------------------------------------------------------- the judge

interface BlindJudgment {
  label: string;
  scores: Record<string, number>;
}

/**
 * Score every candidate's script on the judged dimensions, in ONE call, blind.
 *
 * One call rather than one per candidate because the judged dimensions are
 * comparative — "is this opening strong" is a far weaker question than "which of
 * these three openings is strongest", and a judge shown one script at a time
 * drifts its own scale between calls.
 */
async function judgeBlind(
  judge: LLMProvider,
  entries: Array<{ label: string; script: string }>,
  candidates: string[]
): Promise<BlindJudgment[]> {
  const dimensionList = JUDGED_DIMENSIONS.map((d) => `- ${d.key}: ${d.question}`).join("\n");
  const body = entries
    .map((e) => `### ${e.label}\n${scrubCandidateIdentity(e.script, candidates)}`)
    .join("\n\n");

  const result = await judge.generateStructuredOutput<{ judgments: BlindJudgment[] }>({
    systemPrompt:
      "You are judging podcast dialogue for a two-host sports debate show. You are shown anonymised candidates. " +
      "You do not know, and must not speculate about, which system wrote any of them. Reward specificity, " +
      "character, and argument that moves. Penalise exposition, interchangeable voices, and drama without stakes.",
    prompt:
      `Score each candidate 0-100 on EVERY dimension below. Compare them against each other, not against an ` +
      `absolute ideal.\n\n${dimensionList}\n\n${body}\n\nReturn JSON only: ` +
      `{"judgments":[{"label":"Candidate A","scores":{${JUDGED_DIMENSIONS.map((d) => `"${d.key}":0`).join(",")}}}]}`,
    temperature: 0,
    maxTokens: 4000,
    validate: (value) => {
      const parsed = value as { judgments?: BlindJudgment[] };
      if (!Array.isArray(parsed?.judgments)) return "A judgments array is required.";
      if (parsed.judgments.length !== entries.length) {
        return `Exactly ${entries.length} judgments are required, one per candidate.`;
      }
      for (const j of parsed.judgments) {
        for (const d of JUDGED_DIMENSIONS) {
          if (typeof j?.scores?.[d.key] !== "number") return `${j?.label} is missing a score for ${d.key}.`;
        }
      }
      return null;
    },
  });
  return result.judgments;
}

// ---------------------------------------------------------------- candidates

function parseCandidate(spec: string): { provider: string; model?: string } {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { provider: trimmed.toLowerCase() };
  return { provider: trimmed.slice(0, slash).toLowerCase(), model: trimmed.slice(slash + 1) };
}

/** Candidates from --candidates, else MODEL_EVAL_CANDIDATES, else nothing. */
function resolveCandidates(argv: string[]): string[] {
  const flagIndex = argv.indexOf("--candidates");
  const raw = flagIndex >= 0 ? argv[flagIndex + 1] : process.env.MODEL_EVAL_CANDIDATES || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function arg(argv: string[], name: string, fallback: string): string {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

// ---------------------------------------------------------------- storage

function storedRuns(): EvaluationRun[] {
  if (!fs.existsSync(OUT_DIR)) return [];
  return fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.endsWith(".json") && f !== "decision.json")
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(OUT_DIR, f), "utf8")) as EvaluationRun;
      } catch {
        return null;
      }
    })
    .filter((r): r is EvaluationRun => Boolean(r?.runId));
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const role = arg(argv, "--role", "script_movement") as LLMRole;
  const incumbentSpec = (() => {
    const first = resolveRolePlan(role).candidates[0];
    return first ? candidateKey(first) : "(unresolved)";
  })();

  // ---- --decide reads STORED results and nothing else ----
  if (argv.includes("--decide")) {
    const runs = storedRuns();
    const decision = decidePromotion(runs, arg(argv, "--incumbent", incumbentSpec));
    console.log(`\nPROMOTION DECISION for role '${role}'`);
    console.log(`  stored runs read: ${runs.length}`);
    console.log(`  incumbent:  ${decision.incumbent}`);
    console.log(`  challenger: ${decision.challenger ?? "(none)"}`);
    console.log(`  composite delta: ${decision.compositeDelta === null ? "n/a" : decision.compositeDelta.toFixed(2)}`);
    console.log(`  PROMOTE: ${decision.promote ? "YES" : "NO"}`);
    for (const r of decision.reasons) console.log(`    - ${r}`);
    for (const g of decision.evidenceGaps) console.log(`    ! ${g}`);
    console.log(
      `\n  Promotion is never applied by this command. It prints what the stored blind results support; ` +
        `routing is changed by a person editing a role variable.\n`
    );
    process.exit(0);
  }

  const candidates = resolveCandidates(argv);
  if (!candidates.length) {
    console.error(
      "\nNo candidates. Pass --candidates provider/model,provider/model or set MODEL_EVAL_CANDIDATES.\n" +
        "This harness deliberately has no built-in candidate list: a default list is a hardcoded opinion " +
        "about which models are worth testing, which is the thing it exists to replace.\n"
    );
    process.exit(1);
  }

  const material = SITUATIONS.map((s) => ({
    key: s.key,
    episodeTitle: s.episodeTitle,
    topicsPrompts: s.topicsPrompts,
    previousMovement: s.previousMovement,
    continuityState: s.continuityState,
    persona: PERSONA_PROMPT,
  }));
  const digest = fixtureDigest(material);
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${digest}`;
  const labels = assignBlindLabels(runId, candidates);

  const judgeSpec = arg(argv, "--judge", process.env.MODEL_EVAL_JUDGE || "");
  const judgeProviderName = judgeSpec ? parseCandidate(judgeSpec).provider : "";
  const judgeIndependent = Boolean(
    judgeProviderName && !candidates.some((c) => parseCandidate(c).provider === judgeProviderName)
  );

  console.log(`\nBLIND MODEL EVALUATION`);
  console.log(`  run:        ${runId}`);
  console.log(`  role:       ${role}`);
  console.log(`  incumbent:  ${incumbentSpec}`);
  console.log(`  candidates: ${candidates.join(", ")}`);
  console.log(`  fixtures:   ${SITUATIONS.map((s) => s.key).join(", ")} (digest ${digest})`);
  console.log(`  judge:      ${judgeSpec || "(unset)"} — independent of every candidate: ${judgeIndependent}`);
  console.log(`  blind map:  ${[...labels.entries()].map(([, l]) => l).join(", ")} (assignment withheld from the judge)\n`);

  if (!judgeSpec) {
    console.error(
      "No judge. Pass --judge provider/model or set MODEL_EVAL_JUDGE.\n" +
        "The judge must not share a provider with any candidate — a lab grading its own model is not evidence.\n"
    );
    process.exit(1);
  }
  if (!judgeIndependent) {
    console.error(
      `The judge (${judgeSpec}) shares a provider with a candidate. Refusing to run: the result would be ` +
        `stored as evidence and could never be used, because decidePromotion discards captured runs.\n`
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log("--dry-run: protocol validated, no provider was contacted and nothing was stored.");
    console.log(`  dimensions: ${DIMENSIONS.map((d) => `${d.key}(${d.kind})`).join(", ")}`);
    process.exit(0);
  }

  const results: CandidateFixtureResult[] = [];
  const notes: string[] = [];

  for (const situation of SITUATIONS) {
    const scripts: Array<{ label: string; script: string; candidate: string }> = [];

    for (const spec of candidates) {
      const parsed = parseCandidate(spec);
      const blindLabel = labels.get(spec)!;

      if (!providerCredentialPresent(parsed.provider)) {
        // SKIPPED, never scored zero: an unconfigured candidate has told us
        // nothing about its quality.
        results.push({
          candidate: spec,
          fixtureKey: situation.key,
          blindLabel,
          scores: {},
          failure: `no credential for ${parsed.provider} — SKIPPED, not scored`,
          latencyMs: 0,
          estimatedCostUsd: null,
          tokensIn: 0,
          tokensOut: 0,
        });
        continue;
      }

      const mark = llmCostMark();
      const t0 = Date.now();
      try {
        const llm = instantiateProvider(parsed.provider, parsed.model);
        const generated = await generateOutlineDrivenScript(llm, {
          episodeTitle: situation.episodeTitle,
          targetDuration: situation.targetDuration,
          speakerNames: HOST_NAMES,
          topicsPrompts: situation.topicsPrompts,
          systemPrompt: PERSONA_PROMPT,
          // PRODUCTION'S OWN DEFAULTS, spelled out rather than read from env, so
          // a candidate is measured writing the way this show actually writes and
          // two runs on different machines stay comparable. These mirror
          // scriptService.ts (SCRIPT_GEN_TEMPERATURE 0.85, SCRIPT_GEN_MAX_TOKENS
          // 16000); if that drifts, this must be updated deliberately.
          version: 1,
          temperature: 0.85,
          maxTokens: 16000,
          // `log` is REQUIRED by this function and was previously omitted under
          // an `as never` cast — which silenced the compiler on the exact object
          // that was wrong. Every candidate made four paid calls and then died on
          // "args.log is not a function". Do not cast this argument again: the
          // type is the only thing standing between a typo and a burned run.
          log: (msg: string) => {
            if (process.env.MODEL_EVAL_VERBOSE === "true") console.log(`      ${msg}`);
          },
        });
        const latencyMs = Date.now() - t0;
        const cost = llmCostSince(mark);
        const lines = flatten(generated.segments);

        results.push({
          candidate: spec,
          fixtureKey: situation.key,
          blindLabel,
          scores: {
            host_distinctness: scoreHostDistinctness(lines, HOST_NAMES),
            factual_support: scoreFactualSupport(lines, situation.topicsPrompts),
            repetition: scoreRepetition(lines),
            estimated_cost: cost.totals.estimatedCostUsd ?? 0,
            latency: latencyMs,
          },
          failure: null,
          latencyMs,
          estimatedCostUsd: cost.totals.estimatedCostUsd ?? null,
          tokensIn: cost.totals.tkIn,
          tokensOut: cost.totals.tkOut,
        });
        scripts.push({
          label: blindLabel,
          candidate: spec,
          script: lines.map((l) => `${l.speakerName}: ${l.text}`).join("\n"),
        });
      } catch (err) {
        results.push({
          candidate: spec,
          fixtureKey: situation.key,
          blindLabel,
          scores: {},
          failure: (err as Error).message,
          latencyMs: Date.now() - t0,
          estimatedCostUsd: llmCostSince(mark).totals.estimatedCostUsd ?? null,
          tokensIn: llmCostSince(mark).totals.tkIn,
          tokensOut: llmCostSince(mark).totals.tkOut,
        });
        console.error(`  ${blindLabel} FAILED on ${situation.key}: ${(err as Error).message}`);
      }
    }

    // Judged dimensions, comparatively, over whoever produced a script.
    if (scripts.length >= 2) {
      try {
        const judgeParsed = parseCandidate(judgeSpec);
        const judge = instantiateProvider(judgeParsed.provider, judgeParsed.model);
        const judgments = await judgeBlind(judge, scripts, candidates);
        for (const judgment of judgments) {
          const target = results.find(
            (r) => r.blindLabel === judgment.label && r.fixtureKey === situation.key && !r.failure
          );
          if (!target) continue;
          for (const dim of JUDGED_DIMENSIONS) {
            const raw = Number(judgment.scores[dim.key]);
            if (Number.isFinite(raw)) {
              target.scores[dim.key as EvaluationDimension] = Math.max(0, Math.min(100, raw));
            }
          }
        }
      } catch (err) {
        notes.push(`Blind judging failed on ${situation.key}: ${(err as Error).message}`);
        console.error(`  blind judging FAILED on ${situation.key}: ${(err as Error).message}`);
      }
    } else {
      notes.push(
        `${situation.key}: only ${scripts.length} candidate(s) produced a script, so the comparative ` +
          `dimensions were not judged. The deterministic and measured dimensions still stand.`
      );
    }
  }

  const run: EvaluationRun = {
    runId,
    ranAt: new Date().toISOString(),
    fixtureDigest: digest,
    incumbent: incumbentSpec,
    candidates,
    results,
    judge: judgeSpec,
    judgeIndependentOfCandidates: judgeIndependent,
    notes,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, `${runId}.json`);
  fs.writeFileSync(target, JSON.stringify(run, null, 2));

  console.log(`\n${renderSummaryTable(run)}\n`);
  for (const note of notes) console.log(`  note: ${note}`);
  console.log(`\nStored: ${target}`);

  const decision = decidePromotion([...storedRuns()], incumbentSpec);
  console.log(`\nOn the evidence stored so far — PROMOTE: ${decision.promote ? "YES" : "NO"}`);
  for (const r of decision.reasons) console.log(`  - ${r}`);
  for (const g of decision.evidenceGaps) console.log(`  ! ${g}`);
  console.log("");

  // A run that produced no complete result is a failed run.
  const anyComplete = summarizeRun(run).some((s) => s.fixturesCompleted > 0);
  process.exit(anyComplete ? 0 : 1);
}

main().catch((err) => {
  console.error(`Model evaluation crashed: ${(err as Error).message}`);
  process.exit(1);
});
