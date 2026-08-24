/**
 * The three defects that turned "topic generation runs twice a day" into 38
 * `generate:topics` rows and 139 `generate:research-brief` rows in 2.75 days:
 *
 *   1. the boot sweep ran on EVERY worker restart, and push-to-main
 *      auto-deploys, so a day of shipping swept six extra times;
 *   2. the per-league job ids bucketed by clock HOUR, so each of those
 *      restarts minted a fresh set of ids and nothing deduped;
 *   3. the JobLog row was written per ATTEMPT, and the queue runs attempts: 3,
 *      so a rate-limited job counted three times.
 *
 * This covers the pure logic behind (1) and (2) and the row-identity rule
 * behind (3).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  topicSweepHours,
  topicSweepMinute,
  topicSweepKey,
  topicSweepWindowStart,
  scheduledTopicRunsPerDay,
  topicsGenerateCron,
} from "../lib/services/sportsIngestSchedule";
import { queueJobKey, jobAttempt } from "../lib/queue/queueJobIdentity";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

delete process.env.TOPICS_GENERATE_CRON;

const CRON = topicsGenerateCron();
assert.equal(CRON, "30 5,17 * * *", "default topic cron");

// ---------------------------------------------------------------- cron parsing
assert.deepEqual(topicSweepHours("30 5,17 * * *"), [5, 17]);
assert.deepEqual(topicSweepHours("30 */3 * * *"), [0, 3, 6, 9, 12, 15, 18, 21]);
assert.deepEqual(topicSweepHours("0 * * * *").length, 24);
assert.deepEqual(topicSweepHours("0 17,5,5 * * *"), [5, 17], "deduped and sorted");
assert.deepEqual(topicSweepHours("0 99 * * *"), [0], "garbage falls back");
assert.equal(topicSweepMinute("30 5,17 * * *"), 30);
assert.equal(topicSweepMinute("*/5 5 * * *"), 0, "non-literal minute falls back");

// scheduledTopicRunsPerDay is now derived from the same parse; the numbers the
// admin UI shows must not move.
assert.equal(scheduledTopicRunsPerDay("30 */3 * * *"), 8);
assert.equal(scheduledTopicRunsPerDay("30 5,17 * * *"), 2);
assert.equal(scheduledTopicRunsPerDay("0 6 * * *"), 1);
assert.equal(scheduledTopicRunsPerDay("0 * * * *"), 24);

// ------------------------------------------------------- sweep window identity
const key = (iso: string) => topicSweepKey(new Date(iso), CRON);
const start = (iso: string) => topicSweepWindowStart(new Date(iso), CRON).toISOString();

// The real window the operator reported on. Every one of these instants used to
// produce a DIFFERENT hour bucket; they are one sweep.
assert.equal(key("2026-08-21T05:30:00.000Z"), "2026-08-21T05", "the tick itself");
assert.equal(key("2026-08-21T06:15:00.000Z"), "2026-08-21T05", "deploy 25min later");
assert.equal(key("2026-08-21T06:34:00.000Z"), "2026-08-21T05", "the first row seen");
assert.equal(key("2026-08-21T17:29:59.000Z"), "2026-08-21T05", "one second early");

// ...and 05:30 vs 17:30 must stay two distinct sweeps, or the fix would have
// quietly halved the cadence to once a day.
assert.equal(key("2026-08-21T17:30:00.000Z"), "2026-08-21T17");
assert.equal(key("2026-08-23T17:25:00.000Z"), "2026-08-23T05", "before the 17:30 tick");
assert.equal(key("2026-08-23T17:35:00.000Z"), "2026-08-23T17", "after it");
assert.notEqual(key("2026-08-22T05:30:00.000Z"), key("2026-08-22T17:30:00.000Z"));

// Before the day's first slot we are still inside YESTERDAY's last window.
assert.equal(key("2026-08-24T00:05:00.000Z"), "2026-08-23T17");
assert.equal(key("2026-08-24T01:55:00.000Z"), "2026-08-23T17");
assert.equal(key("2026-08-24T02:10:00.000Z"), "2026-08-23T17", "the last row seen");

// Window start is the instant the gate query counts from.
assert.equal(start("2026-08-21T06:34:00.000Z"), "2026-08-21T05:30:00.000Z");
assert.equal(start("2026-08-24T02:10:00.000Z"), "2026-08-23T17:30:00.000Z");
assert.equal(start("2026-08-01T00:00:00.000Z"), "2026-07-31T17:30:00.000Z", "month rollover");
assert.equal(start("2026-01-01T03:00:00.000Z"), "2025-12-31T17:30:00.000Z", "year rollover");

