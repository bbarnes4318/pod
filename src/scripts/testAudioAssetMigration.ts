// Audio-asset ownership BACKFILL migration test.
//   Run: npm run test:audio-asset-migration
//
// THE ONE THING THIS PROVES: migration 20260717000000 classifies every
// pre-existing AudioAsset from EVIDENCE (seed -> shared_system with confirmed
// rights; everything else -> legacy_global flagged for review), fabricates no
// owner, destroys nothing, is idempotent, and the constraints + trigger it
// installs actually hold on a real Postgres.
//
// We re-create the pre-migration situation on a fully-migrated fresh database:
// insert legacy-shaped rows (as if they predated ownership), then run ONLY the
// backfill section of the real migration file — its UPDATEs are guarded by
// source/scope predicates, so they are exactly what production ran and are
// safe to re-run. No network, no LLM/TTS, no real storage.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { runDataInvariants } from "../lib/services/migrationCheckpoints";

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

const MIGRATION = "20260717000000_add_audio_asset_ownership";

/** The backfill statements (section 2 only — DDL/constraints/trigger already
 *  applied by migrate deploy and not re-runnable). */
function backfillStatements(): string[] {
  const file = fs.readFileSync(path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
  const start = file.indexOf("-- 2. Backfill");
  const end = file.indexOf("-- 3. Scope integrity");
  assert(start > 0 && end > start, "could not locate the backfill section");
  return file
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  console.log("\nAudio-asset ownership backfill migration\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-assetmig-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("assetmig");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/assetmig`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" as const };
  execSync("npx prisma migrate deploy", { env, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const exec = async (sql: string) => { await db.$executeRawUnsafe(sql); };

  try {
    // ---- Legacy-shaped rows: exactly what a pre-Prompt-6 database held ----
    // (raw SQL so column defaults don't pre-classify them differently than
    //  the real pre-migration rows, which land on the fail-closed default)
    await exec(`INSERT INTO "AudioAsset" ("id","name","kind","tags","audioUrl","storageKey","license","rightsConfirmed","isActive","source","createdAt","updatedAt","scope","legacyScopeReviewRequired","licenseStatus","rightsStatus","processingStatus","isArchived")
      VALUES ('seed-1','Arena Charge','theme_intro','[]','http://s.test/seed/intro.mp3','sound-design/seed/theme-intro-arena-charge.mp3','Original (generated in-house), CC0', true, true, 'seed', now(), now(), 'legacy_global', false, 'unknown', 'not_required', 'ready', false)`);
    await exec(`INSERT INTO "AudioAsset" ("id","name","kind","tags","audioUrl","storageKey","license","rightsConfirmed","isActive","source","createdAt","updatedAt","scope","legacyScopeReviewRequired","licenseStatus","rightsStatus","processingStatus","isArchived")
      VALUES ('up-1','Mystery Upload','stinger','[]','http://s.test/up/st.mp3','sound-design/uploads/x-st.mp3','Licensed - see note', false, true, 'upload', now(), now(), 'legacy_global', false, 'unknown', 'not_required', 'ready', false)`);
    await exec(`INSERT INTO "AudioAsset" ("id","name","kind","tags","audioUrl","storageKey","license","rightsConfirmed","isActive","source","createdAt","updatedAt","scope","legacyScopeReviewRequired","licenseStatus","rightsStatus","processingStatus","isArchived")
      VALUES ('hl-1','Cleared Highlight','highlight','[]','http://s.test/up/hl.mp3','sound-design/uploads/x-hl.mp3','Licensed', true, true, 'upload', now(), now(), 'legacy_global', false, 'unknown', 'not_required', 'ready', false)`);
    await exec(`INSERT INTO "AudioAsset" ("id","name","kind","tags","audioUrl","storageKey","license","rightsConfirmed","isActive","source","createdAt","updatedAt","scope","legacyScopeReviewRequired","licenseStatus","rightsStatus","processingStatus","isArchived")
      VALUES ('hl-2','Uncleared Highlight','highlight','[]','http://s.test/up/hl2.mp3','sound-design/uploads/x-hl2.mp3','unknown', false, true, 'upload', now(), now(), 'legacy_global', false, 'unknown', 'not_required', 'ready', false)`);

    // A pre-existing usage row + config referencing the legacy upload:
    await exec(`INSERT INTO "SoundCueUsage" ("id","episodeId","assetId","assetName","cueType","usedAt") VALUES ('use-1','ep-old','up-1','Mystery Upload','stinger', now())`);
    await exec(`INSERT INTO "SoundDesignConfig" ("id","themeIntroAssetId","stingerAssetIds","defaultStyle","defaultSfxDensity","updatedAt") VALUES ('default','seed-1','["up-1"]','full','subtle', now())`);

    // ---- Run the real backfill ----
    const statements = backfillStatements();
    const runBackfill = async () => { for (const s of statements) await exec(s); };
    await runBackfill();

    await check("seed assets become shared_system with confirmed rights and original license", async () => {
      const row = await db.audioAsset.findUnique({ where: { id: "seed-1" } });
      assert(row!.scope === "shared_system", `scope: ${row!.scope}`);
      assert(row!.ownerId === null && row!.podcastId === null, "unowned");
      assert(row!.licenseStatus === "original" && row!.rightsStatus === "confirmed", "license/rights set");
      assert(row!.legacyScopeReviewRequired === false, "no review needed");
    });

    await check("non-seed assets become legacy_global flagged for review — no fabricated owner", async () => {
      for (const id of ["up-1", "hl-1", "hl-2"]) {
        const row = await db.audioAsset.findUnique({ where: { id } });
        assert(row!.scope === "legacy_global", `${id} scope: ${row!.scope}`);
        assert(row!.legacyScopeReviewRequired === true, `${id} flagged`);
        assert(row!.ownerId === null, `${id} no fabricated owner`);
        assert(row!.licenseStatus === "unknown", `${id} license honestly unknown`);
      }
    });

    await check("the legacy rights boolean maps honestly onto rightsStatus", async () => {
      assert((await db.audioAsset.findUnique({ where: { id: "up-1" } }))!.rightsStatus === "not_required", "ordinary asset, unconfirmed -> not_required (matches old behavior: never rights-checked)");
      assert((await db.audioAsset.findUnique({ where: { id: "hl-1" } }))!.rightsStatus === "confirmed", "confirmed highlight stays usable");
      assert((await db.audioAsset.findUnique({ where: { id: "hl-2" } }))!.rightsStatus === "pending", "unconfirmed highlight -> pending (still blocked, exactly as before)");
    });

    await check("nothing is destroyed: rows, usage, config, and legacy columns intact", async () => {
      assert((await db.audioAsset.count()) === 4, "all 4 assets remain");
      assert((await db.soundCueUsage.count()) === 1, "usage row remains");
      const cfg = await db.soundDesignConfig.findUnique({ where: { id: "default" } });
      assert(cfg!.themeIntroAssetId === "seed-1", "config reference remains");
      const up = await db.audioAsset.findUnique({ where: { id: "up-1" } });
      assert(up!.audioUrl === "http://s.test/up/st.mp3" && up!.license === "Licensed - see note" && up!.rightsConfirmed === false, "legacy columns preserved verbatim");
    });

    await check("re-running the backfill is idempotent", async () => {
      const before = await db.audioAsset.findMany({ orderBy: { id: "asc" } });
      await runBackfill();
      const after = await db.audioAsset.findMany({ orderBy: { id: "asc" } });
      // rightsConfirmedAt on seeds uses COALESCE so a re-run cannot move it.
      assert(JSON.stringify(before) === JSON.stringify(after), "second run changed rows");
    });

    await check("the data invariants for this migration pass on the backfilled DB", async () => {
      const results = await runDataInvariants(db as never);
      const mine = results.filter((r) =>
        ["audio_asset_scopes_valid", "shared_system_assets_unowned", "owner_private_assets_owned", "podcast_private_assets_consistent", "seed_assets_shared_system", "seed_assets_rights_confirmed", "legacy_assets_flagged_for_review"].includes(r.name)
      );
      assert(mine.length === 7, `expected 7 invariants, got ${mine.length}`);
      const failing = mine.filter((r) => !r.ok);
      assert(failing.length === 0, `failing: ${failing.map((f) => `${f.name}: ${f.detail}`).join("; ")}`);
    });

    await check("the immutability trigger installed by the migration is live", async () => {
      let raised = false;
      try { await exec(`UPDATE "AudioAsset" SET "audioUrl" = 'http://s.test/tampered.mp3' WHERE "id" = 'up-1'`); }
      catch (err) { raised = /immutable/i.test((err as Error).message); }
      assert(raised, "content change on a ready asset must RAISE");
    });

    await check("`migrate status` stays clean after the backfill", () => {
      const status = execSync("npx prisma migrate status", { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert(/up to date|No pending/i.test(status), `status not clean:\n${status}`);
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
