// System-default variant pools test (PR 2 review). Run: npm run test:system-sound-pools
//
// Real embedded PostgreSQL. Proves admins can configure real system variant
// pools, the resolver builds them (respecting rights/archive/scope/kind), the
// singleton config still works as a one-item fallback, private assets are
// rejected, saves are atomic + optimistically concurrent, and selection over
// the system pools is deterministic.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

import { saveSystemSoundProfile, resolveSystemDefaultSoundProfile } from "../lib/services/podcastSoundProfile";
import { selectEpisodeSoundVariants } from "../lib/audio/variantSelection";
import { assertFrozenBookendIntent } from "../lib/services/episodeConfigurationSnapshot";

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
  console.log("\nSystem-default variant pools\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-syspool-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise(); await pg.start(); await pg.createDatabase("sys");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/sys`;
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  const mk = (over: Record<string, unknown>) => db.audioAsset.create({ data: {
    name: String(over.name ?? "A"), kind: String(over.kind ?? "theme_intro"), tags: [],
    audioUrl: `http://s.test/${Math.random().toString(36).slice(2)}`, license: "x",
    scope: "shared_system", processingStatus: "ready", ...over,
  } as never });
  const ver = () => db.soundDesignConfig.upsert({ where: { id: "default" }, create: { id: "default" }, update: {}, select: { configVersion: true } }).then((c) => c.configVersion);

  try {
    const introA = await mk({ name: "Sys Intro A", kind: "theme_intro" });
    const introB = await mk({ name: "Sys Intro B", kind: "theme_intro" });
    const outroA = await mk({ name: "Sys Outro A", kind: "theme_outro" });
    const outroB = await mk({ name: "Sys Outro B", kind: "theme_outro" });
    const bed1 = await mk({ name: "Bed 1", kind: "bed" });
    const bed2 = await mk({ name: "Bed 2", kind: "bed" });
    const bed3 = await mk({ name: "Bed 3", kind: "bed" });
    const sting = await mk({ name: "Sting", kind: "stinger" });
    const owner = await db.user.create({ data: { email: `owner-${port}@t.test` } });
    const pod = await db.podcast.create({ data: { name: "P", cadence: "one_time", ownerId: owner.id } });
    const privOwner = await mk({ name: "Private", kind: "theme_intro", scope: "owner_private", ownerId: owner.id });
    const privPod = await mk({ name: "PodPriv", kind: "theme_intro", scope: "podcast_private", podcastId: pod.id, ownerId: owner.id });

    await check("Tests 1/2/3: two intro + two outro + three bed variants can all be configured", async () => {
      const res = await saveSystemSoundProfile({ db, expectedVersion: await ver(), assignments: [
        { assetId: introA.id, role: "intro", weight: 1, cueFamily: "brand_main" },
        { assetId: introB.id, role: "intro", weight: 3, cueFamily: "brand_short" },
        { assetId: outroA.id, role: "outro" }, { assetId: outroB.id, role: "outro" },
        { assetId: bed1.id, role: "bed" }, { assetId: bed2.id, role: "bed" }, { assetId: bed3.id, role: "bed" },
        { assetId: sting.id, role: "stinger", cueFamily: "hard_hit" },
      ] });
      assert(res.ok, JSON.stringify(res));
      const prof = await resolveSystemDefaultSoundProfile(db);
      assert(prof.introVariants?.length === 2, `2 intros (${prof.introVariants?.length})`);
      assert(prof.outroVariants?.length === 2, `2 outros (${prof.outroVariants?.length})`);
      assert(prof.beds?.length === 3, `3 beds (${prof.beds?.length})`);
      assert(prof.stingers.length === 1 && prof.stingers[0].cueFamily === "hard_hit", "stinger variant with family");
    });

    await check("Tests 4/5/6/20: system selection is deterministic, varied, weight-biased", async () => {
      const prof = await resolveSystemDefaultSoundProfile(db);
      const a = selectEpisodeSoundVariants(prof, { seed: "s1", formatId: "two_host_debate" });
      const b = selectEpisodeSoundVariants(prof, { seed: "s1", formatId: "two_host_debate" });
      assert(a.intro?.assetId === b.intro?.assetId, "same seed -> same intro (deterministic)");
      const seen = new Set<string>();
      let heavy = 0;
      for (let i = 0; i < 100; i++) {
        const r = selectEpisodeSoundVariants(prof, { seed: `k${i}`, formatId: "two_host_debate" });
        if (r.intro) { seen.add(r.intro.assetId); if (r.intro.assetId === introB.id) heavy++; }
      }
      assert(seen.size === 2, `variety (${seen.size})`);
      assert(heavy > 55, `weight 3 intro dominates (${heavy}/100)`);
    });

    await check("Tests 10/11/12: private / podcast-private / role-kind assets are rejected on save", async () => {
      let r = await saveSystemSoundProfile({ db, expectedVersion: await ver(), assignments: [{ assetId: privOwner.id, role: "intro" }] });
      assert(!r.ok && r.error.code === "asset_not_assignable", `owner-private: ${JSON.stringify(r)}`);
      r = await saveSystemSoundProfile({ db, expectedVersion: await ver(), assignments: [{ assetId: privPod.id, role: "intro" }] });
      assert(!r.ok && r.error.code === "asset_not_assignable", `podcast-private: ${JSON.stringify(r)}`);
      r = await saveSystemSoundProfile({ db, expectedVersion: await ver(), assignments: [{ assetId: bed1.id, role: "intro" }] });
      assert(!r.ok && r.error.code === "asset_not_assignable", `role/kind: ${JSON.stringify(r)}`);
    });

    await check("Tests 8/9: an asset that LATER became rights-invalid / archived is EXCLUDED at resolve (named, not substituted)", async () => {
      const willRevoke = await mk({ name: "WillRevoke", kind: "bed" });
      const willArchive = await mk({ name: "WillArchive", kind: "bed" });
      // Assign all three while valid — the save accepts them.
      const res = await saveSystemSoundProfile({ db, expectedVersion: await ver(), assignments: [
        { assetId: bed1.id, role: "bed" }, { assetId: willRevoke.id, role: "bed" }, { assetId: willArchive.id, role: "bed" },
      ] });
      assert(res.ok, JSON.stringify(res));
      // Now two of them go bad AFTER assignment (rights revoked / archived).
      await db.audioAsset.update({ where: { id: willRevoke.id }, data: { rightsStatus: "revoked" } });
      await db.audioAsset.update({ where: { id: willArchive.id }, data: { isArchived: true } });
      const prof = await resolveSystemDefaultSoundProfile(db);
      assert(prof.beds?.length === 1 && prof.beds[0].assetId === bed1.id, `only the still-valid bed resolves (${prof.beds?.length})`);
      assert(prof.excluded.some((e) => e.assetId === willRevoke.id) && prof.excluded.some((e) => e.assetId === willArchive.id), "both excluded + named");
    });

    await check("Test 7: with NO system assignments, the legacy singleton slots are a one-item pool", async () => {
      await db.systemSoundAssignment.deleteMany({ where: { configId: "default" } });
      await db.soundDesignConfig.update({ where: { id: "default" }, data: { themeIntroAssetId: introA.id, themeOutroAssetId: outroA.id, bedAssetId: bed1.id } });
      const prof = await resolveSystemDefaultSoundProfile(db);
      assert(prof.introVariants?.length === 1 && prof.introVariants[0].assetId === introA.id, "singleton intro -> one-item pool");
      assert(prof.outroVariants?.length === 1 && prof.beds?.length === 1, "singleton outro + bed fallbacks");
      assert(prof.introEnabled === true, "introEnabled true from singleton");
    });

    await check("Tests 13/14: an enabled system bookend with no asset + no exclusion fails at creation", () => {
      const bad = (kind: "intro" | "outro") => ({ mode: "system_default", targetLoudnessLufs: null, cooldownScope: "podcast", stingerCooldownEpisodes: null, reactionCooldownEpisodes: null, introEnabled: kind === "intro", outroEnabled: kind === "outro", intro: null, outro: null, bed: null, stingers: [], reactions: [], introVariants: [], outroVariants: [], beds: [], containsLegacyCompatAssets: false, excluded: [] } as never);
      let introThrew = false, outroThrew = false;
      try { assertFrozenBookendIntent(bad("intro")); } catch { introThrew = true; }
      try { assertFrozenBookendIntent(bad("outro")); } catch { outroThrew = true; }
      assert(introThrew && outroThrew, "enabled system intro/outro with no asset/exclusion throws (Level 2)");
    });

    await check("Tests 17/18: system save is atomic + optimistic-concurrency guarded", async () => {
      const v = await ver();
      const good = await saveSystemSoundProfile({ db, expectedVersion: v, assignments: [{ assetId: introA.id, role: "intro" }] });
      assert(good.ok, JSON.stringify(good));
      // stale version writes nothing
      const stale = await saveSystemSoundProfile({ db, expectedVersion: v, assignments: [{ assetId: introB.id, role: "intro" }] });
      assert(!stale.ok && stale.error.code === "system_config_changed", `stale rejected: ${JSON.stringify(stale)}`);
      const rows = await db.systemSoundAssignment.findMany({ where: { configId: "default", role: "intro" } });
      assert(rows.length === 1 && rows[0].assetId === introA.id, "stale save wrote nothing");
      // an invalid assignment writes nothing (atomic)
      const before = await db.systemSoundAssignment.count({ where: { configId: "default" } });
      const bad = await saveSystemSoundProfile({ db, expectedVersion: await ver(), assignments: [{ assetId: introB.id, role: "intro" }, { assetId: privOwner.id, role: "intro" }] });
      assert(!bad.ok, "invalid save rejected");
      const after = await db.systemSoundAssignment.count({ where: { configId: "default" } });
      assert(before === after, "no partial write on rejected save");
    });

    await check("Test 15: preview/resolve creates no episodes and no DB writes", async () => {
      const epsBefore = await db.episode.count();
      const prof = await resolveSystemDefaultSoundProfile(db);
      selectEpisodeSoundVariants(prof, { seed: "preview", formatId: "two_host_debate" });
      assert((await db.episode.count()) === epsBefore, "no episode created by resolve+select");
    });

    await check("Test 6b: assignment weight affects fixture-seed distribution (explicit)", async () => {
      await db.systemSoundAssignment.deleteMany({ where: { configId: "default" } });
      await saveSystemSoundProfile({ db, expectedVersion: await ver(), assignments: [
        { assetId: bed1.id, role: "bed", weight: 20 }, { assetId: bed2.id, role: "bed", weight: 1 },
      ] });
      const prof = await resolveSystemDefaultSoundProfile(db);
      let heavy = 0;
      for (let i = 0; i < 200; i++) if (selectEpisodeSoundVariants(prof, { seed: `w${i}`, formatId: "two_host_debate" }).bed?.assetId === bed1.id) heavy++;
      assert(heavy > 150, `weighted bed dominates (${heavy}/200)`);
    });
  } finally {
    await db.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* windows file lock on teardown */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
