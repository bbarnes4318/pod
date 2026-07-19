// Sound-render isolation tests. Run: npm run test:sound-render
//
// Proves the RENDER side of Prompt 6 on real Postgres + real ffmpeg:
//   * cooldown is podcast/owner-scoped — another customer's usage is invisible;
//   * usage rows carry render id + owner/podcast scope + frozen asset facts,
//     and versioned render history is never deleted by a re-render;
//   * the asset loader, given a frozen profile, fetches ONLY the frozen pool
//     (verified by observing exactly which objects the storage double served)
//     and refuses bytes whose sha256 does not match the frozen content hash;
//   * the legacy (no-snapshot) loader path is scope-guarded — private assets
//     never enter the pool.
//
// No LLM/TTS/network; a local fake storage provider serves generated audio.

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
  console.log("\nSound render — scoped cooldown, exact usage, isolated loading\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-render-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("render");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/render`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  // The services under test read the singleton db client — point it at the
  // temp database BEFORE importing them.
  process.env.DATABASE_URL = dbUrl;
  const { readCooldownSnapshot, recordPlanUsage } = await import("../lib/services/cueCooldownService");
  const { loadSoundDesignAssetSet } = await import("../lib/services/audioStitchingService");
  const { db } = await import("../lib/db");

  // Tiny real audio clips (ffmpeg sine), served by a fake storage provider
  // that RECORDS every requested URL.
  const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
  const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
  const clipDir = path.join(tmpRoot, "clips");
  fs.mkdirSync(clipDir, { recursive: true });
  const mkClip = (name: string, freq: number): { file: string; bytes: Buffer; hash: string } => {
    const file = path.join(clipDir, `${name}.wav`);
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=0.3`, "-ar", "22050", file], { stdio: "ignore" });
    const bytes = fs.readFileSync(file);
    return { file, bytes, hash: crypto.createHash("sha256").update(bytes).digest("hex") };
  };
  const clipA = mkClip("a", 440);
  const clipB = mkClip("b", 660);
  const served: string[] = [];
  const fakeStorage = {
    async getObject({ url }: { url: string }) {
      served.push(url);
      if (url.endsWith("/a")) return { body: clipA.bytes };
      if (url.endsWith("/b")) return { body: clipB.bytes };
      throw new Error("unknown object");
    },
  };

  try {
    // --- Fixtures ------------------------------------------------------------
    const alice = await db.user.create({ data: { email: "a@x.test", passwordHash: "x" } });
    const bob = await db.user.create({ data: { email: "b@x.test", passwordHash: "x" } });
    const alicePod = await db.podcast.create({ data: { name: "A", cadence: "one_time", slug: "a-show", ownerId: alice.id } });
    const alicePod2 = await db.podcast.create({ data: { name: "A2", cadence: "one_time", slug: "a2-show", ownerId: alice.id } });
    const bobPod = await db.podcast.create({ data: { name: "B", cadence: "one_time", slug: "b-show", ownerId: bob.id } });

    const seedUsage = async (episodeId: string, podcastId: string, ownerId: string, assetId: string) => {
      await db.soundCueUsage.create({
        data: { episodeId, assetId, assetName: assetId, cueType: "stinger", podcastId, ownerId, selectionSource: "production_planner" },
      });
    };
    await seedUsage("ep-a1", alicePod.id, alice.id, "asset-1");
    await seedUsage("ep-a2", alicePod2.id, alice.id, "asset-2");
    await seedUsage("ep-b1", bobPod.id, bob.id, "asset-3");

    await check("CORE: podcast-scoped cooldown sees ONLY that podcast's usage", async () => {
      const snap = await readCooldownSnapshot({ episodeCount: 10, scope: { kind: "podcast", podcastId: alicePod.id } });
      assert(snap.episodes.length === 1 && snap.episodes[0].episodeId === "ep-a1", JSON.stringify(snap));
      assert(!JSON.stringify(snap).includes("asset-3"), "Bob's usage invisible");
    });

    await check("owner-scoped cooldown sees the owner's shows and NEVER another owner's", async () => {
      const snap = await readCooldownSnapshot({ episodeCount: 10, scope: { kind: "owner", ownerId: alice.id } });
      const ids = snap.episodes.map((e) => e.episodeId).sort();
      assert(JSON.stringify(ids) === JSON.stringify(["ep-a1", "ep-a2"]), JSON.stringify(ids));
      assert(!JSON.stringify(snap).includes("asset-3"), "cross-owner usage excluded");
    });

    await check("CORE: another customer's usage cannot influence a podcast's rotation", async () => {
      // Bob renders 100 episodes with asset-1 — Alice's cooldown for asset-1
      // must stay empty.
      for (let i = 0; i < 5; i++) await seedUsage(`ep-b-more-${i}`, bobPod.id, bob.id, "asset-1");
      const snap = await readCooldownSnapshot({ episodeCount: 10, scope: { kind: "podcast", podcastId: alicePod.id } });
      const all = snap.episodes.flatMap((e) => e.assetIds);
      assert(all.filter((a) => a === "asset-1").length === 1, "only Alice's own single use is visible");
    });

    await check("system scope sees only ownerless, podcast-less usage", async () => {
      await db.soundCueUsage.create({ data: { episodeId: "ep-sys", assetId: "asset-sys", cueType: "stinger", selectionSource: "production_planner" } });
      const snap = await readCooldownSnapshot({ episodeCount: 10, scope: { kind: "system" } });
      assert(snap.episodes.length === 1 && snap.episodes[0].episodeId === "ep-sys", JSON.stringify(snap));
    });

    await check("recordPlanUsage writes scoped, fact-carrying rows and preserves versioned history", async () => {
      const episode = await db.episode.create({ data: { title: "E", slug: "e-1", status: "draft", podcastId: alicePod.id, ownerId: alice.id } });
      const render1 = await db.episodeAudioRender.create({ data: { episodeId: episode.id, renderVersion: 1, status: "succeeded", renderMode: "initial" } });
      const plan = {
        plannerVersion: 1, episodeId: episode.id, scriptId: "s-1", seed: 42, style: "full", sfxDensity: "subtle",
        cues: [{ type: "stinger", assetId: "asset-A", assetName: "A" }],
        stats: { stingerCues: 1, reactionCues: 0, silenceCues: 0, cooldownSuppressions: 0 },
      } as never;
      // A legacy (unversioned) row that the first versioned render supersedes:
      await db.soundCueUsage.create({ data: { episodeId: episode.id, assetId: "old", cueType: "stinger" } });

      await recordPlanUsage(plan, {
        renderId: render1.id, ownerId: alice.id, podcastId: alicePod.id, selectionSource: "podcast_assignment",
        assetFacts: new Map([["asset-A", { kind: "stinger", scope: "owner_private", contentHash: "h1", gainDb: -3, fadeInMs: null, fadeOutMs: null }]]),
      });
      const rows1 = await db.soundCueUsage.findMany({ where: { episodeId: episode.id } });
      assert(rows1.length === 1 && rows1[0].renderId === render1.id, "legacy row superseded, versioned row written");
      assert(rows1[0].ownerId === alice.id && rows1[0].podcastId === alicePod.id, "scope stamped");
      assert(rows1[0].assetScope === "owner_private" && rows1[0].assetContentHash === "h1" && rows1[0].gainDb === -3, "frozen facts stamped");

      // A second render must NOT delete the first render's history.
      const render2 = await db.episodeAudioRender.create({ data: { episodeId: episode.id, renderVersion: 2, status: "succeeded", renderMode: "remix_episode_profile" } });
      await recordPlanUsage(plan, { renderId: render2.id, ownerId: alice.id, podcastId: alicePod.id, selectionSource: "podcast_assignment" });
      const rows2 = await db.soundCueUsage.findMany({ where: { episodeId: episode.id } });
      assert(rows2.length === 2, "both renders' usage preserved");
      assert(new Set(rows2.map((r) => r.renderId)).size === 2, "distinct render ids");
    });

    await check("render versions are unique per episode at the DB level", async () => {
      const episode = await db.episode.create({ data: { title: "E2", slug: "e-2", status: "draft" } });
      await db.episodeAudioRender.create({ data: { episodeId: episode.id, renderVersion: 1, status: "running", renderMode: "initial" } });
      let rejected = false;
      try { await db.episodeAudioRender.create({ data: { episodeId: episode.id, renderVersion: 1, status: "running", renderMode: "initial" } }); }
      catch { rejected = true; }
      assert(rejected, "duplicate (episode, version) rejected");
    });

    // --- Loader isolation ----------------------------------------------------
    const frozenAsset = await db.audioAsset.create({
      data: { name: "Frozen Sting", kind: "stinger", tags: [], audioUrl: "http://obj.test/a", license: "x", scope: "owner_private", ownerId: alice.id, contentHash: clipA.hash, processingStatus: "ready" },
    });
    // A tempting decoy: an ACTIVE global SFX owned by Bob.
    await db.audioAsset.create({
      data: { name: "Bob Private SFX", kind: "sfx", category: "whoosh", tags: [], audioUrl: "http://obj.test/b", license: "x", scope: "owner_private", ownerId: bob.id, contentHash: clipB.hash, processingStatus: "ready" },
    });

    const frozenProfile = {
      mode: "custom", targetLoudnessLufs: null, cooldownScope: "podcast",
      stingerCooldownEpisodes: null, reactionCooldownEpisodes: null,
      intro: null, outro: null, bed: null,
      stingers: [{ assetId: frozenAsset.id, kind: "stinger", category: null, name: "Frozen Sting", contentHash: clipA.hash, scope: "owner_private", role: "stinger", orderIndex: 0, gainDb: null, fadeInMs: null, fadeOutMs: null, durationMs: 300, tags: [], rightsStatusAtCapture: "not_required", licenseStatusAtCapture: "unknown", provenance: "podcast_assignment" }],
      reactions: [], containsLegacyCompatAssets: false, excluded: [],
    } as never;

    await check("CORE: with a frozen profile the loader fetches ONLY the frozen pool", async () => {
      served.length = 0;
      const warnings: string[] = [];
      const tempDir = path.join(tmpRoot, "load1");
      fs.mkdirSync(tempDir, { recursive: true });
      const set = await loadSoundDesignAssetSet({
        style: "full", config: null, frozenProfile, highlightAssetIds: [],
        tempDir, storageProvider: fakeStorage, ffmpegPath: ffmpeg, ffprobePath: ffprobe, sampleRate: 22050, warnings,
      });
      assert(set.stingers.length === 1 && set.stingers[0].id === frozenAsset.id, "frozen stinger loaded");
      assert(set.sfxByCategory.size === 0, "no reaction pool beyond the frozen (empty) one");
      assert(served.length === 1 && served[0].endsWith("/a"), `only the frozen object was fetched (served: ${served.join(",")})`);
    });

    await check("CORE: a content-hash mismatch is refused, never mixed, and flagged for review", async () => {
      const tampered = await db.audioAsset.create({
        data: { name: "Tampered", kind: "stinger", tags: [], audioUrl: "http://obj.test/b", license: "x", scope: "owner_private", ownerId: alice.id, contentHash: clipA.hash /* wrong: object b */, processingStatus: "ready" },
      });
      const profile = JSON.parse(JSON.stringify(frozenProfile));
      profile.stingers = [{ ...profile.stingers[0], assetId: tampered.id, contentHash: clipA.hash, name: "Tampered" }];
      const warnings: string[] = [];
      const tempDir = path.join(tmpRoot, "load2");
      fs.mkdirSync(tempDir, { recursive: true });
      const set = await loadSoundDesignAssetSet({
        style: "full", config: null, frozenProfile: profile, highlightAssetIds: [],
        tempDir, storageProvider: fakeStorage, ffmpegPath: ffmpeg, ffprobePath: ffprobe, sampleRate: 22050, warnings,
      });
      assert(set.stingers.length === 0, "mismatched asset never enters the mix");
      assert(warnings.some((w) => /hash mismatch/i.test(w)), `warning surfaced: ${warnings.join("; ")}`);
      const events = await db.audioAssetAuditEvent.findMany({ where: { assetId: tampered.id, event: "metadata_failed" } });
      assert(events.length === 1, "integrity failure audit-flagged for review");
    });

    await check("CORE: the legacy (no-snapshot) loader path excludes private assets from the reaction pool", async () => {
      served.length = 0;
      const warnings: string[] = [];
      const tempDir = path.join(tmpRoot, "load3");
      fs.mkdirSync(tempDir, { recursive: true });
      const set = await loadSoundDesignAssetSet({
        style: "full", config: null, frozenProfile: null, highlightAssetIds: [],
        tempDir, storageProvider: fakeStorage, ffmpegPath: ffmpeg, ffprobePath: ffprobe, sampleRate: 22050, warnings,
      });
      assert(set.sfxByCategory.size === 0, "Bob's private SFX never enters the legacy pool");
      assert(!served.some((u) => u.endsWith("/b")), "Bob's object was never even fetched");
    });

    await check("rights revoked since freeze blocks the asset at load time", async () => {
      await db.$executeRawUnsafe(`UPDATE "AudioAsset" SET "rightsStatus" = 'revoked' WHERE "id" = '${frozenAsset.id}'`);
      const warnings: string[] = [];
      const tempDir = path.join(tmpRoot, "load4");
      fs.mkdirSync(tempDir, { recursive: true });
      const set = await loadSoundDesignAssetSet({
        style: "full", config: null, frozenProfile, highlightAssetIds: [],
        tempDir, storageProvider: fakeStorage, ffmpegPath: ffmpeg, ffprobePath: ffprobe, sampleRate: 22050, warnings,
      });
      assert(set.stingers.length === 0, "revoked asset excluded");
      assert(warnings.some((w) => /rights invalid/i.test(w)), "revocation surfaced as a warning");
    });

    // --- v3 snapshot compatibility (the fixed bug) ---------------------------
    await check("CORE: a version-3 episode resolves its frozen profile and stays isolated to it (never the legacy global pool)", async () => {
      const { resolveSnapshotSoundProfile } = await import("../lib/services/episodeConfigurationSnapshot");
      // Restore rights (a prior test revoked this asset) so it can load.
      await db.$executeRawUnsafe(`UPDATE "AudioAsset" SET "rightsStatus" = 'not_required' WHERE "id" = '${frozenAsset.id}'`);
      const v3Snapshot = {
        version: 3,
        cast: { formatId: "two_host_debate", formatVersion: 1, members: [] },
        source: "podcast", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null,
        editorial: { verticals: [], teams: [], segmentCount: 1, format: "two_host_debate", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} },
        production: { hostIds: [], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {}, soundProfile: JSON.parse(JSON.stringify(frozenProfile)) },
      };
      const res = resolveSnapshotSoundProfile(v3Snapshot);
      assert(res.status === "frozen", `v3 must resolve its frozen profile (got ${res.status}) — the bug returned it as legacy`);
      assert(res.profile?.stingers[0].assetId === frozenAsset.id, "frozen stinger id preserved through v3 resolution");

      served.length = 0;
      const tempDir = path.join(tmpRoot, "load-v3");
      fs.mkdirSync(tempDir, { recursive: true });
      const set = await loadSoundDesignAssetSet({
        style: "full", config: null, frozenProfile: res.profile as never, highlightAssetIds: [],
        tempDir, storageProvider: fakeStorage, ffmpegPath: ffmpeg, ffprobePath: ffprobe, sampleRate: 22050, warnings: [],
      });
      assert(set.stingers.length === 1 && set.stingers[0].id === frozenAsset.id, "loaded from the frozen pool");
      assert(served.length === 1 && served[0].endsWith("/a"), `only the frozen object was fetched, not a legacy scan (served: ${served.join(",")})`);
    });

    await check("render diagnostics carry names/ids/reasons only — URLs and storage keys are redacted", async () => {
      const { buildRenderDiagnostics } = await import("../lib/audio/renderDiagnostics");
      const plan = {
        version: 1, plannerVersion: "1.1.0", episodeId: "e", scriptId: "s", style: "full", sfxDensity: "subtle", seed: 1,
        cues: [{ type: "stinger", lineIndex: 2, assetId: "a1", assetName: "Riser http://obj.test/secret", category: null, timing: "before", gainDb: -5, fadeInMs: 15, fadeOutMs: 90, fit: 0.8, reason: "topic turn key episodes/e/final/x.mp3" }],
        stats: { lineCount: 1, boundaryCount: 1, stingerCues: 1, reactionCues: 0, silenceCues: 0, distinctAssetsUsed: 1, cooldownSuppressions: 0 },
      } as never;
      const diag = buildRenderDiagnostics({
        renderId: "r1", renderVersion: 1, renderMode: "initial", snapshotVersion: 3, soundProfileMode: "custom",
        plannerSeed: 1, plannerVersion: "1.1.0", style: "full", sfxDensity: "subtle", targetLoudnessLufs: -16, cooldownScope: "podcast",
        frozenProfile: null, productionPlan: plan,
        summary: { style: "full", sfxDensity: "subtle", introAsset: null, outroAsset: null, bedAsset: null, bedDucking: false, stingerCount: 1, reactionCount: 0, reactions: [], highlightCount: 0, highlights: [] } as never,
        bookend: null, speechEndMs: 1000, masterDurationMs: 1500,
        skippedWarnings: ["Sound asset 'X' failed to load (https://s3.test/secret) — skipped."],
      });
      const json = JSON.stringify(diag);
      assert(!/https?:\/\//.test(json) && !/s3:\/\//.test(json), `no URLs in diagnostics: ${json}`);
      assert(/\[redacted-(url|key)\]/.test(json), "url/key was redacted in diagnostics");
    });

  } finally {
    await db.$disconnect();
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
