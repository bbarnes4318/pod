// Unified episode-creation domain service — ONE source of truth for turning a
// topic selection into a draft Episode, across /admin, /app, /studio, saved
// podcasts, and the recurring scheduler.
//
// Business rules live here; AUTHORIZATION (who may call) stays in the surface
// server actions. The service never trusts the caller for eligibility: it
// re-validates topics, hosts, TTS/production settings, and owner/podcast access
// against the database and returns a STRUCTURED result — selected, rejected
// (with per-topic reasons), auto-selected, and final order — so no
// user-selected topic is ever silently discarded.

import { z } from "zod";
import { db } from "../db";
import {
  TopicWithBrief,
  evaluateTopicEligibility,
  selectAutoTopics,
  createEpisodeRecord,
  normalizeEpisodeSettings,
  assertHostsCastable,
} from "./episodeService";

/** Configurable hard cap on topics per episode (spec: max six). */
export const MAX_TOPICS_PER_EPISODE = (() => {
  const n = Number(process.env.MAX_TOPICS_PER_EPISODE);
  return Number.isFinite(n) && n >= 1 && n <= 12 ? Math.floor(n) : 6;
})();

/** Default target when the caller doesn't specify one. */
const DEFAULT_TARGET_TOPIC_COUNT = 3;

export type EpisodeCreationMode = "manual" | "automatic" | "hybrid";

const nonEmptyId = z.string().trim().min(1, "Topic ids must be non-empty strings.");

export const CreateEpisodeDraftInputSchema = z
  .object({
    mode: z.enum(["manual", "automatic", "hybrid"]),
    selectedTopicIds: z.array(nonEmptyId).default([]),
    targetTopicCount: z
      .number()
      .int("targetTopicCount must be a whole number.")
      .positive("targetTopicCount must be positive.")
      .max(MAX_TOPICS_PER_EPISODE, `No more than ${MAX_TOPICS_PER_EPISODE} topics per episode.`)
      .optional(),
    ownerId: z.string().trim().min(1).optional(),
    podcastId: z.string().trim().min(1).optional(),
    title: z.string().trim().max(200).optional(),
    description: z.string().trim().max(4000).optional(),
    verticals: z.array(z.string().trim().min(1)).optional(),
    leagueIds: z.array(z.string().trim().min(1)).optional(),
    teams: z.array(z.string().trim().min(1)).optional(),
    hostIds: z.array(nonEmptyId).optional(),
    ttsProvider: z.string().trim().min(1).optional(),
    ttsVoiceOverrides: z.unknown().optional(),
    productionStyle: z.string().trim().min(1).optional(),
    sfxDensity: z.string().trim().min(1).optional(),
    // Auto-selection narrowing (also honored in hybrid fill).
    minDebateScore: z.number().optional(),
    leagueId: z.string().trim().min(1).optional(),
    sport: z.string().trim().min(1).optional(),
  })
  .superRefine((val, ctx) => {
    const deduped = [...new Set(val.selectedTopicIds.map((s) => s.trim()))];
    const target = val.targetTopicCount ?? DEFAULT_TARGET_TOPIC_COUNT;

    if (val.mode === "manual" && deduped.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Manual mode requires at least one selected topic." });
    }
    if (val.mode === "automatic" && deduped.length > 0) {
      // Not fatal, but flag it so the caller knows the picks are ignored.
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Automatic mode ignores selectedTopicIds; use manual or hybrid to pin topics." });
    }
    if (val.mode === "hybrid" && deduped.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: "Hybrid mode requires at least one pinned topic (use automatic for none)." });
    }
    if (val.mode === "hybrid" && deduped.length > target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: `Hybrid mode: pinned topics (${deduped.length}) cannot exceed targetTopicCount (${target}).` });
    }
    if (deduped.length > MAX_TOPICS_PER_EPISODE) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selectedTopicIds"], message: `No more than ${MAX_TOPICS_PER_EPISODE} topics per episode (got ${deduped.length}).` });
    }
  });

export type CreateEpisodeDraftInput = z.input<typeof CreateEpisodeDraftInputSchema>;

export interface RejectedTopic {
  id: string;
  reason: string;
  category?: string;
}

export interface SelectedTopicRef {
  id: string;
  title: string;
  /** true = the user pinned it; false = system auto-selected. */
  pinned: boolean;
}

export interface CreateEpisodeDraftResult {
  ok: boolean;
  mode: EpisodeCreationMode;
  episodeId: string | null;
  selectedTopics: SelectedTopicRef[];
  rejectedTopics: RejectedTopic[];
  autoSelectedTopicIds: string[];
  finalOrder: string[];
  reasons: string[];
  error?: string;
}

function fail(
  mode: EpisodeCreationMode,
  error: string,
  extra?: Partial<CreateEpisodeDraftResult>
): CreateEpisodeDraftResult {
  return {
    ok: false,
    mode,
    episodeId: null,
    selectedTopics: [],
    rejectedTopics: [],
    autoSelectedTopicIds: [],
    finalOrder: [],
    reasons: [],
    error,
    ...extra,
  };
}

