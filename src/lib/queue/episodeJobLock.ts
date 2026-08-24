// ONE EPISODE, ONE SCRIPT RUN. Enforced across processes, not per handler.
//
// WHY IT EXISTS. On 2026-08-24 an operator clicked "generate script" once and
// watched TWO script jobs run against the same show, the second starting about
// ten minutes after the first, both burning provider budget on work only one of
// them could keep. Nothing in the system forbade it. Every guard we had is a
// guard against ENQUEUEING a duplicate, and none of them survives contact with
// the ways a second RUN actually starts:
//
//   * BullMQ stall re-delivery. A job whose lock is not renewed inside
//     `lockDuration` is declared stalled and moved back to wait — while the
//     original promise keeps running, because nothing can kill it. That is not
//     an error path; it is BullMQ working as designed, and it produces exactly
//     two live executions of one job id. (worker.ts now sets a lockDuration
//     sized for LLM work, which makes this rare; this lock makes it harmless.)
//   * A second worker container. `concurrency: 1` is per process. Two replicas
//     are two slots, and neither knows about the other.
//   * A version race. The enqueue guard keys on (episode, NEXT version). The
//     moment run #1 writes its script row, the next click computes a different
//     version, gets a different job id, and sails straight past the guard.
//
// A deduplicated queue cannot express "this episode is busy" — only Redis can,
// because only Redis is shared by every process that could start a run. So the
// rule lives here, at the point of EXECUTION, where all three paths converge.
//
// A BLOCKED RUN IS NOT A FAILURE. It returns and says so, and the caller
// records a skipped job. Throwing would hand the duplicate to BullMQ's retry
// policy, which would faithfully try the duplicate twice more.

import { getRedisClient } from "../redis";

/** The slice of ioredis this module needs. Narrow on purpose: a test supplies
 *  an object with these three methods and no Redis server. */
export interface LockRedis {
  set(
    key: string,
    value: string,
    mode: "PX",
    ttlMs: number,
    condition: "NX"
  ): Promise<"OK" | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export interface HeldEpisodeLock {
  key: string;
  /** Proof of ownership. Only the holder that wrote this token may renew or
   *  release the lock — without it, a slow run would happily delete the lock a
   *  DIFFERENT run acquired after its own expired. */
  token: string;
  release(): Promise<void>;
}

export interface BlockedEpisodeLock {
  blocked: true;
  /** Whatever the current holder wrote about itself, for the operator-facing
   *  message. Never trusted for control flow. */
  heldBy: string;
}

export type EpisodeLockResult = HeldEpisodeLock | BlockedEpisodeLock;

export function isBlocked(result: EpisodeLockResult): result is BlockedEpisodeLock {
  return (result as BlockedEpisodeLock).blocked === true;
}

/**
 * Lock lifetime, and why it is not "the length of a job".
 *
 * The TTL is the answer to "how long after a worker dies must the next attempt
 * wait?", NOT "how long may a job run?". A live holder renews well inside the
 * window, so a long job keeps its lock indefinitely; a killed one leaves a lock
 * that clears itself in two minutes rather than wedging the episode until
 * someone finds it in Redis. Both numbers matter and they are not the same
 * number — a TTL sized to a 25-minute job would strand an episode for 25
 * minutes after every deploy.
 */
export const EPISODE_LOCK_TTL_MS = 2 * 60 * 1000;
export const EPISODE_LOCK_RENEW_MS = 40 * 1000;

/** Delete only if the value still matches — the compare-and-delete every
 *  correct Redis lock needs. */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Extend only if we still own it. A holder that lost the lock (its TTL passed
 *  while the event loop was blocked) must NOT take it back underneath whoever
 *  legitimately owns it now. */
const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`;

export function episodeScriptLockKey(episodeId: string): string {
  return `lock:script-generation:${episodeId}`;
}

let sharedClient: LockRedis | undefined;
function defaultClient(): LockRedis {
  // One connection for every lock in this process. getRedisClient() builds a
  // NEW ioredis client on each call in production, so calling it per job would
  // leak a connection per script run.
  sharedClient ??= getRedisClient() as unknown as LockRedis;
  return sharedClient;
}

export interface AcquireOptions {
  redis?: LockRedis;
  ttlMs?: number;
  renewMs?: number;
  /** Written into the lock value so a blocked run can name its holder. */
  holderLabel: string;
  /** Injected in tests; production uses the real timer. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  log?: (msg: string) => void;
}

/**
 * Take the episode's script lock, or report who has it.
 *
 * Redis being unreachable does NOT block the run. This lock exists to prevent
 * waste, and refusing to generate scripts at all because a cache is down would
 * trade a duplicate for an outage. The failure is logged loudly and the run
 * proceeds unprotected — the same posture the rest of the pipeline takes toward
 * Redis.
 */
export async function acquireEpisodeScriptLock(
  episodeId: string,
  opts: AcquireOptions
): Promise<EpisodeLockResult> {
  const redis = opts.redis ?? defaultClient();
  const ttlMs = opts.ttlMs ?? EPISODE_LOCK_TTL_MS;
  const renewMs = opts.renewMs ?? EPISODE_LOCK_RENEW_MS;
  const setIntervalFn = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
  const log = opts.log ?? ((m: string) => console.warn(m));
  const key = episodeScriptLockKey(episodeId);
  const token = `${opts.holderLabel}#${process.pid}#${Date.now().toString(36)}`;

  let acquired: "OK" | null;
  try {
    acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  } catch (err) {
    log(
      `[EpisodeLock] Redis refused the lock for episode ${episodeId} (${(err as Error).message}). ` +
        `Proceeding WITHOUT single-flight protection — a duplicate run is possible until Redis recovers.`
    );
    return { key, token, release: async () => undefined };
  }

  if (acquired !== "OK") {
    const heldBy = await redis.get(key).catch(() => null);
    return { blocked: true, heldBy: heldBy || "another run (holder unknown)" };
  }

  const renewTimer = setIntervalFn(() => {
    void Promise.resolve(redis.eval(RENEW_SCRIPT, 1, key, token, ttlMs)).catch((err) =>
      log(`[EpisodeLock] Could not renew ${key}: ${(err as Error).message}`)
    );
  }, renewMs);
  // A renewal timer must never be the reason a worker process stays alive.
  (renewTimer as unknown as { unref?: () => void }).unref?.();

  let released = false;
  return {
    key,
    token,
    release: async () => {
      if (released) return;
      released = true;
      clearIntervalFn(renewTimer as unknown as NodeJS.Timeout);
      try {
        await redis.eval(RELEASE_SCRIPT, 1, key, token);
      } catch (err) {
        // The TTL is the backstop: a lock we failed to delete clears itself.
        log(`[EpisodeLock] Could not release ${key}: ${(err as Error).message}`);
      }
    },
  };
}

/** The message an operator sees when a duplicate run was declined. Written to
 *  be read by someone who is already angry that two jobs were running: it says
 *  what was stopped, what is still running, and that nothing was lost. */
export function duplicateRunMessage(episodeId: string, heldBy: string): string {
  return (
    `Skipped: a script generation for episode ${episodeId} is already running (${heldBy}). ` +
    `This second run was declined before it called a single provider, so it cost nothing and ` +
    `nothing was lost — the run already in flight produces the script.`
  );
}
