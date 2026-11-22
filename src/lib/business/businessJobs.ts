// Worker-side bindings: real providers → business engines. The worker calls
// these; tests call the engines directly with injected doubles.
//
// Model roles (existing roles, no new routing):
//   research planning  → research_brief      topic generation → topic_generation
//   editorial review   → quality_judge       dossier writer   → research_brief
//   claim/line judge   → fact_check (never the role that wrote the claim)
//   business script    → script_movement

import { db } from "../db";
import { getRoleLLMProvider, roleHasRealProvider } from "../providers/llm/routing";
import type { LLMRole } from "../providers/llm/roles";
import { llmCostMark, llmCostSince, withLlmJob } from "../providers/llm/costLedger";
import { resolveEpisodeCast } from "../services/hostCasting";
import { exaClient } from "./researchProviders";
import { llmEntailmentJudge } from "./claimVerification";
import { runIndustryResearch } from "./researchEngine";
import { runDossier } from "./businessDossier";
import { generateBusinessScript, factCheckBusinessScript } from "./businessProduction";

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
    resolveCast: async (ep) => (await resolveEpisodeCast({ hostIds: ep.hostIds, formatId: ep.formatId })).members.map((m) => ({ host: m.host, role: m.role })),
  });
}

export function runBusinessFactCheckJob(scriptId: string) {
  return factCheckBusinessScript(db, scriptId, { judge: judge() });
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
