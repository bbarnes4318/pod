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

/** Copy shown when a business show reaches a sports-only production path. */
export const BUSINESS_PRODUCTION_NOT_READY =
  "Business shows can't generate episodes yet — their research-to-production adapter isn't built. Your business profile and research are saved.";

export function isBusinessPodcast(p: { intelligenceType?: string | null } | null | undefined): boolean {
  return p?.intelligenceType === "BUSINESS";
}
