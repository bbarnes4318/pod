// Worker-side bindings: real providers → business engines. The worker calls
// these; tests call the engines directly with injected doubles.
//
// Model roles (existing roles, no new routing):
//   research planning  → research_brief      topic generation → topic_generation
//   editorial review   → quality_judge       dossier writer   → research_brief
//   claim/line judge   → fact_check (never the role that wrote the claim)
//   business script    → script_movement

import { db } from "../db";
import { getRoleLLMProvider, roleHasRealProvider, resolveRolePlan, candidateKey, roleProviderLabel, modelsUsedBy } from "../providers/llm/routing";
import type { LLMRole } from "../providers/llm/roles";
import { llmCostMark, llmCostSince, withLlmJob } from "../providers/llm/costLedger";
import { resolveEpisodeCast } from "../services/hostCasting";
import { exaClient } from "./researchProviders";
import { llmEntailmentJudge } from "./claimVerification";
import { llmClaimClassifier } from "./factualClaims";
import { runIndustryResearch } from "./researchEngine";
import { runDossier } from "./businessDossier";
import { generateBusinessScript, factCheckBusinessScript, recordedWriterModels } from "./businessProduction";
import { businessLLM } from "./schemaInstructions";
import { runSevenRolePipeline } from "../services/scriptSevenRolePipeline";
import { withCreativeDomain } from "../services/creativeDomain";
import type { BusinessCreativeRun, BusinessCreativeResult } from "./businessProduction";

// Every business model call carries its output schema (see schemaInstructions.ts).
const role = (r: LLMRole) => (roleHasRealProvider(r) ? businessLLM(getRoleLLMProvider(r)) : null);
const judge = () => {
  const l = role("fact_check");
  return l ? llmEntailmentJudge(l) : undefined;
};

async function withCost<T>(runId: string, fn: (cost: () => number) => Promise<T>): Promise<T> {
  const mark = llmCostMark();
  const jobKey = `business:${runId}`;
  const cost = () => llmCostSince(mark, { jobId: jobKey }).totals.estimatedCostUsd ?? 0;
  try {
    return await withLlmJob(jobKey, () => fn(cost));
  } finally {
    // Persist the measured LLM spend next to provider usage.
    const totals = llmCostSince(mark, { jobId: jobKey }).totals;
    const run = await db.businessResearchRun.findUnique({ where: { id: runId }, select: { usage: true } });
    await db.businessResearchRun.update({
      where: { id: runId },
      data: { usage: { ...((run?.usage as object) ?? {}), llmCostUsd: totals.estimatedCostUsd ?? 0, tokensIn: totals.tkIn, tokensOut: totals.tkOut, llmCallsMeasured: totals.calls } },
    }).catch(() => undefined);
  }
}

export function runBusinessResearchJob(runId: string) {
  return withCost(runId, (cost) =>
    runIndustryResearch(runId, {
      db,
      llm: { planner: role("research_brief"), topics: role("topic_generation"), reviewer: role("quality_judge") },
      judge: judge(),
      exa: exaClient(),
      llmCostUsd: cost,
    })
  );
}

export function runBusinessDossierJob(runId: string) {
  return withCost(runId, () => runDossier(runId, { db, writer: role("research_brief"), judge: judge(), exa: exaClient() }));
}

export function runBusinessScriptJob(episodeId: string, forceRegenerate?: boolean) {
  const writer = role("script_movement");
  if (!writer) throw new Error("No script model is configured. Real script generation disabled.");
  return generateBusinessScript(db, { episodeId, forceRegenerate }, {
    writer,
    writerModels: () => modelsUsedBy(writer, "script_movement"),
    resolveCast: async (ep) => (await resolveEpisodeCast({ hostIds: ep.hostIds, formatId: ep.formatId })).members.map((m) => ({ host: m.host, role: m.role })),
    creative: runBusinessCreativePipeline,
  });
}

/**
 * Business scripts are written by the SAME seven-role pipeline as sports
 * (story editor, debate architect, one writer per host with private briefs,
 * dialogue director, continuity), with business wording switched on for the
 * few sports-specific prompt sentences. The models that actually served each
 * writing role are recorded so the fact-check can prove it is independent.
 */
const LINE_WRITING_ROLES = new Set(["debate_architect", "host_a_writer", "host_b_writer", "dialogue_director"]);

/**
 * Which models put words on the page, read from the cost ledger's per-call
 * stage labels rather than from the role records.
 *
 * Under the legacy routing profile a role record's model is inferred from the
 * ledger window of that role, and the debate architect's window also holds the
 * cold-open JUDGE call. In the fourth Milestone 2 live run that recorded
 * claude-opus-5 (the judge, also the fact-check model) as a script writer, so
 * an independent fact-check would have been refused as self-certification.
 * Conservative by construction: every model that served any call during the
 * writing run counts as a writer, except calls whose stage only grades or
 * reviews (cold-open judge, quality judge, semantic review).
 */
