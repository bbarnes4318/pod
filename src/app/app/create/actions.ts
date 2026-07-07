"use server";

// User-surface episode-creation actions. The /app create flow used to call
// the /admin server actions directly; those are now admin-gated
// (requireAdmin), so the listener surface gets its own ungated actions that
// wrap the same services/queue jobs. Guards mirror the admin versions.

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/currentUser";
import {
  queueResearchBriefGenerationJob,
  queueScriptGenerationJob,
  queueEpisodeBuildJob,
  queueFactCheckJob,
  queueTtsSegmentGenerationJob,
  queueFinalAudioStitchJob,
  queueContentAssetGenerationJob,
} from "@/lib/queue/podcastQueue";
import { buildEpisodeFromTopics, EpisodeBuildInput } from "@/lib/services/episodeService";
import { approveEpisodeLatestScript } from "@/lib/services/scriptApproval";
import { stageForStatus } from "@/lib/createFlow";
import { isValidVertical } from "@/lib/verticals";
import { SEGMENT_MIN, SEGMENT_MAX } from "../podcasts/config";

/** Ownership guard for the Create flow's per-episode actions: the caller must
 *  be signed in AND own the episode (or be an admin). Returns the episode +
 *  its latest script id, or a standard error shape. */
async function ownedEpisode(episodeId: string) {
  const user = await currentUser();
  if (!user) return { error: { success: false as const, error: "Please sign in to do that." } };
  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    include: { scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true } } },
  });
  if (!episode) return { error: { success: false as const, error: "That episode no longer exists." } };
  if (episode.ownerId && episode.ownerId !== user.id && user.role !== "ADMIN") {
    return { error: { success: false as const, error: "That episode belongs to someone else." } };
  }
  return { user, episode, scriptId: episode.scripts[0]?.id ?? null };
}

/** Shared /app creation guard: returns the standard error shape when the
 *  caller is not signed in. Creation/management requires an account. */
async function requireSignedIn(): Promise<{ success: false; error: string } | null> {
  if (!(await currentUser())) {
    return { success: false as const, error: "Please sign in to create or manage content." };
  }
  return null;
}

/** Lock in a pending take so it can be researched. */
export async function approveTake(topicId: string) {
  try {
    const gate = await requireSignedIn(); if (gate) return gate;
    await db.topicCandidate.update({ where: { id: topicId }, data: { status: "approved" } });
    revalidatePath("/app/create");
    revalidatePath("/app/topics");
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to lock in the take." };
  }
}

/** Kick off research for an approved take. */
export async function researchTake(topicId: string, forceRegenerate = false) {
  try {
    const gate = await requireSignedIn(); if (gate) return gate;
    if (process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER) {
      throw new Error("LLM provider is stub. Real research brief generation disabled.");
    }
    const topic = await db.topicCandidate.findUnique({ where: { id: topicId } });
    if (!topic) throw new Error("That take no longer exists.");
    if (topic.status !== "approved" && topic.status !== "used") {
      throw new Error("Lock in the take before researching it.");
    }
    const job = await queueResearchBriefGenerationJob({ topicId, forceRegenerate });
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to start the research." };
  }
}

/** Build an episode from explicitly chosen (researched) takes. The optional
 *  `config` carries the Create-flow choices (title, host cast, production
 *  style, SFX density) straight into the same build service. ownerId is always
 *  stamped from the signed-in user. */
export async function produceEpisodeFromTopics(
  topicIds: string[],
  ttsProvider?: string,
  ttsVoiceOverrides?: EpisodeBuildInput["ttsVoiceOverrides"],
  config?: {
    title?: string;
    hostIds?: string[];
    productionStyle?: string;
    sfxDensity?: string;
  }
) {
  try {
    const owner = await currentUser();
    if (!owner) return { success: false as const, error: "Please sign in to create or manage content." };
    const res = await buildEpisodeFromTopics({
      topicIds,
      ttsProvider,
      ttsVoiceOverrides,
      ownerId: owner.id,
      title: config?.title,
      hostIds: config?.hostIds,
      productionStyle: config?.productionStyle,
      sfxDensity: config?.sfxDensity,
    });
    revalidatePath("/app/create");
    revalidatePath("/app/episodes");
    return { success: true as const, episodeId: res.episodeId };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to produce the episode." };
  }
}

/** Start the debate (script generation) for a draft episode. Optional style +
 *  target length flow into the existing script-generation job. */
