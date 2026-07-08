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
  queueLineAudioRegenJob,
} from "@/lib/queue/podcastQueue";
import { buildEpisodeFromTopics, EpisodeBuildInput } from "@/lib/services/episodeService";
import { approveEpisodeLatestScript } from "@/lib/services/scriptApproval";
import { getEpisodeTranscriptVM } from "@/lib/services/transcriptView";
import { getEpisodeMixVM } from "@/lib/services/mixView";
import { validateEpisodeForRss, publishEpisode, prepareEpisodeForPublishing } from "@/lib/services/rssPublishingService";
import { ensurePublishAssets, generateTitleOptions } from "@/lib/services/publishAssetsService";
import { episodeHasBettingContent, scanProhibitedGamblingLanguage, checkGamblingCompliance } from "@/lib/services/compliance";
import { stageForStatus } from "@/lib/createFlow";
import { isValidVertical } from "@/lib/verticals";
import { SEGMENT_MIN, SEGMENT_MAX } from "../podcasts/config";

/** Ownership guard for the Create flow's per-episode actions: the caller must
 *  be signed in AND own the episode (or be an admin). Returns the episode +
 *  its latest script id, or a standard error shape. */
type OwnedFail = { ok: false; error: { success: false; error: string } };
type OwnedOk = { ok: true; user: NonNullable<Awaited<ReturnType<typeof currentUser>>>; episode: any; scriptId: string | null };
async function ownedEpisode(episodeId: string): Promise<OwnedFail | OwnedOk> {
  const fail = (error: string): OwnedFail => ({ ok: false, error: { success: false, error } });
  const user = await currentUser();
  if (!user) return fail("Please sign in to do that.");
  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    include: { scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true } } },
  });
  if (!episode) return fail("That episode no longer exists.");
  if (episode.ownerId && episode.ownerId !== user.id && user.role !== "ADMIN") {
    return fail("That episode belongs to someone else.");
  }
  return { ok: true, user, episode, scriptId: episode.scripts[0]?.id ?? null };
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
  if (!gate.ok) return gate.error;
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
  if (!gate.ok) return gate.error;
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
  if (!gate.ok) return gate.error;
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
  if (!gate.ok) return gate.error;
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

/* ============================================================================
 * STEP 4 — Editable transcript, per-line variants, publish gate (owner-gated)
 * All reuse existing data/services; nothing here fabricates evidence.
 * ========================================================================== */

/** Rebuild the plainText transcript after an in-place line edit. */
function transcriptPlainText(segments: any[]): string {
  return (segments || [])
    .map((seg) => {
      const label = `[${String(seg?.type || "").toUpperCase()}${seg?.title ? ` — ${seg.title}` : ""}]`;
      const dialogue = (seg?.lines || []).map((l: any) => `${l.speakerName}:\n${l.text}`).join("\n\n");
      return `${label}\n\n${dialogue}`;
    })
    .join("\n\n");
}

/** Load the latest script for an owned episode, mutate the line at lineIndex,
 *  and persist content (+ plainText). Marks the line dirty so the fact-check
 *  gate treats it as unresolved until it's re-checked. */
async function mutateLatestScriptLine(
  episodeId: string,
  lineIndex: number,
  mutate: (line: any) => void
): Promise<{ success: true } | { success: false; error: string }> {
  const gate = await ownedEpisode(episodeId);
  if (!gate.ok) return gate.error;
  if (!gate.scriptId) return { success: false as const, error: "There's no script to edit yet." };

  const script = await db.script.findUnique({ where: { id: gate.scriptId }, select: { id: true, content: true } });
  if (!script) return { success: false as const, error: "Script not found." };
  const content = (script.content as any) || {};
  const segments: any[] = Array.isArray(content.segments) ? content.segments : [];

  let found = false;
  for (const seg of segments) {
    for (const line of seg?.lines || []) {
      if (line && line.lineIndex === lineIndex) {
        mutate(line);
        line.dirty = true; // edited/varied since the last fact check
        found = true;
      }
    }
  }
  if (!found) return { success: false as const, error: "That line no longer exists." };

  content.segments = segments;
  await db.script.update({
    where: { id: script.id },
    data: { content: content as any, plainText: transcriptPlainText(segments) },
  });
  revalidatePath(`/studio/episodes/${episodeId}`);
  return { success: true as const };
}

/** Read the editable transcript + citations + fact-check + gate view-model. */
export async function getEpisodeTranscript(episodeId: string) {
  const user = await currentUser();
  if (!user) return { ok: false as const, error: "Please sign in." };
  const episode = await db.episode.findUnique({ where: { id: episodeId }, select: { ownerId: true } });
  if (!episode) return { ok: false as const, error: "Episode not found." };
  if (episode.ownerId && episode.ownerId !== user.id && user.role !== "ADMIN") {
    return { ok: false as const, error: "That episode belongs to someone else." };
  }
  return getEpisodeTranscriptVM(episodeId);
}

