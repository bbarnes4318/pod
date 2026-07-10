// Pause-variety QA test. Run: npm run test:pause-variety
//
// Guards the honest pacing metric (scorePauseVariety in src/lib/audio/audioQa.ts)
// against the two things it must separate:
//   - the real v3 "Guts and the Garbage" pause plan (none 24 / beat 30 /
//     breath 4 / long 5) MUST PASS, and
//   - a synthetic metronome script (every line the same beat) MUST FAIL.
//
// The old check measured σ of silence detected in the mastered mix, which the
// ducked music bed masks and the 0.15s floor truncates — so it reported
// "σ=0.00 over 2 pauses" and failed even a perfectly-paced script. This test
// locks in a metric that grades the pacing we actually author. Pure: no ffmpeg,
// no DB.

import { scorePauseVariety, ScriptedPause } from "../lib/audio/audioQa";

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
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Expand a {kind: count} histogram into a flat pause array. */
function expand(hist: Partial<Record<ScriptedPause, number>>): ScriptedPause[] {
  const out: ScriptedPause[] = [];
  (Object.keys(hist) as ScriptedPause[]).forEach((k) => {
    for (let i = 0; i < (hist[k] ?? 0); i++) out.push(k);
  });
  return out;
}

// The actual shipped v3 pause distribution.
const V3_PAUSES = expand({ none: 24, beat: 30, breath: 4, long: 5 });

// Synthetic uniform-pause fixture: 63 lines, every one the same "beat".
// This is exactly the robotic pacing the check exists to catch.
const UNIFORM_PAUSES: ScriptedPause[] = Array.from({ length: 63 }, () => "beat");

function main() {
  console.log("Pause-variety metric:");

  check("v3 pause plan PASSES (meaningful spread + a 'long' beat)", () => {
    const s = scorePauseVariety(V3_PAUSES);
    console.log(`      v3 → ${s.value} [${s.status}]`);
    assert(s.status === "pass", `expected pass, got ${s.status} (${s.value})`);
    assert(s.hasLong, "v3 has 'long' pauses");
    assert(s.stdDevMs !== null && s.stdDevMs >= 150, `expected σ ≥ 150ms, got ${s.stdDevMs}`);
    assert(s.count === 63, `expected 63 pauses, got ${s.count}`);
  });

  check("uniform metronome fixture FAILS (σ=0, no 'long')", () => {
    const s = scorePauseVariety(UNIFORM_PAUSES);
    console.log(`      uniform → ${s.value} [${s.status}]`);
    assert(s.status === "fail", `expected fail, got ${s.status} (${s.value})`);
    assert(s.stdDevMs === 0, `expected σ=0, got ${s.stdDevMs}`);
    assert(!s.hasLong, "uniform fixture must have no 'long' beats");
  });

  check("spread but no 'long' only WARNS (not a pass)", () => {
    // Alternating none/breath: real spread, but the script never breathes long.
    const s = scorePauseVariety(
      Array.from({ length: 40 }, (_, i): ScriptedPause => (i % 2 ? "breath" : "none"))
    );
    console.log(`      no-long → ${s.value} [${s.status}]`);
    assert(s.status !== "pass", "missing 'long' must not pass");
    assert(!s.hasLong, "fixture has no long");
  });

  check("no script data reports n/a as a warning, never a spurious fail", () => {
    const s = scorePauseVariety([]);
    assert(s.status === "warning", `empty should warn, got ${s.status}`);
    assert(s.stdDevMs === null, "no data => null σ");
  });

  check("undefined pauseBefore maps to 'beat' (mirrors planConversationTimeline)", () => {
    const s = scorePauseVariety([undefined, undefined, null]);
    assert(s.histogram.beat === 3, `expected 3 beats, got ${s.histogram.beat}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
