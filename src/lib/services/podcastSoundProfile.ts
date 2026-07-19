// Podcast sound-profile resolution (Prompt 6).
//
// A show's PRODUCED SOUND is part of its canonical configuration. This module
// resolves the profile a new Episode is PERMITTED to use — which exact assets
// may voice the intro/outro/bed and fill the stinger/reaction pools — so the
// Episode snapshot can freeze it. After that freeze, a later edit to the
// Podcast or to the shared system profile never changes the Episode.
//
// Three modes (PodcastProductionConfig.soundProfileMode):
//   system_default  the shared system profile (SoundDesignConfig singleton +
//                   the shared-system reaction pool), resolved to CONCRETE
//                   asset ids/hashes at Episode creation;
//   custom          the Podcast's explicit PodcastSoundAssignment rows;
//   clean           dialogue only — an explicit empty profile.
//
// LEGACY COMPATIBILITY (documented rule): the current production system
// default may reference pre-Prompt-6 `legacy_global` assets (e.g. the
// licensed crate). Those remain usable AS THE SYSTEM DEFAULT ONLY, are
// marked provenance "legacy_compat", and set `containsLegacyCompatAssets`
// so Admin surfaces can show the ownership-review warning. They are never
// eligible for NEW podcast assignments (audioAssetAccess blocks that).

import type { Prisma, PrismaClient } from "@prisma/client";
import { rightsUsableForNewUse } from "./audioAssetAccess";
import {
  ASSIGNMENT_WEIGHT_MIN, ASSIGNMENT_WEIGHT_MAX,
  DEFAULT_SONIC_IDENTITY, validateSonicIdentity, isCueFamilyValidForRole,
  cueFamilyAllowedByIdentity, type SonicIdentity,
} from "@/lib/audio/sonicIdentity";
import { isRegisteredFormat } from "@/lib/formats/showFormatRegistry";

type DbLike = PrismaClient | Prisma.TransactionClient;

export type SoundProfileMode = "system_default" | "custom" | "clean";
export type CooldownScope = "podcast" | "owner";
export const SOUND_ASSIGNMENT_ROLES = ["intro", "outro", "bed", "stinger", "reaction"] as const;
export type SoundAssignmentRole = (typeof SOUND_ASSIGNMENT_ROLES)[number];

/** Role -> permitted AudioAsset.kind values. Never silently coerced. */
export const ROLE_KIND_COMPATIBILITY: Record<SoundAssignmentRole, string[]> = {
  intro: ["theme_intro"],
  outro: ["theme_outro"],
  bed: ["bed"],
  stinger: ["stinger"],
  reaction: ["sfx"],
};

// Bounded assignment-level mix settings (validated on save AND at render).
export const GAIN_DB_MIN = -24;
export const GAIN_DB_MAX = 6;
export const FADE_MS_MAX = 10_000;

export interface FrozenSoundAssetRef {
  assetId: string;
  kind: string;
  category: string | null;
  name: string;
  contentHash: string | null; // null only for unrepaired legacy media
  scope: string;
  role: SoundAssignmentRole;
  orderIndex: number;
  gainDb: number | null;
  fadeInMs: number | null;
  fadeOutMs: number | null;
  durationMs: number | null;
  tags: string[];
  rightsStatusAtCapture: string;
  licenseStatusAtCapture: string;
  provenance: "podcast_assignment" | "system_default" | "legacy_compat";
}

