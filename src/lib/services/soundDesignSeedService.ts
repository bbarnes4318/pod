// Starter sound-pack seeding, callable from the admin console AND from
// worker startup (auto-seed): the pack ships with the app the same way
// migrations do, so a fresh deployment has a working produced-audio layer
// out of the box. Fully idempotent — re-runs update seed rows in place.

import fs from "fs";
import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { SEED_LICENSE, STARTER_PACK, generateStarterPack } from "@/lib/audio/soundPackGenerator";

export async function seedStarterSoundPackCore(): Promise<{ seededCount: number }> {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const storage = getStorageProvider();

  const { dir, assets } = await generateStarterPack(ffmpegPath);
  const created: Record<string, string> = {}; // fileName -> assetId
  try {
    for (const asset of assets) {
      const storageKey = `sound-design/seed/${asset.fileName}`;
      const uploaded = await storage.putObject({
        key: storageKey,
        body: fs.readFileSync(asset.filePath),
        contentType: "audio/mpeg",
      });

      const existing = await db.audioAsset.findFirst({ where: { storageKey } });
      const data = {
        name: asset.name,
        kind: asset.kind,
        category: asset.category,
        tags: asset.tags,
        audioUrl: uploaded.url,
        storageKey,
        durationMs: asset.durationMs,
        license: SEED_LICENSE,
        licenseNote:
          "Synthesized with ffmpeg oscillators/noise by this app's seed generator; no samples, no third-party material.",
        rightsConfirmed: true,
        isActive: true,
        source: "seed",
      };
      const row = existing
        ? await db.audioAsset.update({ where: { id: existing.id }, data })
        : await db.audioAsset.create({ data });
      created[asset.fileName] = row.id;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Fill empty config slots with the seeded pack (never overwrite a pick).
  const config = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
  const stingerIds = [
    created["stinger-slam-riser.mp3"],
    created["stinger-drum-hit.mp3"],
    created["stinger-whoosh-cut.mp3"],
  ].filter(Boolean);
  const fill = {
    themeIntroAssetId: config?.themeIntroAssetId || created["theme-intro-arena-charge.mp3"] || null,
    themeOutroAssetId: config?.themeOutroAssetId || created["theme-outro-final-whistle.mp3"] || null,
    bedAssetId: config?.bedAssetId || created["bed-fast-break.mp3"] || null,
    stingerAssetIds:
      Array.isArray(config?.stingerAssetIds) && (config!.stingerAssetIds as string[]).length > 0
        ? (config!.stingerAssetIds as string[])
        : stingerIds,
  };
  await db.soundDesignConfig.upsert({
    where: { id: "default" },
    create: { id: "default", ...fill },
    update: fill,
  });

  return { seededCount: assets.length };
}

/**
 * Worker-startup hook: seed whenever any STARTER_PACK asset is missing — so
 * a grown pack lands its NEW assets on the next boot even though older seed
 * rows already exist (the core upserts by storageKey, never duplicating).
 * Disable with SOUND_DESIGN_AUTOSEED=false.
 */
export async function ensureStarterSoundPack(): Promise<void> {
  if (process.env.SOUND_DESIGN_AUTOSEED === "false") return;
  const existing = await db.audioAsset.findMany({
    where: { source: "seed" },
    select: { storageKey: true },
  });
  const have = new Set(existing.map((r) => r.storageKey));
  const missing = STARTER_PACK.filter((s) => !have.has(`sound-design/seed/${s.fileName}`));
  if (missing.length === 0) return;
  console.log(
    `[SoundDesign] ${missing.length} of ${STARTER_PACK.length} starter assets missing ` +
      `(${missing.map((m) => m.fileName).join(", ")}) — synthesizing the sports pack…`
  );
  const res = await seedStarterSoundPackCore();
  console.log(`[SoundDesign] Seeded ${res.seededCount} starter assets and filled empty show-config slots.`);
}
