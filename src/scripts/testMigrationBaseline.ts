// Fresh-database reconstruction. Run: npm run test:migration-baseline
//
// THE ONE THING THIS PROVES: a completely empty PostgreSQL database can reach
// the current schema using `prisma migrate deploy` and nothing else.
//
// That was not true before the baseline. The migrations folder began mid-history
// — the first migration ALTERs "Episode", a table no migration created — so
// `migrate deploy` against an empty database failed with
// `relation "Episode" does not exist`. The repository could not rebuild its own
// schema, which is only invisible until the day you need disaster recovery, a
// new staging environment, or an honest answer to "does our migration history
// actually describe our database?".
//
// `prisma db push` is DELIBERATELY not used here. db push is a local
// convenience that syncs a schema without recording history; it is what created
// this problem, and using it here would re-hide the very failure this test
// exists to catch. migrate deploy is the production/recovery authority.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
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

const BASELINE = "20260704000000_baseline";

async function main() {
  console.log("\nMigration baseline — rebuilding from an empty database\n");

  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-baseline-pg-"));
  const dataDir = path.join(tmpRoot, "data");
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port, persistent: false });

  await pg.initialise();
  await pg.start();
  await pg.createDatabase("fresh");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/fresh`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" as const };
  const run = (cmd: string) => execSync(cmd, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  try {
    // ---- The database really is empty -------------------------------------
    const { PrismaClient } = await import("@prisma/client");
    const probe = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    const tablesBefore = await probe.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM information_schema.tables WHERE table_schema = 'public'`
    );
    check("the target database starts genuinely empty", () => {
      assert(Number(tablesBefore[0].count) === 0, `expected 0 tables, found ${tablesBefore[0].count}`);
    });
    await probe.$disconnect();

    // ---- migrate deploy ----------------------------------------------------
    let deployOut = "";
    let deployErr: Error | null = null;
    try { deployOut = run("npx prisma migrate deploy"); } catch (err) { deployErr = err as Error; }

    check("CORE: `prisma migrate deploy` succeeds against an empty database", () => {
      // Before the baseline this failed with `relation "Episode" does not exist`.
      assert(!deployErr, `migrate deploy failed:\n${(deployErr as unknown as { stdout?: string })?.stdout ?? deployErr?.message}`);
    });

    check("the baseline applied first", () => {
      assert(deployOut.includes(BASELINE), `the baseline was not applied:\n${deployOut}`);
    });

    check("no relation-missing error occurred", () => {
      assert(!/does not exist/i.test(deployOut), `a relation was missing:\n${deployOut}`);
    });

    check("no duplicate table / column / index / enum error occurred", () => {
      // The failure mode if the baseline had been generated from the CURRENT
      // schema: later migrations would re-add what already existed.
      assert(!/already exists|duplicate/i.test(deployOut), `a duplicate object error occurred:\n${deployOut}`);
    });

    const migrationDirs = fs.readdirSync(path.join(process.cwd(), "prisma", "migrations"))
      .filter((d) => fs.statSync(path.join(process.cwd(), "prisma", "migrations", d)).isDirectory());

    check("EVERY migration applied, in order, with the baseline first", () => {
      // Not a hardcoded count: the point is that the whole folder applies, and
      // pinning a number here would just have to be edited by whoever adds the
      // next migration — a step that gets skipped, leaving the assertion
      // meaningless. What matters is "all of them, baseline first".
      const applied = migrationDirs.filter((d) => deployOut.includes(d));
      assert(
        applied.length === migrationDirs.length,
        `only ${applied.length}/${migrationDirs.length} migrations appear in the deploy output:\n${deployOut}`
      );
      const sorted = [...migrationDirs].sort();
      assert(sorted[0] === BASELINE, `the baseline must sort first; the earliest is ${sorted[0]}`);
    });

    // ---- migrate status ----------------------------------------------------
    let statusOut = "";
    try { statusOut = run("npx prisma migrate status"); }
    catch (err) { statusOut = (err as unknown as { stdout?: string }).stdout ?? String(err); }

    check("`migrate status` reports nothing pending and nothing failed", () => {
      assert(/up to date|No pending migrations/i.test(statusOut), `status is not clean:\n${statusOut}`);
      assert(!/failed/i.test(statusOut), `a failed migration is recorded:\n${statusOut}`);
    });

    // ---- Drift -------------------------------------------------------------
    let driftErr: (Error & { status?: number }) | null = null;
    let driftScript = "";
    try {
      run(`npx prisma migrate diff --from-url "${dbUrl}" --to-schema-datamodel prisma/schema.prisma --exit-code`);
    } catch (err) {
      driftErr = err as Error & { status?: number };
      // Re-run WITHOUT --exit-code to get the actual SQL describing the drift;
      // "there is drift" is useless without "here is what".
      try { driftScript = run(`npx prisma migrate diff --from-url "${dbUrl}" --to-schema-datamodel prisma/schema.prisma --script`); }
      catch { driftScript = "(could not render the drift script)"; }
    }

    check("CORE: the migrated schema matches prisma/schema.prisma with ZERO drift", () => {
      // --exit-code: 0 = no diff, 2 = drift. Anything else is a tool error.
      if (driftErr) {
        assert(false, `drift detected between the migrated database and the schema:\n${driftScript.trim()}`);
      }
    });

    // ---- Re-running deploy is a no-op --------------------------------------
    const second = run("npx prisma migrate deploy");
    check("re-running `migrate deploy` is safe and reports no pending work", () => {
      assert(/No pending migrations|already in sync/i.test(second), `a second deploy was not a no-op:\n${second}`);
    });

    // ---- Prisma Client can actually use it ---------------------------------
    const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    let readWriteOk = false;
    let sample: { topicId: string; status: string; sourceId: string } | null = null;
    try {
      const league = await db.league.findFirst({ where: { id: "NFL" } });
      const topic = await db.topicCandidate.create({
        data: {
          title: "Reconstruction probe", sport: "NFL", leagueId: league?.id ?? null,
          controversyScore: 1, starPowerScore: 1, bettingRelevanceScore: 1, recencyScore: 1,
          debateScore: 50, evidenceIds: [], status: "pending",
        },
      });
      // A table from the LAST migration, to prove the whole chain landed.
      const src = await db.topicSource.create({
        data: {
          topicId: topic.id, originalUrl: "https://example.test/a", canonicalUrl: "https://example.test/a",
          fetchStatus: "imported", createdByAdminIdentity: "probe",
        },
      });
      const back = await db.topicCandidate.findUnique({ where: { id: topic.id }, include: { sources: true } });
      readWriteOk = !!back && back.sources.length === 1;
      sample = { topicId: topic.id, status: String(back!.status), sourceId: src.id };
    } catch (err) {
      console.error("      read/write probe error:", (err as Error).message);
    }

    check("Prisma Client can write and read representative rows", () => {
      assert(readWriteOk, "a round-trip through the reconstructed database failed");
    });

    check("the enum from a later migration is real, not text", () => {
      // TopicEditorialStatus arrives in 20260714120000 — the baseline leaves
      // status as TEXT. Proving the enum exists proves the chain ran in order.
      assert(sample?.status === "pending", `expected the enum value 'pending', got ${sample?.status}`);
    });

    const enumRows = await db.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'TopicEditorialStatus' ORDER BY e.enumsortorder`
    );
    check("the TopicEditorialStatus enum has exactly its four editorial values", () => {
      const labels = enumRows.map((r) => r.enumlabel);
      assert(JSON.stringify(labels) === JSON.stringify(["pending", "approved", "rejected", "archived"]), `enum labels: ${labels.join(",")}`);
    });

    const seeded = await db.league.count();
    check("data-seeding migrations ran (leagues are present)", () => {
      // 20260706150000 and 20260706210000 INSERT leagues — schema alone would
      // not tell us those ran.
      assert(seeded > 0, "no leagues were seeded; the data-bearing migrations did not run");
    });

    const backfillCols = await db.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string }>>(
      `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'EpisodeTopic' AND column_name IN ('snapshot','selectedAt')`
    );
    check("the backfill migration's columns exist with the right nullability", () => {
      const selectedAt = backfillCols.find((c) => c.column_name === "selectedAt");
      const snapshot = backfillCols.find((c) => c.column_name === "snapshot");
      assert(!!selectedAt && selectedAt.is_nullable === "NO", `selectedAt should be NOT NULL, got ${selectedAt?.is_nullable}`);
      assert(!!snapshot && snapshot.is_nullable === "YES", `snapshot should be nullable, got ${snapshot?.is_nullable}`);
    });

    await db.$disconnect();
  } finally {
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
