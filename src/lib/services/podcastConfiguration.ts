// The ONE canonical resolver for a show's saved configuration.
//
// Prompt 5 makes `Podcast` the source of truth for a real show. Studio, Admin,
// the recurring scheduler and the creation path must all read a configuration
// the SAME way — the authority (who may touch which show) differs, but the
// business rules (what a value means, how precedence works, what is valid) do
// not. Putting them here once is what makes that guarantee true instead of
// aspirational.
//
// This module also owns the ONLY sanctioned reads of the legacy Podcast columns
// (verticals/teams/segmentCount/hostIds). Everything else must go through
// `loadPodcastConfiguration`, so the day those columns are dropped there is a
// single call site to change. A contract test asserts no new direct readers
// appear elsewhere.
//
// Security notes that are NOT optional:
//   * ownerEmail is sensitive. It is loaded here but NEVER placed in a resolved
//     episode configuration or a snapshot, and list-style callers must not
//     select it.
//   * ownerId is authority, never trusted from client input. This module is
//     given a resolved actor; it does not read a client-supplied owner.

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import { z } from "zod";
import { isTtsProviderId } from "../providers/tts/providerIds";
import { isProductionStyle, isSfxDensity } from "../audio/soundDesignShared";
import { validateTtsVoiceOverridesInput } from "../providers/tts/voiceResolution";

// ---------------------------------------------------------------------------
// Show formats (Prompt 7): validation is REGISTRY-driven. two_host_debate is
// registered format #1; a format becomes selectable for new saves only once
// the whole pipeline supports it (generationReady).
// ---------------------------------------------------------------------------
import {
  DEFAULT_FORMAT_ID,
  PLATFORM_MAX_SPEAKERS,
  getShowFormat,
  isGenerationReadyFormat,
  isRegisteredFormat,
} from "../formats/showFormatRegistry";

/** @deprecated registry-driven now; kept for legacy imports. */
export const SUPPORTED_FORMATS = ["two_host_debate"] as const;
export type PodcastFormat = string;
export const DEFAULT_FORMAT: string = DEFAULT_FORMAT_ID;

/** @deprecated the cap is per-format (ShowFormat.speakerMax); this remains the
 *  platform-wide absolute for legacy imports. */
export const MAX_PODCAST_HOSTS = PLATFORM_MAX_SPEAKERS;

export const VISIBILITIES = ["private", "unlisted", "public"] as const;
export type PodcastVisibility = (typeof VISIBILITIES)[number];

export const DEFAULT_SEGMENT_COUNT = 3;
export const DEFAULT_LANGUAGE = "en";

// ---------------------------------------------------------------------------
// Slugs: URL-safe, normalized, reserved-name-rejecting.
// ---------------------------------------------------------------------------
// Reserved because they collide with real routes or are otherwise unsafe as a
// public show handle. A show may never claim one.
export const RESERVED_SLUGS = new Set([
  "admin", "api", "app", "studio", "rss", "feed", "feeds", "auth", "login",
  "logout", "signin", "signout", "settings", "account", "billing", "plan",
  "plans", "analytics", "episodes", "episode", "podcast", "podcasts", "show",
  "shows", "new", "create", "edit", "delete", "public", "static", "assets",
  "images", "audio", "download", "downloads", "health", "status", "robots",
  "sitemap", "favicon", "www", "root", "system", "null", "undefined",
]);

/** Normalize a name into a slug candidate. Does not guarantee uniqueness or
 *  non-reserved-ness; call validateSlug for that. */
export function slugifyPodcastName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

export type SlugError = "slug_empty" | "slug_too_short" | "slug_invalid_chars" | "slug_reserved";

/** Validate a proposed slug's SHAPE (not uniqueness — that needs the db). */
export function validateSlug(slug: string): { ok: true; slug: string } | { ok: false; error: SlugError } {
  const s = slug.trim().toLowerCase();
  if (s.length === 0) return { ok: false, error: "slug_empty" };
  if (s.length < 3) return { ok: false, error: "slug_too_short" };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) return { ok: false, error: "slug_invalid_chars" };
  if (RESERVED_SLUGS.has(s)) return { ok: false, error: "slug_reserved" };
  return { ok: true, slug: s };
}

