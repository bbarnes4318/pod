// REAL Postgres concurrency test (item 4). Run: npm run test:topic-concurrency
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: the raw pg
   client and its rows are dynamically typed. */
//
// Two simultaneous "creation attempts" race to use the SAME (podcast, topic)
// under exclude_podcast. Each runs the PRODUCTION advisory-lock helper
// (reserveRecentlyUsedTopics) inside its own transaction, then inserts an
// Episode + EpisodeTopic only if the topic isn't already used. The advisory
// lock must serialize them so AT MOST ONE succeeds. A separate case proves two
// DIFFERENT podcasts never block each other.

import path from "path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");
import { reserveRecentlyUsedTopics } from "../lib/services/topicReservation";
import { stopEmbeddedPgScoped } from "../../tests/e2e/runtime";

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function ok(name: string) { passed++; console.log(`  ✓ ${name}`); }
function bad(name: string, e: unknown) { failed++; console.error(`  ✗ ${name}\n      ${(e as Error)?.message || e}`); }
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const SCHEMA = `
CREATE TABLE "Episode" ( "id" text PRIMARY KEY, "podcastId" text, "createdAt" timestamptz NOT NULL DEFAULT now() );
CREATE TABLE "EpisodeTopic" (
  "id" text PRIMARY KEY, "episodeId" text NOT NULL, "topicId" text NOT NULL,
  "orderIndex" int NOT NULL, "selectedAt" timestamptz NOT NULL DEFAULT now()
);
`;

/** Wrap a node-postgres client as the tiny AdvisoryLockTx the helper needs. */
function txAdapter(client: any) {
  return {
    $queryRawUnsafe: async <T = unknown>(sql: string, ...values: unknown[]): Promise<T> => {
      const res = await client.query(sql, values);
      return res.rows as unknown as T;
    },
  };
}

/** One creation attempt: reserve under advisory lock, then insert IFF free. */
async function attempt(
  client: any,
  o: { podcastId: string; topicId: string; label: string; widenMs?: number }
): Promise<{ label: string; success: boolean; reason?: string }> {
  await client.query("BEGIN");
  try {
    const blocked = await reserveRecentlyUsedTopics(txAdapter(client), {
      podcastId: o.podcastId,
      topicIds: [o.topicId],
      cooldownDays: 7,
    });
    if (blocked.has(o.topicId)) {
      await client.query("ROLLBACK");
      return { label: o.label, success: false, reason: "recently_used" };
    }
    // Widen the critical section so the sibling attempt is genuinely blocked on
    // the advisory lock, not merely sequenced by luck.
    if (o.widenMs) await delay(o.widenMs);
    const epId = `ep-${o.label}`;
    await client.query(`INSERT INTO "Episode"("id","podcastId") VALUES ($1,$2)`, [epId, o.podcastId]);
    await client.query(
      `INSERT INTO "EpisodeTopic"("id","episodeId","topicId","orderIndex") VALUES ($1,$2,$3,0)`,
      [`et-${o.label}`, epId, o.topicId]
    );
    await client.query("COMMIT");
    return { label: o.label, success: true };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { label: o.label, success: false, reason: (e as Error).message };
  }
}

async function main() {
  const dir = path.join(process.env.TEMP || "/tmp", `pgconc-${Date.now()}`);
  const port = Number(process.env.PG_TEST_PORT) || 55442;
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("conc");

  const setup = pg.getPgClient("conc"); await setup.connect();
  const a = pg.getPgClient("conc"); await a.connect();
  const b = pg.getPgClient("conc"); await b.connect();

  console.log("Topic reuse concurrency (real Postgres advisory locks):");
  try {
    await setup.query(SCHEMA);

    // ---- Same podcast + topic: at most one succeeds ----
    try {
      const [ra, rb] = await Promise.all([
        attempt(a, { podcastId: "pod-1", topicId: "topic-1", label: "A", widenMs: 200 }),
        attempt(b, { podcastId: "pod-1", topicId: "topic-1", label: "B", widenMs: 200 }),
      ]);
      const successes = [ra, rb].filter((r) => r.success).length;
      const uses = await setup.query(
        `SELECT count(*)::int AS n FROM "EpisodeTopic" et JOIN "Episode" e ON e.id=et."episodeId" WHERE e."podcastId"='pod-1' AND et."topicId"='topic-1'`
      );
      assert(successes === 1, `exactly one attempt should succeed, got ${successes} (${JSON.stringify([ra, rb])})`);
      assert(uses.rows[0].n === 1, `exactly one EpisodeTopic use committed, got ${uses.rows[0].n}`);
      ok("two concurrent builds for the same podcast+topic → exactly one succeeds");
    } catch (e) { bad("two concurrent builds for the same podcast+topic → exactly one succeeds", e); }

    // ---- Different podcasts: no blocking, both succeed ----
    try {
      const [ra, rb] = await Promise.all([
        attempt(a, { podcastId: "pod-X", topicId: "topic-2", label: "X", widenMs: 150 }),
        attempt(b, { podcastId: "pod-Y", topicId: "topic-2", label: "Y", widenMs: 150 }),
      ]);
      assert(ra.success && rb.success, `both different-podcast attempts should succeed (${JSON.stringify([ra, rb])})`);
      const uses = await setup.query(`SELECT count(*)::int AS n FROM "EpisodeTopic" WHERE "topicId"='topic-2'`);
      assert(uses.rows[0].n === 2, `both podcasts recorded a use, got ${uses.rows[0].n}`);
      ok("different podcasts do NOT block each other (same topic)");
    } catch (e) { bad("different podcasts do NOT block each other (same topic)", e); }
  } finally {
    await a.end().catch(() => {});
    await b.end().catch(() => {});
    await setup.end().catch(() => {});
    // Scoped stop: this instance only, reaping its own leftover child processes
    // (PG18 io_workers can outlive the shutdown on Windows). A failed cleanup
    // must not fail the test — the assertions above are what matter.
    await stopEmbeddedPgScoped(pg, dir).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
