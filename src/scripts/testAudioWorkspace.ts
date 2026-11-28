// Audio workspace self-check (no DB, no browser): measured-QA extraction stays
// honest (no invented numbers), waveform peaks are real maxima, and the mix
// view's cue/QA query is scoped to the script rather than a global scan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { measuredFromJobOutput } from "@/lib/audio/measuredQa";
import { peaksFrom } from "@/app/studio/MixWaveform";

let passed = 0;
const ok = (name: string, fn: () => void) => { fn(); passed++; console.log(`  ok  ${name}`); };
const at = new Date("2026-11-28T00:00:00Z");

ok("no QA in output -> null (nothing invented)", () => {
  assert.equal(measuredFromJobOutput({ finalAudioUrl: "x" }, at), null);
  assert.equal(measuredFromJobOutput(null, at), null);
});
ok("reads stitch-final audioQa", () => {
  const m = measuredFromJobOutput({ audioQa: { metrics: { integratedLufs: -16.2, truePeakDb: -1.1, loudnessRangeLu: 6, maxSilenceGapSec: 1.4 }, checks: [{ name: "Loudness", status: "pass", value: "-16.2 LUFS", detail: "" }] } }, at)!;
  assert.equal(m.integratedLufs, -16.2);
  assert.equal(m.truePeakDb, -1.1);
  assert.equal(m.checks.length, 1);
  assert.equal(m.measuredAt, at.toISOString());
});
ok("reads line-regen nested stitch.audioQa", () => {
  const m = measuredFromJobOutput({ stitch: { audioQa: { metrics: { integratedLufs: -15 }, checks: [] } } }, at)!;
  assert.equal(m.integratedLufs, -15);
});
ok("missing/garbage metrics stay null, bad checks dropped", () => {
  const m = measuredFromJobOutput({ audioQa: { metrics: { integratedLufs: "loud", truePeakDb: NaN }, checks: [{ name: "x", status: "great" }, null] } }, at)!;
  assert.equal(m.integratedLufs, null);
  assert.equal(m.truePeakDb, null);
  assert.equal(m.loudnessRangeLu, null);
  assert.equal(m.checks.length, 0);
});
ok("peaksFrom returns real per-bucket maxima", () => {
  const s = new Float32Array([0, 0.5, -0.9, 0.1, 0, 0, 0.2, -0.3]);
  assert.deepEqual(peaksFrom(s, 2).map((v) => +v.toFixed(2)), [0.9, 0.3]);
  assert.deepEqual(peaksFrom(new Float32Array(0), 3), [0, 0, 0]);
  assert.equal(peaksFrom(new Float32Array([2]), 1)[0], 1);
  assert.equal(peaksFrom(new Float32Array(10), 50).length, 50);
});
ok("mix view query is scoped to the script and skips failed runs", () => {
  const src = readFileSync("src/lib/services/mixView.ts", "utf8");
  assert.match(src, /input: \{ path: \["scriptId"\], equals: script\.id \}/);
  assert.match(src, /status: \{ in: \["completed", "completed_with_errors"\] \}/);
  assert.doesNotMatch(src, /take: 25/);
});
ok("workspace shows measured panel and real waveform", () => {
  const src = readFileSync("src/app/studio/MixView.tsx", "utf8");
  assert.match(src, /<MeasuredPanel m=\{vm\.measured\} \/>/);
  assert.match(src, /<MixWaveform url=\{vm\.episodeAudioUrl\}/);
  const wave = readFileSync("src/app/studio/MixWaveform.tsx", "utf8");
  assert.match(wave, /decodeAudioData/);
  assert.match(wave, /Waveform unavailable/);
});

console.log(`\nAudio workspace: ${passed} passed, 0 failed`);
