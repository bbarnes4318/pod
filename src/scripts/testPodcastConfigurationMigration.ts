// Podcast-configuration BACKFILL migration test.
//   Run: npm run test:podcast-configuration-migration
//
// THE ONE THING THIS PROVES: the additive migration 20260716000000 gives EVERY
// pre-existing Podcast a deterministic unique slug and exactly one editorial /
// production / publishing row that mirrors its legacy columns — losing nothing,
// duplicating nothing, and staying idempotent — while leaving existing Episodes
// honestly marked configurationSource = 'legacy'.
//
// Because `migrate deploy` runs the whole history at once (and no Podcast exists
// in a fresh DB), we re-create the pre-migration situation: insert legacy-shaped
// Podcast rows with a NULL slug and NO config rows, then run ONLY the backfill
// portion of the real migration file (its INSERT/UPDATE statements are guarded
// by NOT EXISTS / slug IS NULL, so they are exactly what runs in production and
// are safe to re-run). We then assert the outcome, and re-run to prove
// idempotency. No LLM/TTS/network calls.

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

const MIGRATION = "20260716000000_add_podcast_configuration";

/** The backfill (data) statements of the real migration file: everything from
 *  the "2. Backfill" banner onward, split into individual statements (Prisma's
 *  executeRawUnsafe runs one command at a time). Comment lines are stripped;
 *  no statement in the backfill contains a semicolon inside a literal. We run
 *  exactly what production runs. */
