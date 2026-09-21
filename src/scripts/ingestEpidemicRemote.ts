// Ingest the Epidemic Sound crate into PRODUCTION from an operator machine.
//
// Coolify exposes no container-exec API, so `ingest:epidemic` (which needs the
// prod DB) cannot be run in-container from here. This is the exec-free path:
//   1. resolve fresh ES WAV URLs + download + transcode (44.1k/16-bit stereo)
//      — needs EPIDEMIC_SOUND_API_KEY locally; the key never touches the server
//   2. upload each WAV straight to the app's S3 bucket (S3_* creds work locally)
//   3. POST the metadata to the deployed `/admin/ingest-epidemic` route, which
//      creates the AudioAsset rows in the prod DB (shared_system, licensed,
//      rights-confirmed, ready), deactivates the synth seeds, archives the
//      off-genre themes, and repoints the system-default slots — ONE intro /
//      outro / bed, EVERY stinger (see docs/SOUND_DESIGN.md, "Constant vs.
//      per-episode sound").
//
//   npm run ingest:epidemic:remote                       # everything
//   npm run ingest:epidemic:remote -- --only-new         # skip names already listed (default)
//   npm run ingest:epidemic:remote -- --repoint-only     # step 3 with no assets
//   npm run ingest:epidemic:remote -- --intro "<name>" --outro "<name>"
//
// Env: EPIDEMIC_SOUND_API_KEY, S3_*, PROD_BASE_URL (default
// https://podcast.hopwhistle.com), ADMIN_USERNAME, PROD_ADMIN_PASSWORD (the
// prod /admin Basic-auth password — NOT the dev ADMIN_PASSWORD).

import * as dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getFileDurationMs, runFfmpeg } from "../lib/audio/assembly";
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
  license: string;
  licenseNote: string;
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith("--")) return process.argv[idx + 1];
  return fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);
const safeName = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "asset";

async function fetchToFile(url: string, dest: string): Promise<number> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  const baseUrl = (process.env.PROD_BASE_URL || "https://podcast.hopwhistle.com").replace(/\/$/, "");
  const user = process.env.ADMIN_USERNAME || "admin";
  const pass = process.env.PROD_ADMIN_PASSWORD;
  if (!pass) throw new Error("PROD_ADMIN_PASSWORD is not set (the prod /admin Basic-auth password).");
  const auth = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const post = async (body: unknown) => {
    const res = await fetch(`${baseUrl}/admin/ingest-epidemic`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`route HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  };

  const repoint = { intro: arg("intro"), outro: arg("outro") };
  const tail = { deactivateSeeds: true, archiveOffGenreThemes: true, repoint };

  if (hasFlag("repoint-only")) {
    const r = await post({ assets: [], ...tail });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  const manifestPath = arg("manifest", "ingest-manifest.json")!;
  const all: CrateEntry[] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  // --only-new (default): skip names the previous ingest report already lists,
  // so a re-run only ships the manifest's additions. --all re-sends everything
  // (the route is idempotent on same-URL rows, but that re-downloads 80 WAVs).
  const priorNames = new Set<string>();
  if (!hasFlag("all") && fs.existsSync("ingest-report.json")) {
    try {
      const rep = JSON.parse(fs.readFileSync("ingest-report.json", "utf8"));
      for (const a of rep.ingested ?? []) priorNames.add(a.name);
    } catch { /* no usable report — ship everything */ }
  }
  const limit = Number(arg("limit", "0")) || 0;
  let entries = all.filter((e) => !priorNames.has(e.name));
  if (limit > 0) entries = entries.slice(0, limit);
  console.log(`Shipping ${entries.length}/${all.length} manifest entries to ${baseUrl} (${priorNames.size} already ingested)…`);

  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
  // --urls <json>: { "<esId>": "<signed wav url>" } resolved elsewhere (e.g. an
  // Epidemic MCP session) — skips the local ES key entirely when supplied.
  const urlsPath = arg("urls");
  const presetUrls: Record<string, string> = urlsPath ? JSON.parse(fs.readFileSync(urlsPath, "utf8")) : {};
  let client: EpidemicMcpClient | null = null;
  if (entries.some((e) => !presetUrls[e.esId])) {
    client = new EpidemicMcpClient();
    await client.init();
  }
  const storage = (await import("../lib/providers/storage/factory")).getStorageProvider();

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "es-remote-"));
  const assets: any[] = [];
  const failures: Array<{ name: string; error: string }> = [];
  try {
    for (const e of entries) {
      try {
        const resolve = async () => {
          if (presetUrls[e.esId]) return presetUrls[e.esId];
          if (!client) throw new Error("no preset URL and no ES client");
          return e.esType === "recording" ? client.recordingWavUrl(e.esId, e.stemType || "FULL") : client.soundEffectWavUrl(e.esId);
        };
        const rawPath = path.join(work, `raw-${safeName(e.name)}.wav`);
        try {
          await fetchToFile(await resolve(), rawPath);
        } catch {
          await fetchToFile(await resolve(), rawPath); // one retry with a fresh URL
        }
        const durationMs = await getFileDurationMs(ffprobePath, rawPath);
        const prepPath = path.join(work, `prep-${safeName(e.name)}.wav`);
        await runFfmpeg(ffmpegPath, ["-y", "-i", rawPath, "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", prepPath]);
        const body = fs.readFileSync(prepPath);
        const storageKey = `sound-design/uploads/${crypto.randomUUID()}-${safeName(e.name)}.wav`;
        const uploaded = await storage.putObject({ key: storageKey, body, contentType: "audio/wav" });
        assets.push({
          name: e.name,
          kind: e.kind,
          category: e.kind === "sfx" ? e.category : null,
          tags: e.tags ?? [],
          audioUrl: uploaded.url,
          storageKey,
          durationMs,
          license: e.license,
          licenseNote: e.licenseNote ?? null,
        });
        console.log(`  uploaded ${e.kind.padEnd(11)} ${e.name} (${durationMs}ms, ${(body.length / 1048576).toFixed(1)}MB)`);
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

  if (assets.length === 0 && failures.length > 0) {
    console.error("Nothing uploaded; not calling the route.");
    process.exit(1);
  }

  const result = await post({ assets, ...tail });
  console.log(JSON.stringify(result, null, 2));

  // Merge into the local ingest-report so the next --only-new run skips these.
  let prior: any = {};
  try { prior = JSON.parse(fs.readFileSync("ingest-report.json", "utf8")); } catch { /* first run */ }
  const failedNames = new Set<string>((result.failed ?? []).map((f: any) => f.name));
  const ingested = [
    ...(prior.ingested ?? []),
    ...assets.filter((a) => !failedNames.has(a.name)).map((a) => ({ name: a.name, kind: a.kind })),
  ];
  fs.writeFileSync(
    "ingest-report.json",
    JSON.stringify({ ...prior, ranAt: new Date().toISOString(), remote: true, ingested, failures, config: result.config }, null, 2)
  );
  console.log(`Wrote ingest-report.json (${ingested.length} ingested names on record).`);
  if (failures.length || (result.failed ?? []).length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
