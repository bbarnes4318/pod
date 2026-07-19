// Test 18: render-time bookend defense preserves the prior master.
// Run: npm run test:bookend-render-gate
//
// Drives the REAL stitchFinalEpisodeAudio end to end (embedded Postgres, local
// storage, real ffmpeg) on an episode whose FROZEN v4 profile REQUIRES an outro
// (outroEnabled:true) but carries no outro asset — the exact invalid state that
// bypassed Level-1/Level-2 and reached rendering. The post-render bookend gate
// must FAIL the render and:
//   * preserve the episode's previous successful master (audioUrl unchanged);
//   * restore the episode's prior status;
//   * mark the EpisodeAudioRender failed with a safe bookend reason;
//   * record NO successful sound-cue usage.
//
// No LLM/TTS/network/paid APIs — local storage + synthesized audio only.

import EmbeddedPostgres from "embedded-postgres";
import { execSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

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
  console.log("\nBookend render gate — failed render preserves the prior master\n");
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-bookend-render-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("render");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/render`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  // Local storage under a temp dir served back by LocalStorageProvider, and the
  // env the services read (set BEFORE importing them — they read singletons).
  const storageRoot = path.join(process.cwd(), "public", "storage");
  process.env.DATABASE_URL = dbUrl;
  process.env.STORAGE_PROVIDER = "local";
  process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  delete process.env.SOUND_DESIGN_PLANNER; // legacy placement path (deterministic)

  const { stitchFinalEpisodeAudio } = await import("../lib/services/audioStitchingService");
  const { getStorageProvider } = await import("../lib/providers/storage/factory");
  const { db } = await import("../lib/db");
  const storage = getStorageProvider();

  const put = async (key: string, freq: number, durSec: number) => {
    const f = path.join(tmpRoot, `${key.replace(/\W/g, "_")}.mp3`);
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${durSec}`, "-ar", "44100", f], { stdio: "ignore" });
    const body = fs.readFileSync(f);
    const { url } = await storage.putObject({ key, body, contentType: "audio/mpeg" });
    return { url, hash: crypto.createHash("sha256").update(body).digest("hex") };
  };

  const writtenKeys: string[] = [];
  try {
    // --- Fixtures ----------------------------------------------------------
    const host = await db.aiHost.create({ data: { name: "Sol", slug: "sol", role: "host", worldview: "w", speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], intensityLevel: 5, ttsProvider: "stub", ttsVoiceId: "v", isActive: true } });

    // Intro asset (valid, audible) — the profile HAS an intro; the OUTRO is the
    // gap: enabled with no asset.
    const introKey = "episodes/bk/intro.mp3";
    const intro = await put(introKey, 330, 2.0); writtenKeys.push(introKey);
    const introAsset = await db.audioAsset.create({
      data: { name: "Broadcast Intro Theme", kind: "theme_intro", tags: [], audioUrl: intro.url, license: "x", scope: "shared_system", processingStatus: "ready", contentHash: intro.hash, durationMs: 2000, isActive: true, licenseStatus: "licensed", rightsStatus: "not_required" },
    });

    // Two dialogue segments (real audio).
    const seg0Key = "episodes/bk/seg0.mp3", seg1Key = "episodes/bk/seg1.mp3";
    const seg0 = await put(seg0Key, 700, 1.5); writtenKeys.push(seg0Key);
    const seg1 = await put(seg1Key, 700, 1.5); writtenKeys.push(seg1Key);
    const priorMasterKey = "episodes/bk/prior-master.mp3";
    const prior = await put(priorMasterKey, 500, 1.0); writtenKeys.push(priorMasterKey);
    const PRIOR_MASTER_URL = prior.url;

    // A v4 frozen profile: intro enabled+assigned, OUTRO ENABLED but no asset.
    // Constructed directly (bypasses Level-1/2) to exercise the render defense.
    const introRef = {
      assetId: introAsset.id, kind: "theme_intro", category: null, name: introAsset.name, contentHash: intro.hash,
      scope: "shared_system", role: "intro", orderIndex: 0, gainDb: null, fadeInMs: null, fadeOutMs: null,
      durationMs: 2000, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "licensed", provenance: "system_default",
    };
    const soundProfile = {
      mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast",
      stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
      introEnabled: true, outroEnabled: true, // <-- outro REQUIRED
      intro: introRef, outro: null, bed: null, stingers: [], reactions: [],
      containsLegacyCompatAssets: false, excluded: [],
    };
    const snapshot = {
      version: 4, cast: { formatId: "solo_commentary", formatVersion: 2, members: [{ hostId: host.id, role: "anchor", orderIndex: 0 }] },
      source: "standalone", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null,
      editorial: { verticals: [], teams: [], segmentCount: 1, format: "solo_commentary", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} },
      production: { hostIds: [host.id], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {}, soundProfile },
    };

    const episode = await db.episode.create({
      data: {
        title: "Bookend Gate", slug: "bookend-gate", status: "content_ready", formatId: "solo_commentary",
        hostIds: [host.id], audioUrl: PRIOR_MASTER_URL, durationSeconds: 10,
        soundDesign: { style: "light" } as object,
        configurationSource: "standalone", configurationSnapshot: snapshot as object, configurationFingerprint: "fp-bk",
      },
    });
    const script = await db.script.create({
      data: {
        episodeId: episode.id, version: 1, status: "approved",
        plainText: "Sol: Hello and welcome. Sol: Thanks for listening.",
        content: {
          segments: [{ type: "topic", lines: [
            { lineIndex: 0, speakerName: "Sol", speakerHostId: host.id, text: "Hello and welcome to the show.", tone: "neutral", isFactualClaim: false, needsHumanReview: false, evidenceRefs: [] },
            { lineIndex: 1, speakerName: "Sol", speakerHostId: host.id, text: "Thanks for listening, see you next time.", tone: "neutral", isFactualClaim: false, needsHumanReview: false, evidenceRefs: [] },
          ] }],
        } as object,
      },
    });
    await db.audioSegment.create({ data: { episodeId: episode.id, scriptId: script.id, lineIndex: 0, text: "Hello", audioUrl: seg0.url, status: "ready", durationMs: 1500 } });
    await db.audioSegment.create({ data: { episodeId: episode.id, scriptId: script.id, lineIndex: 1, text: "Thanks", audioUrl: seg1.url, status: "ready", durationMs: 1500 } });
    await db.factCheckResult.create({ data: { scriptId: script.id, episodeId: episode.id, passed: true, status: "passed", warnings: [] as object, errors: [] as object } });

    // --- Drive the real stitcher; it MUST throw at the bookend gate ---------
    let thrown: Error | null = null;
    await check("a required-but-absent outro FAILS the render at the bookend gate", async () => {
      try {
        await stitchFinalEpisodeAudio({ scriptId: script.id, forceRegenerate: true });
        assert(false, "stitch should have thrown on the missing required outro");
      } catch (e) {
        thrown = e as Error;
        assert(/bookend|outro/i.test(thrown.message), `error names the bookend/outro: ${thrown.message}`);
      }
    });

    await check("Test 18a: the episode's PRIOR successful master is preserved (audioUrl unchanged)", async () => {
      const ep = await db.episode.findUnique({ where: { id: episode.id } });
      assert(ep?.audioUrl === PRIOR_MASTER_URL, `audioUrl must be untouched (got ${ep?.audioUrl})`);
    });

    await check("Test 18b: the episode's prior status is restored", async () => {
      const ep = await db.episode.findUnique({ where: { id: episode.id } });
      assert(ep?.status === "content_ready", `status restored to content_ready (got ${ep?.status})`);
    });

    await check("Test 18c: the render record is marked failed with a safe bookend reason", async () => {
      const render = await db.episodeAudioRender.findFirst({ where: { episodeId: episode.id }, orderBy: { renderVersion: "desc" } });
      assert(render?.status === "failed", `render failed (got ${render?.status})`);
      assert(/bookend|outro/i.test(render?.failureReason ?? ""), `safe bookend reason: ${render?.failureReason}`);
      assert(!/https?:\/\//.test(render?.failureReason ?? ""), "reason carries no URL");
    });

    await check("Test 18d: NO successful sound-cue usage was recorded for the failed render", async () => {
      const usage = await db.soundCueUsage.count({ where: { episodeId: episode.id } });
      assert(usage === 0, `no usage rows for a failed render (got ${usage})`);
    });
  } finally {
    await db.$disconnect();
    await pg.stop().catch(() => {});
    for (const k of writtenKeys) { try { fs.rmSync(path.join(storageRoot, k), { force: true }); } catch { /* best effort */ } }
    // The stitcher writes a final master only on SUCCESS (never reached here);
    // clean the whole per-test storage prefix regardless.
    try { fs.rmSync(path.join(storageRoot, "episodes", "bk"), { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
