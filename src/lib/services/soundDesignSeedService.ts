// Starter sound-pack seeding, callable from the admin console AND from
// worker startup (auto-seed): the pack ships with the app the same way
// migrations do, so a fresh deployment has a working produced-audio layer
// out of the box.
//
// Prompt 6 semantics — seed assets are SHARED SYSTEM library entries and
// media content is IMMUTABLE:
//   * every seed asset is scope "shared_system" (no owner, no podcast), with
//     structured license/rights state (generated in-house, rights confirmed);
//   * re-running with UNCHANGED generator bytes is a no-op (idempotent by
//     content hash — no upload, no row churn);
//   * re-running with CHANGED generator bytes NEVER overwrites the old media:
//     it uploads the new bytes to a NEW content-versioned storage key, creates
//     a NEW asset row, marks the old one superseded+archived, and repoints the
//     system default profile so only FUTURE episodes pick up the new sound.
//     Historical references to the old asset stay intact and auditable.

import fs from "fs";
import crypto from "crypto";
import { db } from "@/lib/db";
import { getStorageProvider } from "@/lib/providers/storage/factory";
import { SEED_LICENSE, STARTER_PACK, generateStarterPack } from "@/lib/audio/soundPackGenerator";

const SEED_LICENSE_NOTE =
  "Synthesized with ffmpeg oscillators/noise by this app's seed generator; no samples, no third-party material.";

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/** Content-versioned seed key: same bytes -> same key, changed bytes -> a new
 *  key, so a regenerated pack can never overwrite media that historical
 *  episodes reference. (Pre-Prompt-6 seeds used the unversioned
 *  `sound-design/seed/<file>` form; lookups match both via endsWith.) */
function seedStorageKey(fileName: string, contentHash: string): string {
  return `sound-design/seed/v-${contentHash.slice(0, 8)}/${fileName}`;
}

