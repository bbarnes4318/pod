"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { canViewOwned } from "@/lib/ownerScope";
import { assertCanCreateEpisode, assertCanCreatePodcast } from "@/lib/services/entitlementService";
import { businessPodcastsEnabledFor } from "@/lib/business/intelligenceType";
import {
  AnswersSchema,
  BusinessEssentialsSchema,
  readAnswers,
  readFindings,
  type ProfileFinding,
} from "@/lib/business/profileSchema";
import { discoverBusiness } from "@/lib/business/discovery";
import { generateAdaptiveQuestions } from "@/lib/business/adaptiveQuestions";
import { llmEntailmentJudge } from "@/lib/business/claimVerification";
import { BUDGETS, type Depth } from "@/lib/business/researchEngine";
import { createBusinessEpisode, statusForApproval } from "@/lib/business/businessProduction";
import { getRoleLLMProvider } from "@/lib/providers/llm/factory";
import { roleHasRealProvider } from "@/lib/providers/llm/routing";
import { queueBusinessDossierJob, queueBusinessResearchJob, queueFactCheckJob, queueScriptGenerationJob } from "@/lib/queue/podcastQueue";
import { recordHumanRelease } from "@/lib/services/scriptRelease";
import { businessLLM } from "@/lib/business/schemaInstructions";

type Result<T = object> = ({ success: true } & T) | { success: false; error: string };

/** Load a business profile the current user may touch. Authority is the
 *  podcast's owner — never anything the client sends. */
async function ownedProfile(podcastId: string) {
  const user = await currentUser();
  if (!user) return { error: "Please sign in." } as const;
  const pod = await db.podcast.findUnique({
    where: { id: podcastId },
    select: { id: true, ownerId: true, intelligenceType: true, businessProfile: true },
  });
  if (!pod || !canViewOwned(user, pod)) return { error: "Show not found." } as const;
  if (pod.intelligenceType !== "BUSINESS" || !pod.businessProfile) return { error: "This isn't a business show." } as const;
  return { user, pod, profile: pod.businessProfile } as const;
}

function revalidateShow(podcastId: string) {
  revalidatePath("/studio/shows");
  revalidatePath(`/studio/shows/${podcastId}`);
}

const fail = (e: unknown, fallback: string) => ({ success: false as const, error: e instanceof Error ? e.message : fallback });

export async function createBusinessPodcast(raw: unknown): Promise<Result<{ podcastId: string }>> {
  try {
    const user = await currentUser();
    if (!user) return { success: false, error: "Please sign in to create a show." };
    if (!businessPodcastsEnabledFor(user)) return { success: false, error: "Business podcasts aren't enabled for this account yet." };
    const gate = await assertCanCreatePodcast(user.id);
    if (!gate.ok) return { success: false, error: gate.error };

    const parsed = BusinessEssentialsSchema.safeParse(raw);
    if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Check the form." };
    const e = parsed.data;

    const podcast = await db.$transaction(async (tx) => {
      const created = await tx.podcast.create({
        data: {
          name: e.showName,
          cadence: "one_time",
          // Server-decided. No client field reaches this column.
          intelligenceType: "BUSINESS",
          owner: user.email || "listener",
          ownerId: user.id,
          description: e.description ?? null,
          websiteUrl: e.websiteUrl ?? null,
          language: e.language,
        },
        select: { id: true },
      });
      // Same 1-1 config rows a sports show gets, so the canonical resolver
      // never reports a legacy fallback for a business show.
      await tx.podcastEditorialConfig.create({ data: { podcastId: created.id } });
      await tx.podcastProductionConfig.create({ data: { podcastId: created.id } });
      await tx.podcastPublishingConfig.create({ data: { podcastId: created.id } });
      await tx.businessProfile.create({
        data: {
          podcastId: created.id,
          businessName: e.businessName,
          websiteUrl: e.websiteUrl ?? null,
          description: e.description ?? null,
          industry: e.industry,
          subIndustries: e.subIndustries,
          targetAudiences: e.targetAudiences,
          primaryGoal: e.primaryGoal,
          geographicMarkets: e.geographicMarkets,
          language: e.language,
        },
      });
      return created;
    });

    revalidateShow(podcast.id);
    return { success: true, podcastId: podcast.id };
  } catch (err) {
    return fail(err, "Could not create the show.");
  }
}

