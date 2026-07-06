// Ingest externally sourced audio assets (e.g. an Epidemic Sound crate) into
// the AudioAsset library. Run: npm run ingest:audio-assets -- \
//   --dir ./ingest-assets --manifest ingest-manifest.json [--mode admin|direct]
//
// Manifest: JSON array of { file, name, kind, category?, tags[], license,
// licenseNote? } — durationMs is measured here via ffprobe (which also proves
// every file decodes). Files larger than the upload cap are transcoded to the
// mix pipeline's native 44.1kHz/16-bit stereo WAV (the stitcher standardizes
// every asset to exactly that on render, so nothing is lost downstream).
//
// Modes:
//   direct — upsert AudioAsset rows by name using the app's own db + storage
//            clients. Requires DATABASE_URL/S3 env (run server-side, or
//            anywhere with DB reach). True upsert: re-runs update in place.
//   admin  — drive the /admin/sound-design uploadAudioAsset server action
//            over HTTPS (multipart, progressive-enhancement $ACTION_ID call),
//            exactly the operator's upload path. Needs --base-url plus
//            ADMIN_PASSWORD (or COOLIFY_TOKEN to read it from the Coolify
//            env API in memory). Skips names that already exist (create-only
//            action) — delete in the console first to replace.
//
// License hygiene: license/licenseNote come from the manifest; assets ingest
// with source="upload", isActive=true, rightsConfirmed=true. Never commit
// API keys, and never commit the downloaded audio itself.

import * as dotenv from "dotenv";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getFileDurationMs, runFfmpeg } from "../lib/audio/assembly";
import { ASSET_KINDS, SFX_CATEGORIES } from "../lib/audio/soundDesignShared";

dotenv.config();

const UPLOAD_CAP_BYTES = 34 * 1024 * 1024; // action rejects >35MB; keep margin

interface ManifestEntry {
  file: string;
  name: string;
  kind: string;
  category: string | null;
  tags: string[];
  durationMs?: number | null;
  license: string;
  licenseNote?: string | null;
}

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : fallback;
}

async function prepareFile(
  ffmpegPath: string,
  ffprobePath: string,
  srcPath: string,
  workDir: string
): Promise<{ path: string; durationMs: number; transcoded: boolean }> {
  const durationMs = await getFileDurationMs(ffprobePath, srcPath); // throws if not decodable
  if (fs.statSync(srcPath).size <= UPLOAD_CAP_BYTES) {
    return { path: srcPath, durationMs, transcoded: false };
  }
  const out = path.join(workDir, `prep-${path.basename(srcPath)}`);
  await runFfmpeg(ffmpegPath, [
    "-y", "-i", srcPath,
    "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le",
    out,
  ]);
  if (fs.statSync(out).size > UPLOAD_CAP_BYTES) {
    throw new Error(`${path.basename(srcPath)} still exceeds the upload cap after 44.1k/16-bit transcode.`);
  }
  return { path: out, durationMs, transcoded: true };
}