// ---------------------------------------------------------------------------
// Validation schemas for a configuration edit (identity + three sub-configs).
// ---------------------------------------------------------------------------
const trimmedString = z.string().trim();

export const IdentityInputSchema = z.object({
  name: trimmedString.min(1, "A show needs a name.").max(200),
  slug: trimmedString.optional(),
  description: trimmedString.max(4000).optional().nullable(),
  author: trimmedString.max(200).optional().nullable(),
  ownerName: trimmedString.max(200).optional().nullable(),
  ownerEmail: trimmedString.email("That owner email is not valid.").max(320).optional().nullable(),
  websiteUrl: trimmedString.url("That website URL is not valid.").max(2000).optional().nullable(),
  language: trimmedString.min(2).max(35).optional(),
  category: trimmedString.max(100).optional().nullable(),
  subcategory: trimmedString.max(100).optional().nullable(),
  explicit: z.boolean().optional(),
  copyright: trimmedString.max(400).optional().nullable(),
  coverImageUrl: trimmedString.url("That cover image URL is not valid.").max(2000).optional().nullable(),
  visibility: z.enum(VISIBILITIES).optional(),
});

export const EditorialInputSchema = z.object({
  verticals: z.array(trimmedString).optional(),
  teams: z.array(trimmedString).optional(),
  segmentCount: z.number().int().min(1).max(12).optional(),
  format: trimmedString.optional(), // validated against the registry below
  minDebateScore: z.number().int().min(0).max(100).optional().nullable(),
  scriptStyle: trimmedString.max(60).optional().nullable(),
  maxWords: z.number().int().min(50).max(20000).optional().nullable(),
});

export const ProductionInputSchema = z.object({
  hostIds: z.array(trimmedString).max(PLATFORM_MAX_SPEAKERS, `A show supports at most ${PLATFORM_MAX_SPEAKERS} hosts.`).optional(),
  ttsProvider: trimmedString.optional().nullable(),
  ttsVoiceOverrides: z.unknown().optional(),
  productionStyle: trimmedString.optional().nullable(),
  sfxDensity: trimmedString.optional().nullable(),
});

export const PublishingInputSchema = z.object({
  autoGenerateChapters: z.boolean().optional(),
  autoGenerateShowNotes: z.boolean().optional(),
  autoGenerateCover: z.boolean().optional(),
  includeTranscript: z.boolean().optional(),
  downloadsEnabled: z.boolean().optional(),
});

export const PodcastConfigurationInputSchema = z.object({
  identity: IdentityInputSchema,
  editorial: EditorialInputSchema.optional(),
  production: ProductionInputSchema.optional(),
  publishing: PublishingInputSchema.optional(),
});
export type PodcastConfigurationInput = z.infer<typeof PodcastConfigurationInputSchema>;

// ---------------------------------------------------------------------------
// The loaded record: a Podcast plus its three 1-1 config rows, read through the
// compatibility adapter so a missing config row falls back to legacy columns.
// ---------------------------------------------------------------------------
export interface LoadedPodcastConfiguration {
  id: string;
  ownerId: string | null;
  configVersion: number;
  updatedAt: Date;
  identity: {
    name: string;
    slug: string | null;
    description: string | null;
    author: string | null;
    ownerName: string | null;
    ownerEmail: string | null; // SENSITIVE — never forwarded into a snapshot
    websiteUrl: string | null;
    language: string;
    category: string | null;
    subcategory: string | null;
    explicit: boolean;
    copyright: string | null;
    coverImageUrl: string | null;
    visibility: PodcastVisibility;
  };
  editorial: {
    verticals: string[];
    teams: string[]; // Team.id values
    segmentCount: number;
    format: string;
    minDebateScore: number | null;
    scriptStyle: string | null;
    maxWords: number | null;
  };
  production: {
    hostIds: string[];
    ttsProvider: string | null;
    ttsVoiceOverrides: unknown | null;
    productionStyle: string | null;
    sfxDensity: string | null;
    // --- Sound profile (Prompt 6) — part of the canonical configuration and
    // its fingerprint; a sound change is a configuration change.
    soundProfileMode: string;
    targetLoudnessLufs: number | null;
    cooldownScope: string;
    stingerCooldownEpisodes: number | null;
    reactionCooldownEpisodes: number | null;
    defaultIntroEnabled: boolean;
    defaultOutroEnabled: boolean;
    soundAssignments: Array<{
      assetId: string; role: string; orderIndex: number; enabled: boolean;
      gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null;
    }>;
  };
  publishing: {
    autoGenerateChapters: boolean;
    autoGenerateShowNotes: boolean;
    autoGenerateCover: boolean;
    includeTranscript: boolean;
    downloadsEnabled: boolean;
  };
  /** True when any sub-config was reconstructed from legacy columns because its
   *  dedicated row was missing (should not happen after backfill). */
  usedLegacyFallback: boolean;
}

