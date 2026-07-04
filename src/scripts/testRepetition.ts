// Repetition-bug regression proof.
//
//   npx tsx src/scripts/testRepetition.ts          # deterministic tests only
//   npx tsx src/scripts/testRepetition.ts --live   # + real LLM episode generation
//                                                   (reads OPENAI key from .env.coolify.local)
//
// Part 1 reproduces the exact production failure (per-segment lineIndex
// numbering) and proves the old stitch mapping repeats one clip while the
// fixed pipeline maps every line to its own clip.
// Part 2 proves the content-dedup gate catches verbatim and reworded restatement.
// Part 3 (--live) generates a full outline-driven episode with the production
// model and asserts ~zero repetition + prints the 0-100 quality score.

import fs from "fs";
import path from "path";
import {
  findRepetitions,
  dedupeScriptSegments,
  hasLineIndexCollisions,
  normalizeLineIndexes,
} from "../lib/services/scriptRepetition";
import { scoreScriptQuality } from "../lib/services/episodeQualityService";

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failures++;
}

// ---------------------------------------------------------------------------
console.log("\n[1] Index-collision bug (the 40-50x repeated-clip failure)");
// Reproduce production shape: 4 segments, lineIndex restarting at 0 each time.
const buggySegments = Array.from({ length: 4 }, (_, s) => ({
  type: s === 0 ? "cold_open" : "topic",
  title: `Segment ${s + 1}`,
  lines: Array.from({ length: 12 }, (_, i) => ({
    lineIndex: i, // <-- restarts per segment, as the model emits it
    speakerName: i % 2 ? "Dr. Linebreak" : "Max Voltage",
    text: `Segment ${s + 1} line ${i + 1} unique content about play number ${s * 12 + i}.`,
  })),
}));

check("collision detector", hasLineIndexCollisions(buggySegments) === true, "duplicate lineIndex values detected");

// Old stitcher behavior: line -> first AudioSegment row with that lineIndex.
// With 4 segments x 12 lines all indexed 0-11, each clip serves 4 lines.
const clipsByIndex = new Map<number, string>();
for (const seg of buggySegments) {
  for (const line of seg.lines) {
    if (!clipsByIndex.has(line.lineIndex)) clipsByIndex.set(line.lineIndex, line.text);
  }
}
let repeatedClipInsertions = 0;
for (const seg of buggySegments) {
  for (const line of seg.lines) {
    if (clipsByIndex.get(line.lineIndex) !== line.text) repeatedClipInsertions++;
  }
}
check(
  "old mapping repeats clips",
  repeatedClipInsertions === 36,
  `${repeatedClipInsertions}/48 lines would have played someone ELSE'S clip (repeats)`
);

const { hadCollisions } = normalizeLineIndexes(buggySegments);
check("normalizer flags collisions", hadCollisions, "collisions reported");
check("post-fix indexes unique", !hasLineIndexCollisions(buggySegments), "48 unique global indexes 0..47");

// ---------------------------------------------------------------------------
console.log("\n[2] Content restatement gate");
const restated = {
  segments: [
    {
      type: "topic",
      title: "t",
      lines: [
        { lineIndex: 0, speakerName: "Max Voltage", text: "The Wolves have lost five straight games and the coach is out of answers." },
        { lineIndex: 1, speakerName: "Dr. Linebreak", text: "Their net rating in those five losses is historically bad for a two seed." },
        { lineIndex: 2, speakerName: "Max Voltage", text: "Five straight losses for the Wolves, and the coach has zero answers left." }, // reworded repeat of 0
        { lineIndex: 3, speakerName: "Dr. Linebreak", text: "The Wolves have lost five straight games and the coach is out of answers." }, // verbatim repeat of 0
        { lineIndex: 4, speakerName: "Max Voltage", text: "Meanwhile the backup point guard just dropped thirty in a quarter." },
      ],
    },
  ],
};
const rep = findRepetitions(restated.segments[0].lines.map((l) => l.text));
check("catches verbatim + reworded", rep.repeats.length === 2, `${rep.repeats.length} repeats flagged (expected 2)`);
const deduped = dedupeScriptSegments(restated.segments);
check("dedupe keeps first occurrence", deduped.segments[0].lines.length === 3, `${deduped.segments[0].lines.length} lines kept of 5`);

