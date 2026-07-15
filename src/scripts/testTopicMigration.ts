// REAL Postgres migration test. Run: npm run test:topic-migration
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: raw pg
   client rows and seed helpers are dynamically typed. */
//
// Boots a throwaway embedded Postgres, builds the PRE-migration schema, seeds
// representative rows (including a legacy "used" topic and an episode created
// long ago), applies the ACTUAL migration SQL, and asserts the safety
// properties: rows preserved, used->approved, enum enforced, selectedAt
// approximates Episode.createdAt (not migration time), snapshots populated, and
// a safe re-run does not clobber snapshots. Also proves unexpected status
// values abort the migration with a clear error.

import fs from "fs";
import path from "path";
// embedded-postgres is CJS-only; ESM import fails at runtime, so require() here.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");

const MIGRATION = path.join(
  process.cwd(),
  "prisma/migrations/20260714120000_topic_lifecycle_and_snapshots/migration.sql"
);

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function ok(name: string) { passed++; console.log(`  ✓ ${name}`); }
function bad(name: string, e: any) { failed++; console.error(`  ✗ ${name}\n      ${e?.message || e}`); }

const PRE_SCHEMA = `
CREATE TABLE "TopicCandidate" (
  "id" text PRIMARY KEY, "title" text NOT NULL, "sport" text NOT NULL,
  "leagueId" text, "summary" text, "debateScore" double precision NOT NULL DEFAULT 0,
  "evidenceIds" jsonb NOT NULL DEFAULT '[]', "status" text NOT NULL,
  "createdAt" timestamp(3) NOT NULL DEFAULT now()
);
CREATE TABLE "ResearchBrief" (
  "id" text PRIMARY KEY, "topicId" text UNIQUE NOT NULL, "facts" jsonb NOT NULL DEFAULT '[]',
  "stats" jsonb NOT NULL DEFAULT '[]', "sourceIds" jsonb NOT NULL DEFAULT '[]',
  "argumentForHostA" text NOT NULL DEFAULT '', "argumentForHostB" text NOT NULL DEFAULT '',
  "counterArguments" jsonb, "unsafeClaims" jsonb, "mainAngle" text, "contrarianAngle" text,
  "whyMattersNow" text, "keyFactsContext" jsonb, "onAirTalkingPoints" jsonb,
  "strongestDebateQuestion" text, "suggestedHostTake" text, "injuryContext" text, "oddsContext" text
);
CREATE TABLE "Episode" ( "id" text PRIMARY KEY, "createdAt" timestamp(3) NOT NULL DEFAULT now() );
CREATE TABLE "EpisodeTopic" (
  "id" text PRIMARY KEY, "episodeId" text NOT NULL, "topicId" text NOT NULL, "orderIndex" int NOT NULL
);
`;

const EPISODE_CREATED = "2026-01-15 12:00:00";

async function seed(client: any) {
  await client.query(PRE_SCHEMA);
  await client.query(
    `INSERT INTO "TopicCandidate"("id","title","sport","leagueId","summary","debateScore","evidenceIds","status","createdAt")
     VALUES ('t-used','Used Topic','NFL','NFL','summary',90,'[{"type":"news","id":"n1"}]','used','2026-01-10 00:00:00'),
            ('t-appr','Approved Topic','NBA','NBA','summary2',80,'[]','approved','2026-01-12 00:00:00')`
  );
  await client.query(
    `INSERT INTO "ResearchBrief"("id","topicId","facts","sourceIds","stats","argumentForHostA","argumentForHostB","mainAngle","contrarianAngle","onAirTalkingPoints")
     VALUES ('rb1','t-used','[{"text":"fact"}]','[{"type":"news","id":"n1"}]','[]','A','B','angle','contra','["p1"]')`
  );
  await client.query(`INSERT INTO "Episode"("id","createdAt") VALUES ('e1','${EPISODE_CREATED}')`);
  await client.query(`INSERT INTO "EpisodeTopic"("id","episodeId","topicId","orderIndex") VALUES ('et1','e1','t-used',0)`);
}