export async function startDebate(
  episodeId: string,
  opts?: {
    scriptStyle?: "heated-debate" | "balanced-analysis" | "sports-radio";
    targetDurationMinutes?: number;
    forceRegenerate?: boolean;
  }
) {
  try {
    const gate = await requireSignedIn(); if (gate) return gate;
    const job = await queueScriptGenerationJob({
      episodeId,
      scriptStyle: opts?.scriptStyle,
      targetDurationMinutes: opts?.targetDurationMinutes,
      forceRegenerate: opts?.forceRegenerate,
    });
    revalidatePath(`/app/episodes/${episodeId}`);
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to start the debate." };
  }
}

/**
 * Standalone Create Episode: one action, no podcast required. Auto-selects
 * the best researched topics (optionally narrowed to a vertical) and
 * enqueues the full build — the same pipeline recurring podcasts use.
 */
export async function createStandaloneEpisode(input: {
  title?: string;
  vertical?: string;
  segmentCount: number;
}) {
  try {
    const owner = await currentUser();
    if (!owner) return { success: false as const, error: "Please sign in to create or manage content." };
    const segmentCount = Math.round(Number(input.segmentCount));
    if (!Number.isFinite(segmentCount) || segmentCount < SEGMENT_MIN || segmentCount > SEGMENT_MAX) {
      return { success: false as const, error: `Segments must be between ${SEGMENT_MIN} and ${SEGMENT_MAX}.` };
    }
    const title = input.title?.trim() || undefined;
    if (title && title.length > 120) {
      return { success: false as const, error: "Keep the title under 120 characters." };
    }

    let verticals: string[] | undefined;
    if (input.vertical && input.vertical !== "All") {
      if (!isValidVertical(input.vertical)) return { success: false as const, error: "Unknown vertical." };
      verticals = [input.vertical]; // matcher handles sports AND non-sport verticals
    }

    const job = await queueEpisodeBuildJob({
      title,
      verticals,
      targetTopicCount: segmentCount,
      ownerId: owner.id,
    });

    revalidatePath("/app/create");
    revalidatePath("/app/episodes");
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to create the episode." };
  }
}

/* ============================================================================
 * CHECKPOINT + DOWNSTREAM STAGE TRIGGERS (owner-gated)
 * Each wraps an EXISTING queue job — no new pipeline. The stage the episode
 * actually reaches is driven by the worker writing Episode.status; these just
 * enqueue the real work behind an ownership check.
 * ========================================================================== */

/** Checkpoint AFTER Script: the owner approves the latest script (the human
 *  review + safety gates) and we kick fact-checking. Nothing here spends TTS —
 *  voicing is a separate, explicit step. */
export async function approveEpisodeScript(episodeId: string) {
  const gate = await ownedEpisode(episodeId);
  if ("error" in gate) return gate.error;
  try {
    const res = await approveEpisodeLatestScript(episodeId);
    if (!res.success) return { success: false as const, error: res.error, reasons: res.reasons };
    if (res.scriptId) await queueFactCheckJob({ scriptId: res.scriptId });
    revalidatePath(`/app/episodes/${episodeId}`);
    return { success: true as const, scriptId: res.scriptId };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to approve the script." };
  }
}

/** Voices: synthesize the TTS segments for the approved+fact-checked script. */
export async function castEpisodeVoices(episodeId: string) {
  const gate = await ownedEpisode(episodeId);
  if ("error" in gate) return gate.error;
  if (!gate.scriptId) return { success: false as const, error: "There's no script to voice yet." };
  try {
    const job = await queueTtsSegmentGenerationJob({ scriptId: gate.scriptId });
    revalidatePath(`/app/episodes/${episodeId}`);
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to start voicing." };
  }
}

/** Mix: stitch the final episode audio (uses the episode's stored sound-design
 *  settings; the service falls back to sensible defaults). */
export async function mixEpisode(episodeId: string) {
  const gate = await ownedEpisode(episodeId);
  if ("error" in gate) return gate.error;
  if (!gate.scriptId) return { success: false as const, error: "There's nothing to mix yet." };
  try {
    const job = await queueFinalAudioStitchJob({ scriptId: gate.scriptId });
    revalidatePath(`/app/episodes/${episodeId}`);
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to start the mix." };
  }
}

/** Assets: generate show notes / transcript / chapters for the finished audio. */
export async function generateEpisodeAssets(episodeId: string) {
  const gate = await ownedEpisode(episodeId);
  if ("error" in gate) return gate.error;
  if (!gate.scriptId) return { success: false as const, error: "There are no assets to build yet." };
  try {
    const job = await queueContentAssetGenerationJob({ scriptId: gate.scriptId });
    revalidatePath(`/app/episodes/${episodeId}`);
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to build assets." };
  }
}

