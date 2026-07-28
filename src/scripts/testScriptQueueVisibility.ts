import fs from "node:fs";
import path from "node:path";
import {
  canUpdateQueuedScriptJob,
  isPendingScriptJobState,
  queuedScriptLogIsSuperseded,
  scriptGenerationJobId,
} from "../lib/queue/scriptJobTracking";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const root = process.cwd();
const queueSource = fs.readFileSync(path.join(root, "src/lib/queue/podcastQueue.ts"), "utf8");
const pageSource = fs.readFileSync(path.join(root, "src/app/admin/job-logs/page.tsx"), "utf8");
const refreshSource = fs.readFileSync(path.join(root, "src/app/admin/job-logs/AutoRefresh.tsx"), "utf8");

console.log("Script queue visibility regression:");

check("script job identity is stable per episode", () => {
  assert(scriptGenerationJobId("episode-123") === "generate-script-episode-123", "unexpected job id");
});

check("waiting/delayed/active script work is treated as already pending", () => {
  for (const state of ["waiting", "delayed", "prioritized", "active", "waiting-children"]) {
    assert(isPendingScriptJobState(state), `${state} should be pending`);
  }
  assert(!isPendingScriptJobState("failed"), "failed must be retryable");
  assert(!isPendingScriptJobState("completed"), "completed must allow a later regeneration");
});

check("only not-yet-started jobs accept newer producer options", () => {
  assert(canUpdateQueuedScriptJob("waiting"), "waiting should update");
  assert(canUpdateQueuedScriptJob("delayed"), "delayed should update");
  assert(canUpdateQueuedScriptJob("prioritized"), "prioritized should update");
  assert(!canUpdateQueuedScriptJob("active"), "active data must not mutate under the worker");
});

check("a later execution row hides the older enqueue-only row", () => {
  const queued = {
    id: "queued",
    jobType: "generate:script",
    status: "queued",
    input: { episodeId: "ep-1", queueJobId: "generate-script-ep-1" },
    createdAt: new Date("2026-07-28T15:00:00Z"),
  };
  const running = {
    id: "running",
    jobType: "generate:script",
    status: "running",
    input: { episodeId: "ep-1" },
    createdAt: new Date("2026-07-28T15:01:00Z"),
  };
  assert(queuedScriptLogIsSuperseded(queued, [queued, running]), "queued row should be hidden");
  assert(!queuedScriptLogIsSuperseded(queued, [queued]), "real waiting row must remain visible");
});

check("queue creates the visible queued log before adding BullMQ work", () => {
  const logAt = queueSource.indexOf('status: "queued"');
  const addAt = queueSource.indexOf("podcastQueue.add(SCRIPT_JOB_TYPE");
  assert(logAt >= 0, "queued JobLog write missing");
  assert(addAt > logAt, "BullMQ add happens before the visible queued row");
  assert(queueSource.includes("podcastQueue.getJob(jobId)"), "same-episode coalescing missing");
  assert(queueSource.includes("existing.updateData(data)"), "latest waiting options are not preserved");
});

check("job log UI exposes queued state, episode identity, and live refresh", () => {
  assert(pageSource.includes('<option value="queued">queued</option>'), "queued filter missing");
  assert(pageSource.includes("episodeTitleById"), "episode title lookup missing");
  assert(pageSource.includes("queue: {bullJobId}"), "queue identity missing");
  assert(pageSource.includes("queuedScriptLogIsSuperseded"), "stale queued suppression missing");
  assert(refreshSource.includes("router.refresh()"), "live refresh missing");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
