// Source the frozen Epidemic Sound crate (ingest-manifest.json) and ingest it
// into the AudioAsset library. RUN THIS ON THE SERVER (or anywhere the prod DB
// + S3 are reachable) with EPIDEMIC_SOUND_API_KEY, DATABASE_URL and S3_* in env.
//
//   npm run ingest:epidemic                 # full run (DB + S3 writes)
//   npm run ingest:epidemic -- --dry-run    # source+download+transcode only, no DB/S3
//   npm run ingest:epidemic -- --limit 3    # first N manifest entries (debugging)
//
// For each manifest entry it resolves a FRESH WAV download URL from ES (URLs
// expire, so this happens at run time, not at curation time), downloads,
// verifies the file decodes (ffprobe), transcodes to the mix pipeline's native
// 44.1kHz/16-bit stereo WAV, uploads to S3 via the app's storage client, and
// upserts an AudioAsset row BY NAME (source="upload", isActive=true,
// rightsConfirmed=true). Idempotent: re-runs update in place.
//
// After ingest it (a) deactivates the synthesized seed pack (source="seed" ->
// isActive=false) so the planner stops choosing beeps — WITHOUT deleting them,
// and (b) repoints SoundDesignConfig's intro/outro/bed/stinger slots off the
// seeds onto real ES assets, so a render uses ES audio whether the planner is
// enabled (SOUND_DESIGN_PLANNER=true, picks from active assets) or the legacy
// renderer is running (reads the config slots).
//
// NEVER hardcode or commit EPIDEMIC_SOUND_API_KEY — it is read from env.

import * as dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getFileDurationMs, runFfmpeg } from "../lib/audio/assembly";
import { ASSET_KINDS, SFX_CATEGORIES } from "../lib/audio/soundDesignShared";
import { EpidemicMcpClient } from "../lib/epidemic/mcpClient";

interface CrateEntry {
  esId: string;
  esType: "recording" | "soundEffect";
  stemType?: "FULL" | "BASS" | "DRUMS" | "INSTRUMENTS";
  kind: string;
  category: string | null;
  name: string;
  tags: string[];
  durationMs: number | null;
  artist?: string;
  bpm?: number | null;
  license: string;
  licenseNote: string;
  esTitle?: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) return process.argv[idx + 1];
  return fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "asset";
}

function validateManifest(entries: CrateEntry[]) {
  for (const e of entries) {
    if (!e.esId || !e.esType || !e.name || !e.kind || !e.license) {
      throw new Error(`Manifest entry missing required fields: ${JSON.stringify(e).slice(0, 160)}`);
    }
    if (!(ASSET_KINDS as readonly string[]).includes(e.kind)) throw new Error(`Unknown kind '${e.kind}' for ${e.name}`);
    if (e.kind === "sfx" && !(SFX_CATEGORIES as readonly string[]).includes(e.category || "")) {
      throw new Error(`SFX '${e.name}' needs a valid category (got '${e.category}')`);
    }
  }
}

async function fetchToFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function resolveWavUrl(client: EpidemicMcpClient, e: CrateEntry): Promise<string> {
  return e.esType === "recording"
    ? client.recordingWavUrl(e.esId, (e.stemType as any) || "FULL")
    : client.soundEffectWavUrl(e.esId);
}

