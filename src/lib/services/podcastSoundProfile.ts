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
  // --- Variant metadata (PR 2 / snapshot v5). Optional so v2-v4 refs stay
  //     byte-stable; present only on newly frozen v5 profiles. ---
  cueFamily?: string | null;
  weight?: number;
  isBrandedMotif?: boolean;
  allowedFormatIds?: string[];
  prohibitedFormatIds?: string[];
  maxUsesPerEpisode?: number | null;
  minEpisodeCooldown?: number | null;
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
  // --- Variant pools + selection (PR 2 / snapshot v5). All optional so v2-v4
  //     profiles stay byte-stable. `intro`/`outro`/`bed` above hold the SELECTED
  //     variant; the *Variants pools below are the permitted set (audit +
  //     future planner use). ---
  sonicIdentity?: SonicIdentity;
  introVariants?: FrozenSoundAssetRef[];
  outroVariants?: FrozenSoundAssetRef[];
  beds?: FrozenSoundAssetRef[];
  selectionSeed?: string;
  selectionReasons?: { intro?: string; outro?: string; bed?: string };
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

interface AssignmentMix {
  orderIndex: number; gainDb: number | null; fadeInMs: number | null; fadeOutMs: number | null;
  cueFamily?: string | null; weight?: number; isBrandedMotif?: boolean;
  allowedFormatIds?: string[]; prohibitedFormatIds?: string[];
  maxUsesPerEpisode?: number | null; minEpisodeCooldown?: number | null;
}

