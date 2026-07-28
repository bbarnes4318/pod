import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { canonicalJson } from "@/lib/services/podcastConfiguration";
import { supportsAdvisoryLocks } from "@/lib/services/topicReservation";
import { resolveEpisodeTopicContent } from "@/lib/services/topicSnapshot";
import {
  decodeShowForgeState,
  renderShowForgePrompt,
  type ShowForgeState,
  type StorylineAssignment,
} from "./showForge";

export interface FrozenShowForgeExecution {
  version: 1;
  /** Stable for the authored storyline plan. Changing only tone/sound does not restart it. */
  sequenceId: string;
  /** Zero-based reservation index within this storyline sequence. */
  episodeIndex: number;
  /** Frozen for audit and display; null means a standalone episode inside the show bible. */
  assignment: StorylineAssignment | null;
  reservedAt: string;
}

interface SnapshotLike {
  editorial?: { scriptStyle?: unknown };
  showForgeExecution?: unknown;
  [key: string]: unknown;
}

function asSnapshot(value: unknown): SnapshotLike | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as SnapshotLike : null;
}

function parseExecution(value: unknown): FrozenShowForgeExecution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<FrozenShowForgeExecution>;
  if (raw.version !== 1 || typeof raw.sequenceId !== "string" || !Number.isInteger(raw.episodeIndex) || Number(raw.episodeIndex) < 0) return null;
  return {
    version: 1,
    sequenceId: raw.sequenceId,
    episodeIndex: Number(raw.episodeIndex),
    assignment: (raw.assignment ?? null) as StorylineAssignment | null,
    reservedAt: typeof raw.reservedAt === "string" ? raw.reservedAt : "",
  };
}

/**
 * A sequence id is intentionally based only on the authored arcs. Editing show
 * tone, rituals, or recurring segments does not restart story progression.
 * Editing the arc plan does create a new sequence, which is the honest result:
 * the ordered story the user asked us to execute has changed.
 */
export function showForgeSequenceId(state: ShowForgeState): string {
  const material = state.storylines.map((storyline) => ({
    id: storyline.id,
    title: storyline.title,
    premise: storyline.premise,
    status: storyline.status,
    priority: storyline.priority,
    featuredHostIds: storyline.featuredHostIds,
    beats: storyline.beats,
  }));
  return crypto.createHash("sha256").update(canonicalJson(material)).digest("hex").slice(0, 24);
}

function episodeTopicTitles(episode: { topics: Array<{ snapshot: unknown; topic: { title: string } }> }): string[] {
  return episode.topics.map((entry) => {
    try {
      return resolveEpisodeTopicContent(entry as never).title;
    } catch {
      return entry.topic.title;
    }
  }).filter(Boolean);
}

function topicMatchScore(titles: string[], prompt: string): number {
  const haystack = prompt.toLowerCase();
  return titles.reduce((score, title) => score + (haystack.includes(title.toLowerCase()) ? 1 : 0), 0);
}

async function findGeneratingEpisode(podcastId: string, topicText: string) {
  const candidates = await db.episode.findMany({
    where: { podcastId, status: { in: ["draft", "script_draft"] } },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    take: 20,
    select: {
      id: true,
      configurationSnapshot: true,
      topics: { orderBy: { orderIndex: "asc" }, select: { snapshot: true, topic: { select: { title: true } } } },
    },
  });
  const ranked = candidates
    .map((episode) => ({ episode, score: topicMatchScore(episodeTopicTitles(episode), topicText) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score === 0) return null;
  if (ranked[1] && ranked[1].score === best.score) {
    console.warn(`[ShowForge] Multiple draft episodes for podcast ${podcastId} matched the generation topic packet; using most recently updated ${best.episode.id}.`);
  }
  return best.episode;
}

/**
 * Resolve the Show Forge prompt from THIS episode's frozen configuration and
 * atomically reserve its storyline beat. No current podcast edit can rewrite a
 * created episode, and two simultaneous script jobs cannot claim the same beat.
 */
export async function frozenShowForgeForGeneration(
  podcastId: string,
  topicText: string
): Promise<{ prompt: string; assignment: StorylineAssignment | null; execution: FrozenShowForgeExecution } | null> {
  const episode = await findGeneratingEpisode(podcastId, topicText);
  if (!episode) return null;
  const initialSnapshot = asSnapshot(episode.configurationSnapshot);
  const decoded = decodeShowForgeState(initialSnapshot?.editorial?.scriptStyle);
  if (!decoded.state || !initialSnapshot) return null;
  const state = decoded.state;
  const sequenceId = showForgeSequenceId(state);

  const existing = parseExecution(initialSnapshot.showForgeExecution);
  if (existing && existing.sequenceId === sequenceId) {
    const rendered = renderShowForgePrompt(state, existing.episodeIndex);
    return { prompt: rendered.prompt, assignment: existing.assignment ?? rendered.assignment, execution: existing };
  }

  return db.$transaction(async (tx) => {
    if (supportsAdvisoryLocks(tx)) {
      await tx.$queryRawUnsafe(
        "SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) _lock",
        `show-forge:${podcastId}:${sequenceId}`
      );
    }

    const current = await tx.episode.findUnique({ where: { id: episode.id }, select: { configurationSnapshot: true } });
    const snapshot = asSnapshot(current?.configurationSnapshot);
    if (!snapshot) return null;
    const currentState = decodeShowForgeState(snapshot.editorial?.scriptStyle).state;
    if (!currentState) return null;
    const currentSequenceId = showForgeSequenceId(currentState);
    const already = parseExecution(snapshot.showForgeExecution);
    if (already && already.sequenceId === currentSequenceId) {
      const rendered = renderShowForgePrompt(currentState, already.episodeIndex);
      return { prompt: rendered.prompt, assignment: already.assignment ?? rendered.assignment, execution: already };
    }

    const prior = await tx.episode.findMany({
      where: { podcastId, id: { not: episode.id } },
      select: { configurationSnapshot: true },
    });
    const episodeIndex = prior.reduce((count, row) => {
      const execution = parseExecution(asSnapshot(row.configurationSnapshot)?.showForgeExecution);
      return count + (execution?.sequenceId === currentSequenceId ? 1 : 0);
    }, 0);
    const rendered = renderShowForgePrompt(currentState, episodeIndex);
    const execution: FrozenShowForgeExecution = {
      version: 1,
      sequenceId: currentSequenceId,
      episodeIndex,
      assignment: rendered.assignment,
      reservedAt: new Date().toISOString(),
    };
    const updatedSnapshot: SnapshotLike = { ...snapshot, showForgeExecution: execution };
    await tx.episode.update({
      where: { id: episode.id },
      data: { configurationSnapshot: updatedSnapshot as Prisma.InputJsonValue },
    });
    return { prompt: rendered.prompt, assignment: rendered.assignment, execution };
  });
}
