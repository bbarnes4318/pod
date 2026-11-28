"use server";

// AI Executive Producer: drafts (or redrafts one section of) a production brief
// for an episode. It saves nothing; the creator approves the brief in the
// Studio and it travels with episode creation (Episode.editorialBrief).
//
// One model call through the role-based router (script_outline: the planning
// role, never the dialogue writer), JSON-schema structured output with the
// provider's own single repair attempt, then normalisation that drops anything
// the model cited but was not given. If no model is configured, or the call
// fails, the creator gets the deterministic brief built from stored research,
// labelled as such, plus the reason the model was not used.

import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { getRoleLLMProvider } from "@/lib/providers/llm/factory";
import { roleHasRealProvider } from "@/lib/providers/llm/routing";
import { categoryOf, describeFailure, isBillingCategory, isConfigurationCategory } from "@/lib/providers/llm/errors";
import { getStudioTopicsFor } from "@/lib/services/studioActions";
import { rankForObjective } from "@/lib/studio/productionPlan";
import {
  BRIEF_JSON_SCHEMA, BRIEF_SECTIONS, buildBriefPrompt, deterministicBrief, mergeSection, normalizeBrief, readBrief, validateBriefShape,
  type BriefContext, type BriefSection, type BriefSource, type ExecutiveBrief,
} from "@/lib/studio/executiveBrief";
import type { PrismaClient } from "@prisma/client";

const ROLE = "script_outline" as const;
/** Cost ceiling per call: a brief is ~1.5k tokens; this leaves room, not a blank cheque. */
const MAX_TOKENS = 3500;
const MAX_SOURCES = 12;

export interface ProposeBriefInput {
  objective: string;
  podcastId?: string | null;
  /** Business: the approved topic the episode is built on. */
  opportunityId?: string | null;
  hostIds?: string[];
  targetMinutes?: number;
  productionStyle?: string;
  /** Redo one section of `current`, keeping everything else. */
  section?: BriefSection;
  current?: unknown;
}

export type ProposeBriefResult =
  | { success: true; brief: ExecutiveBrief; usedModel: boolean; note: string | null; hostNames: Record<string, string> }
  | { success: false; error: string };

export async function proposeExecutiveBrief(input: ProposeBriefInput): Promise<ProposeBriefResult> {
  const user = await currentUser();
  if (!user) return { success: false, error: "Please sign in." };
  const objective = String(input.objective ?? "").trim().slice(0, 1200);
  if (input.section && !BRIEF_SECTIONS.includes(input.section)) return { success: false, error: "Unknown section." };
  const current = input.section ? readBrief(input.current) : null;
  if (input.section && !current) return { success: false, error: "There is no brief to revise. Draft one first." };

  const built = await buildContext(user, { ...input, objective });
  if (!built.ok) return { success: false, error: built.error };
  const ctx = built.ctx;
  const hostNames = Object.fromEntries(ctx.hosts.map((h) => [h.id, h.name]));

  const fallback = (why: string): ProposeBriefResult => {
    const d = deterministicBrief(ctx);
    return { success: true, brief: current && input.section ? mergeSection(current, d, input.section) : d, usedModel: false, note: why, hostNames };
  };

  if (!roleHasRealProvider(ROLE)) return fallback("No AI model is set up for planning on this deployment, so this brief was built from your goal and the research on file.");

  let raw: unknown;
  const llm = getRoleLLMProvider(ROLE);
  try {
    const { systemPrompt, prompt } = buildBriefPrompt(ctx, { section: input.section, current });
    raw = await llm.generateStructuredOutput({
      systemPrompt, prompt,
      jsonSchema: BRIEF_JSON_SCHEMA as unknown as Record<string, any>,
      validate: validateBriefShape,
      temperature: input.section ? 0.8 : 0.5,
      maxTokens: MAX_TOKENS,
    });
  } catch (err) {
    console.error("[executive-producer] brief failed:", describeFailure(err));
    const c = categoryOf(err);
    return fallback(
      isBillingCategory(c) ? "The AI provider account is out of credit, so this brief was built from your goal and the research on file."
      : isConfigurationCategory(c) ? "The AI provider isn't set up correctly, so this brief was built from your goal and the research on file."
      : c === "structured_output_invalid_after_repair" ? "The AI's answer came back unreadable twice, so this brief was built from your goal and the research on file. Try again for an AI draft."
      : "The AI couldn't be reached just now, so this brief was built from your goal and the research on file. Try again for an AI draft."
    );
  }

  let fresh: ExecutiveBrief;
  try {
    fresh = normalizeBrief(raw, ctx, { source: "model", model: llm.name || ROLE });
  } catch (err) {
    console.error("[executive-producer] unusable brief:", (err as Error).message);
    return fallback("The AI's answer was missing required parts, so this brief was built from your goal and the research on file. Try again for an AI draft.");
  }
  return { success: true, brief: current && input.section ? mergeSection(current, fresh, input.section) : fresh, usedModel: true, note: null, hostNames };
}