function toRef(
  asset: AssetRow,
  role: SoundAssignmentRole,
  provenance: FrozenSoundAssetRef["provenance"],
  assignment?: AssignmentMix
): FrozenSoundAssetRef {
  const ref: FrozenSoundAssetRef = {
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
  // Variant metadata is added whenever an assignment carries it (podcast OR
  // system pools). Singleton freezeSlot calls pass NO assignment, so those refs
  // stay byte-identical to the v2-v4 shape.
  if (assignment) {
    ref.cueFamily = assignment.cueFamily ?? null;
    ref.weight = assignment.weight ?? 1;
    ref.isBrandedMotif = assignment.isBrandedMotif ?? false;
    ref.allowedFormatIds = assignment.allowedFormatIds ?? [];
    ref.prohibitedFormatIds = assignment.prohibitedFormatIds ?? [];
    ref.maxUsesPerEpisode = assignment.maxUsesPerEpisode ?? null;
    ref.minEpisodeCooldown = assignment.minEpisodeCooldown ?? null;
  }
  return ref;
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

  // PR 2: admin-configured system variant pools (weighted, ordered) per role.
  const sysAssignments = await dbi.systemSoundAssignment.findMany({
    where: { configId: "default", enabled: true },
    include: { asset: true },
    orderBy: [{ role: "asc" }, { orderIndex: "asc" }],
  });
  const sysByRole = new Map<string, typeof sysAssignments>();
  for (const a of sysAssignments) {
    const list = sysByRole.get(a.role) ?? [];
    list.push(a);
    sysByRole.set(a.role, list);
  }

  const slotIds = [config?.themeIntroAssetId, config?.themeOutroAssetId, config?.bedAssetId].filter(Boolean) as string[];
  const stingerIds = Array.isArray(config?.stingerAssetIds) ? (config!.stingerAssetIds as string[]) : [];
  const rows = (await dbi.audioAsset.findMany({
    where: {
      OR: [
        { id: { in: [...slotIds, ...stingerIds].length > 0 ? [...slotIds, ...stingerIds] : ["-"] } },
        { kind: "sfx", scope: { in: ["shared_system", "legacy_global"] }, isActive: true },
      ],
    },
  })) as AssetRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));

  // Validate a candidate SYSTEM asset (shared_system / legacy_global only —
  // private assets can never resolve through the system profile) and, if OK,
  // build its ref carrying any variant metadata.
  const buildSystemRef = (
    asset: AssetRow | null | undefined,
    role: SoundAssignmentRole,
    idForError: string,
    mix?: AssignmentMix
  ): FrozenSoundAssetRef | null => {
    if (!asset) { excluded.push({ assetId: idForError, role, reason: "missing asset" }); return null; }
    if (asset.scope !== "shared_system" && asset.scope !== "legacy_global") {
      excluded.push({ assetId: asset.id, role, reason: "not a system asset" }); return null;
    }
    const block = newUseBlockReason(asset);
    if (block) { excluded.push({ assetId: asset.id, role, reason: block }); return null; }
    if (!ROLE_KIND_COMPATIBILITY[role].includes(asset.kind)) {
      excluded.push({ assetId: asset.id, role, reason: `kind ${asset.kind} incompatible with ${role}` }); return null;
    }
    const provenance = asset.scope === "legacy_global" ? "legacy_compat" : "system_default";
    if (provenance === "legacy_compat") legacyCompat = true;
    return toRef(asset, role, provenance, mix);
  };

  // Build a role's pool from SystemSoundAssignment rows; if there are none, fall
  // back to the legacy singleton slot(s) as a one-item compatibility pool.
  const poolFor = (role: SoundAssignmentRole, legacyIds: string[]): FrozenSoundAssetRef[] => {
    const rowsForRole = sysByRole.get(role);
    if (rowsForRole && rowsForRole.length > 0) {
      const out: FrozenSoundAssetRef[] = [];
      for (const a of rowsForRole) {
        const ref = buildSystemRef(a.asset as unknown as AssetRow, role, a.assetId, a as unknown as AssignmentMix);
        if (ref) out.push(ref);
      }
      return out;
    }
    // Legacy fallback (compatibility one-item pool).
    const out: FrozenSoundAssetRef[] = [];
    legacyIds.forEach((id, i) => {
      const ref = buildSystemRef(byId.get(id), role, id, { orderIndex: i, gainDb: null, fadeInMs: null, fadeOutMs: null });
      if (ref) out.push(ref);
    });
    return out;
  };

  const introVariants = base.introEnabled === false ? [] : poolFor("intro", config?.themeIntroAssetId ? [config.themeIntroAssetId] : []);
  const outroVariants = base.outroEnabled === false ? [] : poolFor("outro", config?.themeOutroAssetId ? [config.themeOutroAssetId] : []);
  const beds = poolFor("bed", config?.bedAssetId ? [config.bedAssetId] : []);
  const stingers = poolFor("stinger", stingerIds);

  // Reactions: explicit system reaction assignments win; otherwise the legacy
  // "every usable shared-system/legacy_global SFX" pool (unchanged behavior).
  let reactions: FrozenSoundAssetRef[];
  if ((sysByRole.get("reaction")?.length ?? 0) > 0) {
    reactions = poolFor("reaction", []);
  } else {
    reactions = [];
    let i = 0;
    for (const row of rows) {
      if (row.kind !== "sfx") continue;
      if (row.scope !== "shared_system" && row.scope !== "legacy_global") continue;
      if (newUseBlockReason(row)) continue;
      const provenance = row.scope === "legacy_global" ? "legacy_compat" : "system_default";
      if (provenance === "legacy_compat") legacyCompat = true;
      reactions.push({ ...toRef(row, "reaction", provenance), orderIndex: i++ });
    }
  }

  const intro = introVariants[0] ?? null;
  const outro = outroVariants[0] ?? null;
  const bed = beds[0] ?? null;

  return {
    mode: "system_default",
    targetLoudnessLufs: base.targetLoudnessLufs ?? null,
    cooldownScope: base.cooldownScope === "owner" ? "owner" : "podcast",
    stingerCooldownEpisodes: base.stingerCooldownEpisodes ?? null,
    reactionCooldownEpisodes: base.reactionCooldownEpisodes ?? null,
    // A system bookend is "enabled" only when the toggle is on AND the system
    // actually has at least one usable variant/slot for that role — an empty
    // pool honestly records `false` (not a misconfiguration); a configured-but-
    // unusable asset still reads enabled and is caught via its `excluded` entry.
    introEnabled: base.introEnabled !== false && ((sysByRole.get("intro")?.length ?? 0) > 0 || !!config?.themeIntroAssetId),
    outroEnabled: base.outroEnabled !== false && ((sysByRole.get("outro")?.length ?? 0) > 0 || !!config?.themeOutroAssetId),
    intro,
    outro,
    bed,
    stingers,
    reactions,
    // The shared system default carries the permissive identity (it does not
    // claim any genre/mood — no fabrication) + the real variant pools.
    sonicIdentity: DEFAULT_SONIC_IDENTITY,
    introVariants,
    outroVariants,
    beds,
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
    sonicIdentity?: unknown;
  } | null
): Promise<FrozenSoundProfile> {
  const mode = (production?.soundProfileMode ?? "system_default") as SoundProfileMode;
  // The show's frozen creative identity (validated; permissive default when
  // absent/invalid so an existing show behaves exactly as before).
  const idResult = production?.sonicIdentity != null ? validateSonicIdentity(production.sonicIdentity) : null;
  const identity: SonicIdentity = idResult && idResult.ok ? idResult.identity : DEFAULT_SONIC_IDENTITY;
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
  // Variant POOLS (PR 2): every valid enabled assignment per role, in order.
  const introVariants: FrozenSoundAssetRef[] = [];
  const outroVariants: FrozenSoundAssetRef[] = [];
  const beds: FrozenSoundAssetRef[] = [];
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
    // A variant whose cue family the identity now prohibits is EXCLUDED (named,
    // never silently substituted).
    const famOk = cueFamilyAllowedByIdentity(identity, a.cueFamily);
    if (!famOk.ok) { excluded.push({ assetId: asset.id, role, reason: famOk.reason }); continue; }

    const ref = toRef(asset, role, "podcast_assignment", a);
    if (role === "intro") { if (base.introEnabled !== false) introVariants.push(ref); }
    else if (role === "outro") { if (base.outroEnabled !== false) outroVariants.push(ref); }
    else if (role === "bed") beds.push(ref);
    else if (role === "stinger") stingers.push(ref);
    else if (role === "reaction") reactions.push(ref);
  }

  // Backward-compatible single slots hold the FIRST variant; deterministic
  // per-episode SELECTION among variants happens in selectEpisodeSoundVariants.
  const intro = introVariants[0] ?? null;
  const outro = outroVariants[0] ?? null;
  const bed = beds[0] ?? null;

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
    sonicIdentity: identity,
    introVariants,
    outroVariants,
    beds,
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

