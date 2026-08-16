// A status field that lies about work in progress is worse than no status.
//
//   npm run test:joblog-reconciliation
//
// NETWORK-FREE.
//
// WHY IT EXISTS. On 2026-08-16 the admin job table showed jobs "Running
// 44780s" -- 12.4 hours -- while BullMQ's active list held ZERO jobs. 72 rows
// were stranded in "running", the oldest created 2026-07-09. The operator spent
// an afternoon believing the app was grinding through their provider quota all
// day. Nothing was running. Every one of those rows belonged to a worker that
// had been killed mid-job by a deploy and never got to write its own ending.
//
// The risk in fixing it is the mirror image: closing a row that IS running
// tells someone their live job died. So the tests below spend most of their
// effort on what must NOT be touched.

import assert from "node:assert/strict";
import {
  classifyRow,
  DEFAULT_STALE_AFTER_MS,
  ORPHAN_ERROR_PREFIX,
  orphanMessage,
  reconcileOrphanedJobLogsOnBoot,
  selectOrphans,
  type ReconcilableRow,
} from "../lib/services/jobLogReconciliation";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

const NOW = new Date("2026-08-16T15:00:00.000Z");
const BOOT = new Date("2026-08-16T14:15:35.000Z");
const at = (iso: string): Date => new Date(iso);
const row = (id: string, createdAt: string, updatedAt?: string): ReconcilableRow => ({
  id,
  jobType: "generate:script",
  createdAt: at(createdAt),
  updatedAt: updatedAt ? at(updatedAt) : null,
});

function fakeDb(rows: ReconcilableRow[]) {
  const updates: Array<{ id: string; data: any }> = [];
  return {
    updates,
    jobLog: {
      findMany: async ({ where }: any) => {
        assert.equal(where.status, "running", "only running rows may be considered");
        return rows;
      },
      update: async ({ where, data }: any) => {
        updates.push({ id: where.id, data });
        return {};
      },
    },
  };
}

async function main() {
  console.log("\nJob-log reconciliation — closing rows a dead worker left open\n");

  console.log("  -- the rows that must be closed --");

  await check("the exact 12-hour row from the incident is an orphan", () => {
    // "Running 44780s" as of the incident: created 05:44, worker booted 14:15.
    const r = row("incident", "2026-08-16T05:44:04.000Z");
    assert.equal(classifyRow(r, { processStartedAt: BOOT, now: NOW }).keptBecause, undefined);
  });

  await check("a five-week-old row is an orphan", () => {
    const r = row("july", "2026-07-09T05:41:46.000Z");
    assert.equal(classifyRow(r, { processStartedAt: BOOT, now: NOW }).keptBecause, undefined);
  });

  console.log("\n  -- the rows that must NOT be touched --");

  await check("a job this process started is never closed, however long it runs", () => {
    // The single most damaging false positive: a real, live, slow job.
    const r = row("live", "2026-08-16T14:20:00.000Z");
    assert.equal(
      classifyRow(r, { processStartedAt: BOOT, now: NOW }).keptBecause,
      "started-after-this-process"
    );
  });

  await check("a job from ANOTHER worker, still inside the stale window, is left alone", () => {
    // Predates our boot, so condition (1) alone would close it. This is exactly
    // the case a second worker container produces, and the reason there are two
    // conditions rather than one.
    const r = row("other-worker", "2026-08-16T14:10:00.000Z");
    assert.equal(
      classifyRow(r, { processStartedAt: BOOT, now: NOW }).keptBecause,
      "still-within-stale-window"
    );
  });

  await check("the longest real job ever observed (~33 min) is nowhere near the threshold", () => {
    // The slowest generate:script on record took 1960s. If the threshold ever
    // drops below that, this pipeline starts killing its own healthy jobs.
    assert.ok(
      DEFAULT_STALE_AFTER_MS > 1960 * 1000 * 3,
      `threshold ${DEFAULT_STALE_AFTER_MS}ms leaves too little room above the 1960s worst case`
    );
  });

  await check("a row that keeps updating is judged on its last update, not its start", () => {
    // A long job that reports progress is alive. Judging it by createdAt alone
    // would close it purely for being long-running.
    const r = row("progressing", "2026-08-16T05:00:00.000Z", "2026-08-16T14:50:00.000Z");
    assert.equal(
      classifyRow(r, { processStartedAt: BOOT, now: NOW }).keptBecause,
      "started-after-this-process"
    );
  });

  console.log("\n  -- what the operator is told --");

  await check("the message says a restart orphaned it, not that the job failed", () => {
    const msg = orphanMessage(row("x", "2026-08-16T05:44:04.000Z"), NOW);
    assert.ok(msg.startsWith(ORPHAN_ERROR_PREFIX), msg);
    assert.match(msg, /did not fail on its own/i, "an orphan must be distinguishable from a real failure");
    assert.match(msg, /\d+ minute/, "it must state how long the row had been lying");
  });

  console.log("\n  -- the boot pass --");

  await check("only orphans are written, and each exactly once", async () => {
    const rows = [
      row("orphan-1", "2026-08-16T05:44:04.000Z"),
      row("orphan-2", "2026-07-09T05:41:46.000Z"),
      row("live", "2026-08-16T14:20:00.000Z"),
      row("other-worker", "2026-08-16T14:10:00.000Z"),
    ];
    const db = fakeDb(rows);
    const closed = await reconcileOrphanedJobLogsOnBoot({ db, processStartedAt: BOOT, now: NOW });
    assert.equal(closed, 2, "exactly the two orphans");
    assert.deepEqual(db.updates.map((u) => u.id).sort(), ["orphan-1", "orphan-2"]);
    assert.ok(db.updates.every((u) => u.data.status === "failed"));
  });

  await check("a clean database writes nothing at all", async () => {
    const db = fakeDb([row("live", "2026-08-16T14:20:00.000Z")]);
    assert.equal(await reconcileOrphanedJobLogsOnBoot({ db, processStartedAt: BOOT, now: NOW }), 0);
    assert.equal(db.updates.length, 0, "a no-op boot must not touch a single row");
  });

  await check("a database error cannot stop the worker from booting", async () => {
    // This runs on the boot path. Bookkeeping repair failing must never keep
    // the worker from picking up real jobs.
    const db = { jobLog: { findMany: async () => { throw new Error("connection refused"); } } };
    const logged: string[] = [];
    const closed = await reconcileOrphanedJobLogsOnBoot({
      db, processStartedAt: BOOT, now: NOW, log: (m) => logged.push(m),
    });
    assert.equal(closed, 0);
    assert.ok(logged.some((l) => /connection refused/.test(l)), "the failure must still be visible");
  });

  await check("selectOrphans preserves order, so the oldest is reported first", () => {
    const rows = [row("a", "2026-07-09T05:41:46.000Z"), row("b", "2026-08-16T05:44:04.000Z")];
    assert.deepEqual(selectOrphans(rows, { processStartedAt: BOOT, now: NOW }).map((r) => r.id), ["a", "b"]);
  });

  console.log(failed === 0 ? "\nAll job-log reconciliation checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
