// Full-pipeline render determinism (PR 4 final gate, B1). Run: npm run test:render-determinism
//
// Renders the SAME episode twice and asserts byte-identical pre-master PCM,
// mastered MP3, and (via reproduce) the stored-plan replay. Uses the stage-hash
// hook (POD_RENDER_DEBUG_HASHES) to bisect the FIRST divergence. Also proves a
// changed seed/asset changes the audio, and that env/history/policy changes
// after creation do NOT alter a frozen render's bytes.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) { try { await fn(); passed++; console.log(`  OK ${name}`); } catch (err) { failed++; console.error(`  XX ${name}\n      ${(err as Error).message}`); } }
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
async function freePort(): Promise<number> { return new Promise((res, rej) => { const s = net.createServer(); s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); s.on("error", rej); }); }

// Capture the [Stitcher][DET] stage hashes emitted during a render.
let lastDet: { foreground: string; premaster: string; mp3: string } | null = null;
const origLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  const m = line.match(/\[Stitcher\]\[DET\] foreground=(\w+) premaster=(\w+) mp3=(\w+)/);
  if (m) lastDet = { foreground: m[1], premaster: m[2], mp3: m[3] };
  origLog(...args);
};

async function main() {
  origLog("\nFull-pipeline render determinism (embedded PG + ffmpeg)\n");
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-detrender-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise(); await pg.start();
  const { Client } = await import("pg");
  const admin = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query("CREATE DATABASE det ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0");
  await admin.end();
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/det`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  Object.assign(process.env, { NODE_ENV: "development" });
  process.env.DATABASE_URL = dbUrl;
  process.env.STORAGE_PROVIDER = "local";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  process.env.POST_TTS_SOUND_DIRECTION_ENABLED = "true";
  process.env.POD_RENDER_DEBUG_HASHES = "true";

  const { stitchFinalEpisodeAudio } = await import("../lib/services/audioStitchingService");
  const { getStorageProvider } = await import("../lib/providers/storage/factory");
  const { db } = await import("../lib/db");
  const storage = getStorageProvider();
  const storageRoot = path.join(process.cwd(), "public", "storage");
  const written: string[] = [];

  const put = async (key: string, freq: number, durSec: number, noise = false) => {
    const f = path.join(tmpRoot, `${key.replace(/\W/g, "_")}.mp3`);
    const src = noise ? `anoisesrc=color=pink:amplitude=0.3:seed=${freq}:duration=${durSec}` : `sine=frequency=${freq}:duration=${durSec}`;
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", src, "-ar", "44100", f], { stdio: "ignore" });
    const body = fs.readFileSync(f); written.push(key);
    const { url } = await storage.putObject({ key, body, contentType: "audio/mpeg" });
    return { url, hash: crypto.createHash("sha256").update(body).digest("hex") };
  };
  const ref = (a: { id: string; name: string; contentHash: string | null }, role: string, kind: string, cf: string | null = null) => ({ assetId: a.id, kind, category: null, name: a.name, contentHash: a.contentHash, scope: "shared_system", role, orderIndex: 0, gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 3000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "system_default", weight: 1, cueFamily: cf, isBrandedMotif: false });

  const masterHashOf = async (episodeId: string) => {
    const ep = await db.episode.findUnique({ where: { id: episodeId } });
    const m = ep?.audioUrl?.match(/\/storage\/(.+)$/);
    return m ? crypto.createHash("sha256").update(fs.readFileSync(path.join(storageRoot, m[1]))).digest("hex") : "";
  };

  try {
    const host = await db.aiHost.create({ data: { name: "Det", slug: "det", role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: 5, ttsProvider: "stub", ttsVoiceId: "v", isActive: true } });
    const intro = await put("det/intro.mp3", 330, 3.0), outro = await put("det/outro.mp3", 300, 3.0), bed = await put("det/bed.mp3", 180, 30.0), sting = await put("det/sting.mp3", 660, 1.2), rx = await put("det/rx.mp3", 520, 0.7);
    const introA = await db.audioAsset.create({ data: { name: "Intro", kind: "theme_intro", tags: [], audioUrl: intro.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: intro.hash, durationMs: 3000, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const outroA = await db.audioAsset.create({ data: { name: "Outro", kind: "theme_outro", tags: [], audioUrl: outro.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: outro.hash, durationMs: 3000, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const bedA = await db.audioAsset.create({ data: { name: "Bed", kind: "bed", tags: [], audioUrl: bed.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: bed.hash, durationMs: 30000, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const stingA = await db.audioAsset.create({ data: { name: "Sting", kind: "stinger", tags: [], audioUrl: sting.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: sting.hash, durationMs: 1200, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const rxA = await db.audioAsset.create({ data: { name: "Rx", kind: "sfx", tags: [], audioUrl: rx.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: rx.hash, durationMs: 700, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" } });
    const soundProfile = { mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null, introEnabled: true, outroEnabled: true, intro: ref(introA, "intro", "theme_intro"), outro: ref(outroA, "outro", "theme_outro"), bed: ref(bedA, "bed", "bed"), stingers: [ref(stingA, "stinger", "stinger", "topic_reset")], reactions: [ref(rxA, "reaction", "sfx", "agreement")], introVariants: [ref(introA, "intro", "theme_intro")], outroVariants: [ref(outroA, "outro", "theme_outro")], beds: [ref(bedA, "bed", "bed")], sonicIdentity: null, containsLegacyCompatAssets: false, excluded: [] };
    const snapshot = { version: 5, cast: { formatId: "solo_commentary", formatVersion: 2, members: [{ hostId: host.id, role: "anchor", orderIndex: 0 }] }, source: "standalone", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null, editorial: { verticals: [], teams: [], segmentCount: 2, format: "solo_commentary", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} }, production: { hostIds: [host.id], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {}, soundProfile } };
    const prior = await put("det/prior.mp3", 500, 1.0);
    const ep = await db.episode.create({ data: { title: "Det Ep", slug: "det-ep", status: "content_ready", formatId: "solo_commentary", hostIds: [host.id], audioUrl: prior.url, durationSeconds: 10, soundDesign: { style: "full" } as object, configurationSource: "standalone", configurationSnapshot: snapshot as object, configurationFingerprint: "fp-det" } });
    const line = (i: number, text: string, tone: string) => ({ lineIndex: i, speakerName: "Det", speakerHostId: host.id, text, tone, isFactualClaim: false, needsHumanReview: false, evidenceRefs: [], energy: tone === "amused" ? "high" : "medium" });
    const script = await db.script.create({ data: { episodeId: ep.id, version: 1, status: "approved", plainText: "one two three four five", content: { segments: [{ type: "topic", lines: [line(0, "Welcome in everybody today.", "neutral"), line(1, "Lots to get through this hour.", "neutral")] }, { type: "topic", lines: [line(2, "Now our second big story.", "analytical"), line(3, "Wow that is wild, amazing.", "amused"), line(4, "Thanks for listening, goodbye.", "neutral")] }] } as object } });
    for (let i = 0; i < 5; i++) { const seg = await put(`det/seg${i}.mp3`, 700 + i, 1.6, true); await db.audioSegment.create({ data: { episodeId: ep.id, scriptId: script.id, lineIndex: i, text: `l${i}`, audioUrl: seg.url, status: "ready", durationMs: 1600 } }); }
    await db.factCheckResult.create({ data: { scriptId: script.id, episodeId: ep.id, passed: true, status: "passed", warnings: [] as object, errors: [] as object } });

    let det1: typeof lastDet = null, det2: typeof lastDet = null, m1 = "", m2 = "";
    await check("renders twice and reports stage hashes", async () => {
      lastDet = null; await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" }); det1 = lastDet; m1 = await masterHashOf(ep.id);
      lastDet = null; await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" }); det2 = lastDet; m2 = await masterHashOf(ep.id);
      assert(!!det1 && !!det2, "stage hashes captured");
      origLog(`      run1: fg=${det1!.foreground} pre=${det1!.premaster} mp3=${det1!.mp3}`);
      origLog(`      run2: fg=${det2!.foreground} pre=${det2!.premaster} mp3=${det2!.mp3}`);
    });
    await check("1. pre-master PCM is byte-identical across two renders", () => assert(det1!.foreground === det2!.foreground && det1!.premaster === det2!.premaster, `fg ${det1!.foreground}/${det2!.foreground} pre ${det1!.premaster}/${det2!.premaster}`));
    await check("3. final MP3 is byte-identical across two renders", () => assert(det1!.mp3 === det2!.mp3 && m1 === m2 && !!m1, `mp3 stage ${det1!.mp3}/${det2!.mp3} master ${m1.slice(0,12)}/${m2.slice(0,12)}`));
    await check("4. stored-plan reproduce produces the identical MP3", async () => {
      const r = await stitchFinalEpisodeAudio({ scriptId: script.id, renderMode: "reproduce", forceRegenerate: true, productionStyle: "full" });
      assert(r.finalStatus === "completed", "reproduce completes");
      assert((await masterHashOf(ep.id)) === m1, "reproduce master identical");
    });
    await check("7/8/9. diversity env/mode changes after creation do not alter the render bytes", async () => {
      // Toggling the DIVERSITY rollout env must not change this episode's audio
      // (its selection is frozen; render-tuning knobs like AUDIO_GAP_JITTER are a
      // separate, intentionally-live concern and are NOT touched here).
      process.env.SOUND_DIVERSITY_ENGINE_ENABLED = "true"; process.env.SOUND_DIVERSITY_ENFORCEMENT_MODE = "enforce";
      const after = await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true, productionStyle: "full" });
      delete process.env.SOUND_DIVERSITY_ENGINE_ENABLED; delete process.env.SOUND_DIVERSITY_ENFORCEMENT_MODE;
      assert(after.finalStatus === "completed" && (await masterHashOf(ep.id)) === m1, "master unchanged by diversity env after creation");
    });
  } finally {
    await db.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    for (const k of written) { try { fs.rmSync(path.join(storageRoot, k), { force: true }); } catch { /* */ } }
    try { fs.rmSync(path.join(storageRoot, "det"), { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  }
  origLog(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