// ---------------------------------------------------------------------------
// SYSTEM-DEFAULT variant pools (PR 2 review): admin-managed. Same variant model
// as podcast pools, but scoped to the singleton SoundDesignConfig and RESTRICTED
// to shared_system assets — a private/owner/podcast asset can never become a
// global system assignment. Atomic under SoundDesignConfig.configVersion
// optimistic concurrency.
// ---------------------------------------------------------------------------
export type SystemSoundSaveError =
  | { code: "system_config_changed"; expected: number; actual: number }
  | { code: "invalid_gain"; assetId: string }
  | { code: "invalid_fade"; assetId: string }
  | { code: "invalid_weight"; assetId: string }
  | { code: "duplicate_assignment"; assetId: string; role: string }
  | { code: "invalid_cue_family"; assetId: string; role: string; cueFamily: string }
  | { code: "invalid_format_id"; assetId: string; formatId: string }
  | { code: "asset_not_assignable"; assetId: string; role: string; reason: string };

export async function saveSystemSoundProfile(args: {
  db: PrismaClient;
  expectedVersion: number;
  assignments: SoundAssignmentInput[];
}): Promise<{ ok: true; configVersion: number } | { ok: false; error: SystemSoundSaveError }> {
  const assignments = args.assignments ?? [];
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
    if (a.cueFamily != null && !isCueFamilyValidForRole(a.role, a.cueFamily)) {
      return { ok: false, error: { code: "invalid_cue_family", assetId: a.assetId, role: a.role, cueFamily: a.cueFamily } };
    }
    for (const fid of [...(a.allowedFormatIds ?? []), ...(a.prohibitedFormatIds ?? [])]) {
      if (!isRegisteredFormat(fid)) return { ok: false, error: { code: "invalid_format_id", assetId: a.assetId, formatId: fid } };
    }
    const key = `${a.role}:${a.assetId}`;
    if (seen.has(key)) return { ok: false, error: { code: "duplicate_assignment", assetId: a.assetId, role: a.role } };
    seen.add(key);
  }

  return args.db.$transaction(async (tx) => {
    const cfg = await tx.soundDesignConfig.upsert({
      where: { id: "default" },
      create: { id: "default" },
      update: {},
      select: { id: true, configVersion: true },
    });
    if (cfg.configVersion !== args.expectedVersion) {
      return { ok: false as const, error: { code: "system_config_changed" as const, expected: args.expectedVersion, actual: cfg.configVersion } };
    }

    for (const a of assignments) {
      const asset = (await tx.audioAsset.findUnique({ where: { id: a.assetId } })) as AssetRow | null;
      // SYSTEM assignments accept shared_system ONLY: private/owner/podcast
      // assets are rejected, and legacy_global needs classification first.
      if (!asset || asset.scope !== "shared_system") {
        return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: "not a shared system asset" } };
      }
      if (asset.kind === "highlight") {
        return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: "highlights cannot join ordinary pools" } };
      }
      const block = newUseBlockReason(asset);
      if (block) return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: block } };
      if (!ROLE_KIND_COMPATIBILITY[a.role]?.includes(asset.kind)) {
        return { ok: false as const, error: { code: "asset_not_assignable" as const, assetId: a.assetId, role: a.role, reason: `kind ${asset.kind} incompatible with role ${a.role}` } };
      }
    }

    await tx.systemSoundAssignment.deleteMany({ where: { configId: "default" } });
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i];
      await tx.systemSoundAssignment.create({
        data: {
          configId: "default", assetId: a.assetId, role: a.role,
          orderIndex: a.orderIndex ?? i, enabled: a.enabled ?? true,
          gainDb: a.gainDb ?? null, fadeInMs: a.fadeInMs ?? null, fadeOutMs: a.fadeOutMs ?? null,
          cueFamily: a.cueFamily ?? null, weight: a.weight ?? 1, isBrandedMotif: a.isBrandedMotif ?? false,
          maxUsesPerEpisode: a.maxUsesPerEpisode ?? null, minEpisodeCooldown: a.minEpisodeCooldown ?? null,
          allowedFormatIds: a.allowedFormatIds ?? [], prohibitedFormatIds: a.prohibitedFormatIds ?? [],
        },
      });
    }
    const bumped = await tx.soundDesignConfig.update({
      where: { id: "default" }, data: { configVersion: cfg.configVersion + 1 }, select: { configVersion: true },
    });
    return { ok: true as const, configVersion: bumped.configVersion };
  });
}