// The reported span, Aug 21 06:34 → Aug 24 02:10 UTC, minute by minute: how
// many sweeps can it now contain, however many times the worker restarts?
const FROM = Date.parse("2026-08-21T06:34:00Z");
const TO = Date.parse("2026-08-24T02:10:00Z");
const windows = new Set<string>();
for (let t = FROM; t <= TO; t += 60_000) windows.add(topicSweepKey(new Date(t), CRON));

// Six windows are TOUCHED: the span opens an hour into the 08-21T05 sweep,
// which had already fired at 05:30 before the operator started counting.
assert.equal(windows.size, 6, `expected 6 windows touched, got ${windows.size}`);

// Five of them actually BEGIN inside the span, so at most five sweeps can be
// dispatched in it — down from the ~11 (5 cron + 6 deploys) that ran.
const MINUTE = String(topicSweepMinute(CRON)).padStart(2, "0");
const begun = [...windows].filter((k) => {
  const t = Date.parse(`${k}:${MINUTE}:00.000Z`); // "2026-08-21T05" -> 05:30Z
  return t >= FROM && t <= TO;
});
assert.equal(begun.length, 5, `2.75 days at 2/day is 5 sweeps, got ${begun.length}`);

// ------------------------------------------------------------ JobLog identity
// Only the three fields the helpers read; no BullMQ instance needed.
type FakeJob = { id?: string; timestamp: number; attemptsMade?: number };
const enqueued: FakeJob = { id: "topics-gen-nfl-2026-08-21T05", timestamp: 1_755_000_000_000 };

// One enqueue, three attempts: ONE row.
const firstTry: FakeJob = { ...enqueued, attemptsMade: 0 };
const thirdTry: FakeJob = { ...enqueued, attemptsMade: 2 };
assert.equal(queueJobKey(firstTry), queueJobKey(thirdTry));
assert.equal(jobAttempt({ attemptsMade: 0 }), 1);
assert.equal(jobAttempt({ attemptsMade: 2 }), 3);
assert.equal(jobAttempt(undefined), 1);

// A genuine re-add of the same deterministic id after removeOnComplete is a NEW
// run and must get its own row.
const readded: FakeJob = { ...enqueued, timestamp: 1_755_000_060_000 };
assert.notEqual(queueJobKey(enqueued), queueJobKey(readded));

// No BullMQ job to key on (admin actions, direct service calls) → unkeyed row.
assert.equal(queueJobKey(undefined), null);
const idless: FakeJob = { id: undefined, timestamp: 1 };
const blankId: FakeJob = { id: "", timestamp: 1 };
assert.equal(queueJobKey(idless), null);
assert.equal(queueJobKey(blankId), null);

// ---------------------------------------------------------- wiring in worker.ts
const worker = source("src/lib/queue/worker.ts");
assert.match(worker, /dispatchFreshTopicRunsOnBoot\(\)/, "boot goes through the gate");
assert.doesNotMatch(worker, /dispatchFreshTopicRuns\("boot"\)\s*\)/, "never dispatched unconditionally");
assert.match(worker, /if \(await topicSweepAlreadyRan\(windowStart\)\)/);
// The gate must count the scheduler's own row, not just the league jobs: those
// are enqueued with a per-league delay and have written nothing yet when a
// second restart lands seconds later.
assert.match(worker, /\{ jobType: "generate:topics" \}/);
assert.match(worker, /\{ jobType: "scheduler:topics-generate", status: \{ not: "failed" \} \}/);
// Every queue handler keys its JobLog on the enqueue.
assert.doesNotMatch(
  worker,
  /jobType: "generate:topics",\s*\n\s*status: "running"/,
  "generate:topics still creates a per-attempt row"
);
assert.doesNotMatch(
  worker,
  /jobType: "generate:research-brief",\s*\n\s*status: "running"/,
  "generate:research-brief still creates a per-attempt row"
);
for (const jobType of [
  "generate:topics",
  "generate:research-brief",
  "build:episode",
  "generate:script",
  "fact-check:script",
  "tts:generate-segments",
]) {
  assert.match(
    worker,
    new RegExp(`beginJobLog\\(job, "${jobType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`),
    `${jobType} does not use beginJobLog`
  );
}

const schema = source("prisma/schema.prisma");
assert.match(schema, /queueJobKey String\? @unique/, "JobLog needs a unique enqueue key");

console.log("PASS testTopicSweepWindow");
