import crypto from "node:crypto";
import { db } from "../db";

export const LISTENER_MILESTONES = ["start", "15s", "60s", "180s", "complete", "next_episode", "cold_open_vote", "sounds_human", "host_distinguishable"] as const;
export type ListenerMilestone = (typeof LISTENER_MILESTONES)[number];

function sessionHash(raw: string, headers: Headers): string {
  const day = new Date().toISOString().slice(0, 10);
  const ua = headers.get("user-agent") || "";
  const salt = process.env.ANALYTICS_HASH_SALT || "take-machine-analytics";
  return crypto.createHash("sha256").update(`${raw}|${ua}|${day}|${salt}`).digest("hex").slice(0, 32);
}

function coldOpenVariant(content: unknown): string | null {
  const value = (content as { creativePipeline?: { coldOpenTournament?: { selectedId?: unknown } } } | null)?.creativePipeline?.coldOpenTournament?.selectedId;
  return typeof value === "string" ? value : null;
}

export async function recordListenerSignal(input: {
  episodeId: string;
  sessionId: string;
  milestone: ListenerMilestone;
  positionSeconds?: number;
  durationSeconds?: number;
  value?: number;
  headers: Headers;
}): Promise<void> {
  try {
    if (!LISTENER_MILESTONES.includes(input.milestone)) return;
    const episode = await db.episode.findUnique({
      where: { id: input.episodeId },
      select: { ownerId: true, podcastId: true, scripts: { orderBy: { version: "desc" }, take: 1, select: { content: true } } },
    });
    if (!episode) return;
    await db.listenerSignal.create({
      data: {
        episodeId: input.episodeId,
        ownerId: episode.ownerId,
        sessionHash: sessionHash(input.sessionId, input.headers),
        milestone: input.milestone,
        positionSeconds: Number.isFinite(input.positionSeconds) ? Math.max(0, Math.round(input.positionSeconds!)) : null,
        durationSeconds: Number.isFinite(input.durationSeconds) ? Math.max(0, Math.round(input.durationSeconds!)) : null,
        value: Number.isFinite(input.value) ? Math.max(0, Math.min(1, input.value!)) : null,
        coldOpenVariant: coldOpenVariant(episode.scripts[0]?.content),
      },
    });
    if (input.milestone === "complete" && episode.podcastId) {
      // Await the update so serverless runtimes cannot terminate the request
      // after the beacon response and silently discard the learning step.
      await updatePodcastLearningPolicy(episode.podcastId).catch(() => undefined);
    }
  } catch {
    // Unique milestone or analytics failure must never affect playback.
  }
}

export interface ListenerLearningMetrics {
  starts: number;
  retention15: number;
  retention60: number;
  retention180: number;
  completion: number;
  nextEpisodePlay: number;
  soundsHumanRate: number | null;
  hostDistinguishabilityRate: number | null;
  coldOpen: Record<string, { starts: number; retention60: number; completions: number; pairwiseWinRate: number | null }>;
}

export async function calculateListenerLearningMetrics(podcastId: string): Promise<ListenerLearningMetrics> {
  const signals = await db.listenerSignal.findMany({
    where: { episode: { podcastId } },
    select: { sessionHash: true, episodeId: true, milestone: true, value: true, coldOpenVariant: true },
  });
  const key = (s: { episodeId: string; sessionHash: string }) => `${s.episodeId}:${s.sessionHash}`;
  const sessions = (milestone: string) => new Set(signals.filter((s) => s.milestone === milestone).map(key));
  const starts = sessions("start");
  const ratio = (milestone: string) => starts.size ? [...sessions(milestone)].filter((id) => starts.has(id)).length / starts.size : 0;
  const rated = (milestone: string) => signals.filter((s) => s.milestone === milestone && s.value != null);
  const average = (rows: ReturnType<typeof rated>) => rows.length ? rows.reduce((sum, row) => sum + (row.value || 0), 0) / rows.length : null;
  const coldOpen: ListenerLearningMetrics["coldOpen"] = {};
  for (const variant of ["accusation", "consequence", "contradiction"]) {
    const variantStarts = new Set(signals.filter((s) => s.coldOpenVariant === variant && s.milestone === "start").map(key));
    const reached = (milestone: string) => signals.filter((s) => s.coldOpenVariant === variant && s.milestone === milestone && variantStarts.has(key(s))).length;
    const votes = signals.filter((s) => s.coldOpenVariant === variant && s.milestone === "cold_open_vote" && s.value != null);
    coldOpen[variant] = { starts: variantStarts.size, retention60: variantStarts.size ? reached("60s") / variantStarts.size : 0, completions: reached("complete"), pairwiseWinRate: average(votes) };
  }
  return {
    starts: starts.size,
    retention15: ratio("15s"),
    retention60: ratio("60s"),
    retention180: ratio("180s"),
    completion: ratio("complete"),
    nextEpisodePlay: ratio("next_episode"),
    soundsHumanRate: average(rated("sounds_human")),
    hostDistinguishabilityRate: average(rated("host_distinguishable")),
    coldOpen,
  };
}

export async function updatePodcastLearningPolicy(podcastId: string): Promise<{ updated: boolean; reason: string }> {
  const metrics = await calculateListenerLearningMetrics(podcastId);
  if (metrics.starts < 50) return { updated: false, reason: `Need 50 starts; have ${metrics.starts}.` };
  const scored = Object.entries(metrics.coldOpen).filter(([, m]) => m.starts >= 12).map(([id, m]) => ({ id, score: m.retention60 * 0.7 + (m.pairwiseWinRate ?? 0.5) * 0.3 }));
  if (scored.length < 2) return { updated: false, reason: "Need at least two cold-open archetypes with 12 starts each." };
  scored.sort((a, b) => b.score - a.score);
  const min = Math.min(...scored.map((x) => x.score));
  const max = Math.max(...scored.map((x) => x.score));
  const weights = Object.fromEntries(["accusation", "consequence", "contradiction"].map((id) => {
    const found = scored.find((x) => x.id === id);
    const normalized = !found || max === min ? 1 / 3 : 0.2 + ((found.score - min) / (max - min)) * 0.3;
    return [id, Math.round(normalized * 1000) / 1000];
  }));
  const config = await db.podcastEditorialConfig.findUnique({ where: { podcastId }, select: { learningPolicyVersion: true } });
  if (!config) return { updated: false, reason: "Podcast has no editorial configuration." };
  await db.podcastEditorialConfig.update({
    where: { podcastId },
    data: { learningPolicy: { version: config.learningPolicyVersion + 1, learnedFromStarts: metrics.starts, coldOpenArchetypeWeights: weights, guardrails: { minWeight: 0.2, maxWeight: 0.5, tournamentStillRequired: true }, metrics } as never, learningPolicyVersion: { increment: 1 }, learningPolicyUpdatedAt: new Date() },
  });
  return { updated: true, reason: `Updated bounded cold-open priors from ${metrics.starts} starts.` };
}
