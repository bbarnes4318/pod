// Show-format migration + backfill test.
//   Run: npm run test:show-format-data-migration
//
// THE ONE THING THIS PROVES: migration 20260901000000_show_formats creates the
// format tables, seeds the two-host generic "classic-debate" format with a
// rundown that adds up, points EVERY pre-existing show at it, is idempotent,
// and the constraints it installs actually hold on a real Postgres.
//
// Following the pattern of testAudioAssetMigration: we re-create the
// pre-migration situation on a fully-migrated fresh database (a Podcast with a
// NULL formatId, exactly as one existed before this migration) and re-run only
// the BACKFILL section of the real migration file. Its INSERTs are
// ON CONFLICT DO NOTHING and its UPDATE is guarded by `formatId IS NULL`, so
// what runs here is byte-identical to what production runs, and safe to re-run.
// No network, no LLM/TTS, no real storage.

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

const MIGRATION = "20260901000000_show_formats";

/** The backfill section only — the DDL above it is already applied by
 *  migrate deploy and is not re-runnable. */
function backfillStatements(): string[] {
  const file = fs.readFileSync(path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
  const start = file.indexOf('INSERT INTO "ShowFormat" (');
  assert(start > 0, "could not locate the backfill section");
  return file
    .slice(start)
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  console.log("\nShow-format migration + backfill\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-fmtmig-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("fmtmig");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/fmtmig`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" as const };
  execSync("npx prisma migrate deploy", { env, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const exec = async (sql: string) => { await db.$executeRawUnsafe(sql); };

  try {
    await check("the migration applies from empty and the format tables exist", async () => {
      const rows = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ShowFormat','FormatSegment')`
      );
      assert(rows.length === 2, `expected both tables, found ${rows.map((r) => r.table_name).join(", ") || "none"}`);
    });

    await check("the hand-written SQL reproduces prisma/schema.prisma with NO drift", async () => {
      // The whole risk of a hand-authored migration: SQL that applies cleanly
      // but describes a slightly different schema than every other test is
      // written against. --exit-code makes "there is a difference" a failure.
      const r = execSync(
        `npx prisma migrate diff --from-url "${dbUrl}" --to-schema-datamodel prisma/schema.prisma --exit-code`,
        { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ).toString();
      assert(!r.includes("[+]") && !r.includes("[-]"), `drift: ${r.trim().slice(0, 800)}`);
    });

    await check("the seeded classic-debate rundown adds up to its totalSeconds", async () => {
      const f = await db.showFormat.findUnique({ where: { slug: "classic-debate" }, include: { segments: true } });
      assert(!!f, "classic-debate was not seeded by the migration");
      assert(f!.status === "ACTIVE", `status: ${f!.status}`);
      assert(f!.segments.length === 3, `segments: ${f!.segments.length}`);
      const sum = f!.segments.reduce((n, s) => n + s.seconds, 0);
      assert(sum === f!.totalSeconds, `segments sum to ${sum}s but totalSeconds is ${f!.totalSeconds}s`);
      for (const s of f!.segments) {
        const split = s.floorSplit as Record<string, number>;
        const total = (split.seatA ?? 0) + (split.seatB ?? 0);
        assert(Math.abs(total - 1) < 1e-9, `${s.key} floorSplit sums to ${total}, not 1`);
      }
      const curve = f!.intensityCurve as Record<string, number>;
      for (const s of f!.segments) {
        assert(typeof curve[s.key] === "number", `intensityCurve has no entry for segment "${s.key}"`);
        assert(curve[s.key] >= 1 && curve[s.key] <= 10, `${s.key} intensity ${curve[s.key]} is outside 1-10`);
      }
    });

    // ---- A show as it existed BEFORE this migration: no format at all ----
    await exec(`INSERT INTO "Podcast" ("id","name","cadence","createdAt","updatedAt") VALUES ('legacy-show','Legacy Show','recurring', now(), now())`);
    await exec(`UPDATE "Podcast" SET "formatId" = NULL WHERE "id" = 'legacy-show'`);

    const statements = backfillStatements();
    const runBackfill = async () => { for (const s of statements) await exec(s); };
    await runBackfill();

    await check("every pre-existing show is backfilled to classic-debate", async () => {
      const nulls = await db.podcast.count({ where: { formatId: null } });
      assert(nulls === 0, `${nulls} show(s) still have no format`);
      const show = await db.podcast.findUnique({ where: { id: "legacy-show" }, include: { format: true } });
      assert(show!.format!.slug === "classic-debate", `legacy show got: ${show!.format!.slug}`);
    });

    await check("re-running the backfill duplicates nothing", async () => {
      await runBackfill();
      await runBackfill();
      const formats = await db.showFormat.count({ where: { slug: "classic-debate" } });
      const segments = await db.formatSegment.count();
      assert(formats === 1, `${formats} classic-debate rows after three runs`);
      assert(segments === 3, `${segments} segment rows after three runs`);
    });

    await check("a show cannot point at a format that does not exist", async () => {
      let threw = false;
      try { await exec(`UPDATE "Podcast" SET "formatId" = 'no-such-format' WHERE "id" = 'legacy-show'`); }
      catch { threw = true; }
      assert(threw, "the Podcast.formatId foreign key did not hold");
    });

    await check("a format in use cannot be deleted out from under its shows", async () => {
      let threw = false;
      try { await exec(`DELETE FROM "ShowFormat" WHERE "slug" = 'classic-debate'`); }
      catch { threw = true; }
      assert(threw, "ON DELETE RESTRICT did not hold — a show was left pointing at a deleted format");
    });

    await check("a rundown cannot have two segments in the same slot", async () => {
      const f = await db.showFormat.findUniqueOrThrow({ where: { slug: "classic-debate" } });
      let threw = false;
      try {
        await exec(`INSERT INTO "FormatSegment" ("id","formatId","order","key","displayName","seconds","floorSplit","turnProfile","evidenceDensity","device","exitCondition","producerNote","createdAt","updatedAt")
          VALUES ('dup-1','${f.id}',0,'another_cold_open','Another Cold Open',60,'{"seatA":0.5,"seatB":0.5}','{}',0,'NONE','x','y', now(), now())`);
      } catch { threw = true; }
      assert(threw, "two segments claimed order 0 in the same format");
    });

    await check("the migration's declared data invariants pass on the migrated database", async () => {
      const results = await runDataInvariants(db);
      const mine = results.filter((r) =>
        ["classic_debate_format_seeded", "classic_debate_has_segments", "every_show_has_a_format", "format_segments_have_a_format"].includes(r.name)
      );
      assert(mine.length === 4, `expected 4 show-format invariants, ran ${mine.length}`);
      const bad = mine.filter((r) => !r.ok);
      assert(bad.length === 0, bad.map((r) => `${r.name}: ${r.detail}`).join("; "));
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
  } finally {
    await db.$disconnect();
    await pg.stop();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
