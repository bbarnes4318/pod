// Podcast sound-profile tests. Run: npm run test:sound-profile
//
// Proves: atomic profile saves under Prompt 5 optimistic concurrency (ONE
// version increment per save), canonical assignment validation (cross-owner /
// legacy / highlight / role-kind / bounds), frozen-profile resolution with
// accurate provenance, snapshot v2 + fingerprint behavior, and that a sound
// change moves the Podcast configuration fingerprint.
//
// Embedded PostgreSQL; no ffmpeg, no storage, no network.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import {
  savePodcastSoundProfile,
  resolvePodcastSoundProfile,
  resolveStandaloneSoundProfile,
} from "../lib/services/podcastSoundProfile";
import { loadPodcastConfiguration, fingerprintPodcastConfiguration, resolveEpisodeConfiguration } from "../lib/services/podcastConfiguration";
import { buildEpisodeConfigurationSnapshot, fingerprintEpisodeSnapshot, type EpisodeConfigurationSnapshot } from "../lib/services/episodeConfigurationSnapshot";

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
  console.log("\nPodcast sound profiles — save, resolve, freeze\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-profile-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("profiles");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/profiles`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  const mkAsset = (over: Record<string, unknown>) =>
    db.audioAsset.create({
      data: {
        name: String(over.name ?? "Asset"), kind: String(over.kind ?? "stinger"), tags: [],
        audioUrl: `http://s.test/${Math.random().toString(36).slice(2)}`, license: "x",
        scope: "shared_system", processingStatus: "ready",
        contentHash: "a".repeat(63) + String(over.h ?? "0"),
        ...Object.fromEntries(Object.entries(over).filter(([k]) => !["h"].includes(k))),
      } as never,
    });

  try {
    const alice = await db.user.create({ data: { email: "a@x.test", passwordHash: "x" } });
    const bob = await db.user.create({ data: { email: "b@x.test", passwordHash: "x" } });
    const pod = await db.podcast.create({
      data: { name: "Show", cadence: "one_time", slug: "show", ownerId: alice.id, editorialConfig: { create: {} }, productionConfig: { create: {} }, publishingConfig: { create: {} } },
    });
    const canEditAsAlice = (p: { ownerId: string | null }) => p.ownerId === alice.id;

    const sysIntro = await mkAsset({ name: "Sys Intro", kind: "theme_intro", h: "1" });
    const sysOutro = await mkAsset({ name: "Sys Outro", kind: "theme_outro", h: "2" });
    const sysBed = await mkAsset({ name: "Sys Bed", kind: "bed", h: "3" });
    const sysSting = await mkAsset({ name: "Sys Sting", kind: "stinger", h: "4" });
    const sysSfx = await mkAsset({ name: "Sys Whoosh", kind: "sfx", category: "whoosh", h: "5" });
    const aliceSting = await mkAsset({ name: "Alice Sting", kind: "stinger", scope: "owner_private", ownerId: alice.id, h: "6" });
    const bobSting = await mkAsset({ name: "Bob Sting", kind: "stinger", scope: "owner_private", ownerId: bob.id, h: "7" });
    const legacySting = await mkAsset({ name: "Legacy Sting", kind: "stinger", scope: "legacy_global", legacyScopeReviewRequired: true, h: "8" });
    const highlight = await mkAsset({ name: "Clip", kind: "highlight", scope: "owner_private", ownerId: alice.id, rightsStatus: "confirmed", rightsConfirmed: true, h: "9" });

    // System default profile for later tests:
    await db.soundDesignConfig.create({ data: { id: "default", themeIntroAssetId: sysIntro.id, themeOutroAssetId: sysOutro.id, bedAssetId: sysBed.id, stingerAssetIds: [sysSting.id] } });

    await check("CORE: a valid custom profile saves atomically with ONE version increment", async () => {
      const before = (await db.podcast.findUnique({ where: { id: pod.id } }))!.configVersion;
      const res = await savePodcastSoundProfile({
        db, podcastId: pod.id, expectedVersion: before, canEdit: canEditAsAlice,
        profile: {
          soundProfileMode: "custom",
          cooldownScope: "podcast",
          assignments: [
            { assetId: sysIntro.id, role: "intro", gainDb: -3, fadeInMs: 500 },
            { assetId: sysBed.id, role: "bed" },
            { assetId: sysSting.id, role: "stinger", orderIndex: 0 },
            { assetId: aliceSting.id, role: "stinger", orderIndex: 1 },
            { assetId: sysSfx.id, role: "reaction" },
          ],
        },
      });
      assert(res.ok, JSON.stringify(res));
      if (!res.ok) return;
      assert(res.configVersion === before + 1, `one increment (${before} -> ${res.configVersion}), not one per row`);
      assert((await db.podcastSoundAssignment.count({ where: { podcastId: pod.id } })) === 5, "5 rows written");
    });

    await check("a stale expectedVersion is a structured conflict and writes NOTHING", async () => {
      const current = (await db.podcast.findUnique({ where: { id: pod.id } }))!.configVersion;
      const res = await savePodcastSoundProfile({
        db, podcastId: pod.id, expectedVersion: current - 1, canEdit: canEditAsAlice,
        profile: { soundProfileMode: "clean" },
      });
      assert(!res.ok && res.error.code === "podcast_configuration_changed", JSON.stringify(res));
      assert((await db.podcastSoundAssignment.count({ where: { podcastId: pod.id } })) === 5, "assignments untouched");
      assert((await db.podcast.findUnique({ where: { id: pod.id } }))!.configVersion === current, "version untouched");
    });

    await check("CORE: another owner's asset in a save reads as NOT FOUND and aborts the whole save", async () => {
      const current = (await db.podcast.findUnique({ where: { id: pod.id } }))!.configVersion;
      const res = await savePodcastSoundProfile({
        db, podcastId: pod.id, expectedVersion: current, canEdit: canEditAsAlice,
        profile: { soundProfileMode: "custom", assignments: [{ assetId: sysSting.id, role: "stinger" }, { assetId: bobSting.id, role: "stinger" }] },
      });
      assert(!res.ok && res.error.code === "asset_not_assignable" && res.error.reason === "not found", JSON.stringify(res));
      assert((await db.podcastSoundAssignment.count({ where: { podcastId: pod.id, assetId: bobSting.id } })) === 0, "nothing partially saved");
    });

    await check("legacy, highlight, role-kind, duplicate, singleton, and bounds violations are rejected", async () => {
      const v = () => db.podcast.findUnique({ where: { id: pod.id } }).then((p) => p!.configVersion);
      const cases: Array<[Parameters<typeof savePodcastSoundProfile>[0]["profile"], string]> = [
        [{ soundProfileMode: "custom", assignments: [{ assetId: legacySting.id, role: "stinger" }] }, "asset_not_assignable"],
        [{ soundProfileMode: "custom", assignments: [{ assetId: highlight.id, role: "stinger" }] }, "asset_not_assignable"],
        [{ soundProfileMode: "custom", assignments: [{ assetId: sysBed.id, role: "intro" }] }, "asset_not_assignable"], // kind mismatch
        [{ soundProfileMode: "custom", assignments: [{ assetId: sysSting.id, role: "stinger" }, { assetId: sysSting.id, role: "stinger" }] }, "duplicate_assignment"],
        [{ soundProfileMode: "custom", assignments: [{ assetId: sysIntro.id, role: "intro" }, { assetId: sysIntro.id, role: "intro" }] }, "duplicate_assignment"],
        [{ soundProfileMode: "custom", assignments: [{ assetId: sysSting.id, role: "stinger", gainDb: 40 }] }, "invalid_gain"],
        [{ soundProfileMode: "custom", assignments: [{ assetId: sysSting.id, role: "stinger", fadeInMs: 99999 }] }, "invalid_fade"],
        [{ soundProfileMode: "nope" as never }, "invalid_mode"],
        [{ soundProfileMode: "custom", cooldownScope: "global" as never }, "invalid_cooldown_scope"],
      ];
      for (const [profile, code] of cases) {
        const res = await savePodcastSoundProfile({ db, podcastId: pod.id, expectedVersion: await v(), canEdit: canEditAsAlice, profile });
        assert(!res.ok && res.error.code === code, `expected ${code}, got ${JSON.stringify(res)}`);
      }
    });

    await check("a non-owner cannot save a profile", async () => {
      const current = (await db.podcast.findUnique({ where: { id: pod.id } }))!.configVersion;
      const res = await savePodcastSoundProfile({
        db, podcastId: pod.id, expectedVersion: current, canEdit: (p) => p.ownerId === bob.id,
        profile: { soundProfileMode: "clean" },
      });
      assert(!res.ok && res.error.code === "podcast_forbidden", JSON.stringify(res));
    });

    await check("CORE: the custom profile freezes with accurate refs + provenance", async () => {
      const production = (await db.podcastProductionConfig.findUnique({ where: { podcastId: pod.id } }))!;
      const profile = await resolvePodcastSoundProfile(db, { id: pod.id, ownerId: alice.id }, production);
      assert(profile.mode === "custom", "custom mode");
      assert(profile.intro?.assetId === sysIntro.id && profile.intro.gainDb === -3 && profile.intro.fadeInMs === 500, "intro w/ mix settings");
      assert(profile.intro!.contentHash === sysIntro.contentHash, "content hash frozen");
      assert(profile.stingers.length === 2 && profile.stingers[1].assetId === aliceSting.id, "ordered stinger pool");
      assert(profile.reactions.length === 1 && profile.reactions[0].assetId === sysSfx.id, "reaction pool is ONLY the assignment");
      assert(profile.intro!.provenance === "podcast_assignment", "provenance");
      assert(!JSON.stringify(profile).includes("http://s.test"), "no storage URLs in the frozen profile");
    });

    await check("archiving an assigned asset EXCLUDES it from the next freeze (named, not substituted)", async () => {
      await db.audioAsset.update({ where: { id: aliceSting.id }, data: { isArchived: true, isActive: false } });
      const production = (await db.podcastProductionConfig.findUnique({ where: { podcastId: pod.id } }))!;
      const profile = await resolvePodcastSoundProfile(db, { id: pod.id, ownerId: alice.id }, production);
      assert(profile.stingers.length === 1 && profile.stingers[0].assetId === sysSting.id, "archived stinger excluded");
      assert(profile.excluded.some((e) => e.assetId === aliceSting.id && e.reason === "archived"), "exclusion is visible and named");
      await db.audioAsset.update({ where: { id: aliceSting.id }, data: { isArchived: false, isActive: true } });
    });

    await check("system_default freezes the CURRENT system config + shared reaction pool", async () => {
      const profile = await resolveSystemDefaultSoundProfile_check();
      assert(profile.mode === "system_default", "mode");
      assert(profile.intro?.assetId === sysIntro.id && profile.bed?.assetId === sysBed.id, "system slots frozen");
      assert(profile.stingers.length === 1 && profile.stingers[0].assetId === sysSting.id, "system stingers");
      assert(profile.reactions.some((r) => r.assetId === sysSfx.id), "shared reaction pool");
      assert(profile.reactions.every((r) => r.scope !== "owner_private" && r.scope !== "podcast_private"), "NO private assets in the system pool");
      assert(profile.containsLegacyCompatAssets === false, "no legacy compat yet");
    });
    async function resolveSystemDefaultSoundProfile_check() {
      return resolveStandaloneSoundProfile(db);
    }

    await check("a legacy_global asset in the system default resolves ONLY as flagged legacy compat", async () => {
      await db.soundDesignConfig.update({ where: { id: "default" }, data: { bedAssetId: null, stingerAssetIds: [legacySting.id] } });
      const profile = await resolveStandaloneSoundProfile(db);
      assert(profile.stingers.length === 1 && profile.stingers[0].assetId === legacySting.id, "legacy compat stinger usable as system default");
      assert(profile.stingers[0].provenance === "legacy_compat", "marked legacy_compat");
      assert(profile.containsLegacyCompatAssets === true, "flag set for the admin warning");
      await db.soundDesignConfig.update({ where: { id: "default" }, data: { bedAssetId: sysBed.id, stingerAssetIds: [sysSting.id] } });
    });

    await check("clean mode freezes an explicit empty profile", async () => {
      const profile = await resolvePodcastSoundProfile(db, { id: pod.id, ownerId: alice.id }, { soundProfileMode: "clean" });
      assert(profile.mode === "clean" && !profile.intro && !profile.bed && profile.stingers.length === 0 && profile.reactions.length === 0, "empty");
    });

    await check("CORE: snapshot v2 carries the frozen profile; sound change moves the fingerprint; capturedAt does not", async () => {
      const resolved = resolveEpisodeConfiguration({ podcast: await loadPodcastConfiguration(db, pod.id), overrides: {} });
      assert(resolved.ok, "config resolves"); if (!resolved.ok) return;
      const production = (await db.podcastProductionConfig.findUnique({ where: { podcastId: pod.id } }))!;
      const profile = await resolvePodcastSoundProfile(db, { id: pod.id, ownerId: alice.id }, production);
      const s1 = buildEpisodeConfigurationSnapshot(resolved.resolved, new Date("2026-01-01T00:00:00Z"), profile);
      const s2 = buildEpisodeConfigurationSnapshot(resolved.resolved, new Date("2027-01-01T00:00:00Z"), profile);
      assert(s1.configurationSnapshot.version >= 2, "sound-bearing snapshot version (v2+; v3 since the format engine)");
      assert(s1.configurationSnapshot.production.soundProfile?.intro?.assetId === sysIntro.id, "profile embedded");
      assert(s1.configurationFingerprint === s2.configurationFingerprint, "capturedAt not in fingerprint");
      const s3 = buildEpisodeConfigurationSnapshot(resolved.resolved, new Date("2026-01-01T00:00:00Z"), { ...profile, stingers: [] });
      assert(s3.configurationFingerprint !== s1.configurationFingerprint, "sound change moves the fingerprint");
      assert(!JSON.stringify(s1.configurationSnapshot).includes("http://s.test"), "no URLs in snapshot");
    });

    await check("a stored v1 snapshot still fingerprints byte-stably (no soundProfile key injected)", () => {
      const v1 = {
        version: 1, source: "standalone", capturedAt: "2026-01-01T00:00:00.000Z", podcast: null,
        editorial: { verticals: [], teams: [], segmentCount: 3, format: "two_host_debate", minDebateScore: null, scriptStyle: null, maxWords: null, provenance: {} },
        production: { hostIds: [], ttsProvider: null, ttsVoiceOverrides: null, productionStyle: null, sfxDensity: null, provenance: {} },
      } as unknown as EpisodeConfigurationSnapshot;
      const f1 = fingerprintEpisodeSnapshot(v1);
      const f2 = fingerprintEpisodeSnapshot(JSON.parse(JSON.stringify(v1)));
      assert(f1 === f2, "v1 fingerprint reproducible");
    });

    await check("CORE: a sound-profile save moves the PODCAST configuration fingerprint", async () => {
      const before = fingerprintPodcastConfiguration((await loadPodcastConfiguration(db, pod.id))!);
      const current = (await db.podcast.findUnique({ where: { id: pod.id } }))!.configVersion;
      const res = await savePodcastSoundProfile({
        db, podcastId: pod.id, expectedVersion: current, canEdit: canEditAsAlice,
        profile: { soundProfileMode: "custom", targetLoudnessLufs: -14, assignments: [{ assetId: sysSting.id, role: "stinger" }] },
      });
      assert(res.ok, JSON.stringify(res));
      const after = fingerprintPodcastConfiguration((await loadPodcastConfiguration(db, pod.id))!);
      assert(before !== after, "fingerprint moved");
    });

    await check("the singleton partial unique index blocks a second ENABLED intro at the DB level", async () => {
      const production = (await db.podcastProductionConfig.findUnique({ where: { podcastId: pod.id } }))!;
      await db.podcastSoundAssignment.create({ data: { productionConfigId: production.id, podcastId: pod.id, assetId: sysIntro.id, role: "intro", enabled: true } });
      let rejected = false;
      try {
        await db.podcastSoundAssignment.create({ data: { productionConfigId: production.id, podcastId: pod.id, assetId: sysOutro.id, role: "intro", enabled: true } });
      } catch { rejected = true; }
      assert(rejected, "second enabled intro must violate the partial unique index");
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
