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

const role = (r: LLMRole) => (roleHasRealProvider(r) ? getRoleLLMProvider(r) : null);
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
  });
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
