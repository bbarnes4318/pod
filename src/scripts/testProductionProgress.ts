// Production console progress rules. Run: npm run test:production-progress
//
// Covers the pure decision layer (lib/studio/productionProgress.ts) — the part
// that decides what a waiting user is told. The DB half is a thin snapshot
// assembler, so these tests need no database.
//
// The rules that matter most here are the honesty ones:
//   · a failed stage must be reported as failed even though the worker rolls
//     Episode.status BACK on failure (never writes "failed")
//   · only voicing may carry a counted progress value
//   · a job that was never picked up reads as stalled, not as "still working"

import {
  deriveProduction,
  humanFailure,
  STALL_AFTER_MS,
  type DeriveInput,
  type StageJobSnapshot,
} from "../lib/studio/productionProgress";
import { PRODUCTION_STAGES } from "../lib/createFlow";

let passed = 0,
  failed = 0;
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
function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);
const job = (over: Partial<StageJobSnapshot> = {}): StageJobSnapshot => ({
  status: "running",
  error: null,
  createdAtMs: NOW - 30_000,
  updatedAtMs: NOW - 30_000,
  ...over,
});

function input(over: Partial<DeriveInput> = {}): DeriveInput {
  return {
    status: "draft",
    hasScript: false,
    nowMs: NOW,
    episodeUpdatedAtMs: NOW - 10_000,
    jobs: new Map(),
    voicing: null,
    typicalMsByJobType: new Map(),
    mixStartedAtMs: null,
    mixFailureReason: null,
    ...over,
  };
}
const stageOf = (r: ReturnType<typeof deriveProduction>, key: string) => {
  const s = r.stages.find((x) => x.key === key);
  if (!s) throw new Error(`no stage ${key}`);
  return s;
};

