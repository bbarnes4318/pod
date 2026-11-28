// Audio workspace self-check (no DB, no browser): measured-QA extraction stays
// honest (no invented numbers), waveform peaks are real maxima, and the mix
// view's cue/QA query is scoped to the script rather than a global scan.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { measuredFromJobOutput } from "@/lib/audio/measuredQa";
import { peaksFrom } from "@/app/studio/MixWaveform";
import { jobOutputFile, layoutLines } from "@/lib/audio/mixLayout";

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
  assert.match(src, /<MeasuredPanel m={vm.measured} hasMaster=/);
  assert.match(src, /<MixWaveform url=\{vm\.episodeAudioUrl\}/);
  const wave = readFileSync("src/app/studio/MixWaveform.tsx", "utf8");
  assert.match(wave, /decodeAudioData/);
  assert.match(wave, /Waveform unavailable/);
});

// ---- scene-aware layout ----
const script = [
  { type: "intro", title: "Open", lines: [
    { lineIndex: 0, speakerName: "A", text: "one two three four five six seven eight nine ten" },
    { lineIndex: 1, speakerName: "B", text: "one two three four five" },
    { lineIndex: 2, speakerName: "A", text: "one two three four five" },
  ] },
  { type: "topic", title: "Topic", lines: [{ lineIndex: 3, speakerName: "B", text: "solo line here please" }] },
];
const scene = (over: Record<string, unknown> = {}) => ({ sceneIndex: 0, firstLineIndex: 0, lastLineIndex: 2, lineIndexes: [0, 1, 2], durationMs: 9000, timingStatus: "timing_unavailable", timingMap: null, selected: true, audioUrl: "s3://scene0", ...over });

ok("scene-voiced lines are voiced (no AudioSegment rows needed)", () => {
  const segs = layoutLines(script, new Map(), [scene()]);
  const lines = segs.flatMap((s) => s.lines);
  assert.deepEqual(lines.slice(0, 3).map((l) => l.voicedBy), ["scene", "scene", "scene"]);
  assert.equal(lines[3].voicedBy, null, "a line outside every scene with no clip is unvoiced");
  assert.ok(lines.slice(0, 3).every((l) => l.hasAudio && l.sceneIndex === 0));
});
ok("a scene occupies its REAL recorded duration; lines share it, marked approximate", () => {
  const lines = layoutLines(script, new Map(), [scene()]).flatMap((s) => s.lines);
  const sceneEnd = Math.max(...lines.slice(0, 3).map((l) => l.startMs + l.durationMs));
  assert.ok(Math.abs(sceneEnd - 9000) <= 2, `scene ends at its real 9000ms (got ${sceneEnd})`);
  assert.ok(lines[0].durationMs > lines[1].durationMs, "longer line gets more of the scene");
  assert.ok(lines.slice(0, 3).every((l) => l.approx), "no timing map -> approximate");
  assert.ok(lines[3].startMs >= 9000, "the next segment starts after the scene");
});
ok("a provider timing map gives exact line positions", () => {
  const timed = scene({ timingStatus: "provider_timestamps", timingMap: [{ lineIndex: 0, startMs: 0, endMs: 4000 }, { lineIndex: 1, startMs: 4100, endMs: 6000 }, { lineIndex: 2, startMs: 6200, endMs: 8800 }] });
  const lines = layoutLines(script, new Map(), [timed]).flatMap((s) => s.lines);
  assert.deepEqual(lines.slice(0, 3).map((l) => [l.startMs, l.durationMs, l.approx]), [[0, 4000, false], [4100, 1900, false], [6200, 2600, false]]);
});
ok("an unselected or failed take never counts as voiced", () => {
  const lines = layoutLines(script, new Map(), [scene({ selected: false }), scene({ sceneIndex: 1, audioUrl: null })]).flatMap((s) => s.lines);
  assert.ok(lines.every((l) => l.voicedBy === null));
});
ok("line-voiced clips use their real duration", () => {
  const audio = new Map([[3, { status: "ready", audioUrl: "s3://l3", durationMs: 2500 }]]);
  const l3 = layoutLines(script, audio, []).flatMap((s) => s.lines)[3];
  assert.equal(l3.voicedBy, "line");
  assert.equal(l3.durationMs, 2500);
  assert.equal(l3.audioUrl, "s3://l3");
});
ok("measurements are matched to the file their job produced", () => {
  assert.equal(jobOutputFile({ finalAudioUrl: "a.mp3" }), "a.mp3");
  assert.equal(jobOutputFile({ stitch: { finalAudioUrl: "b.mp3" } }), "b.mp3", "line regen nests the re-stitch");
  assert.equal(jobOutputFile({ finalStatus: "failed" }), null);
  const mv = readFileSync("src/lib/services/mixView.ts", "utf8");
  assert.match(mv, /const match = forFile\(episode\.audioUrl\)/, "the panel's measurement is the job whose output IS the played file");
  assert.doesNotMatch(mv, /logs\.find\(\(l\) => l\.output\)/, "never 'the latest job with any output'");
  assert.match(mv, /dialogueSceneAudio\.findMany/, "scene recordings are read");
});
ok("waveform cannot show an old render's picture", () => {
  const wave = readFileSync("src/app/studio/MixWaveform.tsx", "utf8");
  assert.match(wave, /peaks\.url === url/, "drawn only while its url is current");
  assert.match(wave, /AbortController/, "in-flight read is cancelled on render change");
  assert.match(wave, /ResizeObserver/, "redraws on resize");
  assert.match(wave, /Try again/, "errors are recoverable");
  assert.match(wave, /"Home"/, "keyboard: Home/End");
});

console.log(`\nAudio workspace: ${passed} passed, 0 failed`);
