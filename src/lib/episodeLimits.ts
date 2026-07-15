// Client-safe platform limits shared across the episode-creation stack. No
// server imports, so this can be used in the browser (Studio UI), the shared
// draft schema, the rundown rules, AND the server-side createEpisodeDraft — one
// source of truth instead of conflicting hardcoded numbers.

/** Hard platform maximum of topics per episode. The env-tunable value in
 *  episodeCreation clamps DOWN to this; nothing may exceed it. */
export const PLATFORM_MAX_TOPICS = 6;

/** The generation pipeline is built for exactly two hosts. */
export const MAX_HOSTS = 2;

/** Title / description limits (mirrored by CreateEpisodeDraftInputSchema). */
export const MAX_TITLE_LEN = 200;
export const MAX_DESCRIPTION_LEN = 4000;

export const PRODUCTION_STYLES = ["clean", "light", "full"] as const;
export const SFX_DENSITIES = ["subtle", "medium", "hype"] as const;
export type ProductionStyleId = (typeof PRODUCTION_STYLES)[number];
export type SfxDensityId = (typeof SFX_DENSITIES)[number];
