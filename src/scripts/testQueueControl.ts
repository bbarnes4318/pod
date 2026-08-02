// Contract tests for the deployment-window queue controls.
//
// These run against an injected fake, so the two guarantees an operator is
// relying on at 2am — pause does not delete, resume does not duplicate — are
// proven without Redis.

import assert from "node:assert/strict";
import {
  __setQueueHandleFactoryForTests,
  pauseProductionQueue,
  productionQueueStatus,
  renderQueueStatus,
  resumeProductionQueue,
  type QueueCounts,
  type QueueHandle,
} from "../lib/queue/queueControl";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

/** A fake queue that records every mutation attempted against it. */
function fakeQueue(initial: Partial<Omit<QueueCounts, "paused">> & { isPaused?: boolean } = {}) {
  const counts: QueueCounts = {
    active: initial.active ?? 0,
    waiting: initial.waiting ?? 7,
    delayed: initial.delayed ?? 3,
    failed: initial.failed ?? 2,
    completed: initial.completed ?? 100,
    paused: initial.isPaused ? 1 : 0,
  };
  const state = {
    paused: initial.isPaused ?? false,
    pauseCalls: 0,
    resumeCalls: 0,
    closed: 0,
    workers: [{ name: "worker-1 sha:abc123def456" }] as Array<{ name?: string | null }>,
  };
  const handle: QueueHandle = {
    async isPaused() { return state.paused; },
    async pause() { state.pauseCalls += 1; state.paused = true; },
    async resume() { state.resumeCalls += 1; state.paused = false; },
    async getJobCounts() { return { ...counts }; },
    async getWorkers() { return state.workers; },
    async close() { state.closed += 1; },
  };
  __setQueueHandleFactoryForTests(async () => handle);
  return { state, counts };
}

async function main() {
  console.log("\nProduction queue controls\n");

  await check("pause reports the transition and does not delete any job", async () => {
    const { state, counts } = fakeQueue({ waiting: 7, delayed: 3, failed: 2 });
    const before = { ...counts };
    const r = await pauseProductionQueue("podcast-production");
    assert.equal(r.paused, true);
    assert.equal(r.wasPaused, false);
    assert.equal(r.noop, false);
    assert.equal(state.pauseCalls, 1);
    // The whole point: nothing was drained, obliterated or moved.
    assert.deepEqual(r.counts, before, "pause must not change any job count");
  });

  await check("pausing an ALREADY paused queue is a no-op", async () => {
    const { state } = fakeQueue({ isPaused: true });
    const r = await pauseProductionQueue("podcast-production");
    assert.equal(r.noop, true, "a second pause must report that it changed nothing");
    assert.equal(r.paused, true);
    assert.equal(state.pauseCalls, 0, "it must not re-issue pause");
  });

  await check("resume reports the transition and does not re-enqueue", async () => {
    const { state, counts } = fakeQueue({ isPaused: true, waiting: 7, delayed: 3 });
    const before = { ...counts };
    const r = await resumeProductionQueue("podcast-production");
    assert.equal(r.paused, false);
    assert.equal(r.wasPaused, true);
    assert.equal(state.resumeCalls, 1);
    assert.deepEqual(r.counts, before, "resume must not duplicate or replay jobs");
  });

  await check("resuming an ALREADY running queue is a no-op", async () => {
    const { state } = fakeQueue({ isPaused: false });
    const r = await resumeProductionQueue("podcast-production");
    assert.equal(r.noop, true);
    assert.equal(state.resumeCalls, 0, "it must not re-issue resume");
  });

  await check("pause -> resume -> pause leaves the counts untouched", async () => {
    const { counts } = fakeQueue({ waiting: 12, delayed: 4, failed: 1 });
    const before = { ...counts };
    await pauseProductionQueue("podcast-production");
    await resumeProductionQueue("podcast-production");
    const last = await pauseProductionQueue("podcast-production");
    assert.deepEqual(last.counts, before, "cycling the queue must never alter the work in it");
  });

  await check("status reports paused state, every count, and attached workers", async () => {
    fakeQueue({ isPaused: true, active: 0, waiting: 5, delayed: 1, failed: 3 });
    const s = await productionQueueStatus("podcast-production");
    assert.equal(s.paused, true);
    assert.equal(s.counts.waiting, 5);
    assert.equal(s.counts.delayed, 1);
    assert.equal(s.counts.failed, 3);
    assert.equal(s.workers.length, 1);
    assert.equal(s.workers[0].reportedSha, "abc123def456", "status must surface the worker's release");
  });

  await check("status calls an ACTIVE job not-drained, because a deploy would kill it", async () => {
    fakeQueue({ active: 2 });
    const s = await productionQueueStatus("podcast-production");
    assert.equal(s.drained, false, "an in-flight job means the window is not safe yet");
    const text = renderQueueStatus(s);
    assert.match(text, /wait before deploying/i);
  });

  await check("waiting and delayed jobs do NOT block the window", async () => {
    // Parked work is fine across a deploy; only in-flight work is not.
    fakeQueue({ active: 0, waiting: 40, delayed: 9 });
    const s = await productionQueueStatus("podcast-production");
    assert.equal(s.drained, true, "parked jobs must not be mistaken for in-flight work");
  });

  await check("every call closes its connection", async () => {
    const { state } = fakeQueue();
    await pauseProductionQueue("podcast-production");
    await productionQueueStatus("podcast-production");
    await resumeProductionQueue("podcast-production");
    assert.equal(state.closed, 3, "a leaked connection would hang a deploy script");
  });

  __setQueueHandleFactoryForTests(null);
  console.log(failed === 0 ? "\nAll queue control checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