async function main() {
  const manifestPath = arg("manifest", "ingest-manifest.json")!;
  const dryRun = hasFlag("dry-run");
  const limit = Number(arg("limit", "0")) || 0;
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

  const all: CrateEntry[] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  validateManifest(all);
  const entries = limit > 0 ? all.slice(0, limit) : all;
  console.log(`Ingesting ${entries.length} Epidemic assets${dryRun ? " (DRY RUN — no DB/S3 writes)" : ""}…`);

  const client = new EpidemicMcpClient();
  await client.init();

  // Lazy: only touch the DB/storage on a real run (DB is unreachable in dry-run/local).
  let db: any = null;
  let storage: any = null;
  if (!dryRun) {
    db = (await import("../lib/db")).db;
    storage = (await import("../lib/providers/storage/factory")).getStorageProvider();
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "es-ingest-"));
  const ingested: Array<{ id: string; name: string; kind: string; category: string | null }> = [];
  const failures: Array<{ name: string; error: string }> = [];

  try {
    for (const e of entries) {
      try {
        // Resolve a fresh URL right before download (URLs expire).
        let url = await resolveWavUrl(client, e);
        const rawPath = path.join(work, `raw-${safeName(e.name)}.wav`);
        let bytes: number;
        try {
          bytes = await fetchToFile(url, rawPath);
        } catch {
          url = await resolveWavUrl(client, e); // one retry with a fresh URL
          bytes = await fetchToFile(url, rawPath);
        }

        const durationMs = await getFileDurationMs(ffprobePath, rawPath); // throws if not decodable audio

        // Transcode to the mix pipeline's native format (also shrinks 48k/24-bit ES WAVs).
        const prepPath = path.join(work, `prep-${safeName(e.name)}.wav`);
        await runFfmpeg(ffmpegPath, ["-y", "-i", rawPath, "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", prepPath]);
        const prepBytes = fs.statSync(prepPath).size;

        if (dryRun) {
          console.log(
            `  [dry] ${e.kind.padEnd(11)} ${e.name.slice(0, 44).padEnd(44)} ` +
              `raw ${(bytes / 1048576).toFixed(1)}MB -> prep ${(prepBytes / 1048576).toFixed(1)}MB (${durationMs}ms)`
          );
          fs.rmSync(rawPath, { force: true });
          fs.rmSync(prepPath, { force: true });
          continue;
        }

        const storageKey = `sound-design/uploads/${crypto.randomUUID()}-${safeName(e.name)}.wav`;
        const uploaded = await storage.putObject({
          key: storageKey,
          body: fs.readFileSync(prepPath),
          contentType: "audio/wav",
        });

        const data = {
          name: e.name,
          kind: e.kind,
          category: e.kind === "sfx" ? e.category : null,
          tags: e.tags ?? [],
          audioUrl: uploaded.url,
          storageKey,
          durationMs,
          license: e.license,
          licenseNote: e.licenseNote ?? null,
          rightsConfirmed: true,
          isActive: true,
          source: "upload",
        };
        const existing = await db.audioAsset.findFirst({ where: { name: e.name } });
        const row = existing
          ? await db.audioAsset.update({ where: { id: existing.id }, data })
          : await db.audioAsset.create({ data });
        ingested.push({ id: row.id, name: e.name, kind: e.kind, category: e.kind === "sfx" ? e.category : null });
        console.log(`  ${existing ? "updated" : "created"} ${e.kind.padEnd(11)} ${e.name} (${durationMs}ms) -> ${row.id}`);

        fs.rmSync(rawPath, { force: true });
        fs.rmSync(prepPath, { force: true });
      } catch (err: any) {
        failures.push({ name: e.name, error: err?.message || String(err) });
        console.error(`  FAILED ${e.kind.padEnd(11)} ${e.name}: ${err?.message || err}`);
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  if (dryRun) {
    console.log(`\nDry run complete. ${entries.length - failures.length}/${entries.length} sourced+transcoded OK.`);
    if (failures.length) console.log("failures:", JSON.stringify(failures, null, 2));
    return;
  }

  // ---- Deactivate synth seeds (do not delete) ---------------------------
  const seedResult = await db.audioAsset.updateMany({ where: { source: "seed" }, data: { isActive: false } });
  console.log(`\nDeactivated ${seedResult.count} seed asset(s) (source="seed" -> isActive=false).`);

  // ---- Repoint SoundDesignConfig onto ES assets -------------------------
  const firstOf = (kind: string) => ingested.find((a) => a.kind === kind)?.id ?? null;
  const introId = firstOf("theme_intro");
  const outroId = firstOf("theme_outro");
  const bedId = firstOf("bed");
  const stingerIds = ingested.filter((a) => a.kind === "stinger").slice(0, 5).map((a) => a.id);

  const existingConfig = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
  const configData = {
    themeIntroAssetId: introId ?? existingConfig?.themeIntroAssetId ?? null,
    themeOutroAssetId: outroId ?? existingConfig?.themeOutroAssetId ?? null,
    bedAssetId: bedId ?? existingConfig?.bedAssetId ?? null,
    stingerAssetIds: stingerIds.length ? stingerIds : (existingConfig?.stingerAssetIds ?? []),
    defaultStyle: existingConfig?.defaultStyle ?? "full",
    defaultSfxDensity: existingConfig?.defaultSfxDensity ?? "medium",
  };
  await db.soundDesignConfig.upsert({
    where: { id: "default" },
    create: { id: "default", ...configData },
    update: configData,
  });
  console.log(
    `Repointed SoundDesignConfig: intro=${introId} outro=${outroId} bed=${bedId} stingers=[${stingerIds.join(", ")}]`
  );

  // ---- Summary + report -------------------------------------------------
  const byKind: Record<string, number> = {};
  for (const a of ingested) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  console.log(`\nIngested ${ingested.length}/${entries.length} assets. by kind: ${JSON.stringify(byKind)}`);
  if (failures.length) console.log(`Failures (${failures.length}):`, JSON.stringify(failures, null, 2));

  const report = {
    ranAt: new Date().toISOString(),
    ingestedCount: ingested.length,
    byKind,
    seedsDeactivated: seedResult.count,
    config: configData,
    ingested,
    failures,
  };
  fs.writeFileSync("ingest-report.json", JSON.stringify(report, null, 2));
  console.log("Wrote ingest-report.json");

  if (ingested.length === 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