/** Edit a line's text in place. Marks it dirty (→ unresolved until re-checked). */
export async function saveLineEdit(episodeId: string, lineIndex: number, newText: string) {
  const text = String(newText ?? "").trim();
  if (!text) return { success: false as const, error: "A line can't be empty." };
  if (text.length > 2000) return { success: false as const, error: "That line is too long." };
  return mutateLatestScriptLine(episodeId, lineIndex, (line) => {
    line.text = text;
  });
}

/** Request a plain-language variant for a line ("spicier" | "calmer" |
 *  "regenerate"). The pipeline has no per-line LLM rewrite, so this records the
 *  intent on the line (dirty + requestedTone) — the Step-5 hook the per-line
 *  audio splice will act on. Use regenerateEpisodeScript for a real rewrite. */
export async function requestLineVariant(
  episodeId: string,
  lineIndex: number,
  variant: "spicier" | "calmer" | "regenerate"
) {
  if (!["spicier", "calmer", "regenerate"].includes(variant)) {
    return { success: false as const, error: "Unknown variant." };
  }
  return mutateLatestScriptLine(episodeId, lineIndex, (line) => {
    line.requestedTone = variant;
  });
}

/** Real script rewrite via the existing generation job, tone-mapped from a
 *  plain-language variant. (Whole-script — the only rewrite the pipeline has.) */
export async function regenerateEpisodeScript(
  episodeId: string,
  tone?: "spicier" | "calmer" | "regenerate"
) {
  const gate = await ownedEpisode(episodeId);
  if (!gate.ok) return gate.error;
  const scriptStyle = tone === "spicier" ? "heated-debate" : tone === "calmer" ? "balanced-analysis" : undefined;
  try {
    const job = await queueScriptGenerationJob({ episodeId, scriptStyle: scriptStyle as any, forceRegenerate: true });
    revalidatePath(`/studio/episodes/${episodeId}`);
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to regenerate the script." };
  }
}

/**
 * Publish with the fact-check HARD GATE. Refuses (with the user's work intact —
 * no mutation) whenever any claim is unresolved or the latest FactCheckResult
 * isn't "passed". Only when the gate is clear does it call the REAL publish
 * path (validateEpisodeForRss → publishEpisode), which independently re-checks
 * fact-check status plus audio/assets.
 */
export async function attemptPublish(episodeId: string) {
  const gate = await ownedEpisode(episodeId);
  if (!gate.ok) return gate.error;

  const vm = await getEpisodeTranscriptVM(episodeId);
  if (!vm.ok) return { success: false as const, error: vm.error || "Couldn't load the transcript." };

  if (!vm.gate.canPublish) {
    const n = vm.gate.unresolvedCount;
    const msg =
      n > 0
        ? `Couldn't verify ${n} claim${n === 1 ? "" : "s"} — review or regenerate before publishing.`
        : vm.gate.reasons[0] || "This episode isn't fact-checked yet.";
    return {
      success: false as const,
      blocked: true as const,
      unresolvedCount: n,
      dirtyCount: vm.gate.dirtyCount,
      reasons: vm.gate.reasons,
      error: msg,
    };
  }

  if (!gate.scriptId) return { success: false as const, error: "No script to publish." };

  // Fact-check gate is clear — hand off to the real publish path, which
  // enforces the remaining requirements (audio, assets, metadata).
  try {
    const eligibility = await validateEpisodeForRss(gate.scriptId, "publish");
    if (!eligibility.eligible) {
      return {
        success: false as const,
        notReady: true as const,
        error: `Fact check passed, but the episode isn't publish-ready yet: ${eligibility.errorReasons.join(" ")}`,
      };
    }
    const res: any = await publishEpisode(gate.scriptId, {});
    if (res && res.success === false) return { success: false as const, error: res.error || "Publish failed." };
    revalidatePath(`/studio/episodes/${episodeId}`);
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Publish failed." };
  }
}

/* ============================================================================
 * STEP 5 — Line-level audio regen, table-read preview, mix view (owner-gated)
 * Reuses the real per-line TTS (generateTtsSegments, segmentRange) + stitcher
 * (stitchFinalEpisodeAudio). No whole-episode re-synthesis for a one-line edit.
 * ========================================================================== */

// Episode statuses at which every line is voiced, so a re-splice is valid.
const VOICED_STATUSES = [
  "audio_segments_ready",
  "audio_stitching",
  "audio_ready",
  "content_generating",
  "content_ready",
  "publish_ready",
  "published",
];

