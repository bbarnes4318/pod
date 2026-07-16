// Adoption auditor. Run: npm run test:migration-adoption
//
// Drives the auditor against real throwaway databases in each state it must
// handle, and — the load-bearing assertion — proves it MUTATES NOTHING. It runs
// against production-shaped databases whose state nobody trusts yet; a tool
// that "helpfully" fixed something there would be worse than the problem.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

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

interface Audit { out: string; code: number }

async function main() {
  console.log("\nMigration adoption auditor\n");

  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-adopt-pg-"));
  const dataDir = path.join(tmpRoot, "data");
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port, persistent: false });

  await pg.initialise();
  await pg.start();

  const urlFor = (n: string) => `postgresql://postgres:postgres@localhost:${port}/${n}`;
  const audit = (dbName: string): Audit => {
    const env = { ...process.env, DATABASE_URL: urlFor(dbName), NODE_ENV: "development" as const };
    try {
      const out = execSync("npx tsx --conditions=react-server src/scripts/auditMigrationAdoption.ts", { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return { out, code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; status?: number; message?: string };
      return { out: e.stdout ?? e.message ?? "", code: e.status ?? 1 };
    }
  };
  const sh = (dbName: string, cmd: string) =>
    execSync(cmd, { env: { ...process.env, DATABASE_URL: urlFor(dbName), NODE_ENV: "development" as const }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const client = (n: string) => new PrismaClient({ datasources: { db: { url: urlFor(n) } } });

  /** The rows the seeding migrations INSERT — present in any real database. */
  async function seedLeagues(dbName: string) {
    const db = client(dbName);
    try {
      for (const [id, name, sport, slug] of [
        ["NFL", "National Football League", "Football", "nfl"],
        ["GAMBLING", "Gambling / Point Spread", "Betting", "gambling-point-spread"],
        ["FANTASY", "Fantasy Sports", "Fantasy Sports", "fantasy-sports"],
        ["POKER", "Poker", "Poker", "poker"],
      ]) {
        await db.$executeRawUnsafe(
          `INSERT INTO "League" ("id","name","sport","slug","isActive") VALUES ($1,$2,$3,$4,true) ON CONFLICT DO NOTHING`,
          id, name, sport, slug
        );
      }
    } finally { await db.$disconnect(); }
  }

  /** A fingerprint of everything that matters: schema + history + row counts. */
  async function fingerprint(dbName: string): Promise<string> {
    const db = client(dbName);
    try {
      const cols = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema='public' ORDER BY table_name, column_name`
      );
      let history: unknown[] = [];
      try {
        history = await db.$queryRawUnsafe(`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`);
      } catch { /* no history table */ }
      let topics: unknown[] = [];
      try { topics = await db.$queryRawUnsafe(`SELECT id, "status"::text AS status FROM "TopicCandidate" ORDER BY id`); } catch { /* none */ }
      const material = JSON.stringify({ cols, history, topics }, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      return crypto.createHash("sha256").update(material).digest("hex");
    } finally {
      await db.$disconnect();
    }
  }

  try {
    // =================================================================
    // Scenario A — properly migrated
    // =================================================================
    await pg.createDatabase("proper");
    sh("proper", "npx prisma migrate deploy");
    const a = audit("proper");
    check("Scenario A: a properly migrated database is READY FOR MIGRATE DEPLOY", () => {
      assert(/READY FOR MIGRATE DEPLOY/.test(a.out), `verdict was:\n${a.out.slice(-600)}`);
      assert(a.code === 0, `expected exit 0, got ${a.code}`);
      assert(/_prisma_migrations \.+ present/.test(a.out), "history should be reported present");
      assert(/drift vs schema.prisma none/.test(a.out), "there should be no drift");
    });

    // =================================================================
    // The auditor must not touch anything.
    // =================================================================
    const before = await fingerprint("proper");
    audit("proper");
    audit("proper");
    const after = await fingerprint("proper");
    check("CORE: repeated audits mutate NOTHING (schema, history and rows identical)", () => {
      assert(before === after, "the auditor changed the database");
    });

    check("CORE: the auditor never prints the DATABASE_URL, credentials or a password", () => {
      assert(!a.out.includes("postgres:postgres"), "credentials leaked into the output");
      assert(!/postgresql:\/\/[^\s]*:[^\s]*@/.test(a.out), "a full connection URL leaked into the output");
      // Host/port/database are operationally necessary and are not secrets.
      assert(/Target: localhost:\d+\/proper/.test(a.out), "the sanitized target should still be shown");
    });

    check("the auditor has no write path in its source", () => {
      const src = fs.readFileSync(path.join(process.cwd(), "src/scripts/auditMigrationAdoption.ts"), "utf8");
      // It may PRINT these strings in a plan; it must never EXECUTE them.
      assert(!/execSync\([^)]*migrate resolve/.test(src), "the auditor must never execute migrate resolve");
      assert(!/execSync\([^)]*migrate deploy/.test(src), "the auditor must never execute migrate deploy");
      assert(!/execSync\([^)]*db push/.test(src), "the auditor must never execute db push");
      assert(!/\$executeRaw/.test(src), "the auditor must never execute a write query");
      assert(!/\.(update|create|delete|upsert)\(/.test(src), "the auditor must never write through the client");
    });

    // =================================================================
    // Scenario B — matches the baseline, no history
    // =================================================================
    await pg.createDatabase("baseline_only");
    // `prisma db execute --file`, not $executeRawUnsafe: the baseline is many
    // statements and a prepared statement can only carry one.
    sh("baseline_only", `npx prisma db execute --file prisma/migrations/20260704000000_baseline/migration.sql --schema prisma/schema.prisma`);
    const b = audit("baseline_only");
    check("Scenario B: a baseline-shaped database with no history proposes a plan", () => {
      assert(/ADOPTION POSSIBLE/.test(b.out), `verdict was:\n${b.out.slice(-900)}`);
      assert(/matches .+ BASELINE/.test(b.out), "it should recognise the baseline checkpoint");
      assert(/PROPOSED ONLY -- NOT EXECUTED/.test(b.out), "the plan must be labelled as proposed");
      assert(/migrate resolve --applied 20260704000000_baseline/.test(b.out), "it should propose resolving ONLY the baseline");
      assert(/migrations that must genuinely run: all of them after the baseline/i.test(b.out), "later migrations must actually run here");
    });
    check("Scenario B: the plan demands a backup, maintenance mode and paused workers", () => {
      assert(/backup/i.test(b.out) && /VERIFY it restores/i.test(b.out), "a verified backup must be required");
      assert(/maintenance mode/i.test(b.out), "maintenance mode must be required");
      assert(/Pause the queue workers/i.test(b.out), "workers must be paused");
      assert(/single migration owner/i.test(b.out), "the single migration owner must be named");
    });

    // =================================================================
    // Scenario C — current schema, no history, invariants PASS
    // =================================================================
    await pg.createDatabase("pushed_clean");
    sh("pushed_clean", "npx prisma db push --skip-generate --accept-data-loss");
    // A REAL db-push production database has the seed rows — the app put them
    // there. A bare `db push` does not, and the auditor correctly refuses that
    // (the seeding migrations' INSERTs never ran), which is the behaviour the
    // dirty case below relies on. Seed them so this fixture represents an
    // actual production-shaped database rather than an empty shell.
    await seedLeagues("pushed_clean");
    const c = audit("pushed_clean");
    check("Scenario C: a db-push database matching the current schema with clean data is adoptable", () => {
      assert(/ADOPTION POSSIBLE/.test(c.out), `verdict was:\n${c.out.slice(-900)}`);
      assert(/_prisma_migrations \.+ ABSENT/.test(c.out), "it should notice the missing history");
      assert(/drift vs schema.prisma none/.test(c.out), "a db push database should match the current schema");
      assert(/Migrations that must genuinely run: none/.test(c.out), "everything is already present here");
      assert(/verified present by schema AND invariant, not assumed/.test(c.out), "it must say why marking applied is justified");
    });

    // =================================================================
    // Scenario C' — current schema, no history, invariants FAIL
    // =================================================================
    await pg.createDatabase("pushed_dirty");
    sh("pushed_dirty", "npx prisma db push --skip-generate --accept-data-loss");
    // Same production-shaped starting point as pushed_clean — so the ONLY thing
    // that differs is the legacy row. That isolation is the point: it proves the
    // block comes from the data, not from an incidental gap in the fixture.
    await seedLeagues("pushed_dirty");
    // Reproduce the state 20260714120000's BACKFILL exists to fix, in the only
    // way a current-schema database can actually hold it: an EpisodeTopic with
    // no snapshot. (A legacy 'used' status is unrepresentable here — the column
    // is already the enum — and forcing it by adding an enum value would be
    // schema drift, which the auditor routes to manual review instead. Snapshot
    // is nullable, so this is the genuine "schema matches, backfill never ran"
    // shape.)
    const dirty = client("pushed_dirty");
    await dirty.$executeRawUnsafe(`
      INSERT INTO "TopicCandidate" ("id","title","sport","controversyScore","starPowerScore","bettingRelevanceScore","recencyScore","debateScore","evidenceIds","status","createdAt")
      VALUES ('legacy-1','Legacy topic','NFL',1,1,1,1,50,'[]'::jsonb,'approved',CURRENT_TIMESTAMP)`);
    await dirty.$executeRawUnsafe(`
      INSERT INTO "Episode" ("id","title","slug","status","explicit","audioMimeType","createdAt","updatedAt")
      VALUES ('legacy-ep','Legacy episode','legacy-ep','draft',false,'audio/mpeg',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`);
    await dirty.$executeRawUnsafe(`
      INSERT INTO "EpisodeTopic" ("id","episodeId","topicId","orderIndex","snapshot","selectedAt")
      VALUES ('legacy-et','legacy-ep','legacy-1',0,NULL,CURRENT_TIMESTAMP)`);
    await dirty.$disconnect();
    const cDirty = audit("pushed_dirty");
    check("CORE: Scenario C with a FAILING data invariant is ADOPTION BLOCKED", () => {
      // The whole point: the schema matches PERFECTLY, so a schema-only check
      // would wave this through and freeze the un-backfilled rows as "migrated".
      assert(/drift vs schema.prisma none/.test(cDirty.out), "the schema DOES match — that is exactly the trap");
      assert(/ADOPTION BLOCKED/.test(cDirty.out), `verdict was:\n${cDirty.out.slice(-900)}`);
      assert(/snapshots_backfilled/.test(cDirty.out), "it must name the failing invariant");
      assert(/FAIL\] snapshots_backfilled/.test(cDirty.out), `the invariant should be marked FAIL:\n${cDirty.out.slice(-900)}`);
      assert(!/migrate resolve --applied 20260714120000/.test(cDirty.out), "it must NOT propose marking the data migration applied");
      assert(cDirty.code === 2, `an unsafe verdict should exit non-zero, got ${cDirty.code}`);
    });

    check("Scenario C-dirty: no plan is offered at all", () => {
      assert(/NO PLAN OFFERED/.test(cDirty.out), "a blocked database must get no commands");
      assert(/Do NOT run `migrate resolve` to make the error go away/.test(cDirty.out), "it must warn against silencing the error");
    });

    // =================================================================
    // Scenario D — partial history
    // =================================================================
    await pg.createDatabase("partial");
    sh("partial", "npx prisma migrate deploy");
    const pdb = client("partial");
    // Forget the last few records: history now disagrees with the schema.
    await pdb.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE migration_name IN ('20260715160000_add_topic_source','20260715170000_reconcile_aihost_owner')`);
    await pdb.$disconnect();
    const d = audit("partial");
    check("Scenario D: partial history is reported precisely", () => {
      assert(/missing records \.+ 2/.test(d.out), `expected 2 missing records:\n${d.out.slice(-700)}`);
      // Schema still matches (the tables are there), invariants pass, so this is
      // adoptable — but only because both were actually checked.
      assert(/ADOPTION POSSIBLE|ADOPTION BLOCKED/.test(d.out), "it must reach a definite verdict");
    });

    // =================================================================
    // Scenario E — drift / unknown schema
    // =================================================================
    await pg.createDatabase("drifted");
    sh("drifted", "npx prisma migrate deploy");
    const xdb = client("drifted");
    await xdb.$executeRawUnsafe(`DROP TABLE "TopicSource" CASCADE`);
    await xdb.$executeRawUnsafe(`CREATE TABLE "MysteryTable" ("id" TEXT PRIMARY KEY)`);
    await xdb.$disconnect();
    const e = audit("drifted");
    check("Scenario E: an unknown/drifted schema requires MANUAL DATABASE REVIEW", () => {
      assert(/MANUAL DATABASE REVIEW REQUIRED/.test(e.out), `verdict was:\n${e.out.slice(-900)}`);
      assert(/drift vs schema.prisma YES/.test(e.out), "drift must be reported");
      assert(/NO PLAN OFFERED/.test(e.out), "no commands may be proposed for an unknown schema");
      assert(e.code === 2, `expected a non-zero exit, got ${e.code}`);
    });

    // =================================================================
    // Failed migration record
    // =================================================================
    await pg.createDatabase("failedrec");
    sh("failedrec", "npx prisma migrate deploy");
    const fdb = client("failedrec");
    await fdb.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name = '20260714120000_topic_lifecycle_and_snapshots'`);
    await fdb.$disconnect();
    const f = audit("failedrec");
    check("CORE: a FAILED migration record forces manual review, never a resolve", () => {
      assert(/MANUAL DATABASE REVIEW REQUIRED/.test(f.out), `verdict was:\n${f.out.slice(-700)}`);
      assert(/recorded as FAILED/.test(f.out), "it must explain what a failed record means");
      assert(/Resolve the underlying failure, never the record/.test(f.out), "it must refuse to paper over the record");
      assert(/NO PLAN OFFERED/.test(f.out), "no plan for a failed migration");
    });

    // =================================================================
    // Empty database
    // =================================================================
    await pg.createDatabase("empty");
    const em = audit("empty");
    check("an empty database is simply READY FOR MIGRATE DEPLOY", () => {
      assert(/READY FOR MIGRATE DEPLOY/.test(em.out), `verdict was:\n${em.out.slice(-500)}`);
      assert(/tables \.+ 0/.test(em.out), "it should report an empty database");
    });

    // =================================================================
    // Invariant detail on a real migrated database
    // =================================================================
    const proper = audit("proper");
    check("invariants report the data facts a schema check cannot see", () => {
      for (const inv of ["no_legacy_used_status", "selectedAt_backfilled", "snapshots_backfilled", "leagues_seeded", "admin_draft_present", "topic_source_present", "aihost_owner_fk"]) {
        assert(proper.out.includes(inv), `invariant ${inv} was not reported`);
      }
      assert(/migration\(s\) carry data effects a matching schema does NOT prove/.test(proper.out), "it must name the data-bearing migrations");
    });

    // The dirty database must be untouched by having been audited.
    const dirtyBefore = await fingerprint("pushed_dirty");
    audit("pushed_dirty");
    const dirtyAfter = await fingerprint("pushed_dirty");
    check("CORE: auditing a BLOCKED database does not 'helpfully' repair it", () => {
      assert(dirtyBefore === dirtyAfter, "the auditor modified a database it had just declared unsafe");
    });
  } finally {
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
