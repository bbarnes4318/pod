// Two defects visible in the PUBLISHED product, found by the Phase 4 run.
//
// D-18  Chapter timestamps in the live RSS feed read
//         "1:13.599999999999994 — Intro"
//         "12:6.7000000000000455 — Closing"
//       Float noise, and no zero-padding on the seconds.
//
// D-19  Every episode page load logged two console errors:
//         "Access to fetch at 'https://take-machine-media…/scene-final-v1.mp3'"
//         "Failed to load resource: net::ERR_FAILED"
//       A best-effort waveform decode fetched the master straight from object
//       storage, which serves no Access-Control-Allow-Origin header — so it
//       could never succeed and always fell back to the pseudo waveform. The
//       fallback was the real behaviour; the request only added noise.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatChapterTime as formatTime } from "../lib/chapterTime";

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

console.log("Published artifacts\n");


check("D-18: the exact values from the live feed now format correctly", () => {
  // Verbatim startTimeSeconds from the published episode.
  assert(formatTime(73.599999999999994) === "1:14", `got ${formatTime(73.599999999999994)}`);
  assert(formatTime(726.7000000000000455) === "12:07", `got ${formatTime(726.7000000000000455)}`);
  assert(formatTime(30.9) === "0:31", `got ${formatTime(30.9)}`);
  assert(formatTime(314.100000000000023) === "5:14", `got ${formatTime(314.100000000000023)}`);
});

check("D-18: seconds are always two digits", () => {
  for (const [sec, want] of [[0, "0:00"], [5, "0:05"], [65, "1:05"], [600, "10:00"], [3599, "59:59"]] as const) {
    assert(formatTime(sec) === want, `formatTime(${sec}) = ${formatTime(sec)}, want ${want}`);
  }
});

check("D-18: hours roll over with padded minutes and seconds", () => {
  assert(formatTime(3600) === "1:00:00", `got ${formatTime(3600)}`);
  assert(formatTime(3661) === "1:01:01", `got ${formatTime(3661)}`);
});

check("D-18: no output can ever contain a decimal point", () => {
  // The defect's signature. Fuzz the shape rather than a fixed list.
  for (let i = 0; i < 500; i++) {
    const sec = (i * 7.3331) % 4000;
    const out = formatTime(sec);
    assert(!out.includes("."), `formatTime(${sec}) produced "${out}"`);
    assert(/^\d+:\d{2}(:\d{2})?$/.test(out), `formatTime(${sec}) produced malformed "${out}"`);
  }
});

check("D-18: garbage in does not produce garbage out", () => {
  assert(formatTime(NaN) === "0:00", `NaN -> ${formatTime(NaN)}`);
  assert(formatTime(-5) === "0:00", `negative -> ${formatTime(-5)}`);
});

check("D-19: the waveform decode is skipped for cross-origin audio", () => {
  const player = readFileSync(join(__dirname, "..", "app", "studio", "episodes", "[id]", "StudioPlayer.tsx"), "utf8");
  assert(/const sameOrigin =/.test(player), "there must be an explicit same-origin determination");
  assert(/if \(!sameOrigin\) return;/.test(player), "a cross-origin master must not be fetched at all");
  assert(/window\.location\.origin/.test(player), "the check must compare against the page's real origin");
});

check("D-19: the decode still runs when the audio IS same-origin", () => {
  // The fix must not delete the feature — a same-origin proxy added later
  // should light this up with no further change.
  const player = readFileSync(join(__dirname, "..", "app", "studio", "episodes", "[id]", "StudioPlayer.tsx"), "utf8");
  assert(/await fetch\(audioUrl, \{ mode: "cors" \}\)/.test(player), "the decode path must still exist");
  assert(/decodeAudioData/.test(player), "the real waveform decode must still exist");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
