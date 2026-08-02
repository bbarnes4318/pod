// Operator controls for the production queue.
//
// The rollout document used to say "pause the production queue" and point at
// "Coolify / queue admin". That is not an instruction anyone can follow at 2am
// during an incompatible deployment window, so these are the real commands.
//
// Three guarantees, because a deploy runbook is exactly where a destructive
// surprise hurts most:
//
//   PAUSE NEVER DELETES.   BullMQ's pause() stops workers taking NEW jobs.
//                          Waiting, delayed and failed jobs stay exactly where
//                          they are; nothing is drained, obliterated or moved.
//   RESUME NEVER DUPLICATES. resume() only lets workers pick up again. It does
//                          not re-enqueue, retry, or replay anything.
//   BOTH ARE IDEMPOTENT.   Pausing a paused queue and resuming a running one
//                          are no-ops that report what they found.

import { Queue } from "bullmq";

export interface QueueCounts {
  active: number;
  waiting: number;
  delayed: number;
  failed: number;
  completed: number;
  paused: number;
}

export interface QueueWorkerInfo {
  /** BullMQ's client name for the connection. Never an address. */
  name: string | null;
  /** Release the worker reported, when it reports one. */
  reportedSha: string | null;
}

export interface QueueStatus {
  queue: string;
  paused: boolean;
  counts: QueueCounts;
  workers: QueueWorkerInfo[];
  /** True when nothing is mid-flight — the state a deploy needs. */
  drained: boolean;
}

export interface QueueControlResult {
  queue: string;
  /** What the queue was BEFORE this call. */
  wasPaused: boolean;
  /** What it is now. */
  paused: boolean;
  /** True when the call did nothing because it was already in that state. */
  noop: boolean;
  counts: QueueCounts;
}

/** Injectable so the contract can be proven without Redis. */
export interface QueueHandle {
  isPaused(): Promise<boolean>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  getJobCounts(): Promise<QueueCounts>;
  getWorkers(): Promise<Array<{ name?: string | null; version?: string | null }>>;
  close(): Promise<void>;
}

export type QueueHandleFactory = (queueName: string) => Promise<QueueHandle>;

async function realHandle(queueName: string): Promise<QueueHandle> {
  const { getRedisClient } = await import("../redis");
  const queue = new Queue(queueName, { connection: getRedisClient() as never });
  return {
    isPaused: () => queue.isPaused(),
    pause: () => queue.pause(),
    resume: () => queue.resume(),
    async getJobCounts() {
      const c = await queue.getJobCounts("active", "waiting", "delayed", "failed", "completed", "paused");
      return {
        active: c.active ?? 0,
        waiting: c.waiting ?? 0,
        delayed: c.delayed ?? 0,
        failed: c.failed ?? 0,
        completed: c.completed ?? 0,
        paused: c.paused ?? 0,
      };
    },
    getWorkers: async () => (await queue.getWorkers()) as Array<{ name?: string | null }>,
    close: () => queue.close(),
  };
}

let factory: QueueHandleFactory = realHandle;

export function __setQueueHandleFactoryForTests(f: QueueHandleFactory | null): void {
  factory = f ?? realHandle;
}

function workerInfo(raw: Array<{ name?: string | null; version?: string | null }>): QueueWorkerInfo[] {
  return raw.map((w) => {
    // BullMQ reports the client name a worker set on its connection. The worker
    // stamps its release into that name so an operator can see WHICH build is
    // attached, not merely that something is.
    const name = (w.name || "").trim() || null;
    const shaMatch = name ? /(?:sha[:=])([0-9a-f]{7,40})/i.exec(name) : null;
    return { name, reportedSha: shaMatch ? shaMatch[1] : (w.version || null) };
  });
}

export async function productionQueueStatus(queueName: string): Promise<QueueStatus> {
  const handle = await factory(queueName);
  try {
    const [paused, counts, workers] = await Promise.all([
      handle.isPaused(),
      handle.getJobCounts(),
      handle.getWorkers(),
    ]);
    return {
      queue: queueName,
      paused,
      counts,
      workers: workerInfo(workers),
      // "Drained" is about work IN FLIGHT. Waiting and delayed jobs are fine to
      // leave parked across a deploy; an ACTIVE job is not, because it is
      // running against the code you are about to replace.
      drained: counts.active === 0,
    };
  } finally {
    await handle.close();
  }
}

export async function pauseProductionQueue(queueName: string): Promise<QueueControlResult> {
  const handle = await factory(queueName);
  try {
    const wasPaused = await handle.isPaused();
    if (!wasPaused) await handle.pause();
    const counts = await handle.getJobCounts();
    return { queue: queueName, wasPaused, paused: true, noop: wasPaused, counts };
  } finally {
    await handle.close();
  }
}

export async function resumeProductionQueue(queueName: string): Promise<QueueControlResult> {
  const handle = await factory(queueName);
  try {
    const wasPaused = await handle.isPaused();
    if (wasPaused) await handle.resume();
    const counts = await handle.getJobCounts();
    return { queue: queueName, wasPaused, paused: false, noop: !wasPaused, counts };
  } finally {
    await handle.close();
  }
}

export function renderQueueStatus(status: QueueStatus): string {
  const w = status.workers.length
    ? status.workers
        .map((x) => `      - ${x.name ?? "(unnamed)"}${x.reportedSha ? ` @ ${x.reportedSha}` : " @ (no release reported)"}`)
        .join("\n")
    : "      (none attached)";
  return [
    "",
    `  QUEUE  ${status.queue}`,
    `  state  ${status.paused ? "PAUSED" : "running"}`,
    `  active ${status.counts.active}   waiting ${status.counts.waiting}   delayed ${status.counts.delayed}   failed ${status.counts.failed}`,
    `  drained (nothing active): ${status.drained ? "yes" : "NO — wait before deploying"}`,
    `  workers (${status.workers.length}):`,
    w,
    "",
  ].join("\n");
}
