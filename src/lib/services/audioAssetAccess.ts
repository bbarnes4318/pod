// The ONE server-side access contract for audio assets (Prompt 6).
//
// Every surface — owner library, Podcast assignment, Admin system library,
// the planner, and the stitcher — resolves what an actor may see or use
// THROUGH THIS MODULE. UI actions stay thin; the planner and renderer
// revalidate; an asset ID arriving in JSON is never trusted.
//
// Scopes:
//   shared_system   admin-managed, visible/usable by every authorized user
//   owner_private   one User's library entry
//   podcast_private one owned Podcast's entry (asset.ownerId == Podcast.ownerId)
//   legacy_global   pre-Prompt-6 ambiguous asset: admin-only, blocked from NEW
//                   selection until classified
//
// Security rules encoded here (and only here):
//   * The actor's identity comes from the session / admin auth, never from
//     client input.
//   * Another owner's asset is reported as NOT FOUND, never as "forbidden" —
//     existence must not leak.
//   * Content-hash duplicate checks search only the actor's own visibility;
//     a cross-owner duplicate is never revealed.
//   * Safe DTOs never carry storage keys, raw storage URLs, rights-document
//     keys, or another owner's identity.

import type { Prisma, PrismaClient } from "@prisma/client";

type DbLike = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------
export type AudioAssetActor =
  | { kind: "user"; userId: string }
  | { kind: "admin"; adminIdentity: string }
  /** Internal maintenance paths (seeding, repair). NOT a render authority —
   *  rendering revalidates against the episode's owner/podcast. */
  | { kind: "system" };

export const AUDIO_ASSET_SCOPES = ["shared_system", "owner_private", "podcast_private", "legacy_global"] as const;
export type AudioAssetScope = (typeof AUDIO_ASSET_SCOPES)[number];

export type AudioAssetAccessError =
  | { code: "asset_not_found" } // includes "exists but you may not know that"
  | { code: "asset_forbidden" } // actor may see it but not perform this action
  | { code: "invalid_scope"; scope: string }
  | { code: "scope_requires_admin" }
  | { code: "podcast_not_found" }
  | { code: "podcast_not_owned" }
  | { code: "asset_not_ready"; status: string }
  | { code: "asset_archived" }
  | { code: "asset_superseded" }
  | { code: "legacy_review_required" }
  | { code: "rights_invalid"; rightsStatus: string }
  | { code: "rights_expired" }
  | { code: "license_invalid"; licenseStatus: string }
  | { code: "allowed_use_mismatch"; allowedUse: string }
  | { code: "highlight_requires_explicit_selection" }
  | { code: "immutable_content_field"; field: string };

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: AudioAssetAccessError };

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------
/** Prisma WHERE fragment limiting rows to what the actor may SEE.
 *  - user:  shared system + their own private assets (never legacy_global)
 *  - admin: shared system + legacy_global (NOT users' private libraries —
 *           support access to private assets is deliberately not a default)
 *  - system: everything (internal maintenance only) */
export function visibleAssetWhere(actor: AudioAssetActor): Prisma.AudioAssetWhereInput {
  switch (actor.kind) {
    case "user":
      return {
        OR: [
          { scope: "shared_system" },
          { scope: { in: ["owner_private", "podcast_private"] }, ownerId: actor.userId },
        ],
      };
    case "admin":
      return { scope: { in: ["shared_system", "legacy_global"] } };
    case "system":
      return {};
  }
}

export async function listAccessibleAudioAssets(
  dbi: DbLike,
  actor: AudioAssetActor,
  filter?: { kind?: string; podcastId?: string; includeArchived?: boolean; scope?: AudioAssetScope }
) {
  return dbi.audioAsset.findMany({
    where: {
      AND: [
        visibleAssetWhere(actor),
        filter?.kind ? { kind: filter.kind } : {},
        filter?.scope ? { scope: filter.scope } : {},
        filter?.podcastId ? { OR: [{ scope: "shared_system" }, { podcastId: filter.podcastId }, { scope: "owner_private" }] } : {},
        filter?.includeArchived ? {} : { isArchived: false },
      ],
    },
    orderBy: [{ kind: "asc" }, { name: "asc" }],
  });
}

/** Load one asset the actor may see; cross-owner assets read as null. */
export async function getAccessibleAudioAsset(dbi: DbLike, actor: AudioAssetActor, assetId: string) {
  return dbi.audioAsset.findFirst({ where: { AND: [{ id: assetId }, visibleAssetWhere(actor)] } });
}

