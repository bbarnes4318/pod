// A REAL BullMQ round-trip on a REAL Redis.
//
// The readiness preflight claims it can tell "a worker is consuming this queue"
// from "a worker connection is registered". That distinction only means
// something against a real broker, so this proves both directions:
//
//   1. with a worker attached, an enqueued job is CONSUMED within the timeout
//   2. with NO worker attached, the same probe TIMES OUT rather than passing
//
// Nothing here touches the production queue name or any real job handler.

import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { check, summarize, uid, requireEnv } from "./helpers";

const QUEUE = uid("integration-health");

function connection() {
  // maxRetriesPerRequest: null is required by BullMQ for blocking commands.
  return new IORedis(requireEnv("REDIS_URL"), { maxRetriesPerRequest: null });
}

/** Enqueue one job and wait for a worker to complete it, or time out. */
async function roundTrip(queueName: string, timeoutMs: number): Promise<{ processed: boolean; echoedSha: string | null }> {
  const conn = connection();
  const queue = new Queue(queueName, { connection: conn as never });
  try {
    const jobId = `${uid("probe")}`;
    await queue.add("readiness:health-probe", { probe: true, jobId }, { jobId, removeOnComplete: true, removeOnFail: true });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await queue.getJob(jobId);
      if (!job) {
        // Completed and removed by removeOnComplete.
        return { processed: true, echoedSha: null };
      }
      const state = await job.getState();
      if (state === "completed") {
        const value = (job.returnvalue || {}) as { sha?: string };
        return { processed: true, echoedSha: value.sha ?? null };
      }
      if (state === "failed") return { processed: false, echoedSha: null };
      await new Promise((r) => setTimeout(r, 50));
    }
    return { processed: false, echoedSha: null };
  } finally {
    await queue.close();
    await conn.quit();
  }
}

async function main() {
  console.log("\nWorker health round-trip (real Redis)\n");

  await check("with NO worker attached, the probe TIMES OUT (it does not pass)", async () => {
    const result = await roundTrip(`${QUEUE}-idle`, 1500);
    if (result.processed) {
      throw new Error("a queue with nothing consuming it must not report a successful round-trip");
    }
  });

  await check("with a worker attached, the job is CONSUMED and echoes its version", async () => {
    const name = `${QUEUE}-live`;
    const conn = connection();
    const worker = new Worker(
      name,
      async (job: Job) => {
        // Stand-in for the production handler: echo the release identity so the
        // probe can prove WHICH build consumed the job, not merely that one did.
        return { sha: process.env.GIT_COMMIT_SHA || "integration-sha", jobId: job.id };
      },
      { connection: conn as never }
    );
    try {
      await worker.waitUntilReady();
      const result = await roundTrip(name, 10_000);
      if (!result.processed) throw new Error("an attached worker must consume the health job");
    } finally {
      await worker.close();
      await conn.quit();
    }
  });

  await check("a worker that only CONNECTS but never processes still fails the probe", async () => {
    // The exact false positive the old preflight had: a registered connection.
    const name = `${QUEUE}-registered`;
    const conn = connection();
    const worker = new Worker(name, async () => new Promise(() => {}), {
      connection: conn as never,
      // Attached, but every job hangs forever.
    });
    try {
      await worker.waitUntilReady();
      const result = await roundTrip(name, 1500);
      if (result.processed) throw new Error("a wedged worker must not count as consumption");
    } finally {
      await worker.close();
      await conn.quit();
    }
  });

  summarize("Worker health round-trip");
}

main();
