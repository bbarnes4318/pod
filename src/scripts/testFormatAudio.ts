// N-seat audio + presentation tests (Prompt 7, PR 3). Run: npm run test:format-audio
//
// Proves: seat-indexed stereo panning (two-host seating BYTE-IDENTICAL to the
// legacy left/right pair), the timeline planner accepting 1-4 seats, and the
// seat-colour caption mapping. All PURE — no ffmpeg, no DB, no network.

import { seatPan, planConversationTimeline, type PlannedLine } from "../lib/audio/assembly";
import { makeCastMatchers } from "../lib/services/hostCastingShared";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const line = (i: number, seat: number): PlannedLine => ({
  filePath: `/tmp/l${i}.wav`,
  durationMs: 1000,
  lineIndex: i,
  hostSlot: seat,
  pauseBefore: "beat",
  isInterruption: false,
});

function main() {
  console.log("\nN-seat audio — panning, timeline, caption seats\n");

  check("CORE: two-host seating is byte-identical to the legacy left/right pair", () => {
    const spread = 0.14;
    assert(seatPan(0, 2, spread) === -spread, "seat 0 = hard legacy left");
    assert(seatPan(1, 2, spread) === spread, "seat 1 = hard legacy right");
  });

  check("1-4 seat pan positions are deterministic and bounded", () => {
    const s = 0.2;
    assert(seatPan(0, 1, s) === 0, "solo sits center");
    const three = [seatPan(0, 3, s), seatPan(1, 3, s), seatPan(2, 3, s)];
    assert(three[0] === -s && three[1] === 0 && three[2] === s, `3 seats L/C/R (${three})`);
    const four = [0, 1, 2, 3].map((i) => seatPan(i, 4, s));
    assert(four[0] === -s && four[3] === s, "4 seats span the field");
    assert(Math.abs(four[1] - -s / 3) < 1e-9 && Math.abs(four[2] - s / 3) < 1e-9, `inner seats at thirds (${four})`);
    assert(new Set(four).size === 4, "all four positions distinct");
    // Defensive bounds:
    assert(seatPan(9, 4, s) === s, "overflow seat clamps to the last chair");
    assert(seatPan(0, 99, s) === -s, "cast size clamps to 4");
  });

  check("CORE: the timeline planner pans a 3-voice conversation to 3 distinct positions", () => {
    const lines = [line(0, 0), line(1, 1), line(2, 2), line(3, 0)];
    const clips = planConversationTimeline(lines, { stereoSpread: 0.2, jitterFraction: 0 });
    const speech = clips.filter((c: { kind: string }) => c.kind === "speech");
    assert(speech.length === 4, "4 speech clips");
    const pans = speech.map((c: { pan: number }) => c.pan);
    assert(pans[0] === -0.2 && pans[1] === 0 && pans[2] === 0.2 && pans[3] === -0.2, `L/C/R seating (${pans})`);
  });

  check("legacy two-voice timelines keep their exact pans with NO castSize option", () => {
    const lines = [line(0, 0), line(1, 1)];
    const clips = planConversationTimeline(lines, { stereoSpread: 0.14, jitterFraction: 0 });
    const speech = clips.filter((c: { kind: string }) => c.kind === "speech");
    assert(speech[0].pan === -0.14 && speech[1].pan === 0.14, "inferred castSize 2 = legacy seating");
  });

  check("explicit castSize option wins over inference", () => {
    // A solo script: every line seat 0, castSize 1 -> centered.
    const lines = [line(0, 0), line(1, 0)];
    const clips = planConversationTimeline(lines, { stereoSpread: 0.14, jitterFraction: 0, castSize: 1 });
    const speech = clips.filter((c: { kind: string }) => c.kind === "speech");
    assert(speech.every((c: { pan: number }) => c.pan === 0), "solo centered");
  });

  check("cast matchers seat lookup drives 4-voice slot mapping", () => {
    const cast = [
      { id: "h1", name: "A" }, { id: "h2", name: "B" }, { id: "h3", name: "C" }, { id: "h4", name: "D" },
    ];
    const m = makeCastMatchers(cast);
    assert(m.seatOf("h3") === 2 && m.seatOf("h1") === 0 && m.seatOf("nope") === -1, "seat indexes");
    assert(m.hostNames.join(",") === "A,B,C,D", "4 names");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main();
