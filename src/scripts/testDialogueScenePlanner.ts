// Deterministic scene-planner tests (pure — no DB, no network, no ffmpeg).
// Run: npm run test:scene-planner

import {
  planDialogueScenes,
  plannerLinesFromScriptSegments,
  resolveSceneForLine,
  sceneRequestFingerprint,
  classifySceneType,
  isSplittableBoundary,
  type PlannerLine,
} from "../lib/audio/dialogueScenePlanner";
import { sceneGapMs } from "../lib/services/sceneStitchingService";
import { timingMapFromAlignment } from "../lib/providers/tts/elevenlabsDialogue";
import type { DialogueSceneInput } from "../lib/providers/tts/sceneTypes";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

let nextIndex = 0;
function line(over: Partial<PlannerLine> = {}): PlannerLine {
  return {
    lineIndex: over.lineIndex ?? nextIndex++,
    speakerHostId: "h1",
    speakerName: "Host 1",
    text: "This is a spoken line of ordinary conversational length for the test.",
    tone: "analytical",
    energy: "medium",
    isInterruption: false,
    segmentBoundary: "none",
    ...over,
  };
}
function altLines(n: number, hosts = ["h1", "h2"], textLen = 70): PlannerLine[] {
  nextIndex = 0;
  return Array.from({ length: n }, (_, i) =>
    line({ lineIndex: i, speakerHostId: hosts[i % hosts.length], text: "x".repeat(textLen - 1) + "." })
  );
}
const plan = (lines: PlannerLine[], maxCharacters = 2000, maxSpeakers = 10, formatId = "two_host_debate") =>
  planDialogueScenes({ scriptId: "s1", formatId, lines, maxCharacters, maxSpeakers });