export async function assertAudioAssetReadable(
  dbi: DbLike,
  actor: AudioAssetActor,
  assetId: string
): Promise<Ok<{ asset: NonNullable<Awaited<ReturnType<typeof getAccessibleAudioAsset>>> }> | Err> {
  const asset = await getAccessibleAudioAsset(dbi, actor, assetId);
  if (!asset) return { ok: false, error: { code: "asset_not_found" } };
  return { ok: true, asset };
}

// ---------------------------------------------------------------------------
// Rights / license usability (assign-time AND render-time)
// ---------------------------------------------------------------------------
const BLOCKED_RIGHTS = new Set(["rejected", "expired", "revoked"]);
const BLOCKED_LICENSES = new Set(["expired", "revoked"]);

/** Whether the asset's rights/license state permits NEW use at `at`.
 *  "unknown" license is allowed only for non-highlight kinds (matching the
 *  legacy contract where only highlights were rights-gated); a highlight
 *  additionally requires CONFIRMED rights. */
export function rightsUsableForNewUse(
  asset: {
    kind: string;
    rightsStatus: string;
    rightsExpiresAt: Date | null;
    licenseStatus: string;
    allowedUse: string | null;
  },
  at: Date = new Date()
): { ok: true } | Err {
  if (BLOCKED_LICENSES.has(asset.licenseStatus)) {
    return { ok: false, error: { code: "license_invalid", licenseStatus: asset.licenseStatus } };
  }
  if (BLOCKED_RIGHTS.has(asset.rightsStatus)) {
    return { ok: false, error: { code: "rights_invalid", rightsStatus: asset.rightsStatus } };
  }
  if (asset.rightsExpiresAt && asset.rightsExpiresAt.getTime() <= at.getTime()) {
    return { ok: false, error: { code: "rights_expired" } };
  }
  if (asset.kind === "highlight" && asset.rightsStatus !== "confirmed") {
    return { ok: false, error: { code: "rights_invalid", rightsStatus: asset.rightsStatus } };
  }
  if (asset.licenseStatus === "restricted") {
    // Restricted assets must carry an allowed use covering podcast production.
    if (!asset.allowedUse || !asset.allowedUse.includes("podcast_production")) {
      return { ok: false, error: { code: "allowed_use_mismatch", allowedUse: asset.allowedUse ?? "" } };
    }
  }
  return { ok: true };
}

/**
 * May this asset be ASSIGNED to (or newly selected for) the given podcast?
 * Applies scope, ownership, processing, archive, legacy and rights rules.
 * Highlights are never assignable as ordinary pool/slot content.
 */
export async function assertAudioAssetAssignable(
  dbi: DbLike,
  actor: AudioAssetActor,
  assetId: string,
  podcast: { id: string; ownerId: string | null }
): Promise<Ok<{ asset: NonNullable<Awaited<ReturnType<typeof getAccessibleAudioAsset>>> }> | Err> {
  const readable = await assertAudioAssetReadable(dbi, actor, assetId);
  if (!readable.ok) return readable;
  const asset = readable.asset;

  if (asset.scope === "legacy_global") return { ok: false, error: { code: "legacy_review_required" } };
  if (asset.processingStatus !== "ready") return { ok: false, error: { code: "asset_not_ready", status: asset.processingStatus } };
  if (asset.isArchived) return { ok: false, error: { code: "asset_archived" } };
  if (asset.supersededByAssetId) return { ok: false, error: { code: "asset_superseded" } };
  if (asset.kind === "highlight") return { ok: false, error: { code: "highlight_requires_explicit_selection" } };

  // Scope vs podcast:
  if (asset.scope === "owner_private" && asset.ownerId !== podcast.ownerId) {
    return { ok: false, error: { code: "asset_not_found" } }; // do not reveal existence
  }
  if (asset.scope === "podcast_private" && asset.podcastId !== podcast.id) {
    return { ok: false, error: { code: "asset_not_found" } };
  }

  const rights = rightsUsableForNewUse(asset);
  if (!rights.ok) return rights;
  return { ok: true, asset };
}

