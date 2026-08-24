// Stage chaining: the two links whose absence made the pipeline silently
// non-functional rather than loudly broken.
//
//   generate:topics  -> generate:research-brief
//   build:episode    -> generate:script
//
// Neither existed. The consequences were invisible because both upstream jobs
// reported "completed":
//
//   * A topic with no research brief scores ~10 talkability against a minimum
//     of 35 (talkability is computed almost entirely FROM the brief), so it is
//     not a weak topic — it is permanently unpickable. 39 of 95 topics in
//     production were in that state.
//   * A built episode sat at 'draft' forever. The recurring scheduler and
//     /app/create both enqueue build:episode and nothing else, so every
//     scheduled episode was a dead draft.
//
// These are structural assertions over the worker source. The alternative is
// booting BullMQ and Redis to observe an enqueue, which tests the queue library
// rather than the wiring — and the wiring is what was missing.

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const worker = readFileSync(join(__dirname, "..", "lib", "queue", "worker.ts"), "utf8");
/** The body of a handler, so an assertion cannot be satisfied by a match
 *  somewhere else in this 2500-line file. */
function handlerBody(name: string): string {
  const start = worker.indexOf(`async function ${name}(`);
  assert(start !== -1, `handler ${name} not found`);
  const next = worker.indexOf("\nasync function ", start + 1);
  return worker.slice(start, next === -1 ? worker.length : next);
}

console.log("Pipeline stage chaining\n");

check("the enqueuers are imported into the worker at all", () => {
  assert(/import \{[^}]*queueScriptGenerationJob[^}]*\} from "\.\/podcastQueue"/.test(worker),
    "queueScriptGenerationJob must be imported — without it build:episode cannot chain");
  assert(/import \{[^}]*queueResearchBriefGenerationJob[^}]*\} from "\.\/podcastQueue"/.test(worker),
    "queueResearchBriefGenerationJob must be imported — without it topics never get briefs");
});

check("build:episode CHAINS script generation", () => {
  const body = handlerBody("handleEpisodeBuilding");
  assert(/queueScriptGenerationJob\(/.test(body),
    "handleEpisodeBuilding must enqueue script generation. Without it the episode stays at 'draft' forever " +
      "while the job reports 'completed' — which is how scheduled recurring generation was silently dead.");
  assert(/episodeId: res\.episodeId/.test(body), "the chained job must target the episode just built");
});

check("build:episode reports FAILED when the script could not be queued", () => {
  const body = handlerBody("handleEpisodeBuilding");
  assert(/scriptEnqueueError \? "failed" : "completed"/.test(body),
    "an episode nothing will advance is not a completed build — the job log must say so");
  assert(/stuck at 'draft'/.test(body), "the error must name the actual consequence, not just the failure");
});

check("build:episode surfaces whether the script was queued", () => {
  const body = handlerBody("handleEpisodeBuilding");
  assert(/scriptEnqueued: !!scriptJobId/.test(body), "the job output must record whether the next stage started");
  assert(/scriptJobId/.test(body), "the chained job id must be recorded so an operator can follow it");
});

check("generate:topics CHAINS research-brief generation for every new topic", () => {
  const body = handlerBody("handleTopicGeneration");
  assert(/queueResearchBriefGenerationJob\(/.test(body),
    "handleTopicGeneration must enqueue a research brief per inserted topic. Talkability is scored from the " +
      "brief, so an unbriefed topic scores ~10 against a minimum of 35 and can never be picked.");
  assert(/insertedTopicIds/.test(body), "briefs must be queued for the topics actually inserted, not re-queried");
});

check("one failed brief enqueue does not lose the rest", () => {
  const body = handlerBody("handleTopicGeneration");
  // MATCH THE LOOP BY ITS SUBJECT, NOT ITS EXACT HEADER. This searched for the
  // literal `for (const topicId of insertedTopicIds)`, which stopped existing
  // when the loop started carrying an index for the stagger delay
  // (`for (const [briefIndex, topicId] of insertedTopicIds.entries())`).
  // indexOf then returned -1, slice(-1) handed the assertion the last character
  // of the handler, and the check failed against code that was — and still is —
  // correctly guarded. A test that reports a defect the source does not have
  // costs more than no test: it trains you to read red as noise.
  const loopStart = body.search(/for \(const [^)]*insertedTopicIds/);
  assert(loopStart >= 0, "the per-topic brief enqueue loop over insertedTopicIds must exist");
  const loop = body.slice(loopStart);
  assert(/try \{/.test(loop) && /catch/.test(loop),
    "the per-topic enqueue must be individually guarded — one failure must not abort the other topics' briefs");
});

check("brief coverage is visible in the job output, not only the console", () => {
  const body = handlerBody("handleTopicGeneration");
  assert(/briefJobsQueued,/.test(body), "briefJobsQueued must be in the job output an operator reads");
  assert(/briefEnqueueErrors/.test(body), "enqueue failures must be recorded, not just logged");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
