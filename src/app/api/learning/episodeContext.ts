import "server-only";

// Resolve the attribution dimensions for one episode ONCE, server-side, so a
// listener beacon never has to send (or be trusted with) the show, format,
// host pair, opening variant, or policy versions a signal is attributed to.
//
// Nothing here is invented: a dimension the episode genuinely does not carry
// comes back as null and the aggregate simply has no row for that scope.

import { db } from "@/lib/db";
import { getRedisClient } from "@/lib/redis";
import {
  createInMemoryRateLimitStore,
  createPrismaLearningStore,
  createRedisRateLimitStore,
  hostPairKey,
  resolveLearningSecret,
  sourceIpFromHeaders,
  countryFromHeaders,
  type EpisodeAttribution,
  type LearningIntakeDeps,
  type RateLimitStore,
} from "@/lib/services/listenerLearning";

export interface EpisodeLearningContext {
  episodeId: string;
  podcastId: string | null;
  formatId: string | null;
  openingVariant: string | null;
  hostPairKey: string | null;
  voicePolicyVersion: number | null;
  productionPolicyVersion: number | null;
  /** The real cold-open variants written for this episode, if any. */
  coldOpenVariants: { variantId: string; text: string }[];
}

interface ColdOpenVariantJson {
  id?: unknown;
  lines?: { text?: unknown }[];
}

function readColdOpen(content: unknown): { selectedId: string | null; variants: { variantId: string; text: string }[] } {
  const tournament = (content as { creativePipeline?: { coldOpenTournament?: { selectedId?: unknown; variants?: unknown } } } | null)
    ?.creativePipeline?.coldOpenTournament;
  const selectedId = typeof tournament?.selectedId === "string" ? tournament.selectedId : null;
  const raw = Array.isArray(tournament?.variants) ? (tournament!.variants as ColdOpenVariantJson[]) : [];
  const variants = raw
    .map((v) => ({
      variantId: typeof v?.id === "string" ? v.id : "",
      text: (Array.isArray(v?.lines) ? v.lines : []).map((l) => String(l?.text ?? "")).filter(Boolean).join(" "),
    }))
    .filter((v) => v.variantId && v.text);
  return { selectedId, variants };
}

export async function loadEpisodeLearningContext(episodeId: string): Promise<EpisodeLearningContext | null> {
  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    select: {
      id: true,
      podcastId: true,
      formatId: true,
      hostIds: true,
      configurationSnapshot: true,
      scripts: { orderBy: { version: "desc" }, take: 1, select: { content: true } },
    },
  });
  if (!episode) return null;

  const coldOpen = readColdOpen(episode.scripts[0]?.content);
  const snapshot = episode.configurationSnapshot as Record<string, unknown> | null;
  const snapshotNumber = (key: string): number | null => {
    const v = snapshot?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  return {
    episodeId: episode.id,
    podcastId: episode.podcastId,
    formatId: episode.formatId ?? null,
    openingVariant: coldOpen.selectedId,
    hostPairKey: hostPairKey(episode.hostIds ?? []),
    // Only reported when the episode's frozen configuration actually recorded
    // one — never back-filled from whatever the show looks like today.
    voicePolicyVersion: snapshotNumber("voicePolicyVersion"),
    productionPolicyVersion: snapshotNumber("productionPolicyVersion"),
    coldOpenVariants: coldOpen.variants,
  };
}

/* ------------------------------------------------------------------ */
/* Intake wiring.                                                      */
/*                                                                     */
/* The route handlers own NO policy. They turn a Request into an        */
/* IntakeRequest, call one intake function from listenerLearning.ts     */
/* section 8, and turn the result into a response. Every rule the       */
/* adversarial suite proves offline is therefore the same code the      */
/* public endpoint runs — not a parallel implementation of it.          */
/* ------------------------------------------------------------------ */

// getRedisClient() constructs a NEW connection on every call in production, so
// it is called ONCE here rather than per request.
let cachedLimiter: RateLimitStore | null = null;

function rateLimiter(): RateLimitStore {
  if (cachedLimiter) return cachedLimiter;
  try {
    cachedLimiter = createRedisRateLimitStore(getRedisClient());
  } catch {
    // No Redis configured (local dev). A process-local counter is weaker than a
    // shared one — it multiplies each limit by the number of web processes —
    // but it is a real limiter, and the alternative is none at all.
    cachedLimiter = createInMemoryRateLimitStore();
  }
  return cachedLimiter;
}

/** The episode loader the intake uses. Attribution is resolved here, never sent. */
async function loadEpisodeAttribution(episodeId: string): Promise<EpisodeAttribution | null> {
  const ctx = await loadEpisodeLearningContext(episodeId);
  if (!ctx) return null;
  return {
    episodeId: ctx.episodeId,
    podcastId: ctx.podcastId,
    formatId: ctx.formatId,
    openingVariant: ctx.openingVariant,
    hostPairKey: ctx.hostPairKey,
    voicePolicyVersion: ctx.voicePolicyVersion,
    productionPolicyVersion: ctx.productionPolicyVersion,
    coldOpenVariants: ctx.coldOpenVariants,
  };
}

/**
 * Build the injected dependencies for one public request.
 *
 * `secret` is resolveLearningSecret(): null in production when
 * LEARNING_SIGNAL_SECRET is unset, which makes every intake call refuse with
 * 503 rather than accept attribution nobody signed.
 */
export function learningIntakeDeps(now: Date = new Date()): LearningIntakeDeps {
  return {
    store: createPrismaLearningStore(db),
    rateLimiter: rateLimiter(),
    loadEpisode: loadEpisodeAttribution,
    secret: resolveLearningSecret(),
    now,
  };
}

/** Source ip + country for one request. The ip is hashed by the intake, never stored. */
export function requestOrigin(req: Request): { sourceIp: string | null; country: string | null } {
  return { sourceIp: sourceIpFromHeaders(req.headers), country: countryFromHeaders(req.headers) };
}

/** Read a capped body as TEXT — the intake does its own size check and parse. */
export async function readCappedBody(req: Request): Promise<string> {
  try {
    return await req.text();
  } catch {
    return "";
  }
}
