// Two script runs for one episode is not a race to win — it is money to lose.
//
//   npm run test:episode-job-lock
//
// NETWORK-FREE. A fake Redis stands in for the real one; no server is started.
//
// WHY IT EXISTS. On 2026-08-24 one click produced two script generations for
// the same show, the second starting about ten minutes after the first, both
// spending provider budget on work only one of them could keep. Every guard the
// system had was a guard against ENQUEUEING a duplicate; none of them addresses
// the ways a second RUN actually starts (BullMQ stall re-delivery, a second
// worker container, a version race). See episodeJobLock.ts.
//
// The rule under test is deliberately narrow: the SECOND run is declined, the
// first is untouched, and declining costs nothing.

import assert from "node:assert/strict";
import {
  EPISODE_LOCK_TTL_MS,
  acquireEpisodeScriptLock,
  duplicateRunMessage,
  episodeScriptLockKey,
  isBlocked,
  type EpisodeLockResult,
  type HeldEpisodeLock,
  type LockRedis,
} from "../lib/queue/episodeJobLock";

/** Assert a run got the lock and hand back the holder. Every test that calls
 *  release() goes through here, so a result that was actually BLOCKED can never
 *  be silently treated as a holder. */
function held(result: EpisodeLockResult): HeldEpisodeLock {
  assert.ok(!isBlocked(result), "expected this run to hold the lock");
  return result;
}

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

/** Enough Redis to be wrong in the ways that matter: SET NX actually refuses,
 *  and the release/renew scripts actually compare the token. */
function fakeRedis(opts: { failOn?: "set" } = {}) {
  const store = new Map<string, string>();
  const calls: string[] = [];
  const redis: LockRedis = {
    async set(key, value, _mode, _ttlMs, _condition) {
      calls.push(`set ${key}`);
      if (opts.failOn === "set") throw new Error("READONLY You can't write against a read only replica.");
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async eval(script, _numKeys, ...args) {
      const [key, token] = args as string[];
      const held = store.get(key);
      if (held !== token) return 0;
      if (script.includes("del")) {
        store.delete(key);
        calls.push(`del ${key}`);
        return 1;
      }
      calls.push(`pexpire ${key}`);
      return 1;
    },
  };
  return { redis, store, calls };
}

/** No renewal timer at all: these tests drive the lock directly. */
const noTimers = {
  setIntervalFn: (() => ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
  clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
};

async function main() {
  console.log("\nEpisode script single-flight lock\n");

  console.log("  -- the duplicate this exists to stop --");

  await check("a second run for the same episode is declined", async () => {
    const { redis } = fakeRedis();
    const first = await acquireEpisodeScriptLock("ep-1", { redis, holderLabel: "job:aaa", ...noTimers });
    assert.ok(!isBlocked(first), "the first run must get the lock");

    const second = await acquireEpisodeScriptLock("ep-1", { redis, holderLabel: "job:bbb", ...noTimers });
    assert.ok(isBlocked(second), "the second run must be declined while the first holds it");
    assert.match(isBlocked(second) ? second.heldBy : "", /job:aaa/, "and must be able to name who is running");
  });

  await check("a different episode is never blocked by another episode's run", async () => {
    const { redis } = fakeRedis();
    const a = await acquireEpisodeScriptLock("ep-1", { redis, holderLabel: "job:aaa", ...noTimers });
    const b = await acquireEpisodeScriptLock("ep-2", { redis, holderLabel: "job:bbb", ...noTimers });
    assert.ok(!isBlocked(a) && !isBlocked(b), "the lock is per episode, not global");
  });

  await check("the lock frees the episode when the run finishes", async () => {
    const { redis, store } = fakeRedis();
    const first = await acquireEpisodeScriptLock("ep-1", { redis, holderLabel: "job:aaa", ...noTimers });
    await held(first).release();
    assert.equal(store.size, 0, "release must delete the key");
    const next = await acquireEpisodeScriptLock("ep-1", { redis, holderLabel: "job:ccc", ...noTimers });
    assert.ok(!isBlocked(next), "a later, legitimate re-run must not be locked out");
  });

  console.log("\n  -- ownership --");

  await check("a run cannot release a lock it does not own", async () => {
    // The scenario: run #1 stalls past the TTL, run #2 legitimately acquires
    // the lock, then run #1 finally finishes and tidies up. Without a token
    // check it would delete run #2's lock and let run #3 start alongside it —
    // reintroducing the exact duplicate, one step removed.
    const { redis, store } = fakeRedis();
    const stale = await acquireEpisodeScriptLock("ep-1", { redis, holderLabel: "job:aaa", ...noTimers });
    store.set(episodeScriptLockKey("ep-1"), "job:bbb#999#zzz"); // TTL expired; someone else took it
    await held(stale).release();
    assert.equal(
      store.get(episodeScriptLockKey("ep-1")),
      "job:bbb#999#zzz",
      "the newer holder's lock must survive the older run's release"
    );
  });

  await check("release is idempotent", async () => {
    const { redis } = fakeRedis();
    const lock = held(await acquireEpisodeScriptLock("ep-1", { redis, holderLabel: "job:aaa", ...noTimers }));
    await lock.release();
    await lock.release();
  });

  console.log("\n  -- a lock is not a single point of failure --");

  await check("Redis being down does not stop script generation", async () => {
    // Refusing to generate scripts because a cache is unreachable would trade a
    // duplicate for an outage. The run proceeds unprotected and says so.
    const { redis } = fakeRedis({ failOn: "set" });
    const messages: string[] = [];
    const result = await acquireEpisodeScriptLock("ep-1", {
      redis,
      holderLabel: "job:aaa",
      log: (m) => messages.push(m),
      ...noTimers,
    });
    assert.ok(!isBlocked(result), "an unreachable Redis must not block the job");
    assert.ok(
      messages.some((m) => /WITHOUT single-flight protection/.test(m)),
      "but it must be loud about running unprotected"
    );
    await held(result).release();
  });

  console.log("\n  -- timings --");

  await check("the TTL is sized for recovery, not for job length", async () => {
    // A TTL as long as a job would strand an episode for the whole budget after
    // every deploy; a live holder renews, so it never needs to be that long.
    assert.equal(EPISODE_LOCK_TTL_MS, 120_000);
  });

  await check("a held lock is renewed on a timer", async () => {
    const { redis, calls } = fakeRedis();
    const ticks: Array<() => void> = [];
    const lock = await acquireEpisodeScriptLock("ep-1", {
      redis,
      holderLabel: "job:aaa",
      setIntervalFn: ((fn: () => void) => {
        ticks.push(fn);
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    assert.equal(ticks.length, 1, "a renewal timer must be armed");
    ticks[0]();
    await new Promise((r) => setImmediate(r));
    assert.ok(calls.includes("pexpire lock:script-generation:ep-1"), "the tick must extend the lock");
    await held(lock).release();
  });

  console.log("\n  -- what the operator is told --");

  await check("the skip message says nothing was lost", async () => {
    const msg = duplicateRunMessage("ep-1", "job:aaa#12#x");
    assert.match(msg, /already running/, "names the reason");
    assert.match(msg, /job:aaa/, "names the holder");
    assert.match(msg, /cost nothing/, "and makes clear this is not a failure to act on");
  });

  console.log(
    failed === 0 ? "\nAll episode lock checks passed.\n" : `\n${failed} check(s) FAILED.\n`
  );
  if (failed > 0) process.exit(1);
}

void main();
