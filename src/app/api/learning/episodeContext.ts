import "server-only";

// Resolve the attribution dimensions for one episode ONCE, server-side, so a
// listener beacon never has to send (or be trusted with) the show, format,
// host pair, opening variant, or policy versions a signal is attributed to.
//
// Nothing here is invented: a dimension the episode genuinely does not carry
// comes back as null and the aggregate simply has no row for that scope.

import { db } from "@/lib/db";
import { hostPairKey } from "@/lib/services/listenerLearning";

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
