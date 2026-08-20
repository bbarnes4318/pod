// Monetization tiers — the SINGLE source of truth for plan limits + feature
// entitlements (Step 9c). No billing here: this is the tier/entitlement model a
// future payment webhook would drive by writing User.plan. Nothing in this file
// touches a payment processor.

export type PlanId = "free" | "creator" | "pro";

export interface PlanConfig {
  id: PlanId;
  name: string;
  /** Display-only price copy — NOT wired to any processor. */
  priceLabel: string;
  blurb: string;
  /** Episodes an account may GENERATE per calendar month. null = unlimited. */
  maxEpisodesPerMonth: number | null;
  /** May use premium TTS engines (ElevenLabs/Cartesia/Boson) at generation. */
  premiumVoices: boolean;
  /** Podcasts (shows) an account may own. null = unlimited. */
  maxPodcasts: number | null;
  /** Private / premium RSS feeds (token-gated). */
  privateFeeds: boolean;
  /** Team seats included. */
  teamSeats: number;
  /** Human-readable feature bullets for the pricing UI. */
  features: string[];
}

export const PLANS: Record<PlanId, PlanConfig> = {
  free: {
    id: "free",
    name: "Free",
    priceLabel: "$0",
    blurb: "Make as many episodes as you like.",
    /**
     * NO MONTHLY EPISODE CAP ON FREE — removed deliberately, not overlooked.
     *
     * The cap was 4, and it fired on the owner's own account while the free
     * generation tier was being debugged: "You've used all 4 episodes on the
     * Free plan this month (resets Sep 1)." A metering fence that blocks the
     * operator from testing the thing it meters is worse than no fence.
     *
     * `null` is the value the whole stack already means by "unlimited" —
     * getEpisodeUsage returns remaining: null, assertCanCreateEpisode passes
     * without counting, and PlanClient renders "/ ∞". Nothing else needed
     * changing, which is what a single source of truth is for.
     *
     * The OTHER free-plan limits are untouched and still enforced: one podcast,
     * standard voices only, no private feeds.
     */
    maxEpisodesPerMonth: null,
    premiumVoices: false,
    maxPodcasts: 1,
    privateFeeds: false,
    teamSeats: 1,
    features: [
      "Unlimited episodes",
      "1 podcast",
      "Standard voices (Fish Audio)",
      "Public RSS + downloads",
      "Analytics",
    ],
  },
  creator: {
    id: "creator",
    name: "Creator",
    priceLabel: "$19/mo",
    blurb: "For regular shows that need real voices and room to publish.",
    maxEpisodesPerMonth: 30,
    premiumVoices: true,
    maxPodcasts: 5,
    privateFeeds: false,
    teamSeats: 1,
    features: [
      "30 episodes / month",
      "Up to 5 podcasts",
      "Premium voices (ElevenLabs, Cartesia, Boson)",
      "Advanced Producer controls",
      "Social clips",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceLabel: "$79/mo",
    blurb: "Studios and networks — high volume, private feeds, a team.",
    maxEpisodesPerMonth: 250,
    premiumVoices: true,
    maxPodcasts: null,
    privateFeeds: true,
    teamSeats: 5,
    features: [
      "250 episodes / month",
      "Unlimited podcasts",
      "Premium voices",
      "Private / premium RSS feeds",
      "5 team seats",
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ["free", "creator", "pro"];
export const DEFAULT_PLAN: PlanId = "free";

/**
 * The operator/owner's implicit entitlements — every feature on, no caps.
 * Deliberately NOT in PLANS/PLAN_ORDER: it can't be picked on the pricing
 * surface, setUserPlanId() can't write it, and no billing webhook will ever
 * produce it. entitlementService grants it to owner/admin accounts
 * (User.role === "ADMIN", or an email listed in OWNER_EMAILS); every other
 * account keeps the normal tier ladder + enforcement above.
 */
export const OWNER_PLAN: PlanConfig = {
  id: "pro", // top tier in plan-id terms; the limits below are wider than Pro's
  name: "Owner",
  priceLabel: "—",
  blurb: "Operator account — full access, no caps.",
  maxEpisodesPerMonth: null,
  premiumVoices: true,
  maxPodcasts: null,
  privateFeeds: true,
  teamSeats: 5,
  features: [
    "Unlimited episodes",
    "Unlimited podcasts",
    "All premium voices",
    "Private / premium RSS feeds",
  ],
};

/** TTS engines that count as "premium" and require a premium-voices plan.
 *  Fish is NOT premium: it is the platform default engine, so every plan is
 *  already generating with it whenever a user doesn't override the provider.
 *  Gating it would only have blocked users from naming the engine they were
 *  being given anyway — and OpenAI, the old free-tier engine, is gone. */
export const PREMIUM_TTS_PROVIDERS = ["elevenlabs", "cartesia", "boson"] as const;

export function isPlanId(v: unknown): v is PlanId {
  return typeof v === "string" && (PLAN_ORDER as string[]).includes(v);
}

/** Normalize any stored/legacy value to a real plan config (defaults to free). */
export function planFor(plan?: string | null): PlanConfig {
  return isPlanId(plan) ? PLANS[plan] : PLANS[DEFAULT_PLAN];
}

export function isPremiumTtsProvider(provider?: string | null): boolean {
  return !!provider && (PREMIUM_TTS_PROVIDERS as readonly string[]).includes(provider.trim().toLowerCase());
}
