"use server";

// Owner audio-library server actions (Prompt 6). Thin wrappers: every rule
// lives in the canonical services. The session decides the actor — never a
// client-supplied owner id. DTOs are safe: no storage keys, no raw URLs.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import {
  listAccessibleAudioAssets,
  toSafeAudioAssetDto,
  archiveAudioAsset,
  restoreAudioAsset,
  updateAudioAssetMetadata,
  type AudioAssetActor,
  type SafeAudioAssetDto,
} from "@/lib/services/audioAssetAccess";
import { uploadAudioAsset as uploadService } from "@/lib/services/audioAssetUpload";

async function actor(): Promise<AudioAssetActor | null> {
  const user = await currentUser();
  return user ? { kind: "user", userId: user.id } : null;
}

export interface MyAudioLibrary {
  success: boolean;
  error?: string;
  assets?: SafeAudioAssetDto[];
  /** Podcasts this user owns (for scope selection + filters). */
  podcasts?: Array<{ id: string; name: string }>;
  usage?: Record<string, number>; // assetId -> this owner's usage count
}

export async function fetchMyAudioLibrary(): Promise<MyAudioLibrary> {
  const a = await actor();
  if (!a) return { success: false, error: "Sign in to manage your audio library." };
  try {
    const [assets, podcasts] = await Promise.all([
      listAccessibleAudioAssets(db, a, { includeArchived: true }),
      db.podcast.findMany({ where: { ownerId: (a as { userId: string }).userId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    ]);
    // Usage scoped to THIS owner only — never platform-wide private usage.
    const usageRows = await db.soundCueUsage.groupBy({
      by: ["assetId"],
      where: { ownerId: (a as { userId: string }).userId },
      _count: { assetId: true },
    });
    return {
      success: true,
      assets: assets.map(toSafeAudioAssetDto),
      podcasts,
      usage: Object.fromEntries(usageRows.map((u) => [u.assetId, u._count.assetId])),
    };
  } catch (err) {
    return { success: false, error: (err as Error).message || "Could not load the library." };
  }
}

const UPLOAD_ERROR_COPY: Record<string, string> = {
  invalid_name: "Give the asset a name (200 characters max).",
  invalid_kind: "Pick a valid asset kind.",
  empty_file: "The file is empty.",
  file_too_large: "The file is too large.",
  unsupported_format: "Only MP3, WAV, FLAC, or M4A audio is accepted (the actual content is checked, not the filename).",
  not_decodable: "That file is not decodable audio.",
  duration_too_long: "The audio is too long for this asset kind.",
  duplicate_asset: "You already have an identical file in your library.",
  rights_document_invalid: "Rights documents must be PDF, PNG, or JPEG.",
  rights_document_too_large: "The rights document is too large.",
  storage_failed: "Storage is unavailable right now — try again.",
  podcast_not_owned: "That show belongs to another account.",
  podcast_not_found: "That show no longer exists.",
  scope_requires_admin: "Only the shared system library can hold that scope.",
};

export async function uploadMyAudioAsset(formData: FormData) {
  const a = await actor();
  if (!a) return { success: false, error: "Sign in to upload audio." };
  try {
    const file = formData.get("file");
    if (!(file instanceof File)) return { success: false, error: "An audio file is required." };
    const rightsDoc = formData.get("rightsDocument");
    const scope = String(formData.get("scope") || "owner_private") === "podcast_private" ? "podcast_private" : "owner_private";
    const res = await uploadService(db, a, {
      name: String(formData.get("name") || ""),
      kind: String(formData.get("kind") || ""),
      category: String(formData.get("category") || "").trim() || null,
      tags: String(formData.get("tags") || "").split(",").map((t) => t.trim()).filter(Boolean),
      scope,
      podcastId: scope === "podcast_private" ? String(formData.get("podcastId") || "") : null,
      bytes: Buffer.from(await file.arrayBuffer()),
      originalFilename: file.name,
      licenseStatus: String(formData.get("licenseStatus") || "original"),
      licenseName: String(formData.get("licenseName") || "").trim() || null,
      rightsStatus: formData.get("rightsConfirmed") === "true" ? "confirmed" : "not_required",
      rightsNotes: String(formData.get("rightsNotes") || "").trim() || null,
      rightsDocument: rightsDoc instanceof File && rightsDoc.size > 0 ? Buffer.from(await rightsDoc.arrayBuffer()) : null,
    });
    if (!res.ok) return { success: false, error: UPLOAD_ERROR_COPY[res.error.code] ?? `Upload failed (${res.error.code}).` };
    revalidatePath("/studio/audio");
    return { success: true, assetId: res.assetId };
  } catch (err) {
    return { success: false, error: (err as Error).message || "Upload failed." };
  }
}

export async function archiveMyAudioAsset(assetId: string) {
  const a = await actor();
  if (!a) return { success: false, error: "Sign in first." };
  const res = await archiveAudioAsset(db, a, assetId, "Archived by owner.");
  if (!res.ok) return { success: false, error: "That asset could not be archived." };
  revalidatePath("/studio/audio");
  return { success: true };
}

export async function restoreMyAudioAsset(assetId: string) {
  const a = await actor();
  if (!a) return { success: false, error: "Sign in first." };
  const res = await restoreAudioAsset(db, a, assetId);
  if (!res.ok) return { success: false, error: "That asset could not be restored." };
  revalidatePath("/studio/audio");
  return { success: true };
}

export async function renameMyAudioAsset(assetId: string, name: string) {
  const a = await actor();
  if (!a) return { success: false, error: "Sign in first." };
  const trimmed = name.trim().slice(0, 200);
  if (!trimmed) return { success: false, error: "A name is required." };
  const res = await updateAudioAssetMetadata(db, a, assetId, { name: trimmed });
  if (!res.ok) return { success: false, error: "That asset could not be renamed." };
  revalidatePath("/studio/audio");
  return { success: true };
}
