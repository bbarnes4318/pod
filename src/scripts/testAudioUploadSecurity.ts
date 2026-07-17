// Audio upload + delivery security tests. Run: npm run test:audio-upload-security
//
// Proves the upload pipeline trusts NOTHING from the client (magic bytes,
// ffprobe, server-side hashing, trusted storage keys, bounded sizes), that
// duplicate detection cannot leak across owners, that rights documents accept
// only safe formats, and — statically — that production asset paths never log
// raw storage URLs/keys.
//
// Embedded PostgreSQL + local storage double. No network.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function main() {
  console.log("\nAudio upload security\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-upsec-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("upsec");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/upsec`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  process.env.DATABASE_URL = dbUrl;
  process.env.STORAGE_PROVIDER = "local";
  const { uploadAudioAsset, sniffAudioFormat, sniffRightsDocument } = await import("../lib/services/audioAssetUpload");
  const { toSafeAudioAssetDto } = await import("../lib/services/audioAssetAccess");
  const { db } = await import("../lib/db");

  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const clip = (name: string, args: string[]): Buffer => {
    const f = path.join(tmpRoot, name);
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.4", ...args, f], { stdio: "ignore" });
    return fs.readFileSync(f);
  };
  const mp3 = clip("a.mp3", ["-codec:a", "libmp3lame", "-b:a", "64k"]);
  const wav = clip("a.wav", ["-ar", "22050"]);
  const longMp3 = (() => {
    const f = path.join(tmpRoot, "long.mp3");
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=40", "-codec:a", "libmp3lame", "-b:a", "32k", f], { stdio: "ignore" });
    return fs.readFileSync(f);
  })();

  try {
    const alice = await db.user.create({ data: { email: "a@x.test", passwordHash: "x" } });
    const bob = await db.user.create({ data: { email: "b@x.test", passwordHash: "x" } });
    const bobPod = await db.podcast.create({ data: { name: "B", cadence: "one_time", slug: "b-show", ownerId: bob.id } });
    const A = { kind: "user" as const, userId: alice.id };
    const B = { kind: "user" as const, userId: bob.id };

    const base = { name: "Test", kind: "stinger", scope: "owner_private" as const, bytes: mp3 };

    await check("a valid MP3 uploads with server-computed hash + metadata + trusted key", async () => {
      const res = await uploadAudioAsset(db, A, { ...base, name: "Good MP3", originalFilename: "../../../etc/passwd.mp3" });
      assert(res.ok, JSON.stringify(res));
      if (!res.ok) return;
      const row = await db.audioAsset.findUnique({ where: { id: res.assetId } });
      assert(row!.contentHash?.length === 64, "sha256 computed server-side");
      assert(row!.mimeType === "audio/mpeg" && (row!.durationMs ?? 0) > 200, "probed metadata");
      // The storage key comes from trusted identifiers — the hostile filename
      // never becomes a path.
      assert(new RegExp(`^audio-assets/owners/${alice.id}/[0-9a-f-]{36}/source\\.mp3$`).test(row!.storageKey ?? ""), `key: ${row!.storageKey}`);
      assert(!row!.storageKey!.includes("passwd"), "no filename-derived path");
    });

    await check("a valid WAV uploads; its sniffed format wins over any claimed name", async () => {
      const res = await uploadAudioAsset(db, A, { ...base, name: "Good WAV", bytes: wav, originalFilename: "totally-an.mp3" });
      assert(res.ok, JSON.stringify(res));
      if (!res.ok) return;
      const row = await db.audioAsset.findUnique({ where: { id: res.assetId } });
      assert(row!.mimeType === "audio/wav" && row!.storageKey!.endsWith("source.wav"), "content decided the format");
    });

    await check("spoofed content is rejected by magic bytes, not extension", async () => {
      const html = Buffer.from("<html><script>alert(1)</script></html>");
      const res = await uploadAudioAsset(db, A, { ...base, name: "Evil", bytes: html, originalFilename: "innocent.mp3" });
      assert(!res.ok && res.error.code === "unsupported_format", JSON.stringify(res));
      const exe = Buffer.from("MZ\x90\x00\x03rest-of-a-pe-binary");
      const res2 = await uploadAudioAsset(db, A, { ...base, name: "Evil2", bytes: exe });
      assert(!res2.ok && res2.error.code === "unsupported_format", "executable rejected");
    });

    await check("corrupt audio passes sniffing but fails ffprobe decoding", async () => {
      const corrupt = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2000, 7)]);
      const res = await uploadAudioAsset(db, A, { ...base, name: "Corrupt", bytes: corrupt });
      assert(!res.ok && res.error.code === "not_decodable", JSON.stringify(res));
    });

    await check("empty and oversized files are rejected with structured errors", async () => {
      const r1 = await uploadAudioAsset(db, A, { ...base, name: "Empty", bytes: Buffer.alloc(0) });
      assert(!r1.ok && r1.error.code === "empty_file", "empty");
      process.env.AUDIO_ASSET_MAX_BYTES = "1000";
      const r2 = await uploadAudioAsset(db, A, { ...base, name: "Big", bytes: mp3 });
      delete process.env.AUDIO_ASSET_MAX_BYTES;
      assert(!r2.ok && r2.error.code === "file_too_large", "oversized");
    });

    await check("a 40s file cannot become a stinger (per-kind duration cap)", async () => {
      const res = await uploadAudioAsset(db, A, { ...base, name: "Way Too Long", bytes: longMp3 });
      assert(!res.ok && res.error.code === "duration_too_long", JSON.stringify(res));
    });

    await check("CORE: duplicate detection is visibility-scoped — no cross-owner leak", async () => {
      const own = await uploadAudioAsset(db, A, { ...base, name: "Dup", bytes: mp3 });
      assert(!own.ok && own.error.code === "duplicate_asset", "own duplicate reported");
      // Bob uploads the IDENTICAL bytes: must succeed with no hint that
      // Alice's copy exists.
      const cross = await uploadAudioAsset(db, B, { ...base, name: "Bob Copy", bytes: mp3 });
      assert(cross.ok, `cross-owner duplicate must not be revealed: ${JSON.stringify(cross)}`);
    });

    await check("a user cannot upload into another owner's podcast or the system scope", async () => {
      const fresh1 = clip("scope1.wav", ["-ar", "16000"]);
      const r1 = await uploadAudioAsset(db, A, { ...base, name: "Steal", bytes: fresh1, scope: "podcast_private", podcastId: bobPod.id });
      assert(!r1.ok && r1.error.code === "podcast_not_owned", JSON.stringify(r1));
      const fresh2 = clip("scope2.wav", ["-ar", "8000"]);
      const r2 = await uploadAudioAsset(db, A, { ...base, name: "Sneak", bytes: fresh2, kind: "bed", scope: "shared_system" as never });
      assert(!r2.ok && r2.error.code === "scope_requires_admin", JSON.stringify(r2));
    });

    await check("rights documents accept only PDF/PNG/JPEG — HTML/SVG rejected", async () => {
      assert(sniffRightsDocument(Buffer.from("%PDF-1.4 rest")) !== null, "pdf ok");
      assert(sniffRightsDocument(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'>")) === null, "svg rejected");
      assert(sniffRightsDocument(Buffer.from("<html>doc</html>")) === null, "html rejected");
      const fresh = clip("doc.wav", ["-ar", "11025"]);
      const res = await uploadAudioAsset(db, A, { ...base, name: "With Doc", bytes: fresh, rightsDocument: Buffer.from("<html>evil</html>") });
      assert(!res.ok && res.error.code === "rights_document_invalid", JSON.stringify(res));
    });

    await check("sniffAudioFormat accepts exactly the supported formats", () => {
      assert(sniffAudioFormat(mp3)?.format === "mp3", "mp3");
      assert(sniffAudioFormat(wav)?.format === "wav", "wav");
      assert(sniffAudioFormat(Buffer.from("fLaCxxxxxxxxx"))?.format === "flac", "flac");
      assert(sniffAudioFormat(Buffer.from("\x00\x00\x00\x20ftypM4A xxxx"))?.format === "m4a", "m4a");
      assert(sniffAudioFormat(Buffer.from("OggS\x00rest-of-ogg-file")) === null, "ogg not accepted");
    });

    await check("safe DTOs from uploaded assets expose no storage key or URL", async () => {
      const row = await db.audioAsset.findFirst({ where: { name: "Good MP3" } });
      const json = JSON.stringify(toSafeAudioAssetDto(row!));
      assert(!json.includes("audio-assets/owners"), "no storage key");
      assert(!json.includes("/storage/"), "no raw URL");
      assert(json.includes(`/api/audio-assets/${row!.id}/preview`), "preview is the authorized route");
    });

    // --- Static logging contract --------------------------------------------
    await check("CORE: production asset paths never log raw audio URLs / storage keys", () => {
      const files = [
        "src/lib/services/audioStitchingService.ts",
        "src/lib/services/audioAssetUpload.ts",
        "src/lib/services/audioAssetAccess.ts",
        "src/lib/services/soundDesignSeedService.ts",
        "src/lib/services/cueCooldownService.ts",
        "src/app/api/audio-assets/[assetId]/preview/route.ts",
        "src/app/api/audio-assets/[assetId]/rights-document/route.ts",
      ];
      const offenders: string[] = [];
      for (const f of files) {
        const src = fs.readFileSync(path.join(process.cwd(), f), "utf8");
        src.split("\n").forEach((line, i) => {
          if (!/console\.(log|warn|error)/.test(line)) return;
          if (/\$\{[^}]*(audioUrl|storageKey|signedUrl|rightsDocumentStorageKey|introUrl|outroUrl)[^}]*\}/.test(line)) {
            offenders.push(`${f}:${i + 1}`);
          }
        });
      }
      assert(offenders.length === 0, `URL/key logging found at: ${offenders.join(", ")}`);
    });

    await check("no temp upload files are left behind", () => {
      const leftovers = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith("asset-upload-"));
      assert(leftovers.length === 0, `leftover temp files: ${leftovers.slice(0, 3).join(", ")}`);
    });

  } finally {
    await db.$disconnect();
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    // Local storage double writes under public/storage/audio-assets — clean up.
    try { fs.rmSync(path.join(process.cwd(), "public", "storage", "audio-assets"), { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