async function main() {
  const dir = path.join(process.env.TEMP || "/tmp", `pgmig-${Date.now()}`);
  const port = Number(process.env.PG_TEST_PORT) || 55441;
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("mig");
  const client = pg.getPgClient("mig");
  await client.connect();

  const migrationSql = fs.readFileSync(MIGRATION, "utf8");

  console.log("Topic lifecycle migration (real Postgres):");
  try {
    // ---- Scenario 1: unexpected status aborts with a clear error ----
    try {
      await seed(client);
      await client.query(`UPDATE "TopicCandidate" SET "status"='weird_value' WHERE "id"='t-appr'`);
      let threw = false;
      try { await client.query(migrationSql); } catch (e: any) { threw = /unexpected value/i.test(e.message); }
      assert(threw, "migration must abort on an unexpected status value");
      ok("unexpected status value aborts migration with a clear error");
    } catch (e) { bad("unexpected status value aborts migration with a clear error", e); }

    // Reset the database for the happy path.
    await client.query(`DROP TABLE IF EXISTS "EpisodeTopic","Episode","ResearchBrief","TopicCandidate" CASCADE; DROP TYPE IF EXISTS "TopicEditorialStatus"`);

    // ---- Scenario 2: happy-path migration ----
    await seed(client);
    await client.query(migrationSql);

    try {
      const cnt = await client.query(`SELECT count(*)::int AS n FROM "TopicCandidate"`);
      const etCnt = await client.query(`SELECT count(*)::int AS n FROM "EpisodeTopic"`);
      assert(cnt.rows[0].n === 2 && etCnt.rows[0].n === 1, "no rows deleted");
      ok("rows preserved (no deletes)");
    } catch (e) { bad("rows preserved (no deletes)", e); }

    try {
      const r = await client.query(`SELECT "status"::text AS s FROM "TopicCandidate" WHERE "id"='t-used'`);
      assert(r.rows[0].s === "approved", `used->approved, got ${r.rows[0].s}`);
      ok("legacy 'used' converted to 'approved'");
    } catch (e) { bad("legacy 'used' converted to 'approved'", e); }

    try {
      // Enum now enforced — writing 'used' or garbage must fail.
      let usedFailed = false, garbageFailed = false;
      try { await client.query(`INSERT INTO "TopicCandidate"("id","title","sport","evidenceIds","status") VALUES ('x1','t','NFL','[]','used')`); }
      catch { usedFailed = true; }
      try { await client.query(`INSERT INTO "TopicCandidate"("id","title","sport","evidenceIds","status") VALUES ('x2','t','NFL','[]','nonsense')`); }
      catch { garbageFailed = true; }
      assert(usedFailed && garbageFailed, "enum must reject 'used' and arbitrary values");
      ok("Prisma-level enum rejects 'used' and arbitrary status values");
    } catch (e) { bad("Prisma-level enum rejects 'used' and arbitrary status values", e); }

    try {
      const r = await client.query(`SELECT "selectedAt" FROM "EpisodeTopic" WHERE "id"='et1'`);
      const sel = new Date(r.rows[0].selectedAt).getTime();
      const epoch = new Date(EPISODE_CREATED + "Z").getTime();
      const now = Date.now();
      // selectedAt should approximate the Episode.createdAt (Jan 2026), NOT ~now.
      assert(Math.abs(sel - epoch) < 1000 * 60 * 60 * 24, `selectedAt ~= Episode.createdAt (got ${r.rows[0].selectedAt})`);
      assert(now - sel > 1000 * 60 * 60 * 24 * 30, "selectedAt is historical, not migration time");
      ok("selectedAt backfilled from Episode.createdAt (not migration time)");
    } catch (e) { bad("selectedAt backfilled from Episode.createdAt (not migration time)", e); }

    let firstSnapshot: string | null = null;
    try {
      const r = await client.query(`SELECT "snapshot" FROM "EpisodeTopic" WHERE "id"='et1'`);
      const snap = r.rows[0].snapshot;
      firstSnapshot = JSON.stringify(snap);
      assert(snap && snap.title === "Used Topic" && snap.version === 1 && snap.source === "backfill", "snapshot populated");
      assert(Array.isArray(snap.facts) && snap.facts.length === 1, "snapshot carries brief facts");
      assert(typeof snap.selectionTimestamp === "string" && snap.selectionTimestamp.startsWith("2026-01-15"), "snapshot selectionTimestamp = corrected selectedAt");
      assert(snap.fingerprintAlgo === "md5" && /^[a-f0-9]{32}$/.test(snap.evidenceFingerprint), "legacy md5 fingerprint");
      ok("snapshot backfilled from live data + corrected timestamp");
    } catch (e) { bad("snapshot backfilled from live data + corrected timestamp", e); }

    try {
      // Re-run the safe statements: snapshot must NOT be clobbered.
      await client.query(migrationSql);
      const r = await client.query(`SELECT "snapshot" FROM "EpisodeTopic" WHERE "id"='et1'`);
      assert(JSON.stringify(r.rows[0].snapshot) === firstSnapshot, "re-run must not clobber the snapshot");
      ok("re-running the migration is safe (snapshot not clobbered)");
    } catch (e) { bad("re-running the migration is safe (snapshot not clobbered)", e); }
  } finally {
    await client.end().catch(() => {});
    await pg.stop().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  // Embedded Postgres can leave a handle open; exit explicitly.
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