export interface FrozenSoundProfile {
  mode: SoundProfileMode;
  targetLoudnessLufs: number | null;
  cooldownScope: CooldownScope;
  stingerCooldownEpisodes: number | null;
  reactionCooldownEpisodes: number | null;
  /** Snapshot v4: EXPLICIT frozen bookend intent — did the producer enable an
   *  intro/outro for this episode, independent of whether an asset ultimately
   *  resolved? This is what distinguishes "intentionally disabled" (false) from
   *  "enabled but no asset assigned" (true + intro/outro null + no excluded
   *  entry). ABSENT (undefined) on v2/v3 profiles read from older snapshots —
   *  the render gate falls back to documented compatibility behavior for those
   *  and never fabricates historical intent. */
  introEnabled?: boolean;
  outroEnabled?: boolean;
  intro: FrozenSoundAssetRef | null;
  outro: FrozenSoundAssetRef | null;
  bed: FrozenSoundAssetRef | null;
  stingers: FrozenSoundAssetRef[];
  reactions: FrozenSoundAssetRef[];
  /** True when the SYSTEM DEFAULT resolved through pre-Prompt-6 legacy assets
   *  (documented compatibility) — Admin surfaces show a review warning. */
  containsLegacyCompatAssets: boolean;
  /** Assignments that were configured but EXCLUDED at freeze time (archived /
   *  rights-invalid / not ready) — named so the producer can see what needs
   *  replacing; never silently substituted. */
  excluded: Array<{ assetId: string; role: string; reason: string }>;
}

export const CLEAN_SOUND_PROFILE: FrozenSoundProfile = {
  mode: "clean",
  targetLoudnessLufs: null,
  cooldownScope: "podcast",
  stingerCooldownEpisodes: null,
  reactionCooldownEpisodes: null,
  // Clean = dialogue only: bookends are explicitly NOT enabled.
  introEnabled: false,
  outroEnabled: false,
  intro: null,
  outro: null,
  bed: null,
  stingers: [],
  reactions: [],
  containsLegacyCompatAssets: false,
  excluded: [],
};

type AssetRow = {
  id: string; kind: string; category: string | null; name: string; tags: unknown;
  contentHash: string | null; scope: string; durationMs: number | null;
  isArchived: boolean; processingStatus: string; supersededByAssetId: string | null;
  rightsStatus: string; rightsExpiresAt: Date | null; licenseStatus: string; allowedUse: string | null;
  ownerId: string | null; podcastId: string | null;
};

/** An asset usable in a NEW episode's frozen profile? Returns null when OK,
 *  else the safe exclusion reason. */
function newUseBlockReason(asset: AssetRow): string | null {
  if (asset.processingStatus !== "ready") return `not ready (${asset.processingStatus})`;
  if (asset.isArchived) return "archived";
  if (asset.supersededByAssetId) return "superseded";
  const rights = rightsUsableForNewUse(asset);
  if (!rights.ok) return `rights blocked (${rights.error.code})`;
  return null;
}

function toRef(
  asset: AssetRow,
  role: SoundAssignmentRole,
  provenance: FrozenSoundAssetRef["provenance"],
  assignment?: { orderIndex: number; gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null }
): FrozenSoundAssetRef {
  return {
    assetId: asset.id,
    kind: asset.kind,
    category: asset.category,
    name: asset.name,
    contentHash: asset.contentHash,
    scope: asset.scope,
    role,
    orderIndex: assignment?.orderIndex ?? 0,
    gainDb: assignment?.gainDb ?? null,
    fadeInMs: assignment?.fadeInMs ?? null,
    fadeOutMs: assignment?.fadeOutMs ?? null,
    durationMs: asset.durationMs,
    tags: Array.isArray(asset.tags) ? (asset.tags as string[]) : [],
    rightsStatusAtCapture: asset.rightsStatus,
    licenseStatusAtCapture: asset.licenseStatus,
    provenance,
  };
}

/**
 * Resolve the SHARED SYSTEM profile to concrete assets. Only shared_system
 * assets — plus, under the documented compatibility rule, legacy_global
 * assets the current system default already references — may appear.
 * Private assets can never leak in here.
 */