/** Dedupe while preserving first-seen order. */
function dedupePreserveOrder(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Create a draft episode from a topic selection. Pure business logic — the
 * caller must have already authorized the request and should pass the real
 * `ownerId`. Returns a structured result; only throws on unexpected
 * infrastructure errors.
 */
export async function createEpisodeDraft(rawInput: CreateEpisodeDraftInput): Promise<CreateEpisodeDraftResult> {
  const parsed = CreateEpisodeDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const mode = (rawInput as any)?.mode ?? "manual";
    return fail(mode, first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input.", {
      reasons: parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`),
    });
  }
  const input = parsed.data;
  const mode = input.mode;
  const target = input.targetTopicCount ?? DEFAULT_TARGET_TOPIC_COUNT;
  const pinnedIds = dedupePreserveOrder(input.selectedTopicIds);
  const reasons: string[] = [];

  // ---- Settings validation (TTS / production) ----
  let settings;
  try {
    settings = normalizeEpisodeSettings(input);
  } catch (err: any) {
    return fail(mode, err.message);
  }

  // ---- Owner / podcast access ----
  if (input.podcastId) {
    const podcast = await db.podcast.findUnique({ where: { id: input.podcastId }, select: { id: true, ownerId: true } });
    if (!podcast) return fail(mode, "That podcast no longer exists.");
    if (podcast.ownerId && input.ownerId && podcast.ownerId !== input.ownerId) {
      return fail(mode, "That podcast belongs to another account.");
    }
  }

  // ---- Host casting (scoped to the owner + shared hosts) ----
  try {
    await assertHostsCastable(input.hostIds || [], input.ownerId);
  } catch (err: any) {
    return fail(mode, err.message);
  }

  // ---- Resolve topics per mode ----
  const rejectedTopics: RejectedTopic[] = [];
  const pinnedTopics: TopicWithBrief[] = [];
  let autoTopics: TopicWithBrief[] = [];

  if (mode === "manual" || mode === "hybrid") {
    for (const id of pinnedIds) {
      const topic = (await db.topicCandidate.findUnique({
        where: { id },
        include: { researchBrief: true },
      })) as unknown as TopicWithBrief | null;
      const eligibility = evaluateTopicEligibility(topic, id);
      if (!eligibility.ok) {
        // Surface the rejection — never silently drop a user pick.
        rejectedTopics.push({ id, reason: eligibility.reason!, category: eligibility.category });
        continue;
      }
      pinnedTopics.push(topic!);
    }
  }

  if (mode === "automatic" || mode === "hybrid") {
    const need = mode === "automatic" ? target : Math.max(0, target - pinnedTopics.length);
    if (need > 0) {
      const auto = await selectAutoTopics({
        targetCount: need,
        minDebateScore: input.minDebateScore,
        leagueId: input.leagueId,
        leagueIds: input.leagueIds,
        sport: input.sport,
        verticals: input.verticals,
        teamNames: input.teams,
        excludeTopicIds: pinnedTopics.map((t) => t.id),
      });
      autoTopics = auto.chosen;
      reasons.push(...auto.reasons);
    }
  }

  const orderedTopics: TopicWithBrief[] = [...pinnedTopics, ...autoTopics];

  if (orderedTopics.length === 0) {
    return fail(mode, "No valid topic is available to build the episode.", {
      rejectedTopics,
      reasons,
    });
  }

  if (orderedTopics.length > MAX_TOPICS_PER_EPISODE) {
    orderedTopics.length = MAX_TOPICS_PER_EPISODE;
  }

  // ---- Create the record via the single shared primitive ----
  let episodeId: string;
  try {
    episodeId = await createEpisodeRecord(
      orderedTopics,
      {
        title: input.title,
        description: input.description,
        podcastId: input.podcastId,
        ownerId: input.ownerId,
        hostIds: input.hostIds,
        ttsProvider: settings.ttsProvider,
        ttsVoiceOverrides: settings.ttsVoiceOverrides,
        soundDesign: settings.soundDesign,
        leagueId: input.leagueId,
        sport: input.sport,
      },
      reasons
    );
  } catch (err: any) {
    return fail(mode, err.message || "Failed to create the episode.", { rejectedTopics, reasons });
  }

  const pinnedIdSet = new Set(pinnedTopics.map((t) => t.id));
  return {
    ok: true,
    mode,
    episodeId,
    selectedTopics: orderedTopics.map((t) => ({ id: t.id, title: t.title, pinned: pinnedIdSet.has(t.id) })),
    rejectedTopics,
    autoSelectedTopicIds: autoTopics.map((t) => t.id),
    finalOrder: orderedTopics.map((t) => t.id),
    reasons,
  };
}
