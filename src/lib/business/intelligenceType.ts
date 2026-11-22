// Sports vs business routing. The type lives on Podcast.intelligenceType
// (DB enum, default SPORTS) and is set once, server-side, at creation.

import { isOwnerAccount } from "../services/entitlementService";

export type IntelligenceType = "SPORTS" | "BUSINESS";

/**
 * Controlled rollout: business podcasts are visible to owner/admin accounts
 * always, and to everyone else only when BUSINESS_PODCASTS_ENABLED=1.
 * Sports is never behind a flag.
 */
export function businessPodcastsEnabledFor(user: { role?: string | null; email?: string | null } | null | undefined): boolean {
  if (!user) return false;
  return process.env.BUSINESS_PODCASTS_ENABLED === "1" || isOwnerAccount(user);
}

/** Copy shown when a business show reaches a SPORTS-only production path. Business
 *  episodes are produced from the show's own approved topics and dossiers
 *  (businessActions.generateBusinessEpisode), never from sports topics. */
export const BUSINESS_PRODUCTION_NOT_READY =
  "Business shows produce episodes from their own research. Open the show, approve a researched topic, and generate the episode from there.";

export function isBusinessPodcast(p: { intelligenceType?: string | null } | null | undefined): boolean {
  return p?.intelligenceType === "BUSINESS";
}