/** Render-time revalidation for a NEW render (not historical reproduction). */
export function assertAudioAssetUsableForRender(
  asset: {
    kind: string;
    processingStatus: string;
    rightsStatus: string;
    rightsExpiresAt: Date | null;
    licenseStatus: string;
    allowedUse: string | null;
  },
  at: Date = new Date()
): { ok: true } | Err {
  if (asset.processingStatus !== "ready") {
    return { ok: false, error: { code: "asset_not_ready", status: asset.processingStatus } };
  }
  return rightsUsableForNewUse(asset, at);
}

// ---------------------------------------------------------------------------
// Creation / mutation (metadata-safe; content is immutable)
// ---------------------------------------------------------------------------
export interface CreateAudioAssetInput {
  name: string;
  kind: string;
  category?: string | null;
  tags?: string[];
  scope: "shared_system" | "owner_private" | "podcast_private";
  podcastId?: string | null; // podcast_private only
  audioUrl: string;
  storageKey: string;
  contentHash: string;
  mimeType: string;
  fileSizeBytes: number;
  durationMs?: number | null;
  sampleRate?: number | null;
  channelCount?: number | null;
  bitrateKbps?: number | null;
  originalFilename?: string | null;
  licenseStatus?: string;
  licenseName?: string | null;
  licenseReference?: string | null;
  rightsStatus?: string;
  rightsNotes?: string | null;
  allowedUse?: string | null;
  processingStatus?: string; // default "ready"; the upload pipeline may stage "processing"
}

/**
 * Create a scoped asset. Scope authority:
 *   - user  -> owner_private (self) or podcast_private (a podcast they own)
 *   - admin -> shared_system
 * Nobody creates legacy_global through this path.
 */
export async function createAudioAsset(
  dbi: DbLike,
  actor: AudioAssetActor,
  input: CreateAudioAssetInput
): Promise<Ok<{ assetId: string }> | Err> {
  if (!(AUDIO_ASSET_SCOPES as readonly string[]).includes(input.scope) || input.scope === ("legacy_global" as string)) {
    return { ok: false, error: { code: "invalid_scope", scope: input.scope } };
  }

  let ownerId: string | null = null;
  let podcastId: string | null = null;

  if (input.scope === "shared_system") {
    if (actor.kind !== "admin") return { ok: false, error: { code: "scope_requires_admin" } };
  } else {
    if (actor.kind !== "user") return { ok: false, error: { code: "invalid_scope", scope: input.scope } };
    ownerId = actor.userId;
    if (input.scope === "podcast_private") {
      if (!input.podcastId) return { ok: false, error: { code: "podcast_not_found" } };
      const pod = await dbi.podcast.findUnique({ where: { id: input.podcastId }, select: { id: true, ownerId: true } });
      if (!pod) return { ok: false, error: { code: "podcast_not_found" } };
      if (pod.ownerId !== actor.userId) return { ok: false, error: { code: "podcast_not_owned" } };
      podcastId = pod.id;
    }
  }

  const row = await dbi.audioAsset.create({
    data: {
      name: input.name,
      kind: input.kind,
      category: input.category ?? null,
      tags: (input.tags ?? []) as object,
      audioUrl: input.audioUrl,
      storageKey: input.storageKey,
      durationMs: input.durationMs ?? null,
      license: input.licenseName ?? input.licenseStatus ?? "unknown", // legacy compat column
      rightsConfirmed: input.rightsStatus === "confirmed",
      isActive: true,
      source: "upload",
      scope: input.scope,
      ownerId,
      podcastId,
      uploadedByUserId: actor.kind === "user" ? actor.userId : null,
      createdByAdminIdentity: actor.kind === "admin" ? actor.adminIdentity : null,
      contentHash: input.contentHash,
      originalFilename: input.originalFilename ?? null,
      mimeType: input.mimeType,
      fileSizeBytes: input.fileSizeBytes,
      sampleRate: input.sampleRate ?? null,
      channelCount: input.channelCount ?? null,
      bitrateKbps: input.bitrateKbps ?? null,
      processingStatus: input.processingStatus ?? "ready",
      licenseStatus: input.licenseStatus ?? "unknown",
      licenseName: input.licenseName ?? null,
      licenseReference: input.licenseReference ?? null,
      rightsStatus: input.rightsStatus ?? "not_required",
      rightsNotes: input.rightsNotes ?? null,
      allowedUse: input.allowedUse ?? null,
      ...(input.rightsStatus === "confirmed"
        ? {
            rightsConfirmedAt: new Date(),
            rightsConfirmedByUserId: actor.kind === "user" ? actor.userId : null,
            rightsConfirmedByAdminIdentity: actor.kind === "admin" ? actor.adminIdentity : null,
          }
        : {}),
    },
  });
  await recordAssetAuditEvent(dbi, row.id, "created", actor, { scope: input.scope, kind: input.kind });
  return { ok: true, assetId: row.id };
}

