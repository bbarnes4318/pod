// D-01 — the production chain, and the one human checkpoint that drives it.
//
// The defect: lib/createFlow declares exactly one stage as a human checkpoint
// (`review`), yet NOTHING chained the rest. After generate:script the pipeline
// stopped dead. The only triggers for fact-check / voices / mix / notes lived in
// the Basic-Auth /admin console, and the studio's own server actions
// (approveEpisodeScript, castEpisodeVoices) had zero UI callers — dead code.
//
// The customer-visible result: the console said "Nothing is voiced until you
// approve the draft — read it, edit any line, then approve", and no control
// containing the word "approve" existed anywhere on the episode page. The three
// links that did move an episode were labelled "(ops)", pointed at /admin, and
// returned 401 onto a blank error page with no way back.
//
// These are structural + pure assertions. The full click-through lives in
// tests/e2e/production-chain.spec.ts; this file guards the rules cheaply.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { nextProductionJobFor, PRODUCTION_STAGES } from "../lib/createFlow";
import {
  assertSceneGenerationComplete,
  PartialSceneGenerationError,
  readSceneQaAttemptLimit,
} from "../lib/audio/sceneGenerationOutcome";
import { EPISODE_STATUS_LADDER } from "../lib/episodeStatus";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const worker = src("lib/queue/worker.ts");
const dispatch = src("lib/services/stitchDispatch.ts");
const console_ = src("app/studio/ProductionConsole.tsx");

/** The body of a worker handler, so a match cannot come from elsewhere in the file. */
function handlerBody(name: string): string {
  const start = worker.indexOf(`async function ${name}(`);
  assert(start !== -1, `handler ${name} not found`);
  const next = worker.indexOf("\nasync function ", start + 1);
  return worker.slice(start, next === -1 ? worker.length : next);
}

console.log("Production chain + approval checkpoint\n");

check("exactly one stage is a human checkpoint, and it is the script review", () => {
  const cps = PRODUCTION_STAGES.filter((s) => s.checkpoint);
  assert(cps.length === 1, `expected 1 checkpoint stage, got ${cps.length}: ${cps.map((c) => c.key).join(",")}`);
  assert(cps[0].key === "review", `the checkpoint should be 'review', got '${cps[0].key}'`);
});

check("every non-checkpoint stage after the script has a chain rule", () => {
  // If a stage is not waiting on a human, something must start it. These are the
  // three transitions that had no trigger at all outside /admin.
  assert(nextProductionJobFor("fact_checked") === "tts:generate-segments", "fact_checked must chain voicing");
  assert(nextProductionJobFor("audio_segments_ready") === "audio:stitch-final", "voiced must chain the mix");
  assert(nextProductionJobFor("audio_ready") === "content:generate-assets", "a finished master must chain show notes");
});

check("statuses that did NOT advance chain nothing", () => {
  // Chaining off a job that completed without moving the episode is how a queue
  // looks busy while producing nothing.
  for (const s of ["draft", "script_draft", "script_approved", "audio_stitching"]) {
    assert(nextProductionJobFor(s) === null, `status '${s}' must not chain (got ${nextProductionJobFor(s)})`);
  }
});

check("a produced episode is never re-chained by a forced re-mix", () => {
  // audio_ready chains notes once; published/publish_ready/content_ready must not
  // regenerate assets when an operator re-mixes.
  for (const s of ["content_generating", "content_ready", "publish_ready", "published"]) {
    assert(nextProductionJobFor(s) === null, `already-produced status '${s}' must not chain (got ${nextProductionJobFor(s)})`);
  }
});

check("every ladder status is accounted for — a new rung forces a decision", () => {
  const unknown = EPISODE_STATUS_LADDER.filter(
    (s) => nextProductionJobFor(s) === null && !["draft", "script_draft", "script_approved", "audio_stitching", "content_generating", "content_ready", "publish_ready", "published"].includes(s)
  );
  assert(unknown.length === 0, `these statuses have no explicit chain decision: ${unknown.join(", ")}`);
});

