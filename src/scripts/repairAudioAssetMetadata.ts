// Explicit legacy-asset metadata repair. DRY-RUN by default.
//
//   npm run repair:audio-asset-metadata                       (dry-run, all incomplete)
//   npm run repair:audio-asset-metadata -- --asset-id <id>    (dry-run, one asset)
//   npm run repair:audio-asset-metadata -- --apply            (write)
//
// For assets missing contentHash / technical metadata (pre-Prompt-6 rows),
// this tool downloads the stored object (BOUNDED), computes sha256, runs
// ffprobe, and fills ONLY the missing technical fields. It NEVER:
//   * guesses ownership or scope (that is admin classification, not repair);
//   * changes license or rights state;
//   * replaces a non-null contentHash (media is immutable);
//   * runs at application startup or inside a migration.
//
// SECURITY: prints asset IDs, never raw storage URLs/keys.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFileSync } from "child_process";
import { db } from "../lib/db";
import { getStorageProvider } from "../lib/providers/storage/factory";

const MAX_REPAIR_BYTES = Number(process.env.AUDIO_ASSET_MAX_BYTES || 100 * 1024 * 1024); // 100MB bound

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes("--apply"),
    assetId: (() => { const i = args.indexOf("--asset-id"); return i >= 0 ? args[i + 1] : undefined; })(),
  };
}

function ffprobeMeta(ffprobePath: string, filePath: string): {
  durationMs: number | null; sampleRate: number | null; channelCount: number | null; bitrateKbps: number | null; codec: string | null;
} {
  const out = execFileSync(ffprobePath, [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,channels,codec_name:format=duration,bit_rate",
    "-of", "json", filePath,
  ], { encoding: "utf8" });
  const j = JSON.parse(out);
  const stream = j.streams?.[0] ?? {};
  const format = j.format ?? {};
  return {
    durationMs: format.duration ? Math.round(parseFloat(format.duration) * 1000) : null,
    sampleRate: stream.sample_rate ? parseInt(stream.sample_rate, 10) : null,
    channelCount: typeof stream.channels === "number" ? stream.channels : null,
    bitrateKbps: format.bit_rate ? Math.round(parseInt(format.bit_rate, 10) / 1000) : null,
    codec: stream.codec_name ?? null,
  };
}

async function main() {
  const { apply, assetId } = parseArgs();
  console.log(`\n=== Audio-asset metadata repair (${apply ? "APPLY" : "dry-run"}) ===\n`);

  const where = assetId
    ? { id: assetId }
    : { OR: [{ contentHash: null }, { fileSizeBytes: null }, { mimeType: null }] };
  const targets = await db.audioAsset.findMany({ where, orderBy: { createdAt: "asc" } });
  if (targets.length === 0) { console.log("Nothing to repair."); await db.$disconnect(); return; }
  console.log(`${targets.length} asset(s) selected.\n`);

  const storage = getStorageProvider();
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  let repaired = 0, skipped = 0, failed = 0;

  for (const a of targets) {
    const label = `${a.id.slice(0, 8)} (${a.kind}, ${a.scope})`;
    if (!a.storageKey && !a.audioUrl) { console.log(`  SKIP ${label}: no storage reference`); skipped++; continue; }

    // Bounded size check BEFORE download when the provider can head.
    try {
      const head = await storage.headObject({ key: a.storageKey ?? undefined, url: a.audioUrl }).catch(() => null);
      if (head?.sizeBytes && head.sizeBytes > MAX_REPAIR_BYTES) {
        console.log(`  SKIP ${label}: object exceeds the ${MAX_REPAIR_BYTES}-byte repair bound`);
        skipped++;
        continue;
      }
    } catch { /* head unsupported — the post-download bound below still applies */ }

    let tmp: string | null = null;
    try {
      const obj = await storage.getObject({ key: a.storageKey ?? undefined, url: a.audioUrl });
      if (obj.body.length === 0) throw new Error("empty object");
      if (obj.body.length > MAX_REPAIR_BYTES) throw new Error("object exceeds repair bound");

      const hash = crypto.createHash("sha256").update(obj.body).digest("hex");
      if (a.contentHash && a.contentHash !== hash) {
        // NEVER overwrite an expected hash — this is a media-integrity failure.
        console.log(`  FAIL ${label}: stored bytes do not match the recorded contentHash — flagged for admin review, nothing changed`);
        failed++;
        continue;
      }

      tmp = path.join(os.tmpdir(), `asset-repair-${crypto.randomUUID()}`);
      fs.writeFileSync(tmp, obj.body);
      const meta = ffprobeMeta(ffprobePath, tmp);

      const patch: Record<string, unknown> = {};
      if (!a.contentHash) patch.contentHash = hash;
      if (!a.fileSizeBytes) patch.fileSizeBytes = obj.body.length;
      if (!a.mimeType && obj.contentType) patch.mimeType = obj.contentType;
      if (!a.durationMs && meta.durationMs) patch.durationMs = meta.durationMs;
      if (!a.sampleRate && meta.sampleRate) patch.sampleRate = meta.sampleRate;
      if (!a.channelCount && meta.channelCount) patch.channelCount = meta.channelCount;
      if (!a.bitrateKbps && meta.bitrateKbps) patch.bitrateKbps = meta.bitrateKbps;

      if (Object.keys(patch).length === 0) { console.log(`  OK   ${label}: already complete`); skipped++; continue; }

      if (apply) {
        await db.audioAsset.update({ where: { id: a.id }, data: patch });
        await db.audioAssetAuditEvent.create({
          data: { assetId: a.id, event: "metadata_extracted", actorType: "system", metadata: { fields: Object.keys(patch), tool: "repair:audio-asset-metadata" } },
        });
        console.log(`  FIXED ${label}: ${Object.keys(patch).join(", ")}`);
      } else {
        console.log(`  WOULD FIX ${label}: ${Object.keys(patch).join(", ")}`);
      }
      repaired++;
    } catch (err) {
      console.log(`  FAIL ${label}: ${(err as Error).message}`);
      failed++;
    } finally {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
    }
  }

  console.log(`\n${apply ? "Repaired" : "Would repair"}: ${repaired}, skipped: ${skipped}, failed: ${failed}`);
  if (!apply && repaired > 0) console.log("Re-run with --apply to write.");
  await db.$disconnect();
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exit(1); });