async function run() {
  console.log("\nProduction progress rules\n");

  // ---- Stage mapping ------------------------------------------------------
  check("no script + script job running → script stage, real elapsed, no counted progress", () => {
    const r = deriveProduction(input({ jobs: new Map([["script", job()]]) }));
    assert(r.stage === "script", `stage was ${r.stage}`);
    const s = stageOf(r, "script");
    assert(s.state === "active", `state was ${s.state}`);
    assert(s.elapsedMs === 30_000, `elapsed was ${s.elapsedMs}`);
    assert(s.progress === null, "script must never carry counted progress");
    assert(r.headline === "Writing the script", `headline was ${r.headline}`);
    assert(!r.done && !r.failure && !r.stalled, "should be plainly running");
  });

  check("script_draft → human checkpoint, not a busy state", () => {
    const r = deriveProduction(input({ status: "script_draft", hasScript: true }));
    assert(r.stage === "review", `stage was ${r.stage}`);
    assert(stageOf(r, "review").state === "checkpoint", "review must be a checkpoint");
    assert(r.awaitingUser, "awaitingUser should be set");
    assert(r.headline === "Your read is next", `headline was ${r.headline}`);
    assert(r.pollAfterMs === 10000, "should slow-poll while waiting on the user");
  });

  check("earlier stages read done, later stages read todo", () => {
    const r = deriveProduction(input({ status: "fact_checked", hasScript: true }));
    assert(r.stage === "voices", `stage was ${r.stage}`);
    assert(stageOf(r, "script").state === "done", "script should be done");
    assert(stageOf(r, "review").state === "done", "review should be done");
    assert(stageOf(r, "factcheck").state === "done", "factcheck should be done");
    assert(stageOf(r, "mix").state === "todo", "mix should be todo");
    assert(stageOf(r, "assets").state === "todo", "assets should be todo");
  });

  check("completed stages report their real recorded duration", () => {
    const r = deriveProduction(
      input({
        status: "fact_checked",
        hasScript: true,
        jobs: new Map([["script", job({ status: "completed", createdAtMs: NOW - 300_000, updatedAtMs: NOW - 180_000 })]]),
      })
    );
    assert(stageOf(r, "script").elapsedMs === 120_000, `elapsed was ${stageOf(r, "script").elapsedMs}`);
  });

  check("terminal statuses → done, polling stops", () => {
    for (const status of ["content_ready", "publish_ready", "published"]) {
      const r = deriveProduction(input({ status, hasScript: true }));
      assert(r.done, `${status} should be done`);
      assert(r.pollAfterMs === 0, `${status} should stop polling`);
      assert(r.stages.every((s) => s.state === "done"), `${status} should mark every stage done`);
      assert(r.headline === "Episode ready", `${status} headline was ${r.headline}`);
    }
  });

  // ---- Honest progress affordances ---------------------------------------
  check("voicing is the only stage allowed a counted bar", () => {
    const r = deriveProduction(
      input({
        status: "fact_checked",
        hasScript: true,
        jobs: new Map([["voices", job()]]),
        voicing: { done: 30, total: 120, failed: 0, unit: "lines" },
      })
    );
    assert(stageOf(r, "voices").progress?.done === 30, "voices should carry progress");
    assert(stageOf(r, "voices").progress?.total === 120, "voices should carry the denominator");
    const others = r.stages.filter((s) => s.key !== "voices");
    assert(others.every((s) => s.progress === null), "no other stage may carry counted progress");
  });

  check("scene mode reports a count with no denominator (never a fake percentage)", () => {
    const r = deriveProduction(
      input({
        status: "fact_checked",
        hasScript: true,
        jobs: new Map([["voices", job()]]),
        voicing: { done: 3, total: null, failed: 0, unit: "scenes" },
      })
    );
    const p = stageOf(r, "voices").progress;
    assert(p?.total === null, "scene mode must not invent a denominator");
    assert(p?.done === 3 && p?.unit === "scenes", "scene count should pass through");
  });

  check("typical durations attach by job type, and only where history exists", () => {
    const r = deriveProduction(
      input({
        jobs: new Map([["script", job()]]),
        typicalMsByJobType: new Map([["generate:script", 150_000]]),
      })
    );
    assert(stageOf(r, "script").typicalMs === 150_000, "script should get its median");
    assert(stageOf(r, "voices").typicalMs === null, "no history → no claim");
    assert(stageOf(r, "review").typicalMs === null, "a human checkpoint has no job median");
  });

  // ---- Failure, despite the status rollback -------------------------------
  check("failed job is reported failed even though Episode.status rolled back", () => {
    // The worker never writes status "failed"; after a failed script job the
    // episode still reads "draft", exactly as if it had never started.
    const r = deriveProduction(
      input({
        status: "draft",
        hasScript: false,
        jobs: new Map([["script", job({ status: "failed", error: "Anthropic 429 rate limit", updatedAtMs: NOW - 5_000 })]]),
      })
    );
    assert(stageOf(r, "script").state === "failed", "script should read failed");
    assert(r.failure?.stage === "script", "failure should name the stage");
    assert(r.headline === "Script failed", `headline was ${r.headline}`);
    assert(!r.stalled, "a failure is not a stall");
    assert(r.pollAfterMs === 10000, "should keep slow-polling in case it is retried elsewhere");
  });

  check("mix failure is picked up from the render row when no job log failed", () => {
    const r = deriveProduction(
      input({
        status: "audio_segments_ready",
        hasScript: true,
        mixFailureReason: "ffmpeg_filtergraph_error",
        jobs: new Map(),
      })
    );
    assert(stageOf(r, "mix").state === "failed", "mix should read failed");
    assert(r.failure?.message === "ffmpeg_filtergraph_error", `message was ${r.failure?.message}`);
  });

  check("a render failure does not taint a stage the episode already passed", () => {
    const r = deriveProduction(
      input({ status: "content_generating", hasScript: true, mixFailureReason: "old_failure" })
    );
    assert(stageOf(r, "mix").state === "done", "already-passed mix stays done");
    assert(r.failure === null, "a stale render failure must not stop the console");
  });

  // ---- Stall detection ----------------------------------------------------
  check("no running job + nothing moving for a long time → stalled", () => {
    const r = deriveProduction(
      input({ status: "fact_checked", hasScript: true, episodeUpdatedAtMs: NOW - STALL_AFTER_MS - 1000 })
    );
    assert(r.stalled, "should be stalled");
    assert(r.headline === "Waiting for a production worker", `headline was ${r.headline}`);
  });

  check("a running job is never stalled, however long it has run", () => {
    const r = deriveProduction(
      input({
        status: "fact_checked",
        hasScript: true,
        episodeUpdatedAtMs: NOW - STALL_AFTER_MS * 5,
        jobs: new Map([["voices", job({ createdAtMs: NOW - STALL_AFTER_MS * 5 })]]),
      })
    );
    assert(!r.stalled, "long-running is not stalled");
  });

  check("a running mix render counts as activity", () => {
    const r = deriveProduction(
      input({
        status: "audio_stitching",
        hasScript: true,
        episodeUpdatedAtMs: NOW - STALL_AFTER_MS * 2,
        mixStartedAtMs: NOW - 60_000,
      })
    );
    assert(!r.stalled, "an open render row means work is in flight");
    assert(stageOf(r, "mix").elapsedMs === 60_000, `mix elapsed was ${stageOf(r, "mix").elapsedMs}`);
  });

  check("waiting on the user is never reported as stalled", () => {
    const r = deriveProduction(
      input({ status: "script_draft", hasScript: true, episodeUpdatedAtMs: NOW - STALL_AFTER_MS * 10 })
    );
    assert(!r.stalled, "a checkpoint is the user's turn, not a stall");
    assert(r.awaitingUser, "should still be awaitingUser");
  });

  // ---- Failure text -------------------------------------------------------
  check("failure text is humanised for the cases we recognise", () => {
    assert(humanFailure("Fish 402 insufficient_credit").includes("billing"), "402 → billing");
    assert(humanFailure("Error: rate limit exceeded").includes("rate-limited"), "429 → rate limited");
    assert(humanFailure("ETIMEDOUT contacting provider").includes("timed out"), "timeout → timed out");
    assert(humanFailure("").includes("failed"), "empty → generic but honest");
    assert(humanFailure(null).includes("failed"), "null → generic but honest");
  });

  check("an unrecognised failure is passed through, not hidden", () => {
    assert(humanFailure("weird planner explosion") === "weird planner explosion", "should pass through verbatim");
    const long = "x".repeat(400);
    const out = humanFailure(long);
    assert(out.length === 218 && out.endsWith("…"), `truncated length was ${out.length}`);
  });

  // ---- Model integrity ----------------------------------------------------
  check("every non-checkpoint stage maps to a real job type and match key", () => {
    for (const s of PRODUCTION_STAGES) {
      if (s.checkpoint) {
        assert(s.jobType === null && s.matchBy === null, `${s.key}: a checkpoint has no job`);
      } else {
        assert(!!s.jobType && !!s.matchBy, `${s.key}: needs a jobType and matchBy`);
        assert(s.matchBy === "episodeId" || s.matchBy === "scriptId", `${s.key}: bad matchBy`);
      }
    }
    // Only generate:script carries an episodeId in JobLog.input (worker.ts);
    // every downstream job is keyed by scriptId.
    const byEpisode = PRODUCTION_STAGES.filter((s) => s.matchBy === "episodeId").map((s) => s.jobType);
    assert(
      byEpisode.length === 1 && byEpisode[0] === "generate:script",
      `only generate:script is episode-keyed, got ${JSON.stringify(byEpisode)}`
    );
  });

  check("exactly one stage is marked determinate — voicing", () => {
    const det = PRODUCTION_STAGES.filter((s) => s.determinate).map((s) => s.key);
    assert(det.length === 1 && det[0] === "voices", `determinate stages: ${JSON.stringify(det)}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