function backfillStatements(): string[] {
  const file = fs.readFileSync(path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
  const marker = file.indexOf("-- 2. Backfill");
  assert(marker > 0, "could not locate the backfill section of the migration");
  return file
    .slice(marker)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  console.log("\nPodcast configuration backfill migration\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-cfgmig-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("cfgmig");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/cfgmig`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" as const };

  execSync("npx prisma migrate deploy", { env, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const exec = async (sql: string) => { await db.$executeRawUnsafe(sql); };

  try {
    // Insert LEGACY-shaped podcasts: NULL slug, no config rows. The backfill
    // copies team IDs verbatim (no join), so no League/Team seed is needed. An
    // owner and an owner-less one, plus a punctuation-only name.
    const owner = await db.user.create({ data: { email: "own@x.test", name: "Owner", passwordHash: "x" } });
    await exec(`INSERT INTO "Podcast" ("id","name","cadence","verticals","teams","segmentCount","hostIds","owner","ownerId","slug","configVersion","createdAt","updatedAt","language","explicit","visibility")
      VALUES ('leg-owned','My Great Show!','recurring', ARRAY['NFL'], ARRAY['team-1'], 6, ARRAY['h1','h2'], 'listener', '${owner.id}', NULL, 1, now(), now(), 'en', false, 'private')`);
    await exec(`INSERT INTO "Podcast" ("id","name","cadence","verticals","teams","segmentCount","hostIds","owner","ownerId","slug","configVersion","createdAt","updatedAt","language","explicit","visibility")
      VALUES ('leg-orphan','My Great Show!','one_time', ARRAY[]::text[], ARRAY[]::text[], 3, ARRAY[]::text[], 'listener', NULL, NULL, 1, now(), now(), 'en', false, 'private')`);
    await exec(`INSERT INTO "Podcast" ("id","name","cadence","verticals","teams","segmentCount","hostIds","owner","ownerId","slug","configVersion","createdAt","updatedAt","language","explicit","visibility")
      VALUES ('leg-weird','!!!','one_time', ARRAY[]::text[], ARRAY[]::text[], 3, ARRAY[]::text[], 'listener', NULL, NULL, 1, now(), now(), 'en', false, 'private')`);

    // A pre-existing Episode: it must keep configurationSource = 'legacy'.
    await exec(`INSERT INTO "Episode" ("id","title","slug","status","hostIds","audioMimeType","explicit","configurationSource","createdAt","updatedAt")
      VALUES ('ep-legacy','Old Ep','old-ep','completed', ARRAY[]::text[], 'audio/mpeg', false, 'legacy', now(), now())`);

    // ---- Run the real backfill ----
    const statements = backfillStatements();
    const runBackfill = async () => { for (const s of statements) await exec(s); };
    await runBackfill();

    await check("every podcast now has a unique, non-null slug", async () => {
      const rows = await db.$queryRawUnsafe<Array<{ id: string; slug: string | null }>>(`SELECT "id","slug" FROM "Podcast"`);
      assert(rows.every((r) => !!r.slug), `some slug is still NULL: ${JSON.stringify(rows)}`);
      const slugs = rows.map((r) => r.slug);
      assert(new Set(slugs).size === slugs.length, `slugs are not unique: ${slugs.join(", ")}`);
    });

    await check("the slug derives from the name and is reserved-safe for a punctuation-only name", async () => {
      const owned = await db.podcast.findUnique({ where: { id: "leg-owned" } });
      assert(!!owned!.slug && owned!.slug!.startsWith("my-great-show-"), `expected my-great-show-*, got ${owned!.slug}`);
      const weird = await db.podcast.findUnique({ where: { id: "leg-weird" } });
      assert(!!weird!.slug && weird!.slug!.startsWith("show-"), `punctuation-only name should fall back to show-*, got ${weird!.slug}`);
    });

    await check("every podcast has exactly one editorial/production/publishing row mirroring its legacy columns", async () => {
      for (const table of ["PodcastEditorialConfig", "PodcastProductionConfig", "PodcastPublishingConfig"]) {
        const missing = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM "Podcast" p WHERE NOT EXISTS (SELECT 1 FROM "${table}" c WHERE c."podcastId"=p."id")`);
        assert(missing[0].n === 0, `${table}: ${missing[0].n} podcast(s) without a row`);
      }
      const ed = await db.podcastEditorialConfig.findUnique({ where: { podcastId: "leg-owned" } });
      assert(ed!.segmentCount === 6, `segmentCount preserved: ${ed!.segmentCount}`);
      assert(JSON.stringify(ed!.verticals) === JSON.stringify(["NFL"]), "verticals preserved");
      assert(JSON.stringify(ed!.teams) === JSON.stringify(["team-1"]), "teams (IDs) preserved verbatim");
      assert(ed!.format === "two_host_debate", "format defaulted to the only supported one");
      const pr = await db.podcastProductionConfig.findUnique({ where: { podcastId: "leg-owned" } });
      assert(JSON.stringify(pr!.hostIds) === JSON.stringify(["h1", "h2"]), "hostIds preserved");
      assert(pr!.ttsProvider === null, "no fabricated voice pin");
    });

    await check("an owner-less podcast STAYS owner-less; an owned one keeps its owner", async () => {
      const orphan = await db.podcast.findUnique({ where: { id: "leg-orphan" } });
      assert(orphan!.ownerId === null, "owner-less stays owner-less");
      const owned = await db.podcast.findUnique({ where: { id: "leg-owned" } });
      assert(owned!.ownerId === owner.id, "owned keeps its owner");
    });

    await check("legacy columns are preserved (nothing is destroyed)", async () => {
      const owned = await db.podcast.findUnique({ where: { id: "leg-owned" } });
      assert(owned!.segmentCount === 6 && JSON.stringify(owned!.verticals) === JSON.stringify(["NFL"]), "legacy Podcast columns intact");
      assert(JSON.stringify(owned!.hostIds) === JSON.stringify(["h1", "h2"]), "legacy hostIds intact");
    });

    await check("the pre-existing episode is honestly marked 'legacy', not a fabricated snapshot", async () => {
      const ep = await db.episode.findUnique({ where: { id: "ep-legacy" } });
      assert(ep!.configurationSource === "legacy", `expected legacy, got ${ep!.configurationSource}`);
      assert(ep!.configurationSnapshot === null, "no snapshot was fabricated for a legacy episode");
    });

    await check("re-running the backfill is idempotent (still one row each, slug unchanged)", async () => {
      const slugBefore = (await db.podcast.findUnique({ where: { id: "leg-owned" } }))!.slug;
      await runBackfill(); // run again
      for (const table of ["PodcastEditorialConfig", "PodcastProductionConfig", "PodcastPublishingConfig"]) {
        const dup = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT COUNT(*)::int AS n FROM (SELECT "podcastId" FROM "${table}" GROUP BY "podcastId" HAVING COUNT(*)>1) d`);
        assert(dup[0].n === 0, `${table} gained duplicate rows on re-run`);
      }
      const slugAfter = (await db.podcast.findUnique({ where: { id: "leg-owned" } }))!.slug;
      assert(slugBefore === slugAfter, "slug changed on re-run");
    });

    await check("`migrate status` stays clean and no drift is introduced", () => {
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