type DbLike = PrismaClient | Prisma.TransactionClient;

/**
 * Load a show's full configuration. THE single sanctioned reader of the legacy
 * Podcast.{verticals,teams,segmentCount,hostIds} columns: when a dedicated
 * config row is present it wins; otherwise the legacy column is used and
 * `usedLegacyFallback` is set so callers/tests can notice.
 */
export async function loadPodcastConfiguration(
  db: DbLike,
  podcastId: string
): Promise<LoadedPodcastConfiguration | null> {
  const pod = await db.podcast.findUnique({
    where: { id: podcastId },
    include: {
      editorialConfig: true,
      productionConfig: { include: { soundAssignments: { orderBy: [{ role: "asc" }, { orderIndex: "asc" }] } } },
      publishingConfig: true,
    },
  });
  if (!pod) return null;

  let usedLegacyFallback = false;
  const ed = pod.editorialConfig;
  const pr = pod.productionConfig;
  const pu = pod.publishingConfig;
  if (!ed || !pr || !pu) usedLegacyFallback = true;

  return {
    id: pod.id,
    ownerId: pod.ownerId,
    configVersion: pod.configVersion,
    updatedAt: pod.updatedAt,
    identity: {
      name: pod.name,
      slug: pod.slug,
      description: pod.description,
      author: pod.author,
      ownerName: pod.ownerName,
      ownerEmail: pod.ownerEmail,
      websiteUrl: pod.websiteUrl,
      language: pod.language ?? DEFAULT_LANGUAGE,
      category: pod.category,
      subcategory: pod.subcategory,
      explicit: pod.explicit,
      copyright: pod.copyright,
      coverImageUrl: pod.coverImageUrl,
      visibility: (VISIBILITIES as readonly string[]).includes(pod.visibility)
        ? (pod.visibility as PodcastVisibility)
        : "private",
    },
    editorial: {
      verticals: ed?.verticals ?? pod.verticals,
      teams: ed?.teams ?? pod.teams,
      segmentCount: ed?.segmentCount ?? pod.segmentCount,
      format: ed?.format ?? DEFAULT_FORMAT,
      minDebateScore: ed?.minDebateScore ?? null,
      scriptStyle: ed?.scriptStyle ?? null,
      maxWords: ed?.maxWords ?? null,
    },
    production: {
      hostIds: pr?.hostIds ?? pod.hostIds,
      ttsProvider: pr?.ttsProvider ?? null,
      ttsVoiceOverrides: (pr?.ttsVoiceOverrides ?? null) as unknown | null,
      productionStyle: pr?.productionStyle ?? null,
      sfxDensity: pr?.sfxDensity ?? null,
      soundProfileMode: pr?.soundProfileMode ?? "system_default",
      targetLoudnessLufs: pr?.targetLoudnessLufs ?? null,
      cooldownScope: pr?.cooldownScope ?? "podcast",
      stingerCooldownEpisodes: pr?.stingerCooldownEpisodes ?? null,
      reactionCooldownEpisodes: pr?.reactionCooldownEpisodes ?? null,
      defaultIntroEnabled: pr?.defaultIntroEnabled ?? true,
      defaultOutroEnabled: pr?.defaultOutroEnabled ?? true,
      soundAssignments: (pr?.soundAssignments ?? []).map((a) => ({
        assetId: a.assetId, role: a.role, orderIndex: a.orderIndex, enabled: a.enabled,
        gainDb: a.gainDb, fadeInMs: a.fadeInMs, fadeOutMs: a.fadeOutMs,
      })),
    },
    publishing: {
      autoGenerateChapters: pu?.autoGenerateChapters ?? true,
      autoGenerateShowNotes: pu?.autoGenerateShowNotes ?? true,
      autoGenerateCover: pu?.autoGenerateCover ?? true,
      includeTranscript: pu?.includeTranscript ?? true,
      downloadsEnabled: pu?.downloadsEnabled ?? true,
    },
    usedLegacyFallback,
  };
}