/** Fields that may be edited after an asset is ready. Content fields
 *  (contentHash/storageKey/audioUrl/bytes) are IMMUTABLE — enforced here and
 *  by the audio_asset_content_guard DB trigger. */
const SAFE_METADATA_FIELDS = new Set([
  "name", "tags", "category", "licenseName", "licenseReference", "rightsNotes", "allowedUse",
]);

export async function updateAudioAssetMetadata(
  dbi: DbLike,
  actor: AudioAssetActor,
  assetId: string,
  patch: Record<string, unknown>
): Promise<Ok<object> | Err> {
  for (const key of Object.keys(patch)) {
    if (!SAFE_METADATA_FIELDS.has(key)) {
      return { ok: false, error: { code: "immutable_content_field", field: key } };
    }
  }
  const gate = await assertCanManage(dbi, actor, assetId);
  if (!gate.ok) return gate;
  await dbi.audioAsset.update({ where: { id: assetId }, data: patch as Prisma.AudioAssetUpdateInput });
  await recordAssetAuditEvent(dbi, assetId, "license_updated", actor, { fields: Object.keys(patch) });
  return { ok: true };
}

/** Owner may manage their own private assets; admin manages shared_system and
 *  legacy_global. Nobody manages another owner's asset. */
async function assertCanManage(
  dbi: DbLike,
  actor: AudioAssetActor,
  assetId: string
): Promise<Ok<{ asset: { id: string; scope: string; ownerId: string | null } }> | Err> {
  const readable = await assertAudioAssetReadable(dbi, actor, assetId);
  if (!readable.ok) return readable;
  const asset = readable.asset;
  if (actor.kind === "user") {
    if (asset.scope === "shared_system" || asset.ownerId !== actor.userId) {
      return { ok: false, error: { code: "asset_forbidden" } };
    }
  }
  return { ok: true, asset };
}

export async function archiveAudioAsset(
  dbi: DbLike,
  actor: AudioAssetActor,
  assetId: string,
  reason?: string
): Promise<Ok<object> | Err> {
  const gate = await assertCanManage(dbi, actor, assetId);
  if (!gate.ok) return gate;
  await dbi.audioAsset.update({
    where: { id: assetId },
    data: { isArchived: true, archivedAt: new Date(), archiveReason: reason ?? null, isActive: false },
  });
  await recordAssetAuditEvent(dbi, assetId, "archived", actor, reason ? { reason } : undefined);
  return { ok: true };
}

export async function restoreAudioAsset(
  dbi: DbLike,
  actor: AudioAssetActor,
  assetId: string
): Promise<Ok<object> | Err> {
  const gate = await assertCanManage(dbi, actor, assetId);
  if (!gate.ok) return gate;
  await dbi.audioAsset.update({
    where: { id: assetId },
    data: { isArchived: false, archivedAt: null, archiveReason: null, isActive: true },
  });
  await recordAssetAuditEvent(dbi, assetId, "restored", actor);
  return { ok: true };
}

/**
 * Admin-only classification of a legacy_global asset. The admin supplies the
 * EVIDENCED target — this tool never guesses an owner:
 *   - shared_system (it is provably platform content), or
 *   - owner_private with an explicit ownerId, or
 *   - podcast_private with an explicit podcastId (owner derived from the
 *     podcast — never entered separately, so they cannot disagree).
 */
