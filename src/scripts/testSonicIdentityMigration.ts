// Sonic-identity + variant-pools migration test.
// Run: npm run test:sonic-identity-migration
//
// Proves 20260719000000_add_sonic_identity_and_variant_pools:
//   * applies from an EMPTY database (full history) and on top of current schema;
//   * adds PodcastProductionConfig.sonicIdentity (nullable jsonb);
//   * adds PodcastSoundAssignment variant columns with safe defaults;
//   * adds AudioAsset.cueMetadata + metadataState (default unclassified);
//   * DROPS the singleton intro/outro/bed index (variant pools now allowed);
//   * enforces the weight + metadataState CHECK constraints;
//   * existing assignments/podcasts stay valid with documented defaults;
//   * is idempotent; leaves the schema drift-free + migrate status clean.
//
// Embedded PostgreSQL; no ffmpeg, no storage, no network, no paid APIs.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
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
async function expectReject(fn: () => Promise<unknown>, label: string) {
  let threw = false;
  try { await fn(); } catch { threw = true; }
  assert(threw, label);
}

async function main() {
  console.log("\nSonic identity + variant pools migration\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-sonic-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("sonic");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/sonic`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" } as NodeJS.ProcessEnv;

  execSync("npx prisma migrate deploy", { env, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  const col = (table: string, name: string) =>
    db.$queryRawUnsafe<Array<{ is_nullable: string; data_type: string; column_default: string | null }>>(
      `SELECT is_nullable, data_type, column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      table, name
    );

  try {
    await check("Test 1/2: PodcastProductionConfig.sonicIdentity is a nullable jsonb", async () => {
      const c = await col("PodcastProductionConfig", "sonicIdentity");
      assert(c.length === 1 && c[0].is_nullable === "YES" && c[0].data_type === "jsonb", `got ${JSON.stringify(c)}`);
    });

    await check("PodcastSoundAssignment variant columns exist with safe defaults", async () => {
      const w = await col("PodcastSoundAssignment", "weight");
      assert(w.length === 1 && w[0].is_nullable === "NO" && /1/.test(w[0].column_default ?? ""), `weight default: ${JSON.stringify(w)}`);
      const m = await col("PodcastSoundAssignment", "isBrandedMotif");
      assert(m.length === 1 && /false/.test(m[0].column_default ?? ""), `motif default: ${JSON.stringify(m)}`);
      for (const name of ["cueFamily", "maxUsesPerEpisode", "minEpisodeCooldown", "allowedFormatIds", "prohibitedFormatIds"]) {
        assert((await col("PodcastSoundAssignment", name)).length === 1, `${name} present`);
      }
    });

    await check("AudioAsset.cueMetadata (jsonb) + metadataState (default unclassified) exist", async () => {
      const cm = await col("AudioAsset", "cueMetadata");
      assert(cm.length === 1 && cm[0].data_type === "jsonb" && cm[0].is_nullable === "YES", `cueMetadata: ${JSON.stringify(cm)}`);
      const ms = await col("AudioAsset", "metadataState");
      assert(ms.length === 1 && ms[0].is_nullable === "NO" && /unclassified/.test(ms[0].column_default ?? ""), `metadataState: ${JSON.stringify(ms)}`);
    });

    // Build a podcast + config + two intro assets to exercise defaults + pools.
    const pod = await db.podcast.create({ data: { name: "Sonic Show", cadence: "one_time" } });
    const cfg = await db.podcastProductionConfig.create({ data: { podcastId: pod.id } });
    const mkAsset = (n: string) => db.audioAsset.create({ data: { name: n, kind: "theme_intro", tags: [], audioUrl: `http://s.test/${n}`, license: "x", scope: "shared_system", processingStatus: "ready" } });
    const introA = await mkAsset("Intro A");
    const introB = await mkAsset("Intro B");

    await check("Tests 3/4: an existing-style assignment gets documented defaults (weight 1, not motif, no format restriction)", async () => {
      const a = await db.podcastSoundAssignment.create({ data: { productionConfigId: cfg.id, podcastId: pod.id, assetId: introA.id, role: "intro", enabled: true } });
      assert(a.weight === 1 && a.isBrandedMotif === false && a.allowedFormatIds.length === 0 && a.cueFamily === null, `defaults: ${JSON.stringify(a)}`);
      const asset = await db.audioAsset.findUnique({ where: { id: introA.id } });
      assert(asset?.metadataState === "unclassified" && asset?.cueMetadata === null, "asset metadata default unclassified/null");
    });

    await check("the singleton intro/outro/bed index is DROPPED: two ENABLED intro variants are now allowed", async () => {
      const b = await db.podcastSoundAssignment.create({ data: { productionConfigId: cfg.id, podcastId: pod.id, assetId: introB.id, role: "intro", enabled: true, weight: 2, cueFamily: "brand_short" } });
      assert(b.weight === 2 && b.cueFamily === "brand_short", "second enabled intro variant persisted");
      const introCount = await db.podcastSoundAssignment.count({ where: { podcastId: pod.id, role: "intro", enabled: true } });
      assert(introCount === 2, `two enabled intro variants (got ${introCount})`);
    });

    await check("Test 24: the weight CHECK rejects out-of-bounds weights", async () => {
      const introC = await mkAsset("Intro C");
      await expectReject(() => db.podcastSoundAssignment.create({ data: { productionConfigId: cfg.id, podcastId: pod.id, assetId: introC.id, role: "intro", weight: 101 } }), "weight 101 rejected");
    });

    await check("the metadataState CHECK rejects an unknown state", async () => {
      await expectReject(() => db.$executeRawUnsafe(`UPDATE "AudioAsset" SET "metadataState" = 'bogus' WHERE "id" = $1`, introA.id), "bogus metadataState rejected");
    });

    await check("Test idempotent: re-applying the whole migration file is a no-op", () => {
      // Run through prisma db execute so the multi-statement file (incl. DO$$
      // blocks) is executed by the server, not as a prepared statement.
      execSync(
        `npx prisma db execute --url "${dbUrl}" --file prisma/migrations/20260719000000_add_sonic_identity_and_variant_pools/migration.sql`,
        { env, stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    await check("Test 5: schema has zero drift against the migration history", () => {
      execSync(`npx prisma migrate diff --from-url "${dbUrl}" --to-schema-datamodel prisma/schema.prisma --exit-code`, { env, stdio: ["ignore", "pipe", "pipe"] });
    });

    await check("Test 6: migrate status is clean", () => {
      execSync("npx prisma migrate status", { env, stdio: ["ignore", "pipe", "pipe"] });
    });
  } finally {
    await db.$disconnect();
    await pg.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
