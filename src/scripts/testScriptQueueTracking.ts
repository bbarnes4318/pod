// Regression for the production failure where a newly-clicked Studio episode
// had no visible JobLog while an older episode finally became active and looked
// like a mystery replacement job.
//
// Run: npx tsx --conditions=react-server src/scripts/testScriptQueueTracking.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scriptJobIsInFlight, scriptQueueIdentity } from "../lib/queue/scriptQueueIdentity";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const src = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");
const queue = src("lib/queue/podcastQueue.ts");
const worker = src("lib/queue/worker.ts");
const actions = src("app/app/create/actions.ts");
const builder = src("app/studio/create/RundownBuilder.tsx");
const jobLogsPage = src("app/admin/job-logs/page.tsx");
const jobLogsRefresh = src("app/admin/job-logs/AutoRefresh.tsx");

console.log("Script queue identity + submission visibility\n");

check("one episode/version has one deterministic BullMQ and submission-log identity", () => {
  const a = scriptQueueIdentity("episode-a", 3);
  const b = scriptQueueIdentity("episode-a", 3);
  assert(a.jobId === b.jobId, "same episode/version must produce the same job id");
  assert(a.submissionLogId === b.submissionLogId, "same episode/version must produce the same submission log id");
  assert(a.jobId === "script-episode-a-v3", `unexpected job id: ${a.jobId}`);
});

check("different episodes and versions cannot collide", () => {
  const a = scriptQueueIdentity("episode-a", 3);
  const otherEpisode = scriptQueueIdentity("episode-b", 3);
  const otherVersion = scriptQueueIdentity("episode-a", 4);
  assert(a.jobId !== otherEpisode.jobId, "different episodes collided");
  assert(a.jobId !== otherVersion.jobId, "different versions collided");
  assert(a.submissionLogId !== otherEpisode.submissionLogId, "submission logs collided across episodes");
});

check("all BullMQ waiting/running states coalesce repeat clicks", () => {
  for (const state of ["waiting", "active", "delayed", "prioritized", "waiting-children", "paused"]) {
    assert(scriptJobIsInFlight(state), `${state} should be treated as in flight`);
  }
  assert(!scriptJobIsInFlight("failed"), "a failed job must be explicitly retryable");
  assert(!scriptJobIsInFlight("completed"), "a completed terminal record must not block a new version");
});

check("Studio hands the exact newly-created episode id to startDebate", () => {
  assert(/startDebate\(result\.episodeId\)/.test(builder), "ResultView must start the episode returned by creation");
  assert(/queueScriptGenerationJob\(\{[\s\S]*?episodeId,/.test(actions), "startDebate must enqueue its episodeId unchanged");
});

check("submission is logged before Redis enqueue and includes the queue identity", () => {
  const upsertAt = queue.indexOf("await db.jobLog.upsert");
  const addAt = queue.indexOf('productionQueue.add("generate:script"', upsertAt);
  assert(upsertAt !== -1, "script submission must write a JobLog audit row");
  assert(addAt > upsertAt, "submission JobLog must be durable before Redis enqueue");
  assert(/status:\s*"submitted"/.test(queue), "the pre-worker state must say submitted, not running");
  assert(/jobId:\s*identity\.jobId/.test(queue), "BullMQ add must use the deterministic job id");
  assert(/queueJobId:\s*identity\.jobId/.test(queue), "payload must carry the BullMQ identity");
  assert(/submissionLogId:\s*identity\.submissionLogId/.test(queue), "payload must carry the submission audit id");
});

check("repeat clicks reuse production jobs and safely adopt legacy queue jobs", () => {
  assert(/productionQueue\.getJob\(identity\.jobId\)/.test(queue),
    "the production queue must look up the deterministic job first");
  assert(/scriptJobIsInFlight\(state\)\) return existing/.test(queue),
    "an in-flight production duplicate must return the existing job");
  assert(/podcastQueue\.getJob\(identity\.jobId\)/.test(queue),
    "the adoption bridge must inspect the legacy background queue");
  assert(/state === "active"\) return legacy/.test(queue),
    "an already-active legacy script must finish instead of being duplicated");
  assert(/await legacy\.remove\(\)/.test(queue),
    "a non-active legacy script must be removed before production enqueue");
});

check("the worker's active JobLog preserves queueJobId and targetVersion", () => {
  const start = worker.indexOf("async function handleScriptGeneration(");
  assert(start !== -1, "script worker handler missing");
  const end = worker.indexOf("\nasync function ", start + 1);
  const body = worker.slice(start, end === -1 ? worker.length : end);
  // WHAT IS BEING ASSERTED IS THE PAYLOAD, NOT THE SPELLING. This used to grep
  // for `input: job.data as any`, the literal the handler happened to use when
  // it opened its own row. `beginJobLog` (jobLogRecord.ts) now opens the row so
  // that a retry reuses it instead of writing a third one, and it takes the
  // payload as its third argument. The property that matters is unchanged and
  // is what the check still enforces: the WHOLE job payload reaches the running
  // row, so queueJobId and targetVersion ride along and the operations table
  // can show which click a running job belongs to. Passing a hand-picked subset
  // here is the regression this guards against.
  assert(
    /beginJobLog\(\s*job\s*,\s*"generate:script"\s*,\s*job\.data\s*\)/.test(body) ||
      /input:\s*job\.data as any/.test(body),
    "worker running log must preserve the tracked job payload"
  );
});

check("the operations page shows submitted jobs and refreshes without a manual reload", () => {
  assert(jobLogsPage.includes('<option value="submitted">submitted</option>'), "submitted status filter missing");
  assert(jobLogsPage.includes("Open this exact episode"), "episode identity is not explicit in the table");
  assert(jobLogsPage.includes("queue: {queueJobId}"), "BullMQ queue identity is not displayed");
  assert(jobLogsPage.includes("Waiting ${elapsedSeconds}s"), "submitted wait time is not displayed");
  assert(jobLogsRefresh.includes("router.refresh()"), "job log page does not auto-refresh");
  assert(jobLogsRefresh.includes("4000"), "job log refresh interval changed from four seconds");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