// ---------------------------------------------------------------------------
// Deterministic fingerprint of a loaded configuration.
// ---------------------------------------------------------------------------
/** Canonical JSON: object keys sorted recursively, so key order never changes
 *  the fingerprint. Arrays keep their order (order is meaningful for hosts). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** A stable content fingerprint. Deliberately excludes ownerEmail and every
 *  identity contact field that must never leak through a hash-linked snapshot;
 *  it covers the settings that actually shape an episode plus the public
 *  identity. Version-tagged so the algorithm can evolve without silent drift. */
export function fingerprintPodcastConfiguration(cfg: LoadedPodcastConfiguration): string {
  const material = {
    v: 1,
    configVersion: cfg.configVersion,
    identity: {
      name: cfg.identity.name,
      slug: cfg.identity.slug,
      description: cfg.identity.description,
      author: cfg.identity.author,
      language: cfg.identity.language,
      category: cfg.identity.category,
      subcategory: cfg.identity.subcategory,
      explicit: cfg.identity.explicit,
      copyright: cfg.identity.copyright,
      coverImageUrl: cfg.identity.coverImageUrl,
      visibility: cfg.identity.visibility,
    },
    editorial: cfg.editorial,
    production: cfg.production,
    publishing: cfg.publishing,
  };
  return crypto.createHash("sha256").update(canonicalJson(material)).digest("hex");
}

// ---------------------------------------------------------------------------
// Episode configuration resolution with precedence + provenance.
// ---------------------------------------------------------------------------
export type Provenance = "episode_override" | "podcast" | "system_default" | "application_default";

export interface ResolvedField<T> {
  value: T;
  provenance: Provenance;
}

/** Per-episode overrides an actor may supply. Everything is optional; a value
 *  that is present wins over the podcast (for a podcast episode) or over the
 *  system default (for a standalone episode). */
export interface EpisodeConfigurationOverrides {
  verticals?: string[];
  teams?: string[]; // Team.id values
  hostIds?: string[];
  segmentCount?: number;
  format?: string;
  minDebateScore?: number | null;
  scriptStyle?: string | null;
  maxWords?: number | null;
  ttsProvider?: string | null;
  ttsVoiceOverrides?: unknown;
  productionStyle?: string | null;
  sfxDensity?: string | null;
}

export interface ResolvedEpisodeConfiguration {
  source: "podcast" | "standalone";
  podcastId: string | null;
  podcastConfigurationVersion: number | null;
  podcastConfigurationFingerprint: string | null;
  editorial: {
    verticals: ResolvedField<string[]>;
    teams: ResolvedField<string[]>;
    segmentCount: ResolvedField<number>;
    format: ResolvedField<string>;
    minDebateScore: ResolvedField<number | null>;
    scriptStyle: ResolvedField<string | null>;
    maxWords: ResolvedField<number | null>;
  };
  production: {
    hostIds: ResolvedField<string[]>;
    ttsProvider: ResolvedField<string | null>;
    ttsVoiceOverrides: ResolvedField<unknown | null>;
    productionStyle: ResolvedField<string | null>;
    sfxDensity: ResolvedField<string | null>;
  };
  /** Public show identity, carried for the snapshot. NEVER includes ownerEmail. */
  identity: LoadedPodcastConfiguration["identity"] | null;
}