async function buildContext(
  user: { id: string; role: string },
  input: ProposeBriefInput & { objective: string }
): Promise<{ ok: true; ctx: BriefContext } | { ok: false; error: string }> {
  const podcast = input.podcastId
    ? await db.podcast.findUnique({ where: { id: input.podcastId }, select: { id: true, ownerId: true, name: true, description: true, intelligenceType: true, hostIds: true } })
    : null;
  if (input.podcastId && (!podcast || (podcast.ownerId !== user.id && user.role !== "ADMIN"))) return { ok: false, error: "That show isn't available." };
  const kind = podcast?.intelligenceType === "BUSINESS" ? "business" : "sports";

  const hostIds = (input.hostIds?.length ? input.hostIds : podcast?.hostIds ?? []).slice(0, 4);
  const hostRows = hostIds.length
    ? await db.aiHost.findMany({
        where: { id: { in: hostIds }, OR: [{ ownerId: user.id }, { ownerId: null }] },
        select: { id: true, name: true, role: true, worldview: true, speakingStyle: true, argumentPatterns: true },
      })
    : [];
  const hosts = hostIds.map((id) => hostRows.find((h) => h.id === id)).filter(Boolean).map((h) => ({
    id: h!.id, name: h!.name, role: h!.role, worldview: h!.worldview, speakingStyle: h!.speakingStyle,
    argumentPatterns: Array.isArray(h!.argumentPatterns) ? (h!.argumentPatterns as unknown[]).map(String) : [],
  }));

  let sources: BriefSource[] = [];
  if (kind === "business") {
    if (!input.opportunityId) return { ok: false, error: "Choose the approved topic this episode is built on." };
    const opp = await db.businessTopicOpportunity.findFirst({ where: { id: input.opportunityId, podcastId: podcast!.id }, include: { dossier: true } });
    if (!opp) return { ok: false, error: "That topic isn't available." };
    sources = businessSources(opp);
  } else {
    const pool = await getStudioTopicsFor({ user, db: db as unknown as PrismaClient }, input.podcastId ?? null);
    if (!pool.success) return { ok: false, error: pool.error };
    const byId = new Map(pool.topics.map((t) => [t.id, t]));
    sources = rankForObjective(pool.topics, input.objective).slice(0, MAX_SOURCES).map((p) => {
      const t = byId.get(p.id)!;
      return { id: t.id, title: t.title, summary: t.brief?.whyMattersNow ?? t.summary, detail: [t.brief?.mainAngle, t.brief?.strongestDebateQuestion].filter(Boolean).join(" | ") || null };
    });
  }

  return {
    ok: true,
    ctx: {
      objective: input.objective, showName: podcast?.name ?? null, showDescription: podcast?.description ?? null, kind, hosts, sources,
      targetMinutes: Math.min(60, Math.max(3, Math.round(input.targetMinutes ?? 12))),
      productionStyle: ["clean", "light", "full"].includes(input.productionStyle ?? "") ? input.productionStyle! : "light",
    },
  };
}

/** The approved topic and its VERIFIED dossier items, each addressable by id. */
function businessSources(opp: { id: string; title: string; coreQuestion: string; whyNow: string | null; dossier: { status: string; content: unknown } | null }): BriefSource[] {
  const out: BriefSource[] = [{ id: `topic:${opp.id}`, title: opp.title, summary: opp.coreQuestion, detail: opp.whyNow }];
  const c = (opp.dossier?.status === "READY" ? opp.dossier.content : null) as { verifiedFacts?: { claim: string }[]; verifiedStatistics?: { claim: string; asOf?: string | null }[]; misconceptions?: { myth: string; reality: string }[] } | null;
  if (!c) return out;
  (c.verifiedFacts ?? []).slice(0, 6).forEach((f, i) => out.push({ id: `fact:${i}`, title: "Verified fact", summary: f.claim }));
  (c.verifiedStatistics ?? []).slice(0, 4).forEach((f, i) => out.push({ id: `stat:${i}`, title: "Verified statistic", summary: f.claim, detail: f.asOf ? `as of ${f.asOf}` : null }));
  (c.misconceptions ?? []).slice(0, 2).forEach((m, i) => out.push({ id: `myth:${i}`, title: "Misconception", summary: m.myth, detail: m.reality }));
  return out.slice(0, MAX_SOURCES);
}