// ponytail: discovery stays inline (≤ 8 same-origin pages, 3 at a time, plus
// one extraction call and per-claim checks). Industry research and dossiers —
// the multi-provider work — run on the queue.
export async function runBusinessDiscovery(podcastId: string): Promise<Result<{ added: number; skipped: string[]; pages: number }>> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const p = owned.profile;

  // Atomic claim: one discovery at a time per profile.
  const claimed = await db.businessProfile.updateMany({
    where: { id: p.id, discoveryStatus: { not: "running" } },
    data: { discoveryStatus: "running", discoveryError: null },
  });
  if (claimed.count === 0) return { success: false, error: "Discovery is already running." };

  const judge = roleHasRealProvider("fact_check") ? llmEntailmentJudge(businessLLM(getRoleLLMProvider("fact_check"))) : undefined;
  const res = await discoverBusiness(p, { llm: businessLLM(getRoleLLMProvider("evidence_extraction")), judge }).catch(
    (err: Error) => ({ ok: false as const, error: err.message })
  );
  if (!res.ok) {
    await db.businessProfile.update({ where: { id: p.id }, data: { discoveryStatus: "failed", discoveryError: res.error.slice(0, 500) } });
    revalidateShow(podcastId);
    return { success: false, error: res.error };
  }

  // Re-running discovery replaces only PENDING suggestions. Anything the user
  // accepted, edited or rejected is their decision and survives.
  const kept = readFindings(p.findings).filter((f) => f.status !== "pending");
  const decided = new Set(kept.map((f) => `${f.field}|${f.value.toLowerCase()}`));
  const fresh = res.findings.filter((f) => !decided.has(`${f.field}|${f.value.toLowerCase()}`));
  const now = new Date();
  await db.$transaction(async (tx) => {
    await tx.businessProfile.update({
      where: { id: p.id },
      data: {
        findings: [...kept, ...fresh] as unknown as Prisma.InputJsonValue,
        discoveryStatus: "complete",
        discoveredAt: now,
        version: { increment: 1 },
      },
    });
    // The pages read become first-party sources that research and dossiers can cite.
    if (res.sources.length) {
      const run = await tx.businessResearchRun.create({
        data: {
          podcastId, ownerId: owned.pod.ownerId, kind: "discovery", depth: "QUICK", status: "completed",
          idempotencyKey: `${podcastId}:discovery:${now.toISOString()}`, profileVersion: p.version + 1,
          budget: { maxPages: 8 }, usage: { apiRequests: { safe_fetch: res.sources.length } }, startedAt: now, completedAt: now,
          progress: { pass: "done", message: `${res.sources.length} pages read`, pct: 100 },
        },
      });
      for (const s of res.sources) {
        await tx.businessResearchSource.create({
          data: {
            runId: run.id, podcastId, ownerId: owned.pod.ownerId, sourceType: "FIRST_PARTY_SITE", provider: "safe_fetch",
            canonicalUrl: s.url, title: s.title ?? null, publisher: new URL(s.url).hostname.replace(/^www\./, ""),
            publishedAt: s.publishedAt ? new Date(s.publishedAt) : null, retrievedAt: new Date(s.retrievedAt),
            excerpt: s.text.slice(0, 6000), contentHash: s.contentHash ?? "", originKey: `site:${new URL(s.url).hostname}`,
          },
        });
      }
    }
  });
  revalidateShow(podcastId);
  return { success: true, added: fresh.length, skipped: res.skipped, pages: res.sources.length };
}