export async function resolveSystemDefaultSoundProfile(
  dbi: DbLike,
  base: {
    targetLoudnessLufs?: number | null;
    cooldownScope?: string | null;
    stingerCooldownEpisodes?: number | null;
    reactionCooldownEpisodes?: number | null;
    introEnabled?: boolean;
    outroEnabled?: boolean;
  } = {}
): Promise<FrozenSoundProfile> {
  const config = await dbi.soundDesignConfig.findUnique({ where: { id: "default" } });
  const excluded: FrozenSoundProfile["excluded"] = [];
  let legacyCompat = false;

  const slotIds = [config?.themeIntroAssetId, config?.themeOutroAssetId, config?.bedAssetId].filter(Boolean) as string[];
  const stingerIds = Array.isArray(config?.stingerAssetIds) ? (config!.stingerAssetIds as string[]) : [];

  // Configured slots/stingers by id; the reaction pool is every usable
  // shared-system SFX (plus legacy_global SFX under the compat rule — the
  // pre-Prompt-6 behavior was "all active SFX", and the system library is
  // exactly the non-private remainder of that set).
  const rows = (await dbi.audioAsset.findMany({
    where: {
      OR: [
        { id: { in: [...slotIds, ...stingerIds].length > 0 ? [...slotIds, ...stingerIds] : ["-"] } },
        { kind: "sfx", scope: { in: ["shared_system", "legacy_global"] }, isActive: true },
      ],
    },
  })) as AssetRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const freezeSlot = (id: string | null | undefined, role: SoundAssignmentRole): FrozenSoundAssetRef | null => {
    if (!id) return null;
    const asset = byId.get(id);
    if (!asset) { excluded.push({ assetId: id, role, reason: "missing asset" }); return null; }
    if (asset.scope !== "shared_system" && asset.scope !== "legacy_global") {
      // A private asset must never resolve through the SYSTEM profile.
      excluded.push({ assetId: id, role, reason: "not a system asset" });
      return null;
    }
    const block = newUseBlockReason(asset);
    if (block) { excluded.push({ assetId: id, role, reason: block }); return null; }
    if (!ROLE_KIND_COMPATIBILITY[role].includes(asset.kind)) {
      excluded.push({ assetId: id, role, reason: `kind ${asset.kind} incompatible with ${role}` });
      return null;
    }
    const provenance = asset.scope === "legacy_global" ? "legacy_compat" : "system_default";
    if (provenance === "legacy_compat") legacyCompat = true;
    return toRef(asset, role, provenance);
  };

  const stingers: FrozenSoundAssetRef[] = [];
  stingerIds.forEach((id, i) => {
    const ref = freezeSlot(id, "stinger");
    if (ref) stingers.push({ ...ref, orderIndex: i });
  });

  const reactions: FrozenSoundAssetRef[] = [];
  let i = 0;
  for (const row of rows) {
    if (row.kind !== "sfx") continue;
    if (row.scope !== "shared_system" && row.scope !== "legacy_global") continue;
    if (newUseBlockReason(row)) continue;
    const provenance = row.scope === "legacy_global" ? "legacy_compat" : "system_default";
    if (provenance === "legacy_compat") legacyCompat = true;
    reactions.push({ ...toRef(row, "reaction", provenance), orderIndex: i++ });
  }

  return {
    mode: "system_default",
    targetLoudnessLufs: base.targetLoudnessLufs ?? null,
    cooldownScope: base.cooldownScope === "owner" ? "owner" : "podcast",
    stingerCooldownEpisodes: base.stingerCooldownEpisodes ?? null,
    reactionCooldownEpisodes: base.reactionCooldownEpisodes ?? null,
    // For the SYSTEM default, a bookend is "enabled" only when the toggle is on
    // AND the shared config actually pins a theme asset. A platform that has no
    // system intro/outro configured simply has none — that is not a per-episode
    // misconfiguration to fail on (the frozen intent honestly records `false`).
    // A configured-but-unusable asset (rights) still reads enabled=true and is
    // caught downstream via its `excluded` entry.
    introEnabled: base.introEnabled !== false && !!config?.themeIntroAssetId,
    outroEnabled: base.outroEnabled !== false && !!config?.themeOutroAssetId,
    intro: base.introEnabled === false ? null : freezeSlot(config?.themeIntroAssetId, "intro"),
    outro: base.outroEnabled === false ? null : freezeSlot(config?.themeOutroAssetId, "outro"),
    bed: freezeSlot(config?.bedAssetId, "bed"),
    stingers,
    reactions,
    containsLegacyCompatAssets: legacyCompat,
    excluded,
  };
}

