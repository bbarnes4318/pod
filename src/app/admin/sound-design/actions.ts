"use server";

import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { getFileDurationMs } from "@/lib/audio/assembly";
import { seedStarterSoundPackCore } from "@/lib/services/soundDesignSeedService";
import {
  ASSET_KINDS,
  PRODUCTION_STYLES,
  SFX_CATEGORIES,
  SFX_DENSITIES,
  isProductionStyle,
  isSfxDensity,
} from "@/lib/audio/soundDesign";
import { revalidatePath } from "next/cache";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

function serializeAsset(a: {
  id: string; name: string; kind: string; category: string | null; tags: unknown;
  audioUrl: string; durationMs: number | null; license: string; licenseNote: string | null;
  rightsConfirmed: boolean; isActive: boolean; source: string; createdAt: Date;
}) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    category: a.category,
    tags: Array.isArray(a.tags) ? (a.tags as string[]) : [],
    audioUrl: a.audioUrl,
    durationMs: a.durationMs,
    license: a.license,
    licenseNote: a.licenseNote,
    rightsConfirmed: a.rightsConfirmed,
    isActive: a.isActive,
    source: a.source,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function fetchSoundDesignData() {
  try {
    const [assets, config] = await Promise.all([
      db.audioAsset.findMany({ orderBy: [{ kind: "asc" }, { createdAt: "desc" }] }),
      db.soundDesignConfig.findUnique({ where: { id: "default" } }),
    ]);
    return {
      success: true,
      assets: assets.map(serializeAsset),
      config: config
        ? {
            themeIntroAssetId: config.themeIntroAssetId,
            themeOutroAssetId: config.themeOutroAssetId,
            bedAssetId: config.bedAssetId,
            stingerAssetIds: Array.isArray(config.stingerAssetIds) ? (config.stingerAssetIds as string[]) : [],
            defaultStyle: config.defaultStyle,
            defaultSfxDensity: config.defaultSfxDensity,
          }
        : null,
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to load sound design data." };
  }
}

/**
 * Upload a new audio asset. License is REQUIRED on every asset; game
 * highlights are additionally rights-gated — the uploader must affirm they
 * hold the rights or the upload is rejected outright.
 */
export async function uploadAudioAsset(formData: FormData) {
  try {
    const name = String(formData.get("name") || "").trim();
    const kind = String(formData.get("kind") || "").trim();
    const category = String(formData.get("category") || "").trim() || null;
    const tagsRaw = String(formData.get("tags") || "").trim();
    const license = String(formData.get("license") || "").trim();
    const licenseNote = String(formData.get("licenseNote") || "").trim() || null;
    const rightsConfirmed = formData.get("rightsConfirmed") === "true";
    const file = formData.get("file");

    if (!name) throw new Error("Asset name is required.");
    if (!(ASSET_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown asset kind '${kind}'.`);
    if (kind === "sfx" && (!category || !(SFX_CATEGORIES as readonly string[]).includes(category))) {
      throw new Error(`SFX assets need a category (${SFX_CATEGORIES.join(", ")}).`);
    }
    if (!license) {
      throw new Error("License is required. Only royalty-free or properly licensed audio may be uploaded.");
    }
    if (kind === "highlight" && !rightsConfirmed) {
      throw new Error(
        "Game highlights are rights-gated: you must affirm you hold the rights to this clip. Broadcast audio pulled from the open web is not allowed."
      );
    }
    if (!(file instanceof File) || file.size === 0) throw new Error("An audio file is required.");
    if (file.size > 35 * 1024 * 1024) throw new Error("File too large (35MB max).");

    const buffer = Buffer.from(await file.arrayBuffer());

    // Probe duration server-side (also proves the file is decodable audio).
    const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
    const tmpPath = path.join(os.tmpdir(), `asset-upload-${crypto.randomUUID()}`);
    fs.writeFileSync(tmpPath, buffer);
    let durationMs: number;
    try {
      durationMs = await getFileDurationMs(ffprobePath, tmpPath);
    } catch {
      throw new Error("File is not decodable audio (ffprobe could not read it).");
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    }

    const safeName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "asset";
    const ext = (file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "") || "mp3";
    const storageKey = `sound-design/uploads/${crypto.randomUUID()}-${safeName}.${ext}`;

    const storage = getStorageProvider();
    const uploaded = await storage.putObject({
      key: storageKey,
      body: buffer,
      contentType: file.type || "audio/mpeg",
    });

    const asset = await db.audioAsset.create({
      data: {
        name,
        kind,
        category: kind === "sfx" ? category : kind === "highlight" ? category : null,
        tags: tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : [],
        audioUrl: uploaded.url,
        storageKey,
        durationMs,
        license,
        licenseNote,
        rightsConfirmed,
        source: "upload",
      },
    });

    revalidatePath("/admin/sound-design");
    return { success: true, assetId: asset.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to upload asset." };
  }
}

export async function setAssetActive(assetId: string, isActive: boolean) {
  try {
    await db.audioAsset.update({ where: { id: assetId }, data: { isActive } });
    revalidatePath("/admin/sound-design");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to update asset." };
  }
}

export async function deleteAudioAsset(assetId: string) {
  try {
    // Unhook from the show config first so we never point at a dead id.
    const config = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
    if (config) {
      const stingers = Array.isArray(config.stingerAssetIds) ? (config.stingerAssetIds as string[]) : [];
      await db.soundDesignConfig.update({
        where: { id: "default" },
        data: {
          themeIntroAssetId: config.themeIntroAssetId === assetId ? null : config.themeIntroAssetId,
          themeOutroAssetId: config.themeOutroAssetId === assetId ? null : config.themeOutroAssetId,
          bedAssetId: config.bedAssetId === assetId ? null : config.bedAssetId,
          stingerAssetIds: stingers.filter((id) => id !== assetId),
        },
      });
    }
    await db.audioAsset.delete({ where: { id: assetId } });
    revalidatePath("/admin/sound-design");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to delete asset." };
  }
}

export async function updateSoundDesignConfig(input: {
  themeIntroAssetId?: string | null;
  themeOutroAssetId?: string | null;
  bedAssetId?: string | null;
  stingerAssetIds?: string[];
  defaultStyle?: string;
  defaultSfxDensity?: string;
}) {
  try {
    if (input.defaultStyle !== undefined && !isProductionStyle(input.defaultStyle)) {
      throw new Error(`Style must be one of ${PRODUCTION_STYLES.join(", ")}.`);
    }
    if (input.defaultSfxDensity !== undefined && !isSfxDensity(input.defaultSfxDensity)) {
      throw new Error(`SFX density must be one of ${SFX_DENSITIES.join(", ")}.`);
    }
    const data = {
      themeIntroAssetId: input.themeIntroAssetId ?? null,
      themeOutroAssetId: input.themeOutroAssetId ?? null,
      bedAssetId: input.bedAssetId ?? null,
      stingerAssetIds: input.stingerAssetIds ?? [],
      ...(input.defaultStyle ? { defaultStyle: input.defaultStyle } : {}),
      ...(input.defaultSfxDensity ? { defaultSfxDensity: input.defaultSfxDensity } : {}),
    };
    await db.soundDesignConfig.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: data,
    });
    revalidatePath("/admin/sound-design");
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to save config." };
  }
}

/**
 * Synthesize + upload the starter sports pack (12 fully original,
 * ffmpeg-generated assets — zero third-party rights involved), then fill any
 * empty slots in the show config with the seeded pieces. Idempotent: re-runs
 * update the existing seed rows instead of duplicating them. The worker also
 * auto-seeds on boot when the library is empty (soundDesignSeedService).
 */
export async function seedStarterSoundPack() {
  try {
    const res = await seedStarterSoundPackCore();
    revalidatePath("/admin/sound-design");
    return { success: true, seededCount: res.seededCount };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to seed starter pack." };
  }
}