export async function reviewFinding(
  podcastId: string,
  findingId: string,
  action: "accept" | "reject" | "edit",
  value?: string
): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const p = owned.profile;
  const findings = readFindings(p.findings);
  const idx = findings.findIndex((f) => f.id === findingId);
  if (idx < 0) return { success: false, error: "That finding no longer exists." };

  const f = findings[idx];
  let next: ProfileFinding;
  if (action === "reject") next = { ...f, status: "rejected" };
  else if (action === "accept") {
    // Keeping an AI suggestion makes it the user's claim. It does NOT become an
    // independently verified fact; a source-supported finding stays supported.
    const keepsProvenance = f.provenance === "SOURCE_SUPPORTED" || f.provenance === "SOURCE_VERIFIED";
    next = { ...f, status: "accepted", provenance: keepsProvenance ? f.provenance : "USER_CONFIRMED" };
  } else {
    const v = (value ?? "").trim();
    if (!v || v.length > 1000) return { success: false, error: "Edited value must be 1–1000 characters." };
    // An edit is the user's statement now — its old source quote no longer backs it.
    next = { ...f, value: v, status: "accepted", provenance: "USER_CONFIRMED", evidenceQuote: null, sourceUrl: null, confidence: 1, verification: null };
  }
  findings[idx] = next;

  // Compare-and-swap on version so two tabs can't silently overwrite each other.
  const res = await db.businessProfile.updateMany({
    where: { id: p.id, version: p.version },
    data: { findings: findings as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  if (res.count === 0) return { success: false, error: "This profile changed in another window. Reload and try again." };
  revalidateShow(podcastId);
  return { success: true };
}

export async function saveBusinessAnswers(podcastId: string, raw: unknown, expectedVersion: number): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const parsed = AnswersSchema.safeParse(raw);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid answers." };
  // Drop blanks so "skipped" and "answered" stay distinguishable. Follow-ups are
  // owned by their own actions; this form never overwrites them.
  const fields = Object.fromEntries(Object.entries(parsed.data.fields).filter(([, v]) => v.trim()));
  const current = readAnswers(owned.profile.answers);
  const res = await db.businessProfile.updateMany({
    where: { id: owned.profile.id, version: expectedVersion },
    data: { answers: { fields, followups: current.followups } as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  if (res.count === 0) return { success: false, error: "This profile changed in another window. Reload and try again." };
  revalidateShow(podcastId);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Adaptive follow-up questions
// ---------------------------------------------------------------------------

export async function askAdaptiveQuestions(podcastId: string): Promise<Result<{ asked: number; note?: string }>> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const p = owned.profile;
  const answers = readAnswers(p.answers);
  if (Object.values(answers.followups).some((f) => !f.skipped && !f.answer.trim())) {
    return { success: false, error: "Answer or skip the current questions first." };
  }
  const llm = roleHasRealProvider("topic_classification") ? businessLLM(getRoleLLMProvider("topic_classification")) : null;
  const out = await generateAdaptiveQuestions(p, llm);
  if (!Object.keys(out.questions).length) return { success: true, asked: 0, note: out.note };
  const res = await db.businessProfile.updateMany({
    where: { id: p.id, version: p.version },
    data: { answers: { ...answers, followups: { ...answers.followups, ...out.questions } } as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  if (res.count === 0) return { success: false, error: "This profile changed in another window. Reload and try again." };
  revalidateShow(podcastId);
  return { success: true, asked: Object.keys(out.questions).length };
}

export async function answerAdaptiveQuestion(podcastId: string, questionId: string, answer: string | null): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const answers = readAnswers(owned.profile.answers);
  const q = answers.followups[questionId];
  if (!q) return { success: false, error: "That question no longer exists." };
  const text = (answer ?? "").trim();
  if (answer !== null && (!text || text.length > 4000)) return { success: false, error: "Answers must be 1–4000 characters (or skip)." };
  answers.followups[questionId] = answer === null ? { ...q, skipped: true, answer: "" } : { ...q, skipped: false, answer: text };
  const res = await db.businessProfile.updateMany({
    where: { id: owned.profile.id, version: owned.profile.version },
    data: { answers: answers as unknown as Prisma.InputJsonValue, version: { increment: 1 } },
  });
  if (res.count === 0) return { success: false, error: "This profile changed in another window. Reload and try again." };
  revalidateShow(podcastId);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Research runs (queued)
// ---------------------------------------------------------------------------

export async function startBusinessResearch(podcastId: string, depth: Depth): Promise<Result<{ runId: string; reused: boolean }>> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  if (!(depth in BUDGETS)) return { success: false, error: "Unknown research depth." };
  const p = owned.profile;
  // Same profile + depth on the same day = the same run. Changing the profile starts fresh research.
  const key = `${podcastId}:industry:${depth}:v${p.version}:${new Date().toISOString().slice(0, 10)}`;
  try {
    const existing = await db.businessResearchRun.findUnique({ where: { idempotencyKey: key } });
    // A run that stopped short (partial: budget, time limit or a failed pass) can be re-run;
    // only a queued, running or completed run is reused for the same day and profile.
    if (existing && !["failed", "cancelled", "partial"].includes(existing.status)) return { success: true, runId: existing.id, reused: true };
    // A run whose worker died stops updating; past the longest run limit it no longer blocks new research.
    await db.businessResearchRun.updateMany({ where: { podcastId, kind: "industry", status: "running", updatedAt: { lt: staleBefore() } }, data: { status: "failed", error: "The research worker stopped reporting progress.", completedAt: new Date() } });
    const running = await db.businessResearchRun.findFirst({ where: { podcastId, kind: "industry", status: { in: ["queued", "running"] } } });
    if (running) return { success: false, error: "Research is already running for this show." };
    const run = existing
      ? await db.businessResearchRun.update({ where: { id: existing.id }, data: { status: "queued", error: null, cancelRequested: false, completedAt: null } })
      : await db.businessResearchRun.create({
          data: { podcastId, ownerId: owned.pod.ownerId, kind: "industry", depth, idempotencyKey: key, profileVersion: p.version, budget: BUDGETS[depth] as unknown as Prisma.InputJsonValue, progress: { pass: "queued", message: "Waiting for a research worker", pct: 0 } },
        });
    await queueBusinessResearchJob({ runId: run.id });
    revalidateShow(podcastId);
    return { success: true, runId: run.id, reused: false };
  } catch (e) {
    return fail(e, "Could not start research.");
  }
}

/** Longer than the DEEP run limit (15 min) plus one slow model call. */
const staleBefore = () => new Date(Date.now() - 25 * 60_000);

export async function cancelBusinessRun(podcastId: string, runId: string): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const res = await db.businessResearchRun.updateMany({ where: { id: runId, podcastId, status: { in: ["queued", "running"] } }, data: { cancelRequested: true } });
  if (res.count === 0) return { success: false, error: "That run isn't running." };
  // A run still waiting in the queue, or one whose worker stopped reporting, is cancelled immediately.
  await db.businessResearchRun.updateMany({
    where: { id: runId, podcastId, OR: [{ status: "queued" }, { status: "running", updatedAt: { lt: staleBefore() } }] },
    data: { status: "cancelled", completedAt: new Date(), error: "Cancelled by the user." },
  });
  revalidateShow(podcastId);
  return { success: true };
}

export async function startDossier(podcastId: string, opportunityId: string, depth: Depth = "STANDARD"): Promise<Result<{ runId: string }>> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const opp = await db.businessTopicOpportunity.findFirst({ where: { id: opportunityId, podcastId }, include: { dossier: true } });
  if (!opp) return { success: false, error: "Topic not found." };
  if (opp.editorialStatus === "REJECTED") return { success: false, error: "Reopen this topic before researching it." };
  const version = (opp.dossier?.version ?? 0) + (opp.dossier ? 1 : 0);
  const key = `${podcastId}:dossier:${opportunityId}:${depth}:v${version}`;
  try {
    const existing = await db.businessResearchRun.findUnique({ where: { idempotencyKey: key } });
    if (existing && ["queued", "running"].includes(existing.status)) return { success: true, runId: existing.id };
    const run = existing
      ? await db.businessResearchRun.update({ where: { id: existing.id }, data: { status: "queued", error: null, cancelRequested: false, completedAt: null } })
      : await db.businessResearchRun.create({
          data: { podcastId, ownerId: owned.pod.ownerId, kind: "dossier", depth, idempotencyKey: key, opportunityId, profileVersion: owned.profile.version, budget: { queries: depth === "DEEP" ? 6 : depth === "QUICK" ? 2 : 4, llmCalls: 1 }, progress: { pass: "queued", message: "Waiting for a research worker", pct: 0 } },
        });
    await queueBusinessDossierJob({ runId: run.id });
    revalidateShow(podcastId);
    return { success: true, runId: run.id };
  } catch (e) {
    return fail(e, "Could not start the dossier.");
  }
}

// ---------------------------------------------------------------------------
// Editorial decisions
// ---------------------------------------------------------------------------

export async function decideOpportunity(podcastId: string, opportunityId: string, action: "approve" | "reject" | "reopen"): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const opp = await db.businessTopicOpportunity.findFirst({ where: { id: opportunityId, podcastId }, include: { dossier: { select: { status: true } } } });
  if (!opp) return { success: false, error: "Topic not found." };
  if (opp.editorialStatus === "PRODUCED") return { success: false, error: "An episode already uses this topic." };
  let editorialStatus: string;
  if (action === "approve") {
    // A held topic can be approved only once its dossier did the research the hold asked for.
    if (opp.editorialStatus === "HELD" && opp.dossier?.status !== "READY") {
      return { success: false, error: "This topic is held until research supports it. Run its dossier first." };
    }
    editorialStatus = "APPROVED";
  } else if (action === "reject") editorialStatus = "REJECTED";
  else editorialStatus = (opp.holdReasons as unknown[]).length && opp.dossier?.status !== "READY" ? "HELD" : "CANDIDATE";
  await db.businessTopicOpportunity.update({ where: { id: opp.id }, data: { editorialStatus } });
  revalidateShow(podcastId);
  return { success: true };
}

export async function refineOpportunity(podcastId: string, opportunityId: string, edits: { title?: string; coreQuestion?: string; targetListener?: string }): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const clean = (s: string | undefined, max: number) => (s === undefined ? undefined : s.trim().slice(0, max));
  const data = { title: clean(edits.title, 160), coreQuestion: clean(edits.coreQuestion, 300), targetListener: clean(edits.targetListener, 200) };
  if (Object.values(data).some((v) => v !== undefined && v.length < 3)) return { success: false, error: "Edits must be at least 3 characters." };
  // An edited topic needs fresh research: its dossier (if any) no longer matches.
  const res = await db.businessTopicOpportunity.updateMany({
    where: { id: opportunityId, podcastId, editorialStatus: { notIn: ["PRODUCED"] } },
    data: { ...data, editorialStatus: "CANDIDATE", review: Prisma.JsonNull },
  });
  if (res.count === 0) return { success: false, error: "Topic not found or already produced." };
  await db.businessResearchDossier.updateMany({ where: { opportunityId, podcastId, status: "READY" }, data: { status: "HOLD", holdReasons: ["The topic was edited after this dossier was written. Re-run the dossier."] } });
  revalidateShow(podcastId);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

export async function generateBusinessEpisode(podcastId: string, opportunityId: string): Promise<Result<{ episodeId: string }>> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  try {
    const cap = await assertCanCreateEpisode(owned.user.id);
    if (!cap.ok) return { success: false, error: cap.error };
    const created = await createBusinessEpisode(db, { podcastId, opportunityId, ownerId: owned.user.id });
    if (!created.success) return created;
    await queueScriptGenerationJob({ episodeId: created.episodeId });
    revalidateShow(podcastId);
    return { success: true, episodeId: created.episodeId };
  } catch (e) {
    return fail(e, "Could not create the episode.");
  }
}

/**
 * The owner approving a business script IS the editorial review. It is recorded
 * as an attributable human release (the same record the production guard reads
 * for every show) and then fact-checked; voicing starts only if fact-check passes.
 */
export async function approveBusinessScript(podcastId: string, episodeId: string): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const ep = await db.episode.findFirst({ where: { id: episodeId, podcastId }, select: { id: true, status: true } });
  if (!ep) return { success: false, error: "Episode not found." };
  const script = await db.script.findFirst({ where: { episodeId }, orderBy: { version: "desc" } });
  if (!script) return { success: false, error: "No script yet." };
  // A needs_revision script is re-audited first: if no line is flagged any more it is approvable.
  const status = await statusForApproval(db, script);
  if (status !== "draft") return { success: false, error: status === "needs_revision" ? "This script has flagged lines. Fix or regenerate them before approving." : `Script is ${status}.` };
  const who = owned.user.email || owned.user.id;
  const release = await recordHumanRelease({ scriptId: script.id, approvedBy: who, note: "Business script approved by the show owner in Studio." });
  if (!release.success) return { success: false, error: release.error };
  await db.$transaction([
    db.script.update({ where: { id: script.id }, data: { status: "approved" } }),
    db.episode.update({ where: { id: episodeId }, data: { status: "script_approved" } }),
  ]);
  await queueFactCheckJob({ scriptId: script.id });
  revalidateShow(podcastId);
  return { success: true };
}

export async function regenerateBusinessScript(podcastId: string, episodeId: string): Promise<Result> {
  const owned = await ownedProfile(podcastId);
  if ("error" in owned) return { success: false, error: owned.error! };
  const ep = await db.episode.findFirst({ where: { id: episodeId, podcastId }, select: { id: true } });
  if (!ep) return { success: false, error: "Episode not found." };
  try {
    await queueScriptGenerationJob({ episodeId, forceRegenerate: true });
    revalidateShow(podcastId);
    return { success: true };
  } catch (e) {
    return fail(e, "Could not queue the script.");
  }
}