function loadManifest(dir: string, manifestPath: string): ManifestEntry[] {
  const entries: ManifestEntry[] = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const e of entries) {
    if (!e.file || !e.name || !e.kind || !e.license) {
      throw new Error(`Manifest entry missing required fields: ${JSON.stringify(e)}`);
    }
    if (!(ASSET_KINDS as readonly string[]).includes(e.kind)) {
      throw new Error(`Unknown kind '${e.kind}' for ${e.name}`);
    }
    if (e.kind === "sfx" && !(SFX_CATEGORIES as readonly string[]).includes(e.category || "")) {
      throw new Error(`SFX '${e.name}' needs a category (${SFX_CATEGORIES.join(", ")})`);
    }
    if (!fs.existsSync(path.join(dir, e.file))) {
      throw new Error(`File not found: ${path.join(dir, e.file)}`);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// direct mode — app db + storage clients, true upsert by name
// ---------------------------------------------------------------------------
async function ingestDirect(dir: string, entries: ManifestEntry[], ffmpegPath: string, ffprobePath: string) {
  const { db } = await import("../lib/db");
  const { getStorageProvider } = await import("../lib/providers/storage/factory");
  const storage = getStorageProvider();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "asset-ingest-"));
  try {
    for (const e of entries) {
      const prep = await prepareFile(ffmpegPath, ffprobePath, path.join(dir, e.file), work);
      const safeName = e.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "asset";
      const storageKey = `sound-design/uploads/${crypto.randomUUID()}-${safeName}.wav`;
      const uploaded = await storage.putObject({
        key: storageKey,
        body: fs.readFileSync(prep.path),
        contentType: "audio/wav",
      });
      const data = {
        name: e.name,
        kind: e.kind,
        category: e.kind === "sfx" ? e.category : null,
        tags: e.tags ?? [],
        audioUrl: uploaded.url,
        storageKey,
        durationMs: prep.durationMs,
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
      console.log(`  ${existing ? "updated" : "created"} ${e.kind.padEnd(11)} ${e.name} (${prep.durationMs}ms) -> ${row.id}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// admin mode — the operator's upload action over HTTPS
// ---------------------------------------------------------------------------
async function resolveAdminPassword(): Promise<string> {
  // COOLIFY_TOKEN wins: the remote target's own env is authoritative — a
  // local .env ADMIN_PASSWORD is usually the DEV password and 401s on prod.
  const token = process.env.COOLIFY_TOKEN;
  if (!token && process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const coolifyUrl = process.env.COOLIFY_URL || "http://178.156.153.87:8000";
  const appUuid = process.env.COOLIFY_WEB_APP_UUID || "fs2y9ukgyykqq39bptosl7un";
  if (!token) throw new Error("admin mode needs ADMIN_PASSWORD or COOLIFY_TOKEN in env.");
  const res = await fetch(`${coolifyUrl}/api/v1/applications/${appUuid}/envs`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Coolify env read failed: HTTP ${res.status}`);
  const envs = (await res.json()) as Array<{ key: string; value: string; is_preview: boolean }>;
  const row = envs.find((e) => e.key === "ADMIN_PASSWORD" && !e.is_preview);
  if (!row) throw new Error("ADMIN_PASSWORD not found in Coolify env.");
  return row.value;
}

async function discoverActionIds(baseUrl: string, auth: string): Promise<{ upload: string; fetchData: string }> {
  const page = await fetch(`${baseUrl}/admin/sound-design`, { headers: { Authorization: auth } });
  if (!page.ok) throw new Error(`GET /admin/sound-design -> HTTP ${page.status}`);
  const html = await page.text();
  const chunks = [...new Set(html.match(/\/_next\/static\/chunks\/[0-9A-Za-z_.-]+[.]js/g) || [])];
  let upload = "";
  let fetchData = "";
  for (const c of chunks) {
    const js = await (await fetch(baseUrl + c)).text();
    for (const m of js.matchAll(/createServerReference\)\("([0-9a-f]{40,44})"[^)]{0,140}?,"(uploadAudioAsset|fetchSoundDesignData)"/g)) {
      if (m[2] === "uploadAudioAsset") upload = m[1];
      else fetchData = m[1];
    }
  }
  if (!upload || !fetchData) throw new Error("Could not discover server-action IDs from prod chunks (build changed?).");
  return { upload, fetchData };
}

async function ingestAdmin(dir: string, entries: ManifestEntry[], ffmpegPath: string, ffprobePath: string, baseUrl: string) {
  const password = await resolveAdminPassword();
  const auth = "Basic " + Buffer.from(`${process.env.ADMIN_USERNAME || "admin"}:${password}`).toString("base64");
  const ids = await discoverActionIds(baseUrl, auth);
  console.log(`  action ids: upload=${ids.upload.slice(0, 10)}… fetchData=${ids.fetchData.slice(0, 10)}…`);

  // Existing names — the upload action is create-only, so skip duplicates.
  const listRes = await fetch(`${baseUrl}/admin/sound-design`, {
    method: "POST",
    headers: { Authorization: auth, "Next-Action": ids.fetchData, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" },
    body: "[]",
  });
  const flight = await listRes.text();
  const line = flight.split("\n").find((l) => /^[0-9a-f]+:\{"success"/.test(l));
  const existingNames = new Set<string>();
  if (line) {
    const data = JSON.parse(line.replace(/^[0-9a-f]+:/, ""));
    for (const a of data.assets ?? []) existingNames.add(a.name);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "asset-ingest-"));
  try {
    for (const e of entries) {
      if (existingNames.has(e.name)) {
        console.log(`  skip (exists)  ${e.kind.padEnd(11)} ${e.name}`);
        continue;
      }
      const prep = await prepareFile(ffmpegPath, ffprobePath, path.join(dir, e.file), work);
      const form = new FormData();
      form.set(`$ACTION_ID_${ids.upload}`, "");
      form.set("name", e.name);
      form.set("kind", e.kind);
      form.set("category", e.category ?? "");
      form.set("tags", (e.tags ?? []).join(", "));
      form.set("license", e.license);
      form.set("licenseNote", e.licenseNote ?? "");
      form.set("rightsConfirmed", "true");
      form.set("file", new Blob([fs.readFileSync(prep.path)], { type: "audio/wav" }), e.file.replace(/\.\w+$/, ".wav"));
      const res = await fetch(`${baseUrl}/admin/sound-design`, {
        method: "POST",
        headers: { Authorization: auth },
        body: form,
      });
      if (!res.ok && res.status !== 303) {
        throw new Error(`upload '${e.name}' -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      console.log(`  uploaded       ${e.kind.padEnd(11)} ${e.name} (${prep.durationMs}ms${prep.transcoded ? ", transcoded 44.1k/16" : ""})`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // Verify: re-list and report which manifest names are now present + active.
  const verify = await fetch(`${baseUrl}/admin/sound-design`, {
    method: "POST",
    headers: { Authorization: auth, "Next-Action": ids.fetchData, "Content-Type": "text/plain;charset=UTF-8", Accept: "text/x-component" },
    body: "[]",
  });
  const vline = (await verify.text()).split("\n").find((l) => /^[0-9a-f]+:\{"success"/.test(l));
  const now = vline ? JSON.parse(vline.replace(/^[0-9a-f]+:/, "")) : { assets: [] };
  let ok = 0;
  for (const e of entries) {
    const hit = (now.assets ?? []).find((a: { name: string; isActive: boolean }) => a.name === e.name);
    if (hit?.isActive) ok++;
    else console.error(`  MISSING/INACTIVE after ingest: ${e.name}`);
  }
  console.log(`Verified ${ok}/${entries.length} manifest assets present + active on ${baseUrl}.`);
  if (ok !== entries.length) process.exit(1);
}

async function main() {
  const dir = arg("dir", "./ingest-assets")!;
  const manifestPath = arg("manifest", "ingest-manifest.json")!;
  const mode = arg("mode", "direct")!;
  const baseUrl = (arg("base-url", process.env.APP_BASE_URL || "") || "").replace(/\/$/, "");
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

  const entries = loadManifest(dir, manifestPath);
  console.log(`Ingesting ${entries.length} assets from ${dir} (${mode} mode)…`);
  if (mode === "direct") await ingestDirect(dir, entries, ffmpegPath, ffprobePath);
  else if (mode === "admin") {
    if (!baseUrl) throw new Error("admin mode needs --base-url (or APP_BASE_URL).");
    await ingestAdmin(dir, entries, ffmpegPath, ffprobePath, baseUrl);
  } else throw new Error(`Unknown mode '${mode}'`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