/**
 * Re-voice ONE line and re-splice the episode. Optionally nudge delivery
 * ("spicier" → high energy/heated, "calmer" → low energy/analytical) by editing
 * that line's tone/energy — which flow into synthesizeSpeech — then regenerate.
 * NOTE: this changes DELIVERY, not words; there is no per-line AI text rewrite
 * in the pipeline (see requestLineVariant / regenerateEpisodeScript).
 */
export async function regenerateLineAudio(
  episodeId: string,
  lineIndex: number,
  opts?: { tone?: "spicier" | "calmer" }
) {
  const gate = await ownedEpisode(episodeId);
  if (!gate.ok) return gate.error;
  if (!gate.scriptId) return { success: false as const, error: "There's no script to voice yet." };
  if (!VOICED_STATUSES.includes(gate.episode.status)) {
    return {
      success: false as const,
      error: "Voice the episode first — line re-voice re-splices the finished mix.",
    };
  }

  // Optional delivery nudge (tone/energy only — no fact-affecting text change,
  // so we don't mark the line dirty for the publish gate).
  if (opts?.tone) {
    const script = await db.script.findUnique({ where: { id: gate.scriptId }, select: { id: true, content: true } });
    const content = (script?.content as any) || {};
    const segments: any[] = Array.isArray(content.segments) ? content.segments : [];
    let found = false;
    for (const seg of segments) {
      for (const line of seg?.lines || []) {
        if (line && line.lineIndex === lineIndex) {
          line.energy = opts.tone === "spicier" ? "high" : "low";
          line.tone = opts.tone === "spicier" ? "heated" : "analytical";
          line.requestedTone = null;
          found = true;
        }
      }
    }
    if (found && script) {
      content.segments = segments;
      await db.script.update({ where: { id: script.id }, data: { content: content as any } });
    }
  }

  try {
    const job = await queueLineAudioRegenJob({ scriptId: gate.scriptId, lineIndex });
    revalidatePath(`/studio/episodes/${episodeId}`);
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to re-voice the line." };
  }
}

/**
 * Table read: cheaply synthesize a short span of lines (one host exchange) via
 * the SAME per-line TTS, so the user hears the vibe before committing to the
 * full episode. No stitch — the UI plays the individual line clips.
 */
export async function tableReadEpisode(episodeId: string, startLineIndex: number, endLineIndex: number) {
  const gate = await ownedEpisode(episodeId);
  if (!gate.ok) return gate.error;
  if (!gate.scriptId) return { success: false as const, error: "Write the script first." };
  const start = Math.max(0, Math.min(startLineIndex, endLineIndex));
  const end = Math.max(startLineIndex, endLineIndex);
  if (end - start > 11) return { success: false as const, error: "Keep the table read to a dozen lines." };
  try {
    const job = await queueTtsSegmentGenerationJob({
      scriptId: gate.scriptId,
      segmentRange: { startLineIndex: start, endLineIndex: end },
      forceRegenerate: true,
    });
    revalidatePath(`/studio/episodes/${episodeId}`);
    return { success: true as const, jobId: job.id };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to start the table read." };
  }
}

/** Read the mix/timeline view-model (dialogue lane + music-bed lane + cues). */
export async function getMixView(episodeId: string) {
  const user = await currentUser();
  if (!user) return { ok: false as const, error: "Please sign in." };
  const episode = await db.episode.findUnique({ where: { id: episodeId }, select: { ownerId: true } });
  if (!episode) return { ok: false as const, error: "Episode not found." };
  if (episode.ownerId && episode.ownerId !== user.id && user.role !== "ADMIN") {
    return { ok: false as const, error: "That episode belongs to someone else." };
  }
  return getEpisodeMixVM(episodeId);
}

/* ============================================================================
 * STEP 6 — Publishing (owner-gated). Reuses the real publish path
 * (validateEpisodeForRss → prepareEpisodeForPublishing → publishEpisode); the
 * gambling gate lives inside validateEpisodeForRss so every path enforces it.
 * ========================================================================== */

/** Generate/refresh publish assets (title options, cover art, and — for betting
 *  episodes — the responsible-gambling disclaimer injected into show notes). */
export async function preparePublishAssets(episodeId: string, opts?: { regenerateCover?: boolean }) {
  const gate = await ownedEpisode(episodeId);
  if (!gate.ok) return gate.error;
  try {
    const res = await ensurePublishAssets(episodeId, opts);
    revalidatePath(`/studio/episodes/${episodeId}`);
    return { success: true as const, ...res };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Failed to prepare assets." };
  }
}

/** Set the episode title (from a generated option or free text). Betting titles
 *  are scanned for prohibited profit-promise language. */