const NON_WRITING_STAGE = /judge|review|semantic/i;
export function writerModelsFromLedger(stages: { stage: string; models: string[] }[]): string[] {
  return [...new Set(stages
    .filter((s) => !NON_WRITING_STAGE.test(s.stage))
    .flatMap((s) => s.models)
    .map((m) => m.toLowerCase()))];
}

async function runBusinessCreativePipeline(run: BusinessCreativeRun): Promise<BusinessCreativeResult> {
  const reasons: string[] = [];
  // Scoped to this script job by the worker's withLlmJob.
  const mark = llmCostMark();
  const seven = await withCreativeDomain(run.domain, () =>
    runSevenRolePipeline({
      systemPrompt: run.systemPrompt,
      episodeTitle: run.episodeTitle,
      topicsPrompts: run.topicsPrompts,
      rundownTopics: run.rundownTopics,
      targetDuration: run.targetDuration,
      temperature: Number(process.env.SCRIPT_GEN_TEMPERATURE) || 0.85,
      maxTokens: Number(process.env.SCRIPT_GEN_MAX_TOKENS) || 16000,
      speakerNames: run.speakerNames,
      log: (m) => reasons.push(m),
    })
  );
  if (!seven.ok || !seven.segments) {
    const failed = seven.trace.stageRecords.find((r) => r.status === "failed");
    return { ok: false, error: `${failed ? `${failed.role} failed: ` : ""}${seven.error ?? "the pipeline returned no script"}` };
  }
  const roleRecordModels = [...new Set(seven.trace.stageRecords
    // Only roles that put words on the page: the architect writes the cold open,
    // the host writers write the lines, the director repairs joins. The story
    // editor and continuity editor plan and report; the judge only scores.
    .filter((r) => r.status === "ok" && LINE_WRITING_ROLES.has(r.role) && r.actualProvider && r.actualModel)
    .map((r) => `${r.actualProvider}/${r.actualModel}`.toLowerCase()))];
  const ledgerModels = writerModelsFromLedger(llmCostSince(mark).stages);
  // The ledger is authoritative when it saw the calls; the role records are the
  // fallback for a provider that records nothing.
  const writerModels = ledgerModels.length ? ledgerModels : roleRecordModels;
  reasons.push(`Writer models (from the calls that wrote): ${writerModels.join(", ") || "none observed"}.`);
  reasons.push(`Seven-role pipeline: ${seven.trace.stageRecords.filter((r) => r.status === "ok").length} role(s) ok, ${seven.trace.violations.length} violation(s).`);
  return { ok: true, segments: seven.segments as never, writerModels, reasons };
}

/**
 * The judge must not be the model that wrote the script: same model =
 * self-certification = unavailable. Checked twice: up front against the
 * writer recorded on the script (skips a pointless paid call), and after the
 * run against the judge models that actually answered (a fallback can land on
 * the writer's model) — see factCheckBusinessScript.
 */
async function independentFactCheckDeps(scriptId: string) {
  const s = await db.script.findUnique({ where: { id: scriptId }, select: { content: true } });
  const writers = recordedWriterModels(s?.content);
  const j = resolveRolePlan("fact_check").candidates[0];
  const l = role("fact_check");
  if (!l) return { judgeUnavailableReason: "no fact_check model configured" };
  if (j && writers.includes(candidateKey(j))) return { judgeUnavailableReason: "the fact_check model is the same model that wrote the script" };
  return { judge: llmEntailmentJudge(l), classifier: llmClaimClassifier(l), judgeLabel: roleProviderLabel("fact_check"), judgeModelsUsed: () => modelsUsedBy(l, "fact_check") };
}

export async function runBusinessFactCheckJob(scriptId: string) {
  return factCheckBusinessScript(db, scriptId, await independentFactCheckDeps(scriptId));
}

/** Which engine owns this episode — the worker's dispatch question. */
export async function episodeIsBusiness(episodeId: string): Promise<boolean> {
  const ep = await db.episode.findUnique({ where: { id: episodeId }, select: { podcast: { select: { intelligenceType: true } } } });
  return ep?.podcast?.intelligenceType === "BUSINESS";
}
export async function scriptIsBusiness(scriptId: string): Promise<boolean> {
  const s = await db.script.findUnique({ where: { id: scriptId }, select: { episode: { select: { podcast: { select: { intelligenceType: true } } } } } });
  return s?.episode?.podcast?.intelligenceType === "BUSINESS";
}
