// Show notes must not fail on a scene-voiced episode.
//
// Found by the Phase 4 verification run. The episode reached the LAST stage of
// six with everything done — script, review, fact-check, voices, mix all green,
// a real 11m23s MP3 in object storage — and then:
//
//   content:generate-assets  FAILED  "Line 0 does not have a matching AudioSegment."
//
// Cause: two voicing paths write to two different tables. The legacy per-line
// path writes AudioSegment; scene mode writes DialogueSceneAudio. The stitcher
// understands both, which is why the mix succeeded. This stage only ever read
// AudioSegment, so a finished episode was declared broken by the one stage that
// merely describes it. Measured on the failing episode: 13 DialogueSceneAudio
// rows, 0 AudioSegment rows.
//
// Per-line rows are used here for exactly one thing: exact chapter timestamps.
// The service already estimates a duration from word count when a row is missing
// and already reports that by leaving timestampsApproximate = true. So the
// correct outcome for a scene-voiced episode is APPROXIMATE CHAPTERS, never a
// dead episode.
//
// This was pre-existing: nothing chained the assets stage before, so it had
// never run automatically and the trap had never been sprung.

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

const svc = readFileSync(join(__dirname, "..", "lib", "services", "contentAssetService.ts"), "utf8");

console.log("Scene-voiced episodes can still get show notes\n");

check("the service detects scene-voiced episodes", () => {
  assert(/sceneVoiced/.test(svc), "there must be an explicit scene-voiced determination");
  assert(/dialogueSceneAudio\.count/.test(svc),
    "it must be decided by the presence of real DialogueSceneAudio rows, not by guessing from an empty AudioSegment list");
});

check("a missing per-line row is skipped for scene-voiced, still fatal otherwise", () => {
  const at = svc.indexOf("does not have a matching AudioSegment");
  assert(at !== -1, "the legacy assertion must still exist for legacy episodes");
  const before = svc.slice(Math.max(0, at - 400), at);
  assert(/if \(sceneVoiced\) continue;/.test(before),
    "scene-voiced episodes must skip the per-line requirement rather than throw");
});

check("the scene-voiced path is announced, not silent", () => {
  // A silently different chapter-timing path is how you get chapters that are
  // wrong and nobody knows why.
  assert(/scene-voiced \(no per-line AudioSegment rows\)/.test(svc), "the fallback must log what it is doing");
  assert(/approximate/i.test(svc), "the log must say the timestamps are estimated");
});

check("no downstream code dereferences a per-line row that cannot exist", () => {
  // Skipping the guard at the top is only half the fix — the transcript JSON
  // then read matchingSeg.id and died with "Cannot read properties of undefined
  // (reading 'id')" on the SECOND run. Every read of a per-line row after the
  // scene-voiced skip must tolerate its absence.
  assert(/audioSegmentId: matchingSeg \? matchingSeg\.id : null/.test(svc),
    "the transcript's audioSegmentId must be nullable — it is a provenance pointer, not content");
  // The other three reads were already optional-chained or truthiness-guarded;
  // assert they stay that way.
  assert(/let dur = as\?\.durationMs \|\| 0;/.test(svc), "duration read must stay optional-chained");
  assert(/return as && as\.durationMs && as\.durationMs > 0;/.test(svc), "exactness check must stay guarded");
});

check("approximate timestamps are still reported as approximate", () => {
  // The honesty guarantee: estimated chapters must not claim to be exact.
  assert(/timestampsApproximate/.test(svc), "the flag must still exist");
  assert(/allSegmentsHaveDuration/.test(svc),
    "exactness must still be derived from real durations — a scene-voiced episode has none, so it stays approximate");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
