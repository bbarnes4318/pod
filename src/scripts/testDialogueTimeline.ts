// Actual-dialogue timeline + gap classification tests (PR 3, pure).
// Run: npm run test:dialogue-timeline

import { buildActualDialogueTimeline, type ActualTimelineLineInput } from "../lib/audio/dialogueTimeline";
import { resolveWaveformConfig, gapAllowsTransition, gapAllowsReaction } from "../lib/audio/waveformAnalysis";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const cfg = resolveWaveformConfig();
const line = (over: Partial<ActualTimelineLineInput> = {}): ActualTimelineLineInput => ({
  lineIndex: 0, hostId: "h1", seatIndex: 0, fileDurationMs: 2000,
  timelineStartMs: 0, timelineEndMs: 2000, leadSilenceMs: 0, trailSilenceMs: 0,
  isInterruption: false, segmentBoundary: "inline", timingSource: "ffprobe_waveform", ...over,
});

// Build a 2-line timeline with a chosen audible gap + boundary + overlap.
function twoLine(gapMs: number, boundary: "inline" | "segment" | "topic", overlapMs = 0) {
  const a = line({ lineIndex: 0, timelineStartMs: 0, fileDurationMs: 2000, timelineEndMs: 2000 });
  const start = 2000 + gapMs;
  const b = line({ lineIndex: 1, seatIndex: 1, hostId: "h2", timelineStartMs: start, timelineEndMs: start + 2000, segmentBoundary: boundary, appliedOverlapMs: overlapMs });
  return buildActualDialogueTimeline([a, b], cfg);
}

function main() {
  console.log("\nActual dialogue timeline + gap classification\n");

  check("actual line durations drive the timeline (no estimates)", () => {
    const t = buildActualDialogueTimeline([line({ lineIndex: 0, fileDurationMs: 1234, timelineEndMs: 1234 })], cfg);
    assert(t.lines[0].fileDurationMs === 1234 && t.dialogueDurationMs === 1234, "uses measured duration");
  });

  check("leading + trailing silence are measured and separate from spoken duration", () => {
    const t = buildActualDialogueTimeline([line({ fileDurationMs: 3000, timelineEndMs: 3000, leadSilenceMs: 400, trailSilenceMs: 600 })], cfg);
    const l = t.lines[0];
    assert(l.speechStartMs === 400 && l.speechEndMs === 2400, `speech window ${l.speechStartMs}-${l.speechEndMs}`);
    assert(l.speechDurationMs === 2000 && l.fileDurationMs === 3000, "spoken != file duration");
  });

  check("assembly-added pause is distinguished from embedded (script) pause", () => {
    const t = buildActualDialogueTimeline([line(), line({ lineIndex: 1, timelineStartMs: 3000, timelineEndMs: 5000, embeddedPauseMs: 500, appliedPauseMs: 800 })], cfg);
    const l = t.lines[1];
    assert(l.embeddedPauseMs === 500 && l.appliedPauseMs === 800, "both pauses preserved distinctly");
  });

  check("overlap (interruption) removes the apparent gap", () => {
    const t = twoLine(300, "inline", 250);
    assert(t.gaps[0].classification === "overlap_removed", `overlap removes gap (${t.gaps[0].classification})`);
    assert(!gapAllowsReaction(t.gaps[0].classification) && !gapAllowsTransition(t.gaps[0].classification), "no cue in a removed gap");
  });

  check("the build is deterministic (same input -> same timeline)", () => {
    const inp = [line(), line({ lineIndex: 1, timelineStartMs: 2500, timelineEndMs: 4500, segmentBoundary: "topic" })];
    assert(JSON.stringify(buildActualDialogueTimeline(inp, cfg)) === JSON.stringify(buildActualDialogueTimeline(inp, cfg)), "deterministic");
  });

  check("invalid segment duration fails safely (typed error)", () => {
    let cat = "";
    try { buildActualDialogueTimeline([line({ fileDurationMs: 0 })], cfg); } catch (e) { cat = (e as { category?: string }).category ?? ""; }
    assert(cat === "dialogue_timeline_invalid", `typed error (${cat})`);
    let cat2 = "";
    try { buildActualDialogueTimeline([line({ fileDurationMs: NaN })], cfg); } catch (e) { cat2 = (e as { category?: string }).category ?? ""; }
    assert(cat2 === "dialogue_timeline_invalid", "NaN duration rejected");
  });

  // Gap classification matrix (defaults: minSilence 120, minReaction 450, minTransition 1200).
  check("gap classes: too_short / breath / reaction_ok / transition_ok / topic_gap", () => {
    assert(twoLine(80, "inline").gaps[0].classification === "too_short", "80ms -> too_short");
    assert(twoLine(300, "inline").gaps[0].classification === "breath", "300ms -> breath");
    assert(twoLine(700, "segment").gaps[0].classification === "reaction_ok", "700ms -> reaction_ok");
    assert(twoLine(1500, "segment").gaps[0].classification === "transition_ok", "1500ms segment -> transition_ok");
    assert(twoLine(1500, "topic").gaps[0].classification === "topic_gap", "1500ms topic -> topic_gap");
  });

  check("gap helpers gate cue eligibility correctly", () => {
    assert(gapAllowsReaction("reaction_ok") && !gapAllowsTransition("reaction_ok"), "reaction gap != transition gap");
    assert(gapAllowsTransition("transition_ok") && gapAllowsTransition("topic_gap"), "transition + topic host transitions");
    assert(!gapAllowsReaction("breath") && !gapAllowsReaction("too_short"), "breath/too_short host nothing");
  });

  // Format-shaped timelines build without error and carry the right structure.
  check("format-shaped timelines: mono / debate / panel / roundtable / rapid-fire / interrupted / silence edges", () => {
    const mono = buildActualDialogueTimeline([line({ lineIndex: 0 }), line({ lineIndex: 1, timelineStartMs: 2200, timelineEndMs: 4200 })], cfg);
    assert(mono.lines.every((l) => l.seatIndex === 0 || l.hostId === "h1"), "mono ok");
    const seats = [0, 1, 2, 3].map((s, i) => line({ lineIndex: i, seatIndex: s, hostId: `h${s}`, timelineStartMs: i * 2200, timelineEndMs: i * 2200 + 2000 }));
    assert(buildActualDialogueTimeline(seats, cfg).lines.length === 4, "four-seat roundtable ok");
    const rapid = [0, 1, 2, 3, 4].map((i) => line({ lineIndex: i, seatIndex: i % 2, timelineStartMs: i * 900, timelineEndMs: i * 900 + 800, fileDurationMs: 800 }));
    const rt = buildActualDialogueTimeline(rapid, cfg);
    assert(rt.gaps.every((g) => g.classification === "too_short" || g.classification === "breath"), "rapid-fire gaps are short");
    const interrupted = twoLine(0, "inline", 400);
    assert(interrupted.gaps[0].overlapMs === 400, "interruption overlap captured");
    const both = buildActualDialogueTimeline([line({ fileDurationMs: 3000, timelineEndMs: 3000, leadSilenceMs: 300, trailSilenceMs: 300 })], cfg);
    assert(both.lines[0].speechDurationMs === 2400, "leading+trailing silence both measured");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