// Degenerate 45x case
const degenerate = Array.from({ length: 50 }, (_, i) => ({
  lineIndex: i,
  speakerName: "Max Voltage",
  text: i < 5 ? `Unique opening line number ${i} about the game.` : "Rings talk, baby! You either hang banners or you make excuses!",
}));
const degenRep = findRepetitions(degenerate.map((l) => l.text));
check("catches 45x degenerate loop", degenRep.repeats.length >= 43, `${degenRep.repeats.length} of 45 duplicates flagged`);

// ---------------------------------------------------------------------------
console.log("\n[3] Clean fixture control (should be ~zero repetition)");
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "abSampleScript.json"), "utf8")
);
const cleanRep = findRepetitions(fixture.lines.map((l: any) => l.text));
check("clean dialogue passes", cleanRep.repeats.length === 0, `${cleanRep.repeats.length} false positives on the 12-line fixture`);

// ---------------------------------------------------------------------------
async function liveTest() {
  console.log("\n[4] LIVE generation test (outline-driven, real model)");
  const dotenv = await import("dotenv");
  dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length < 20) {
    console.log("  SKIP — no OPENAI_API_KEY available locally.");
    return;
  }
  process.env.LLM_PROVIDER = "openai";

  const { getScriptLLMProvider } = await import("../lib/providers/llm/factory");
  const { generateOutlineDrivenScript } = await import("../lib/services/scriptOutlineEngine");

  const systemPrompt = fs.readFileSync(path.join(__dirname, "fixtures", "livePersonaPrompt.txt"), "utf8");
  const topicsPrompts = fs.readFileSync(path.join(__dirname, "fixtures", "liveTopicEvidence.txt"), "utf8");

  const llm = getScriptLLMProvider();
  const start = Date.now();
  const out = await generateOutlineDrivenScript(llm, {
    systemPrompt,
    episodeTitle: "Live repetition regression test episode",
    topicsPrompts,
    targetDuration: 10,
    version: 1,
    temperature: 0.85,
    maxTokens: 16000,
    log: (m) => console.log(`  [gen] ${m}`),
  });
  console.log(`  generation took ${((Date.now() - start) / 1000).toFixed(0)}s`);

  const allTexts: string[] = [];
  for (const seg of out.segments) for (const line of seg.lines || []) allTexts.push(String(line.text || ""));
  console.log(`  generated ${allTexts.length} lines across ${out.segments.length} segments`);

  const liveRep = findRepetitions(allTexts);
  check(
    "LIVE: zero significant repetition",
    liveRep.repetitionRatio <= 0.05,
    `${liveRep.repeats.length} near-duplicates of ${liveRep.totalLines} lines (${(liveRep.repetitionRatio * 100).toFixed(1)}%)`
  );
  if (liveRep.repeats.length) {
    for (const r of liveRep.repeats.slice(0, 5)) console.log(`    dup: "${r.text.slice(0, 80)}"`);
  }

  const { segments } = dedupeScriptSegments(out.segments);
  normalizeLineIndexes(segments);
  const quality = scoreScriptQuality({ segments });
  console.log(`  QUALITY SCORE: ${quality.total}/100`);
  for (const [axis, v] of Object.entries(quality.axes)) {
    console.log(`    ${axis.padEnd(12)} ${String((v as any).score).padStart(2)}/${(v as any).max}  ${(v as any).detail}`);
  }

  // Save the transcript for listening/review
  const outPath = path.join(process.cwd(), "samples", "live-script-sample.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ segments, quality }, null, 2));
  console.log(`  transcript saved: ${outPath}`);
}

(async () => {
  if (process.argv.includes("--live")) {
    await liveTest();
  }
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})();