/**
 * Resolve a Podcast's sound profile for a NEW episode. `production` is the
 * Podcast's production config row (or null for shows that predate it).
 */
export async function resolvePodcastSoundProfile(
  dbi: DbLike,
  podcast: { id: string; ownerId: string | null },
  production: {
    soundProfileMode?: string | null;
    targetLoudnessLufs?: number | null;
    cooldownScope?: string | null;
    stingerCooldownEpisodes?: number | null;
    reactionCooldownEpisodes?: number | null;
    defaultIntroEnabled?: boolean;
    defaultOutroEnabled?: boolean;
  } | null
): Promise<FrozenSoundProfile> {
  const mode = (production?.soundProfileMode ?? "system_default") as SoundProfileMode;
  const base = {
    targetLoudnessLufs: production?.targetLoudnessLufs ?? null,
    cooldownScope: production?.cooldownScope ?? "podcast",
    stingerCooldownEpisodes: production?.stingerCooldownEpisodes ?? null,
    reactionCooldownEpisodes: production?.reactionCooldownEpisodes ?? null,
    introEnabled: production?.defaultIntroEnabled ?? true,
    outroEnabled: production?.defaultOutroEnabled ?? true,
  };

  if (mode === "clean") {
    return { ...CLEAN_SOUND_PROFILE, cooldownScope: base.cooldownScope === "owner" ? "owner" : "podcast" };
  }
  if (mode !== "custom") {
    return resolveSystemDefaultSoundProfile(dbi, base);
  }

  // CUSTOM: this Podcast's explicit assignments — revalidated at freeze time.
  const assignments = await dbi.podcastSoundAssignment.findMany({
    where: { podcastId: podcast.id, enabled: true },
    include: { asset: true },
    orderBy: [{ role: "asc" }, { orderIndex: "asc" }],
  });

  const excluded: FrozenSoundProfile["excluded"] = [];
  let intro: FrozenSoundAssetRef | null = null;
  let outro: FrozenSoundAssetRef | null = null;
  let bed: FrozenSoundAssetRef | null = null;
  const stingers: FrozenSoundAssetRef[] = [];
  const reactions: FrozenSoundAssetRef[] = [];

  for (const a of assignments) {
    const asset = a.asset as unknown as AssetRow;
    const role = a.role as SoundAssignmentRole;

    // Access is re-checked here, not just at save: scope + ownership.
    const accessible =
      asset.scope === "shared_system" ||
      (asset.scope === "owner_private" && asset.ownerId === podcast.ownerId) ||
      (asset.scope === "podcast_private" && asset.podcastId === podcast.id);
    if (!accessible) { excluded.push({ assetId: asset.id, role, reason: "not accessible to this podcast" }); continue; }
    const block = newUseBlockReason(asset);
    if (block) { excluded.push({ assetId: asset.id, role, reason: block }); continue; }
    if (!ROLE_KIND_COMPATIBILITY[role]?.includes(asset.kind)) {
      excluded.push({ assetId: asset.id, role, reason: `kind ${asset.kind} incompatible with ${role}` });
      continue;
    }

    const ref = toRef(asset, role, "podcast_assignment", a);
    if (role === "intro" && base.introEnabled !== false) intro = intro ?? ref;
    else if (role === "outro" && base.outroEnabled !== false) outro = outro ?? ref;
    else if (role === "bed") bed = bed ?? ref;
    else if (role === "stinger") stingers.push(ref);
    else if (role === "reaction") reactions.push(ref);
  }

  return {
    mode: "custom",
    targetLoudnessLufs: base.targetLoudnessLufs,
    cooldownScope: base.cooldownScope === "owner" ? "owner" : "podcast",
    stingerCooldownEpisodes: base.stingerCooldownEpisodes,
    reactionCooldownEpisodes: base.reactionCooldownEpisodes,
    // Custom: "enabled" is the producer's explicit toggle. savePodcastSoundProfile
    // guarantees an enabled bookend has a valid assignment, so enabled => intro
    // is set; a bypassed/legacy invalid save is caught at snapshot creation.
    introEnabled: base.introEnabled !== false,
    outroEnabled: base.outroEnabled !== false,
    intro,
    outro,
    bed,
    stingers,
    reactions,
    containsLegacyCompatAssets: false,
    excluded,
  };
}

