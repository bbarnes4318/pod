"use server";

// Server actions for the Admin rundown builder.
//
// THE AUTHORIZATION BOUNDARY. Every export here calls requireAdmin() FIRST and
// derives the operator identity from adminIdentity() — the server-verified HTTP
// Basic Auth credential. Nothing in this file reads a role, an ownerId, an
// isAdmin flag, or any other authority signal out of the client payload: a
// browser cannot escalate by sending one, because none is ever consulted.
//
// The business rules live in the SHARED services (adminRundown → rundownCreation
// → createEpisodeDraft, topicEligibility). This layer only authorizes, audits,
// and revalidates.

import { requireAdmin, adminIdentity } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  getAdminTopicsFor,
  createAdminEpisodeFor,
  resumeAdminRundown,
  saveAdminDraftFor,
  discardAdminDraftFor,
  type AdminCtx,
  type AdminRundownInput,
} from "@/lib/services/adminRundown";
import { queueResearchBriefGenerationJob } from "@/lib/queue/podcastQueue";
import { consumeRateLimit, rateLimitMessage } from "@/lib/rateLimit";
import { shouldStubQueue } from "@/lib/e2eSeam";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";

/** Build the audited admin context. Only callable after requireAdmin() has passed. */
function adminCtx(): AdminCtx {
  return { admin: { id: adminIdentity() }, db };
}

/**
 * Durable audit record for a high-risk admin action, plus a structured log
 * line. Follows the existing `admin:*` JobLog convention. Auditing must never
 * block the operation — the console line is the fallback.
 */
async function audit(action: string, record: Record<string, unknown>): Promise<void> {
  const entry = { admin: adminIdentity(), at: new Date().toISOString(), ...record };
  console.warn(`[audit] ${action}`, entry);
  try {
    await db.jobLog.create({
      data: { jobType: `admin:${action}`, status: "completed", input: entry as Prisma.InputJsonValue, output: {} },
    });
  } catch {
    // Never block the action on an audit-write failure.
  }
}

/** The authorized global topic board, every topic carrying its shared eligibility. */
export async function fetchAdminRundownTopics(opts: { podcastId?: string | null; selectedTopicIds?: string[] } = {}) {
  await requireAdmin();
  try {
    return await getAdminTopicsFor(adminCtx(), opts);
  } catch (err) {
    return { success: false as const, error: (err as Error).message || "Failed to load topics." };
  }
}

/** Restore the saved rundown + report topics whose eligibility changed. */
export async function resumeAdminRundownDraft() {
  await requireAdmin();
  try {
    const res = await resumeAdminRundown(adminCtx());
    return { success: true as const, ...res };
  } catch (err) {
    return { success: false as const, error: (err as Error).message || "Failed to resume the draft." };
  }
}

export async function saveAdminRundownDraft(state: unknown) {
  await requireAdmin();
  try {
    return await saveAdminDraftFor(adminCtx(), state);
  } catch (err) {
    return { success: false as const, error: (err as Error).message || "Failed to save the draft." };
  }
}

export async function discardAdminRundownDraft() {
  await requireAdmin();
  try {
    return await discardAdminDraftFor(adminCtx());
  } catch (err) {
    return { success: false as const, error: (err as Error).message || "Failed to discard the draft." };
  }
}

/**
 * Create the episode from the Admin rundown, through the SHARED creation core.
 *
 * `reuseOverride` is the one admin-gated capability. It is audited here BEFORE
 * creation, and the shared core independently refuses to honour it for any
 * non-admin actor — so this action is the only way it can ever be applied.
 */
export async function createAdminRundownEpisode(input: AdminRundownInput, opts?: { reuseOverrideReason?: string }) {
  await requireAdmin();
  try {
    if (input.reuseOverride) {
      await audit("reuse-override", {
        podcastId: input.podcastId ?? null,
        topicIds: input.selectedTopicIds ?? [],
        reason: opts?.reuseOverrideReason ?? null,
        surface: "admin-rundown",
      });
    }

    const res = await createAdminEpisodeFor(adminCtx(), input);
    if (res.success) {
      revalidatePath("/admin/episodes");
      await audit("episode-create", {
        episodeId: res.episodeId,
        mode: res.mode,
        finalOrder: res.finalOrder,
        reuseOverrideApplied: res.reuseOverrideApplied,
      });
    }
    return res;
  } catch (err) {
    return { success: false as const, error: (err as Error).message || "Failed to create the episode." };
  }
}