export type PodcastConfigurationError =
  | { code: "podcast_not_found" }
  | { code: "podcast_forbidden" } // actor may not use this show
  | { code: "unsupported_format"; format: string }
  | { code: "unknown_tts_provider"; provider: string }
  | { code: "invalid_production_style"; style: string }
  | { code: "invalid_sfx_density"; density: string }
  | { code: "too_many_hosts"; count: number }
  | { code: "invalid_tts_voice_overrides"; message: string }
  | { code: "podcast_configuration_changed"; expected: number; actual: number } // optimistic-concurrency conflict
  | { code: "slug_taken"; slug: string }
  | { code: "invalid_slug"; reason: SlugError }
  | { code: "invalid_input"; message: string };

/** Whether an override array counts as "provided". Empty array == not
 *  provided, matching the existing creation-path convention (an omitted filter
 *  and an empty filter both mean "no episode-level narrowing"). Provenance is
 *  never inferred from emptiness of the RESOLVED value — only from which SOURCE
 *  supplied it. */
function arrayProvided(a: string[] | undefined): a is string[] {
  return Array.isArray(a) && a.length > 0;
}
function scalarProvided<T>(v: T | undefined): v is T {
  return v !== undefined;
}

/**
 * Resolve the configuration for a NEW episode.
 *
 * Podcast episode precedence:   episode_override > podcast > system_default
 * Standalone precedence:        episode_override > system_default
 *   (a standalone episode NEVER inherits any Podcast's values — passing a
 *    podcast is what makes it a podcast episode.)
 *
 * `validateProduction` is applied to the FINAL resolved production values, so an
 * invalid provider/style inherited from a show is caught exactly like an
 * invalid one typed at the episode.
 */
