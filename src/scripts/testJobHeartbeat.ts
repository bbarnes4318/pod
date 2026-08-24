// "Running 4096s" has to mean something.
//
//   npm run test:job-heartbeat
//
// NETWORK-FREE.
//
// WHY IT EXISTS. A JobLog row spoke exactly twice — once when the job started
// and once when it ended — and /admin/job-logs rendered the silence in between
// as a counter climbing without limit. The same "Running 4096s" was produced by
// a job doing 68 minutes of real work and by a job that died an hour ago, and
// the operator had no way to tell those apart. jobLogReconciliation.ts already
// read `updatedAt` as "when it last showed signs of life"; nothing ever wrote
// one. This is that writer, plus the reader the admin table uses.

import assert from "node:assert/strict";
import {
  JOB_HEARTBEAT_INTERVAL_MS,
  JOB_HEARTBEAT_STALE_AFTER_MS,
  heartbeatState,
  startJobLogHeartbeat,
} from "../lib/queue/jobHeartbeat";

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

interface JobLogWrite {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
}

function fakeDb(opts: { throwOnWrite?: boolean } = {}) {
  const writes: JobLogWrite[] = [];
  return {
    writes,
    jobLog: {
      async updateMany(args: JobLogWrite) {
        if (opts.throwOnWrite) throw new Error("connection terminated unexpectedly");
        writes.push(args);
        return { count: 1 };
      },
      async update(args: JobLogWrite) {
        writes.push(args);
        return {};
      },
    },
  };
}

/** A controllable stand-in for setInterval. */
function fakeTimer() {
  let fn: (() => void) | null = null;
  let cleared = false;
  return {
    get cleared() {
      return cleared;
    },
    tick() {
      fn?.();
    },
    setIntervalFn: ((cb: () => void) => {
      fn = cb;
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {
      cleared = true;
    }) as unknown as typeof clearInterval,
  };
}

const at = (iso: string) => new Date(iso);

async function main() {
  console.log("\nJob log heartbeat\n");

  console.log("  -- writing the beat --");

  await check("a running job touches its own row", async () => {
    const db = fakeDb();
    const timer = fakeTimer();
    const hb = startJobLogHeartbeat({
      db,
      jobLogId: "log-1",
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });
    timer.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(db.writes.length, 1, "a tick must write");
    assert.equal(db.writes[0].where.id, "log-1");
    hb.stop();
  });

  await check("the beat never resurrects a row that already ended", async () => {
    // A job that completed a millisecond before the last tick must not be
    // dragged back to "running" by its own heartbeat.
    const db = fakeDb();
    const timer = fakeTimer();
    const hb = startJobLogHeartbeat({
      db,
      jobLogId: "log-1",
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });
    timer.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(db.writes[0].where.status, "running", "the write must be filtered to running rows only");
    hb.stop();
  });

  await check("a failed heartbeat never kills the job", async () => {
    const db = fakeDb({ throwOnWrite: true });
    const timer = fakeTimer();
    const logs: string[] = [];
    const hb = startJobLogHeartbeat({
      db,
      jobLogId: "log-1",
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      log: (m) => logs.push(m),
    });
    timer.tick();
    await new Promise((r) => setImmediate(r));
    assert.equal(logs.length, 1, "the failure is logged");
    assert.match(logs[0], /log-1/);
    hb.stop();
  });

  await check("stop() is idempotent and actually stops the timer", async () => {
    const db = fakeDb();
    const timer = fakeTimer();
    const hb = startJobLogHeartbeat({
      db,
      jobLogId: "log-1",
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
    });
    hb.stop();
    hb.stop();
    assert.equal(timer.cleared, true);
  });

  console.log("\n  -- reading the beat --");

  const NOW = at("2026-08-24T12:00:00.000Z");

  await check("a job beating right now reads as alive", () => {
    const state = heartbeatState(
      { createdAt: at("2026-08-24T10:52:00.000Z"), updatedAt: at("2026-08-24T11:59:45.000Z") },
      NOW
    );
    assert.equal(state.kind, "alive", "4080 seconds of real work is still work");
    assert.equal(state.sinceMs, 15_000);
  });

  await check("a job that went quiet an hour ago reads as stale", () => {
    const state = heartbeatState(
      { createdAt: at("2026-08-24T10:52:00.000Z"), updatedAt: at("2026-08-24T11:00:00.000Z") },
      NOW
    );
    assert.equal(state.kind, "stale", "this row is wreckage, and the table must say so");
  });

  await check("a brand new row is not accused of being dead", () => {
    // The first heartbeat lands one interval in; a row younger than the stale
    // window has simply not had the chance to beat yet.
    const state = heartbeatState({ createdAt: at("2026-08-24T11:59:50.000Z"), updatedAt: null }, NOW);
    assert.equal(state.kind, "alive");
  });

  await check("a row from before heartbeats existed is 'unknown', not 'stale'", () => {
    // Absence of evidence. Calling these rows dead would be a guess, and the
    // whole point of this module is to stop the table from guessing.
    const created = at("2026-08-24T09:00:00.000Z");
    const state = heartbeatState({ createdAt: created, updatedAt: created }, NOW);
    assert.equal(state.kind, "unknown");
  });

  await check("one slow write cannot make a live job look dead", () => {
    assert.ok(
      JOB_HEARTBEAT_STALE_AFTER_MS >= 4 * JOB_HEARTBEAT_INTERVAL_MS,
      "the stale window must tolerate several missed beats"
    );
  });

  console.log(
    failed === 0 ? "\nAll job heartbeat checks passed.\n" : `\n${failed} check(s) FAILED.\n`
  );
  if (failed > 0) process.exit(1);
}

void main();