/**
 * REAL progress for the Create flow. This is the source the streaming UI polls:
 * it reflects Episode.status (written by the worker as each pipeline job
 * completes) plus the artifacts that have actually landed — the ResearchBrief,
 * the generated Script (with its lines), and the AudioSegment rows. No mock
 * stages; everything here is a live read of what the pipeline has produced.
 */
export async function getCreateProgress(params: { topicId?: string; episodeId?: string }) {
  const user = await currentUser();
  if (!user) return { ok: false as const, error: "Please sign in." };

  // Research brief (lives on the topic, before the episode exists).
  let brief: null | {
    present: boolean;
    whyMattersNow: string | null;
    mainAngle: string | null;
    factCount: number;
    argA: string | null;
    argB: string | null;
    talkingPoints: string[];
  } = null;
  if (params.topicId) {
    const rb = await db.researchBrief.findUnique({ where: { topicId: params.topicId } });
    if (rb) {
      const facts = Array.isArray(rb.keyFactsContext) && rb.keyFactsContext.length
        ? (rb.keyFactsContext as any[])
        : Array.isArray(rb.facts) ? (rb.facts as any[]) : [];
      const tps = Array.isArray(rb.onAirTalkingPoints) ? (rb.onAirTalkingPoints as any[]) : [];
      brief = {
        present: true,
        whyMattersNow: rb.whyMattersNow ?? null,
        mainAngle: rb.mainAngle ?? null,
        factCount: facts.length,
        argA: rb.argumentForHostA ?? null,
        argB: rb.argumentForHostB ?? null,
        talkingPoints: tps.map((t: any) => (typeof t === "string" ? t : String(t?.text || t?.point || ""))).filter(Boolean).slice(0, 6),
      };
    } else {
      brief = { present: false, whyMattersNow: null, mainAngle: null, factCount: 0, argA: null, argB: null, talkingPoints: [] };
    }
  }

  if (!params.episodeId) {
    return { ok: true as const, stage: brief?.present ? "research" : "research", brief, episode: null, script: null, audio: null };
  }

  const episode = await db.episode.findUnique({
    where: { id: params.episodeId },
    select: { id: true, title: true, status: true, ownerId: true, audioUrl: true, durationSeconds: true, transcriptUrl: true },
  });
  if (!episode) return { ok: false as const, error: "Episode not found." };
  if (episode.ownerId && episode.ownerId !== user.id && user.role !== "ADMIN") {
    return { ok: false as const, error: "That episode belongs to someone else." };
  }

  const scriptRow = await db.script.findFirst({
    where: { episodeId: episode.id },
    orderBy: { version: "desc" },
    select: { id: true, version: true, status: true, content: true },
  });

  let script: null | {
    present: boolean;
    id: string;
    version: number;
    status: string;
    lineCount: number;
    estMinutes: number | null;
    quality: number | null;
    lines: { speaker: string; text: string; tone: string | null }[];
  } = null;
  if (scriptRow) {
    const content = (scriptRow.content as any) || {};
    const segs = Array.isArray(content.segments) ? content.segments : [];
    const lines: { speaker: string; text: string; tone: string | null }[] = [];
    for (const seg of segs) {
      for (const ln of seg?.lines || []) {
        if (!ln?.text) continue;
        lines.push({ speaker: String(ln.speakerName || ""), text: String(ln.text), tone: ln.tone ?? null });
      }
    }
    script = {
      present: true,
      id: scriptRow.id,
      version: scriptRow.version,
      status: scriptRow.status,
      lineCount: lines.length,
      estMinutes: typeof content.estimatedDurationMinutes === "number" ? content.estimatedDurationMinutes : null,
      quality: content.quality && typeof content.quality.total === "number" ? content.quality.total : null,
      lines: lines.slice(0, 400),
    };
  }

  // Audio segments — how many lines have been voiced so far.
  const [totalSegments, readySegments] = await Promise.all([
    db.audioSegment.count({ where: { episodeId: episode.id } }),
    db.audioSegment.count({ where: { episodeId: episode.id, status: "ready" } }),
  ]);

  const stage = stageForStatus(episode.status, !!scriptRow);

  return {
    ok: true as const,
    stage,
    brief,
    episode: {
      id: episode.id,
      title: episode.title,
      status: episode.status,
      audioUrl: episode.audioUrl,
      durationSeconds: episode.durationSeconds,
      transcriptUrl: episode.transcriptUrl,
    },
    script,
    audio: { totalSegments, readySegments },
  };
}