export async function seedStarterSoundPackCore(opts?: {
  /** Recorded on audit events; defaults to the system actor (worker boot). */
  adminIdentity?: string;
}): Promise<{ seededCount: number }> {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const storage = getStorageProvider();
  const actor = opts?.adminIdentity ?? null;

  const { dir, assets } = await generateStarterPack(ffmpegPath);
  const current: Record<string, string> = {}; // fileName -> current (non-superseded) assetId
  let touched = 0;
  try {
    for (const asset of assets) {
      const bytes = fs.readFileSync(asset.filePath);
      const hash = sha256(bytes);

      // The CURRENT seed asset for this pack file — legacy plain key or any
      // content-versioned key, as long as it has not been superseded.
      const existing = await db.audioAsset.findFirst({
        where: {
          source: "seed",
          storageKey: { endsWith: `/${asset.fileName}` },
          supersededByAssetId: null,
        },
        orderBy: { createdAt: "desc" },
      });

      if (existing) {
        // Legacy seed rows predate content hashing: adopt the hash of the
        // bytes ACTUALLY IN STORAGE (never assume they match the generator).
        let existingHash = existing.contentHash;
        if (!existingHash && existing.storageKey) {
          try {
            const stored = await storage.getObject({ key: existing.storageKey, url: existing.audioUrl });
            existingHash = sha256(stored.body);
            await db.audioAsset.update({ where: { id: existing.id }, data: { contentHash: existingHash } });
          } catch {
            // Storage object unreadable — leave hash null; the repair tool and
            // audit command surface this state.
          }
        }

        if (existingHash === hash) {
          current[asset.fileName] = existing.id; // up to date — a true no-op
          continue;
        }

        // Generator bytes CHANGED: new immutable version, old preserved.
        const newKey = seedStorageKey(asset.fileName, hash);
        const uploaded = await storage.putObject({ key: newKey, body: bytes, contentType: "audio/mpeg" });
        const replacement = await db.audioAsset.create({
          data: {
            ...seedAssetData(asset, uploaded.url, newKey, hash, bytes.length),
            createdByAdminIdentity: actor,
          },
        });
        await db.audioAsset.update({
          where: { id: existing.id },
          data: {
            supersededByAssetId: replacement.id,
            isArchived: true,
            archivedAt: new Date(),
            archiveReason: "Superseded by a regenerated starter-pack version.",
            isActive: false,
          },
        });
        await db.audioAssetAuditEvent.createMany({
          data: [
            { assetId: replacement.id, event: "created", actorType: actor ? "admin" : "system", adminIdentity: actor, metadata: { reason: "seed_pack_new_version", supersedes: existing.id } },
            { assetId: existing.id, event: "superseded", actorType: actor ? "admin" : "system", adminIdentity: actor, metadata: { supersededBy: replacement.id } },
          ],
        });
        current[asset.fileName] = replacement.id;
        touched++;
        continue;
      }

      // Never seeded here before: upload + create fresh.
      const key = seedStorageKey(asset.fileName, hash);
      const uploaded = await storage.putObject({ key, body: bytes, contentType: "audio/mpeg" });
      const row = await db.audioAsset.create({
        data: {
          ...seedAssetData(asset, uploaded.url, key, hash, bytes.length),
          createdByAdminIdentity: actor,
        },
      });
      await db.audioAssetAuditEvent.create({
        data: { assetId: row.id, event: "created", actorType: actor ? "admin" : "system", adminIdentity: actor, metadata: { reason: "seed_pack_initial" } },
      });
      current[asset.fileName] = row.id;
      touched++;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Fill empty config slots with the seeded pack (never overwrite a manual
  // pick) and REPOINT any slot that references a superseded seed so future
  // episodes use the current version. NOTE: this singleton is the SYSTEM
  // DEFAULT profile only — it is not a per-Podcast show configuration.
  const config = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
  const supersededIds = await supersededSeedIds();
  const remap = (id: string | null | undefined) => (id && supersededIds.has(id) ? supersededIds.get(id)! : id || null);
  const stingerIds = [
    current["stinger-slam-riser.mp3"],
    current["stinger-drum-hit.mp3"],
    current["stinger-whoosh-cut.mp3"],
  ].filter(Boolean);
  const existingStingers = Array.isArray(config?.stingerAssetIds) ? (config!.stingerAssetIds as string[]) : [];
  const fill = {
    themeIntroAssetId: remap(config?.themeIntroAssetId) || current["theme-intro-arena-charge.mp3"] || null,
    themeOutroAssetId: remap(config?.themeOutroAssetId) || current["theme-outro-final-whistle.mp3"] || null,
    bedAssetId: remap(config?.bedAssetId) || current["bed-fast-break.mp3"] || null,
    stingerAssetIds:
      existingStingers.length > 0 ? existingStingers.map((id) => remap(id) || id) : stingerIds,
  };
  await db.soundDesignConfig.upsert({
    where: { id: "default" },
    create: { id: "default", ...fill },
    update: fill,
  });

  return { seededCount: assets.length };
}

/** Map of superseded seed asset id -> its replacement id. */
async function supersededSeedIds(): Promise<Map<string, string>> {
  const rows = await db.audioAsset.findMany({
    where: { source: "seed", supersededByAssetId: { not: null } },
    select: { id: true, supersededByAssetId: true },
  });
  return new Map(rows.map((r) => [r.id, r.supersededByAssetId!]));
}

function seedAssetData(
  asset: { name: string; kind: string; category: string | null; tags: unknown; durationMs: number },
  audioUrl: string,
  storageKey: string,
  contentHash: string,
  fileSizeBytes: number
) {
  return {
    name: asset.name,
    kind: asset.kind,
    category: asset.category,
    tags: asset.tags as object,
    audioUrl,
    storageKey,
    durationMs: asset.durationMs,
    // Legacy compat fields (old readers):
    license: SEED_LICENSE,
    licenseNote: SEED_LICENSE_NOTE,
    rightsConfirmed: true,
    isActive: true,
    source: "seed",
    // Canonical Prompt 6 fields:
    scope: "shared_system",
    ownerId: null,
    podcastId: null,
    licenseStatus: "original",
    licenseName: SEED_LICENSE,
    rightsStatus: "confirmed",
    rightsConfirmedAt: new Date(),
    rightsConfirmedByAdminIdentity: "system:seed-generator",
    contentHash,
    mimeType: "audio/mpeg",
    fileSizeBytes,
    processingStatus: "ready",
    legacyScopeReviewRequired: false,
  };
}

/**
 * Worker-startup hook: seed whenever any STARTER_PACK asset is missing — so
 * a grown pack lands its NEW assets on the next boot even though older seed
 * rows already exist. Boot NEVER rolls out changed generator bytes (that is
 * an explicit admin action); it only repairs missing files, and it never
 * touches private user assets. Disable with SOUND_DESIGN_AUTOSEED=false.
 */
export async function ensureStarterSoundPack(): Promise<void> {
  if (process.env.SOUND_DESIGN_AUTOSEED === "false") return;
  const existing = await db.audioAsset.findMany({
    where: { source: "seed", supersededByAssetId: null },
    select: { storageKey: true },
  });
  const have = new Set<string>();
  for (const r of existing) {
    const m = r.storageKey?.match(/\/([^/]+)$/);
    if (m) have.add(m[1]);
  }
  const missing = STARTER_PACK.filter((s) => !have.has(s.fileName));
  if (missing.length === 0) return;
  console.log(
    `[SoundDesign] ${missing.length} of ${STARTER_PACK.length} starter assets missing ` +
      `(${missing.map((m) => m.fileName).join(", ")}) — synthesizing the sports pack…`
  );
  const res = await seedStarterSoundPackCore();
  console.log(`[SoundDesign] Seeded ${res.seededCount} starter assets and filled empty show-config slots.`);
}
