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
  /** May use premium TTS engines (ElevenLabs/Cartesia/Fish/Boson) at generation. */
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
    blurb: "Kick the tires — make a few episodes a month.",
    maxEpisodesPerMonth: 4,
    premiumVoices: false,
    maxPodcasts: 1,
    privateFeeds: false,
    teamSeats: 1,
    features: [
      "4 episodes / month",
      "1 podcast",
      "Standard voices (OpenAI)",
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
      "Premium voices (ElevenLabs, Cartesia, Fish, Boson)",
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

/** TTS engines that count as "premium" and require a premium-voices plan. The
 *  stub + OpenAI engines are the free tier's standard voices. */
export const PREMIUM_TTS_PROVIDERS = ["elevenlabs", "cartesia", "fish", "boson"] as const;

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