export function resolveEpisodeConfiguration(
  args: {
    podcast: LoadedPodcastConfiguration | null;
    overrides: EpisodeConfigurationOverrides;
  }
): { ok: true; resolved: ResolvedEpisodeConfiguration } | { ok: false; error: PodcastConfigurationError } {
  const { podcast, overrides } = args;

  const editorialFrom = <T>(
    override: T | undefined,
    provided: boolean,
    podcastValue: T,
    systemDefault: T
  ): ResolvedField<T> => {
    if (provided) return { value: override as T, provenance: "episode_override" };
    if (podcast) return { value: podcastValue, provenance: "podcast" };
    return { value: systemDefault, provenance: "system_default" };
  };

  // --- editorial ---
  const verticals = editorialFrom<string[]>(
    overrides.verticals, arrayProvided(overrides.verticals), podcast?.editorial.verticals ?? [], []
  );
  const teams = editorialFrom<string[]>(
    overrides.teams, arrayProvided(overrides.teams), podcast?.editorial.teams ?? [], []
  );
  const segmentCount = editorialFrom<number>(
    overrides.segmentCount, scalarProvided(overrides.segmentCount),
    podcast?.editorial.segmentCount ?? DEFAULT_SEGMENT_COUNT, DEFAULT_SEGMENT_COUNT
  );
  const format = editorialFrom<string>(
    overrides.format, scalarProvided(overrides.format),
    podcast?.editorial.format ?? DEFAULT_FORMAT, DEFAULT_FORMAT
  );
  const minDebateScore = editorialFrom<number | null>(
    overrides.minDebateScore, scalarProvided(overrides.minDebateScore),
    podcast?.editorial.minDebateScore ?? null, null
  );
  const scriptStyle = editorialFrom<string | null>(
    overrides.scriptStyle, scalarProvided(overrides.scriptStyle),
    podcast?.editorial.scriptStyle ?? null, null
  );
  const maxWords = editorialFrom<number | null>(
    overrides.maxWords, scalarProvided(overrides.maxWords),
    podcast?.editorial.maxWords ?? null, null
  );

  // --- production ---
  const hostIds = editorialFrom<string[]>(
    overrides.hostIds, arrayProvided(overrides.hostIds), podcast?.production.hostIds ?? [], []
  );
  const ttsProvider = editorialFrom<string | null>(
    overrides.ttsProvider, scalarProvided(overrides.ttsProvider),
    podcast?.production.ttsProvider ?? null, null
  );
  const ttsVoiceOverrides = editorialFrom<unknown | null>(
    overrides.ttsVoiceOverrides, scalarProvided(overrides.ttsVoiceOverrides),
    podcast?.production.ttsVoiceOverrides ?? null, null
  );
  const productionStyle = editorialFrom<string | null>(
    overrides.productionStyle, scalarProvided(overrides.productionStyle),
    podcast?.production.productionStyle ?? null, null
  );
  const sfxDensity = editorialFrom<string | null>(
    overrides.sfxDensity, scalarProvided(overrides.sfxDensity),
    podcast?.production.sfxDensity ?? null, null
  );

  // --- validate the FINAL resolved values (inherited or overridden alike) ---
  // Registry-driven (Prompt 7): the format must be registered, and the pinned
  // cast must fit ITS speaker bounds — two_host_debate keeps its cap of 2.
  const resolvedFormat = getShowFormat(format.value);
  if (!resolvedFormat) {
    return { ok: false, error: { code: "unsupported_format", format: format.value } };
  }
  if (hostIds.value.length > resolvedFormat.speakerMax) {
    return { ok: false, error: { code: "too_many_hosts", count: hostIds.value.length } };
  }
  if (ttsProvider.value && !isTtsProviderId(ttsProvider.value)) {
    return { ok: false, error: { code: "unknown_tts_provider", provider: ttsProvider.value } };
  }
  if (productionStyle.value && !isProductionStyle(productionStyle.value)) {
    return { ok: false, error: { code: "invalid_production_style", style: productionStyle.value } };
  }
  if (sfxDensity.value && !isSfxDensity(sfxDensity.value)) {
    return { ok: false, error: { code: "invalid_sfx_density", density: sfxDensity.value } };
  }
  if (ttsVoiceOverrides.value != null) {
    try {
      validateTtsVoiceOverridesInput(ttsVoiceOverrides.value);
    } catch (err) {
      return { ok: false, error: { code: "invalid_tts_voice_overrides", message: (err as Error).message } };
    }
  }

  return {
    ok: true,
    resolved: {
      source: podcast ? "podcast" : "standalone",
      podcastId: podcast?.id ?? null,
      podcastConfigurationVersion: podcast?.configVersion ?? null,
      podcastConfigurationFingerprint: podcast ? fingerprintPodcastConfiguration(podcast) : null,
      editorial: { verticals, teams, segmentCount, format, minDebateScore, scriptStyle, maxWords },
      production: { hostIds, ttsProvider, ttsVoiceOverrides, productionStyle, sfxDensity },
      identity: podcast ? podcast.identity : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Save a configuration with optimistic concurrency (compare-and-swap).
// ---------------------------------------------------------------------------
export interface SavePodcastConfigurationArgs {
  db: PrismaClient;
  podcastId: string;
  /** The configVersion the editor believed it was changing. The write only
   *  lands if the row still carries it. */
  expectedVersion: number;
  input: PodcastConfigurationInput;
  /** Actor authority — an ownership predicate resolved by the caller. Never a
   *  client-supplied ownerId. */
  canEdit: (pod: { id: string; ownerId: string | null }) => boolean;
}

export type SavePodcastConfigurationResult =
  | { ok: true; configVersion: number; slug: string; fingerprint: string }
  | { ok: false; error: PodcastConfigurationError };

/**
 * Persist an edit transactionally with a compare-and-swap on configVersion.
 * configVersion is incremented EXACTLY once. On a version mismatch nothing is
 * written and a structured `podcast_configuration_changed` conflict is returned
 * so the caller can re-load and re-present. There are no partial saves.
 */
export async function savePodcastConfiguration(
  args: SavePodcastConfigurationArgs
): Promise<SavePodcastConfigurationResult> {
  const parsed = PodcastConfigurationInputSchema.safeParse(args.input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: { code: "invalid_input", message: first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid configuration." } };
  }
  const input = parsed.data;

  // Format guard (Prompt 7): NEW saves may only pick a format the WHOLE
  // pipeline can produce (generation-ready) — registered-but-not-ready formats
  // are rejected honestly rather than appearing functional. Loading/resolving
  // an existing config only requires registration (legacy safety).
  const savedFormat = input.editorial?.format ?? DEFAULT_FORMAT_ID;
  if (!isRegisteredFormat(savedFormat)) {
    return { ok: false, error: { code: "unsupported_format", format: savedFormat } };
  }
  if (!isGenerationReadyFormat(savedFormat)) {
    return { ok: false, error: { code: "unsupported_format", format: savedFormat } };
  }
  const savedFormatDef = getShowFormat(savedFormat)!;
  if (input.production?.hostIds && input.production.hostIds.length > savedFormatDef.speakerMax) {
    return { ok: false, error: { code: "too_many_hosts", count: input.production.hostIds.length } };
  }
  if (input.production?.ttsProvider && !isTtsProviderId(input.production.ttsProvider)) {
    return { ok: false, error: { code: "unknown_tts_provider", provider: input.production.ttsProvider } };
  }
  if (input.production?.productionStyle && !isProductionStyle(input.production.productionStyle)) {
    return { ok: false, error: { code: "invalid_production_style", style: input.production.productionStyle } };
  }
  if (input.production?.sfxDensity && !isSfxDensity(input.production.sfxDensity)) {
    return { ok: false, error: { code: "invalid_sfx_density", density: input.production.sfxDensity } };
  }
  let normalizedVoiceOverrides: unknown | undefined;
  if (input.production && "ttsVoiceOverrides" in input.production && input.production.ttsVoiceOverrides != null) {
    try {
      normalizedVoiceOverrides = validateTtsVoiceOverridesInput(input.production.ttsVoiceOverrides);
    } catch (err) {
      return { ok: false, error: { code: "invalid_tts_voice_overrides", message: (err as Error).message } };
    }
  }

  // Resolve the slug (explicit or derived), validate its shape.
  const requestedSlug = input.identity.slug?.trim() || slugifyPodcastName(input.identity.name);
  const slugCheck = validateSlug(requestedSlug);
  if (!slugCheck.ok) return { ok: false, error: { code: "invalid_slug", reason: slugCheck.error } };
  const slug = slugCheck.slug;

  try {
    const result = await args.db.$transaction(async (tx) => {
      const pod = await tx.podcast.findUnique({ where: { id: args.podcastId }, select: { id: true, ownerId: true, configVersion: true } });
      if (!pod) return { ok: false as const, error: { code: "podcast_not_found" as const } };
      if (!args.canEdit({ id: pod.id, ownerId: pod.ownerId })) return { ok: false as const, error: { code: "podcast_forbidden" as const } };

      // Compare-and-swap: refuse if the row moved under us.
      if (pod.configVersion !== args.expectedVersion) {
        return { ok: false as const, error: { code: "podcast_configuration_changed" as const, expected: args.expectedVersion, actual: pod.configVersion } };
      }

      // Slug uniqueness (excluding this podcast).
      const clash = await tx.podcast.findFirst({ where: { slug, id: { not: args.podcastId } }, select: { id: true } });
      if (clash) return { ok: false as const, error: { code: "slug_taken" as const, slug } };

      const nextVersion = pod.configVersion + 1;

      await tx.podcast.update({
        where: { id: args.podcastId },
        data: {
          name: input.identity.name,
          slug,
          description: input.identity.description ?? null,
          author: input.identity.author ?? null,
          ownerName: input.identity.ownerName ?? null,
          ownerEmail: input.identity.ownerEmail ?? null,
          websiteUrl: input.identity.websiteUrl ?? null,
          language: input.identity.language ?? DEFAULT_LANGUAGE,
          category: input.identity.category ?? null,
          subcategory: input.identity.subcategory ?? null,
          explicit: input.identity.explicit ?? false,
          copyright: input.identity.copyright ?? null,
          coverImageUrl: input.identity.coverImageUrl ?? null,
          visibility: input.identity.visibility ?? "private",
          configVersion: nextVersion,
        },
      });

      const ed = input.editorial ?? {};
      await tx.podcastEditorialConfig.upsert({
        where: { podcastId: args.podcastId },
        create: {
          podcastId: args.podcastId,
          verticals: ed.verticals ?? [],
          teams: ed.teams ?? [],
          segmentCount: ed.segmentCount ?? DEFAULT_SEGMENT_COUNT,
          format: ed.format ?? DEFAULT_FORMAT,
          minDebateScore: ed.minDebateScore ?? null,
          scriptStyle: ed.scriptStyle ?? null,
          maxWords: ed.maxWords ?? null,
        },
        update: {
          verticals: ed.verticals ?? [],
          teams: ed.teams ?? [],
          segmentCount: ed.segmentCount ?? DEFAULT_SEGMENT_COUNT,
          format: ed.format ?? DEFAULT_FORMAT,
          minDebateScore: ed.minDebateScore ?? null,
          scriptStyle: ed.scriptStyle ?? null,
          maxWords: ed.maxWords ?? null,
        },
      });

      const pr = input.production ?? {};
      const voiceOverrideData =
        "ttsVoiceOverrides" in pr
          ? (normalizedVoiceOverrides == null ? Prisma.DbNull : (normalizedVoiceOverrides as Prisma.InputJsonValue))
          : Prisma.DbNull;
      await tx.podcastProductionConfig.upsert({
        where: { podcastId: args.podcastId },
        create: {
          podcastId: args.podcastId,
          hostIds: pr.hostIds ?? [],
          ttsProvider: pr.ttsProvider ?? null,
          ttsVoiceOverrides: voiceOverrideData,
          productionStyle: pr.productionStyle ?? null,
          sfxDensity: pr.sfxDensity ?? null,
        },
        update: {
          hostIds: pr.hostIds ?? [],
          ttsProvider: pr.ttsProvider ?? null,
          ttsVoiceOverrides: voiceOverrideData,
          productionStyle: pr.productionStyle ?? null,
          sfxDensity: pr.sfxDensity ?? null,
        },
      });

      const pu = input.publishing ?? {};
      await tx.podcastPublishingConfig.upsert({
        where: { podcastId: args.podcastId },
        create: {
          podcastId: args.podcastId,
          autoGenerateChapters: pu.autoGenerateChapters ?? true,
          autoGenerateShowNotes: pu.autoGenerateShowNotes ?? true,
          autoGenerateCover: pu.autoGenerateCover ?? true,
          includeTranscript: pu.includeTranscript ?? true,
          downloadsEnabled: pu.downloadsEnabled ?? true,
        },
        update: {
          autoGenerateChapters: pu.autoGenerateChapters ?? true,
          autoGenerateShowNotes: pu.autoGenerateShowNotes ?? true,
          autoGenerateCover: pu.autoGenerateCover ?? true,
          includeTranscript: pu.includeTranscript ?? true,
          downloadsEnabled: pu.downloadsEnabled ?? true,
        },
      });

      return { ok: true as const, configVersion: nextVersion, slug };
    });

    if (!result.ok) return result;

    // Fingerprint from the freshly-saved state.
    const reloaded = await loadPodcastConfiguration(args.db, args.podcastId);
    const fingerprint = reloaded ? fingerprintPodcastConfiguration(reloaded) : "";
    return { ok: true, configVersion: result.configVersion, slug: result.slug, fingerprint };
  } catch (err) {
    // A unique-constraint race on slug surfaces here even though we checked.
    if ((err as { code?: string }).code === "P2002") {
      return { ok: false, error: { code: "slug_taken", slug } };
    }
    throw err;
  }
}