function main() {
  console.log("\nDialogue scene planner\n");

  check("preserves line order, never drops, never duplicates", () => {
    const lines = altLines(40);
    const p = plan(lines);
    const flat = p.scenes.flatMap((s) => s.lineIndexes);
    assert(flat.length === 40, `expected 40 lines, got ${flat.length}`);
    assert(new Set(flat).size === 40, "duplicated line indexes");
    assert(flat.every((v, i) => i === 0 || v > flat[i - 1]), "line order not preserved");
  });

  check("respects provider character limits", () => {
    const p = plan(altLines(40), 500);
    for (const s of p.scenes) {
      assert(s.characterCount <= 500 || s.lines.length === 1, `scene ${s.sceneIndex} over budget: ${s.characterCount}`);
    }
    assert(p.scenes.length > 1, "expected multiple scenes under a tight budget");
  });

  check("respects provider speaker limits", () => {
    nextIndex = 0;
    const lines = altLines(12, ["h1", "h2", "h3", "h4"]);
    const p = plan(lines, 100000, 2);
    for (const s of p.scenes) assert(s.speakerHostIds.length <= 2, `scene ${s.sceneIndex} has ${s.speakerHostIds.length} speakers`);
  });

  check("breaks at topic and segment boundaries (stinger locations)", () => {
    const lines = altLines(8);
    lines[4] = { ...lines[4], segmentBoundary: "topic" };
    const p = plan(lines);
    const boundaryScene = p.scenes.find((s) => s.firstLineIndex === 4);
    assert(!!boundaryScene, "no scene starts at the topic boundary");
    assert(boundaryScene!.openedBy === "topic", `openedBy=${boundaryScene!.openedBy}`);
  });

  check("keeps interruption pairs together across a budget edge", () => {
    // Force the budget to want a cut exactly before the interruption.
    const a = line({ lineIndex: 0, text: "y".repeat(300) });
    const b = line({ lineIndex: 1, speakerHostId: "h2", text: "z".repeat(300) + " and then the setup ends mid-sentence—" });
    const c = line({ lineIndex: 2, text: "Cut-in reply!", isInterruption: true });
    const p = plan([a, b, c], 620, 10);
    const sceneOfB = p.scenes.find((s) => s.lineIndexes.includes(1))!;
    assert(sceneOfB.lineIndexes.includes(2), "interruption was separated from the line it cuts off");
  });

  check("never splits between a setup and its payoff", () => {
    const a = line({ lineIndex: 0, tone: "setup", text: "s".repeat(400) });
    const b = line({ lineIndex: 1, speakerHostId: "h2", text: "p".repeat(400) });
    const p = plan([a, b], 500, 10);
    const s0 = p.scenes.find((s) => s.lineIndexes.includes(0))!;
    assert(s0.lineIndexes.includes(1), "setup/payoff pair was split");
    assert(!isSplittableBoundary(a, b), "isSplittableBoundary should veto a setup boundary");
  });

  check("handles one to four speakers and solo formats", () => {
    for (const hosts of [["h1"], ["h1", "h2"], ["h1", "h2", "h3"], ["h1", "h2", "h3", "h4"]]) {
      const p = plan(altLines(9, hosts), 2000, 10, hosts.length === 1 ? "solo_commentary" : "two_host_debate");
      const flat = p.scenes.flatMap((s) => s.lineIndexes);
      assert(flat.length === 9, `cast ${hosts.length}: dropped lines`);
    }
  });

  check("handles a single oversized utterance safely", () => {
    const lines = [line({ lineIndex: 0 }), line({ lineIndex: 1, text: "w".repeat(5000) }), line({ lineIndex: 2 })];
    const p = plan(lines, 2000);
    const big = p.scenes.find((s) => s.lineIndexes.includes(1))!;
    assert(big.oversized, "oversized flag not set");
    assert(big.lineIndexes.length === 1, "oversized line must be its own scene");
    const flat = p.scenes.flatMap((s) => s.lineIndexes);
    assert(flat.length === 3 && new Set(flat).size === 3, "coverage broken around oversized line");
  });

  check("produces stable scene IDs and fingerprints", () => {
    const lines = altLines(20);
    const p1 = plan(lines);
    const p2 = plan(altLines(20));
    assert(p1.scenes.length === p2.scenes.length, "non-deterministic scene count");
    for (let i = 0; i < p1.scenes.length; i++) {
      assert(p1.scenes[i].sceneId === p2.scenes[i].sceneId, `sceneId differs at ${i}`);
      const fp = (s: typeof p1.scenes[number]) =>
        sceneRequestFingerprint({ scene: s, provider: "elevenlabs", model: "eleven_v3", renderUnit: "multi_speaker_scene", voiceMap: { h1: "v1", h2: "v2" } });
      assert(fp(p1.scenes[i]) === fp(p2.scenes[i]), `fingerprint differs at ${i}`);
    }
    // Fingerprint MUST move when the voice map moves.
    const fpA = sceneRequestFingerprint({ scene: p1.scenes[0], provider: "elevenlabs", model: "eleven_v3", renderUnit: "multi_speaker_scene", voiceMap: { h1: "v1", h2: "v2" } });
    const fpB = sceneRequestFingerprint({ scene: p1.scenes[0], provider: "elevenlabs", model: "eleven_v3", renderUnit: "multi_speaker_scene", voiceMap: { h1: "v1", h2: "vX" } });
    assert(fpA !== fpB, "fingerprint ignored the voice map");
  });

  check("scene typing: cold open first, closing last, format-aware middles", () => {
    const lines = altLines(30);
    lines[10] = { ...lines[10], segmentBoundary: "segment" };
    lines[20] = { ...lines[20], segmentBoundary: "topic" };
    const news = plan(lines, 900, 10, "news_roundup");
    assert(news.scenes[0].sceneType === "cold_open", "first scene must be cold_open");
    assert(news.scenes[news.scenes.length - 1].sceneType === "closing", "last scene must be closing");
    assert(news.scenes.slice(1, -1).every((s) => s.sceneType === "news_block"), "news_roundup middles should be news_block");
    const heated = classifySceneType({
      formatId: "two_host_debate", isFirstScene: false, isLastScene: false,
      lines: [line({ tone: "heated", energy: "high" }), line({ tone: "incredulous", energy: "high" })],
    });
    assert(heated === "argument_escalation", `expected argument_escalation, got ${heated}`);
  });

  check("resolveSceneForLine finds the smallest containing scene", () => {
    const p = plan(altLines(24), 700);
    const target = p.scenes[1];
    const found = resolveSceneForLine(p, target.lineIndexes[0]);
    assert(found?.sceneIndex === target.sceneIndex, "wrong scene resolved");
    assert(resolveSceneForLine(p, 9999) === null, "unknown line must resolve to null");
  });

  check("plannerLinesFromScriptSegments flags segment/topic boundaries", () => {
    const segs = [
      { type: "intro", lines: [{ lineIndex: 0, speakerHostId: "h1", speakerName: "A", text: "hi" }] },
      { type: "topic", lines: [{ lineIndex: 1, speakerHostId: "h2", speakerName: "B", text: "next" }] },
    ];
    const out = plannerLinesFromScriptSegments(segs as never);
    assert(out[0].segmentBoundary === "none", "first line must not carry a boundary");
    assert(out[1].segmentBoundary === "topic", "topic boundary lost");
  });

  check("scene gaps are deterministic and boundary-aware", () => {
    const a = sceneGapMs("topic", 3);
    const b = sceneGapMs("topic", 3);
    assert(a.gapMs === b.gapMs, "gap not deterministic");
    assert(sceneGapMs("topic", 1).gapMs > sceneGapMs("budget", 1).gapMs, "topic gap should exceed budget gap");
  });

  check("timingMapFromAlignment maps utterances and refuses garbage", () => {
    const input = {
      sceneId: "s", utterances: [
        { lineIndex: 0, speakerHostId: "h1", spokenText: "Hi there." },
        { lineIndex: 1, speakerHostId: "h2", spokenText: "Hello!" },
      ],
    } as unknown as DialogueSceneInput;
    const text = "Hi there. Hello!";
    const chars = text.split("");
    const starts = chars.map((_, i) => i * 0.1);
    const ends = chars.map((_, i) => i * 0.1 + 0.09);
    const map = timingMapFromAlignment(input, { characters: chars, character_start_times_seconds: starts, character_end_times_seconds: ends });
    assert(!!map && map.utterances.length === 2, "expected a 2-utterance timing map");
    assert(map!.utterances[0].startMs === 0, "utterance 0 start wrong");
    assert(map!.utterances[1].startMs === Math.round(10 * 100), `utterance 1 start wrong: ${map!.utterances[1].startMs}`);
    assert(map!.utterances[1].endMs > map!.utterances[1].startMs, "end before start");
    assert(map!.status === "provider_timestamps", "status must be provider_timestamps");
    // Garbage alignment → null (honest timing_unavailable), never invented.
    assert(timingMapFromAlignment(input, { characters: ["z", "q"], character_start_times_seconds: [0, 1], character_end_times_seconds: [1, 2] }) === null, "garbage alignment must map to null");
    assert(timingMapFromAlignment(input, null) === null, "missing alignment must map to null");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