export async function setEpisodeTitle(episodeId: string, title: string) {
  const gate = await ownedEpisode(episodeId);
  if (!gate.ok) return gate.error;
  const t = String(title || "").trim();
  if (t.length < 3 || t.length > 120) return { success: false as const, error: "Title must be 3–120 characters." };

  const ep = await db.episode.findUnique({
    where: { id: episodeId },
    include: {
      podcast: { select: { verticals: true } },
      topics: { include: { topic: { select: { title: true, summary: true, leagueId: true, bettingRelevanceScore: true } } } },
    },
  });
  if (!ep) return { success: false as const, error: "Episode not found." };
  const betting = episodeHasBettingContent({
    podcastVerticals: ep.podcast?.verticals ?? null,
    topics: ep.topics.map((et) => ({ title: et.topic?.title ?? "", summary: et.topic?.summary ?? null, leagueId: et.topic?.leagueId ?? null, bettingRelevanceScore: et.topic?.bettingRelevanceScore ?? null })),
  });
  if (betting) {
    const hits = scanProhibitedGamblingLanguage(t);
    if (hits.length > 0) return { success: false as const, error: `Title can't contain: ${hits.map((h) => `"${h.match}"`).join(", ")}` };
  }
  await db.episode.update({ where: { id: episodeId }, data: { title: t } });
  revalidatePath(`/studio/episodes/${episodeId}`);
  return { success: true as const };
}

/**
 * Publish to the feed. Ensures assets (incl. disclaimer), then runs the REAL
 * gate + publish. The gate hard-blocks on the Step-4 fact-check requirement AND
 * the gambling compliance requirement — returned as structured reasons with the
 * user's work intact (nothing is mutated on refusal beyond idempotent assets).
 */
export async function publishOwnedEpisode(episodeId: string) {
  const gate = await ownedEpisode(episodeId);
  if (!gate.ok) return gate.error;
  if (!gate.scriptId) return { success: false as const, error: "No script to publish." };

  // Idempotent: injects the responsible-gambling disclaimer for betting episodes
  // so a compliant episode isn't blocked purely because assets weren't prepped.
  await ensurePublishAssets(episodeId).catch(() => {});

  const ep = await db.episode.findUnique({ where: { id: episodeId }, select: { status: true } });
  const action = ep?.status === "content_ready" ? "prepare" : "publish";
  try {
    const val = await validateEpisodeForRss(gate.scriptId, action as any);
    if (!val.eligible) {
      return { success: false as const, blocked: true as const, reasons: val.errorReasons, error: val.errorReasons[0] || "Not eligible to publish." };
    }
    if (ep?.status === "content_ready") await prepareEpisodeForPublishing(gate.scriptId);
    await publishEpisode(gate.scriptId, {});
    revalidatePath(`/studio/episodes/${episodeId}`);
    revalidatePath("/studio/publish");
    return { success: true as const };
  } catch (err: any) {
    return { success: false as const, error: err.message || "Publish failed." };
  }
}

/** Read-only publish state for the UI: status, compliance (betting?
 *  disclaimer? prohibited language?), title options, cover art, feed +
 *  download URLs. No mutation. */
export async function getPublishState(episodeId: string) {
  const user = await currentUser();
  if (!user) return { ok: false as const, error: "Please sign in." };
  const ep = await db.episode.findUnique({
    where: { id: episodeId },
    include: {
      podcast: { select: { verticals: true } },
      topics: { orderBy: { orderIndex: "asc" }, include: { topic: { select: { title: true, summary: true, leagueId: true, bettingRelevanceScore: true } } } },
    },
  });
  if (!ep) return { ok: false as const, error: "Episode not found." };
  if (ep.ownerId && ep.ownerId !== user.id && user.role !== "ADMIN") {
    return { ok: false as const, error: "That episode belongs to someone else." };
  }
  const topicTitles = ep.topics.map((et) => et.topic?.title).filter(Boolean) as string[];
  const betting = episodeHasBettingContent({
    podcastVerticals: ep.podcast?.verticals ?? null,
    topics: ep.topics.map((et) => ({ title: et.topic?.title ?? "", summary: et.topic?.summary ?? null, leagueId: et.topic?.leagueId ?? null, bettingRelevanceScore: et.topic?.bettingRelevanceScore ?? null })),
  });
  const marketingText = [ep.title, ep.rssSummary, ep.description, ep.longShowNotes].filter(Boolean).join("\n");
  const compliance = checkGamblingCompliance({ betting, showNotes: ep.longShowNotes ?? null, marketingText });
  return {
    ok: true as const,
    title: ep.title,
    status: ep.status,
    published: ep.status === "published",
    podcastId: ep.podcastId,
    betting,
    compliance,
    coverArtUrl: ep.rssImageUrl ?? null,
    hasShowNotes: !!(ep.longShowNotes && ep.longShowNotes.trim()),
    titleOptions: generateTitleOptions(ep.title, topicTitles),
    feedPath: ep.podcastId ? `/rss/${ep.podcastId}` : "/rss",
    downloadPath: `/api/episodes/${ep.id}/download`,
  };
}