check("the worker actually calls the chain after fact-check, voices and mix", () => {
  for (const [handler, why] of [
    ["handleFactChecking", "an approved+passing script must start voicing"],
    ["handleTtsSegmentGeneration", "a voiced script must start the mix"],
    ["handleFinalAudioStitching", "a finished master must start show notes"],
  ] as const) {
    assert(/chainProductionStage\(/.test(handlerBody(handler)), `${handler} must chain — ${why}`);
  }
});

check("scene QA retries inside the active voice stage before it can fail", () => {
  assert(/readSceneQaAttemptLimit\(\)/.test(dispatch), "scene dispatch must use a bounded internal QA attempt limit");
  assert(/while \(!sceneGenerationIsComplete\(summary\) && qaAttempt < maxAttempts\)/.test(dispatch), "failed scenes must retry inside the active stage");
  assert(/forceRegenerate: false/.test(dispatch), "retry passes must preserve ready scene fingerprints");
  const loopAt = dispatch.indexOf("while (!sceneGenerationIsComplete(summary)");
  const guardAt = dispatch.indexOf("assertSceneGenerationComplete(summary, qaAttempt)");
  const returnAt = dispatch.indexOf("return { pipeline: summary.mode", guardAt);
  assert(loopAt !== -1 && guardAt > loopAt, "the completeness guard must run after the internal retry loop");
  assert(returnAt > guardAt, "the completeness guard must run before scene dispatch returns success");
});

check("exhausted scene QA is unrecoverable, while unexpected TTS failures keep normal queue retries", () => {
  assert(/import \{ UnrecoverableError \} from "bullmq"/.test(dispatch), "dispatch must use BullMQ's unrecoverable error for exhausted QA");
  assert(/error instanceof PartialSceneGenerationError/.test(dispatch), "only the typed partial-scene outcome may stop queue retries");
  assert(/throw new UnrecoverableError\(error\.message\)/.test(dispatch), "exhausted scene QA must not multiply into another full job retry");
});

check("scene QA attempt configuration is bounded and safe", () => {
  assert(readSceneQaAttemptLimit("") === 3, "unset attempt limit should default to 3");
  assert(readSceneQaAttemptLimit("0") === 1, "attempt limit must never drop below 1");
  assert(readSceneQaAttemptLimit("99") === 5, "attempt limit must be capped at 5");
  assert(readSceneQaAttemptLimit("garbage") === 3, "invalid attempt limit should use the default");
});

check("partial scene generation is rejected only after the retry budget is exhausted", () => {
  let thrown: unknown = null;
  try {
    assertSceneGenerationComplete(
      {
        sceneCount: 11,
        readyScenes: 9,
        failedScenes: 2,
        scenes: [
          { sceneIndex: 4, lineRange: [24, 31], status: "failed", errorCategory: "quality_gate_failed" },
          { sceneIndex: 8, lineRange: [47, 54], status: "failed", errorCategory: "quality_gate_failed" },
        ],
      },
      3
    );
  } catch (err) {
    thrown = err;
  }
  assert(thrown instanceof PartialSceneGenerationError, "partial scene output must throw a typed error after retries");
  assert(thrown.failedSceneIndexes.join(",") === "4,8", `expected failed scenes 4,8, got ${thrown.failedSceneIndexes.join(",")}`);
  assert(thrown.attemptsMade === 3, `expected 3 attempts, got ${thrown.attemptsMade}`);
  assert(/9 completed scenes are saved/.test(thrown.message), "error must say ready scenes are preserved");
  assert(/only the failed scenes will be regenerated/.test(thrown.message), "error must explain the targeted retry");
  assert(/Final mixing remains paused/.test(thrown.message), "error must say mixing is paused");
});

check("a complete scene generation passes the guard", () => {
  assertSceneGenerationComplete({
    sceneCount: 2,
    readyScenes: 2,
    failedScenes: 0,
    scenes: [
      { sceneIndex: 0, lineRange: [0, 3], status: "ready" },
      { sceneIndex: 1, lineRange: [4, 7], status: "ready" },
    ],
  });
});

check("a chain failure is recorded, never swallowed", () => {
  assert(/chainEnqueueError/.test(worker), "the enqueue failure must be surfaced on the job output");
  assert(/chainSkippedReason/.test(worker), "a deliberate skip must be distinguishable from a failure");
});

check("the console renders a real APPROVE control at the checkpoint", () => {
  // The regression being guarded: the checkpoint used to render only
  // `<a href="#transcript">Read the draft →</a>` — a scroll anchor. The word
  // "approve" appeared on the page exactly once, in the instruction telling the
  // customer to do it.
  assert(/prod-approve-cta/.test(console_), "the checkpoint needs an approve CTA with a stable test id");
  assert(/approveEpisodeScript/.test(console_), "the CTA must call the real owner-gated approval action");
  // The control moved out of the checkpoint ROW and into the console header
  // during the Studio UX rebuild: when the studio is waiting on the operator,
  // the button that unblocks it belongs beside the status lamp, not 363px down
  // a six-stage rundown. It renders in one place or the other, never both.
  //
  // Anchoring on the CONTROL rather than on the block it happens to sit in
  // keeps this contract honest through layout changes while still catching the
  // regression it exists for: an anchor link masquerading as an action.
  const ctaAt = console_.indexOf('data-testid="prod-approve-cta"');
  assert(ctaAt !== -1, "the approve CTA was not found");
  const openedAt = console_.lastIndexOf("<", ctaAt);
  assert(
    console_.slice(openedAt).startsWith("<button"),
    "the checkpoint's primary control must be a button, not only a link"
  );
  assert(/onClick=\{onApprove\}/.test(console_), "the approve CTA must be wired to the approval handler");
  // Still gated on the checkpoint state: the button must not be offered when
  // the pipeline is not actually waiting on a human.
  assert(
    /active\?\.state === "checkpoint"/.test(console_),
    "the approve CTA must only render while the active stage is the human checkpoint"
  );
});

check("the approval gate's own reasons are rendered to the customer", () => {
  // approveEpisodeLatestScript returns { success:false, reasons:[...] } listing
  // exactly what is wrong. A correct refusal the screen never shows is half a guard.
  assert(/approveReasons/.test(console_), "gate reasons must be held in state");
  assert(/prod-approve-error/.test(console_), "gate failure needs an addressable, asserted-on region");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