/**
 * Approve a pending topic — the REAL existing editorial workflow
 * (admin/topics/actions.ts approveTopic), now audited and reachable from the
 * rundown board so an operator doesn't have to leave the builder.
 *
 * Returns the re-evaluated topic so the caller can refresh a single card.
 */
export async function approveTopicFromRundown(topicId: string): Promise<
  { success: true; topic: StudioTopicVM | null } | { success: false; error: string }
> {
  await requireAdmin();
  try {
    const topic = await db.topicCandidate.findUnique({ where: { id: topicId }, select: { id: true, status: true, title: true } });
    if (!topic) return { success: false, error: "That topic no longer exists." };
    if (topic.status === "approved") return { success: false, error: "That topic is already approved." };

    await db.topicCandidate.update({ where: { id: topicId }, data: { status: "approved" } });
    await audit("topic-approve", { topicId, title: topic.title, previousStatus: topic.status });

    revalidatePath("/admin/topics");
    revalidatePath("/admin/episodes");
    const pool = await getAdminTopicsFor(adminCtx());
    return { success: true, topic: pool.success ? pool.topics.find((t) => t.id === topicId) ?? null : null };
  } catch (err) {
    return { success: false, error: (err as Error).message || "Failed to approve the topic." };
  }
}

/**
 * Start or regenerate research — the REAL existing workflow
 * (research-briefs/actions.ts triggerResearchBriefGeneration), which enqueues
 * the `generate:research-brief` job. Regeneration is the same workflow with
 * forceRegenerate, and is audited because it overwrites editorial work.
 *
 * The upstream workflow requires an APPROVED topic; that precondition is
 * re-checked here so the operator gets the real reason instead of a queued job
 * that quietly fails.
 */
export async function requestResearchFromRundown(topicId: string, forceRegenerate = false) {
  await requireAdmin();
  try {
    const gate = await consumeRateLimit("researchEnqueue", adminIdentity());
    if (!gate.allowed) {
      return { success: false as const, error: rateLimitMessage("researchEnqueue", gate.retryAfterSeconds) };
    }

    const topic = await db.topicCandidate.findUnique({
      where: { id: topicId },
      select: { id: true, status: true, title: true, researchBrief: { select: { id: true } } },
    });
    if (!topic) return { success: false as const, error: "That topic no longer exists." };
    if (topic.status !== "approved") {
      return { success: false as const, error: `Research needs an approved topic (status: ${topic.status}). Approve it first.` };
    }
    if (topic.researchBrief && !forceRegenerate) {
      return { success: false as const, error: "That topic already has a research brief. Use Regenerate to replace it." };
    }

    // Audit the AUTHORIZED INTENT before acting, matching the reuse-override
    // pattern. Auditing after the enqueue would lose the record entirely
    // whenever the queue is unreachable — exactly the case where knowing an
    // operator tried to overwrite editorial work matters most.
    if (forceRegenerate) {
      await audit("research-regenerate", { topicId, title: topic.title });
    }
    // Idempotent id: a double-click cannot queue the same expensive LLM run
    // twice. Regeneration carries its own id so it isn't swallowed by the
    // record of a prior first run.
    const jobId = `research:${topicId}:${forceRegenerate ? "regen" : "initial"}`;
    const job = shouldStubQueue()
      ? { id: `e2e-stub-${jobId}` } // Redis is an EXTERNAL boundary; the harness runs without it.
      : await queueResearchBriefGenerationJob({ topicId, forceRegenerate }, { jobId });
    revalidatePath("/admin/episodes");
    return { success: true as const, jobId: job.id };
  } catch (err) {
    return { success: false as const, error: (err as Error).message || "Failed to queue research." };
  }
}