export async function classifyLegacyAudioAssetAdmin(
  dbi: DbLike,
  actor: AudioAssetActor,
  assetId: string,
  target:
    | { scope: "shared_system" }
    | { scope: "owner_private"; ownerId: string }
    | { scope: "podcast_private"; podcastId: string }
): Promise<Ok<object> | Err> {
  if (actor.kind !== "admin") return { ok: false, error: { code: "scope_requires_admin" } };
  const asset = await dbi.audioAsset.findUnique({ where: { id: assetId } });
  if (!asset) return { ok: false, error: { code: "asset_not_found" } };
  if (asset.scope !== "legacy_global") return { ok: false, error: { code: "invalid_scope", scope: asset.scope } };

  let data: Prisma.AudioAssetUncheckedUpdateInput;
  if (target.scope === "shared_system") {
    data = { scope: "shared_system", ownerId: null, podcastId: null, legacyScopeReviewRequired: false };
  } else if (target.scope === "owner_private") {
    const user = await dbi.user.findUnique({ where: { id: target.ownerId }, select: { id: true } });
    if (!user) return { ok: false, error: { code: "asset_forbidden" } };
    data = { scope: "owner_private", ownerId: target.ownerId, podcastId: null, legacyScopeReviewRequired: false };
  } else {
    const pod = await dbi.podcast.findUnique({ where: { id: target.podcastId }, select: { id: true, ownerId: true } });
    if (!pod) return { ok: false, error: { code: "podcast_not_found" } };
    if (!pod.ownerId) return { ok: false, error: { code: "podcast_not_owned" } };
    data = { scope: "podcast_private", ownerId: pod.ownerId, podcastId: pod.id, legacyScopeReviewRequired: false };
  }
  await dbi.audioAsset.update({ where: { id: assetId }, data });
  await recordAssetAuditEvent(dbi, assetId, "classified", actor, { to: target.scope });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Duplicate detection (no cross-owner leak)
// ---------------------------------------------------------------------------
/** Find a duplicate of `contentHash` WITHIN the actor's own visibility. A
 *  byte-identical asset owned by someone else is never revealed — the check
 *  simply reports "no duplicate". */
export async function findDuplicateInScope(dbi: DbLike, actor: AudioAssetActor, contentHash: string) {
  return dbi.audioAsset.findFirst({
    where: { AND: [{ contentHash }, visibleAssetWhere(actor), { isArchived: false }] },
    select: { id: true, name: true, kind: true },
  });
}

// ---------------------------------------------------------------------------
// Safe DTO
// ---------------------------------------------------------------------------
export interface SafeAudioAssetDto {
  id: string;
  name: string;
  kind: string;
  category: string | null;
  tags: string[];
  scope: AudioAssetScope;
  scopeLabel: string;
  durationMs: number | null;
  licenseStatus: string;
  rightsStatus: string;
  processingStatus: string;
  isArchived: boolean;
  legacyScopeReviewRequired: boolean;
  podcastId: string | null; // only meaningful to callers already authorized for the podcast
  previewPath: string; // authorized streaming route — never the storage URL
  createdAt: string;
}

const SCOPE_LABELS: Record<AudioAssetScope, string> = {
  shared_system: "Shared system",
  owner_private: "My library",
  podcast_private: "This podcast",
  legacy_global: "Legacy review required",
};

/** Public-safe projection. NEVER include: audioUrl, storageKey,
 *  rightsDocumentStorageKey, ownerId/uploadedBy identities, provider data. */
export function toSafeAudioAssetDto(asset: {
  id: string; name: string; kind: string; category: string | null; tags: unknown;
  scope: string; durationMs: number | null; licenseStatus: string; rightsStatus: string;
  processingStatus: string; isArchived: boolean; legacyScopeReviewRequired: boolean;
  podcastId: string | null; createdAt: Date;
}): SafeAudioAssetDto {
  const scope = (AUDIO_ASSET_SCOPES as readonly string[]).includes(asset.scope)
    ? (asset.scope as AudioAssetScope)
    : "legacy_global";
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind,
    category: asset.category,
    tags: Array.isArray(asset.tags) ? (asset.tags as string[]) : [],
    scope,
    scopeLabel: SCOPE_LABELS[scope],
    durationMs: asset.durationMs,
    licenseStatus: asset.licenseStatus,
    rightsStatus: asset.rightsStatus,
    processingStatus: asset.processingStatus,
    isArchived: asset.isArchived,
    legacyScopeReviewRequired: asset.legacyScopeReviewRequired,
    podcastId: asset.podcastId,
    previewPath: `/api/audio-assets/${asset.id}/preview`,
    createdAt: asset.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------
export async function recordAssetAuditEvent(
  dbi: DbLike,
  assetId: string,
  event: string,
  actor: AudioAssetActor,
  metadata?: Record<string, unknown>,
  podcastId?: string
): Promise<void> {
  await dbi.audioAssetAuditEvent.create({
    data: {
      assetId,
      event,
      actorType: actor.kind,
      userId: actor.kind === "user" ? actor.userId : null,
      adminIdentity: actor.kind === "admin" ? actor.adminIdentity : null,
      podcastId: podcastId ?? null,
      metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