/** Standalone episodes (no Podcast) NEVER inherit any Podcast's profile: they
 *  get the shared system default, exactly like today's behavior. */
export async function resolveStandaloneSoundProfile(dbi: DbLike): Promise<FrozenSoundProfile> {
  return resolveSystemDefaultSoundProfile(dbi);
}

// ---------------------------------------------------------------------------
// Saving a custom profile (used by the Podcast Sound & Branding surface; the
// UI lands in the next PR but the contract + tests live here).
// ---------------------------------------------------------------------------
export interface SoundAssignmentInput {
  assetId: string;
  role: SoundAssignmentRole;
  orderIndex?: number;
  gainDb?: number | null;
  fadeInMs?: number | null;
  fadeOutMs?: number | null;
  // --- Variant pool metadata (PR 2) ---
  enabled?: boolean;
  cueFamily?: string | null;
  weight?: number | null;
  isBrandedMotif?: boolean;
  maxUsesPerEpisode?: number | null;
  minEpisodeCooldown?: number | null;
  allowedFormatIds?: string[];
  prohibitedFormatIds?: string[];
}

export type SoundProfileSaveError =
  | { code: "podcast_not_found" }
  | { code: "podcast_forbidden" }
  | { code: "podcast_configuration_changed"; expected: number; actual: number }
  | { code: "invalid_mode"; mode: string }
  | { code: "invalid_cooldown_scope"; scope: string }
  | { code: "invalid_gain"; assetId: string }
  | { code: "invalid_fade"; assetId: string }
  | { code: "invalid_weight"; assetId: string }
  | { code: "duplicate_assignment"; assetId: string; role: string }
  | { code: "bookend_enabled_without_asset"; role: "intro" | "outro" }
  | { code: "invalid_cue_family"; assetId: string; role: string; cueFamily: string }
  | { code: "cue_family_prohibited"; assetId: string; cueFamily: string; reason: string }
  | { code: "invalid_format_id"; assetId: string; formatId: string }
  | { code: "invalid_sonic_identity"; reason: string }
  | { code: "asset_not_assignable"; assetId: string; role: string; reason: string };

/**
 * Save a Podcast's sound profile ATOMICALLY under Prompt 5 optimistic
 * concurrency: every referenced asset is validated (access, rights, role-kind,
 * bounds), the assignment set is replaced in one transaction, and
 * Podcast.configVersion increments EXACTLY ONCE per accepted save — never once
 * per row. A stale expectedVersion writes nothing and returns the structured
 * `podcast_configuration_changed` conflict.
 */
export async function savePodcastSoundProfile(args: {
  db: PrismaClient;
  podcastId: string;
  expectedVersion: number;
  canEdit: (pod: { id: string; ownerId: string | null }) => boolean;
  profile: {
    soundProfileMode: SoundProfileMode;
    targetLoudnessLufs?: number | null;
    cooldownScope?: CooldownScope;
    stingerCooldownEpisodes?: number | null;
    reactionCooldownEpisodes?: number | null;
    defaultIntroEnabled?: boolean;
    defaultOutroEnabled?: boolean;
    assignments?: SoundAssignmentInput[];
    /** Versioned sonic identity (validated). Absent = leave existing/none. */
    sonicIdentity?: unknown;
  };
}): Promise<{ ok: true; configVersion: number } | { ok: false; error: SoundProfileSaveError }> {
  const { profile } = args;
  if (!["system_default", "custom", "clean"].includes(profile.soundProfileMode)) {
    return { ok: false, error: { code: "invalid_mode", mode: profile.soundProfileMode } };
  }
  if (profile.cooldownScope && !["podcast", "owner"].includes(profile.cooldownScope)) {
    return { ok: false, error: { code: "invalid_cooldown_scope", scope: profile.cooldownScope } };
  }

  // Validate the sonic identity once (used below for cue-family prohibitions).
  let identity: SonicIdentity = DEFAULT_SONIC_IDENTITY;
  let identityToPersist: SonicIdentity | undefined;
  if (profile.sonicIdentity !== undefined && profile.sonicIdentity !== null) {
    const vi = validateSonicIdentity(profile.sonicIdentity);
    if (!vi.ok) return { ok: false, error: { code: "invalid_sonic_identity", reason: vi.error.code } };
    identity = vi.identity;
    identityToPersist = vi.identity;
  }

  const assignments = profile.assignments ?? [];
  const seen = new Set<string>();
  for (const a of assignments) {
    if (a.gainDb != null && (a.gainDb < GAIN_DB_MIN || a.gainDb > GAIN_DB_MAX || !Number.isFinite(a.gainDb))) {
      return { ok: false, error: { code: "invalid_gain", assetId: a.assetId } };
    }
    for (const fade of [a.fadeInMs, a.fadeOutMs]) {
      if (fade != null && (fade < 0 || fade > FADE_MS_MAX || !Number.isInteger(fade))) {
        return { ok: false, error: { code: "invalid_fade", assetId: a.assetId } };
      }
    }
    if (a.weight != null && (!Number.isFinite(a.weight) || a.weight < ASSIGNMENT_WEIGHT_MIN || a.weight > ASSIGNMENT_WEIGHT_MAX)) {
      return { ok: false, error: { code: "invalid_weight", assetId: a.assetId } };
    }
    // Cue family must be valid for the ROLE and permitted by the sonic identity.
    if (a.cueFamily != null) {
      if (!isCueFamilyValidForRole(a.role, a.cueFamily)) {
        return { ok: false, error: { code: "invalid_cue_family", assetId: a.assetId, role: a.role, cueFamily: a.cueFamily } };
      }
      const idOk = cueFamilyAllowedByIdentity(identity, a.cueFamily);
      if (!idOk.ok) return { ok: false, error: { code: "cue_family_prohibited", assetId: a.assetId, cueFamily: a.cueFamily, reason: idOk.reason } };
    }
    // Optional per-assignment format restrictions must reference real formats.
    for (const fid of [...(a.allowedFormatIds ?? []), ...(a.prohibitedFormatIds ?? [])]) {
      if (!isRegisteredFormat(fid)) return { ok: false, error: { code: "invalid_format_id", assetId: a.assetId, formatId: fid } };
    }
    // Variant pools: intro/outro/bed may hold MANY variants (the singleton limit
    // is gone). Only exact (role, asset) duplicates are rejected.
    const key = `${a.role}:${a.assetId}`;
    if (seen.has(key)) return { ok: false, error: { code: "duplicate_assignment", assetId: a.assetId, role: a.role } };
    seen.add(key);
  }

  return args.db.$transaction(async (tx) => {
    const pod = await tx.podcast.findUnique({
      where: { id: args.podcastId },
      select: { id: true, ownerId: true, configVersion: true, productionConfig: { select: { id: true } } },
    });
    if (!pod) return { ok: false as const, error: { code: "podcast_not_found" as const } };
    if (!args.canEdit({ id: pod.id, ownerId: pod.ownerId })) return { ok: false as const, error: { code: "podcast_forbidden" as const } };
    if (pod.configVersion !== args.expectedVersion) {
      return { ok: false as const, error: { code: "podcast_configuration_changed" as const, expected: args.expectedVersion, actual: pod.configVersion } };
    }

    // Validate every referenced asset with the canonical rules.
    for (const a of assignments) {
      const asset = (await tx.audioAsset.findUnique({ where: { id: a.assetId } })) as AssetRow | null;
      const accessible =
        asset &&
        (asset.scope === "shared_system" ||
          (asset.scope === "owner_private" && asset.ownerId === pod.ownerId) ||
          (asset.scope === "podcast_private" && asset.podcastId === pod.id));
      if (!asset || !accessible) {
        // Cross-owner assets read as not-found — no existence leak.
        return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: "not found" } };
      }
      if (asset.kind === "highlight") {
        return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: "highlights cannot join ordinary pools" } };
      }
      if (asset.scope === "legacy_global") {
        return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: "ownership review required" } };
      }
      const block = newUseBlockReason(asset);
      if (block) return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: block } };
      if (!ROLE_KIND_COMPATIBILITY[a.role]?.includes(asset.kind)) {
        return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: `kind ${asset.kind} incompatible with role ${a.role}` } };
      }
    }

    // LEVEL 1 (bookend intent): a CUSTOM profile that ENABLES an intro/outro must
    // assign a valid one. An enabled-but-unassigned bookend would otherwise
    // freeze as introEnabled:true with no asset — the exact ambiguity v4 removes.
    // Runs AFTER per-asset validation so a malformed asset still reports its
    // specific error first; returns from the transaction so nothing is written
    // (no partial save; optimistic concurrency untouched). Disabled bookends
    // need no assignment.
    if (profile.soundProfileMode === "custom") {
      // Pool semantics: an enabled bookend needs at least one ENABLED variant.
      // An all-disabled pool is equivalent to no valid assignment.
      const hasEnabled = (role: string) => assignments.some((a) => a.role === role && a.enabled !== false);
      if (profile.defaultIntroEnabled !== false && !hasEnabled("intro")) {
        return { ok: false as const, error: { code: "bookend_enabled_without_asset" as const, role: "intro" as const } };
      }
      if (profile.defaultOutroEnabled !== false && !hasEnabled("outro")) {
        return { ok: false as const, error: { code: "bookend_enabled_without_asset" as const, role: "outro" as const } };
      }
    }

    const production = await tx.podcastProductionConfig.upsert({
      where: { podcastId: pod.id },
      create: { podcastId: pod.id },
      update: {},
      select: { id: true },
    });

    await tx.podcastProductionConfig.update({
      where: { id: production.id },
      data: {
        soundProfileMode: profile.soundProfileMode,
        targetLoudnessLufs: profile.targetLoudnessLufs ?? null,
        cooldownScope: profile.cooldownScope ?? "podcast",
        stingerCooldownEpisodes: profile.stingerCooldownEpisodes ?? null,
        reactionCooldownEpisodes: profile.reactionCooldownEpisodes ?? null,
        defaultIntroEnabled: profile.defaultIntroEnabled ?? true,
        defaultOutroEnabled: profile.defaultOutroEnabled ?? true,
        // Persist the validated identity only when the caller supplied one
        // (undefined = leave the existing identity untouched).
        ...(identityToPersist ? { sonicIdentity: identityToPersist as unknown as Prisma.InputJsonValue } : {}),
      },
    });

    // Replace the assignment set atomically (no partial saves).
    await tx.podcastSoundAssignment.deleteMany({ where: { podcastId: pod.id } });
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i];
      await tx.podcastSoundAssignment.create({
        data: {
          productionConfigId: production.id,
          podcastId: pod.id,
          assetId: a.assetId,
          role: a.role,
          orderIndex: a.orderIndex ?? i,
          enabled: a.enabled ?? true,
          gainDb: a.gainDb ?? null,
          fadeInMs: a.fadeInMs ?? null,
          fadeOutMs: a.fadeOutMs ?? null,
          cueFamily: a.cueFamily ?? null,
          weight: a.weight ?? 1,
          isBrandedMotif: a.isBrandedMotif ?? false,
          maxUsesPerEpisode: a.maxUsesPerEpisode ?? null,
          minEpisodeCooldown: a.minEpisodeCooldown ?? null,
          allowedFormatIds: a.allowedFormatIds ?? [],
          prohibitedFormatIds: a.prohibitedFormatIds ?? [],
        },
      });
    }

    // ONE version increment per accepted save.
    const bumped = await tx.podcast.update({
      where: { id: pod.id },
      data: { configVersion: pod.configVersion + 1 },
      select: { configVersion: true },
    });
    return { ok: true as const, configVersion: bumped.configVersion };
  });
}
