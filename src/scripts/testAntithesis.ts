import fs from "node:fs";
import path from "node:path";
import { analyzeAntithesis, findAntithesis, type AntithesisLine } from "../lib/services/scriptAntithesis";

const FIX = path.join(process.cwd(), "src/scripts/fixtures/varietyEpisodes");
const files = fs.readdirSync(FIX).filter((f) => f.endsWith(".json"));

let grand = 0, grandLines = 0;
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
  const lines: AntithesisLine[] = [];
  const walk = (o: any) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === "object") {
      if (typeof o.text === "string" && typeof o.lineIndex === "number") {
        lines.push({ lineIndex: o.lineIndex, speakerName: o.speakerName ?? "?", text: o.text });
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(data);
  if (!lines.length) continue;

  const r = analyzeAntithesis(lines);
  grand += r.totalHits; grandLines += lines.length;
  console.log(`\n${f}  — ${lines.length} lines, ${r.totalHits} antithesis frames (${r.hitsPerHundredLines.toFixed(0)} per 100 lines) — ${r.passed ? "PASS" : "FAIL"}`);
  for (const v of r.violations) {
    console.log(`   line ${v.lineIndex} [${v.speakerName}] ${v.hits.map(h => h.kind).join(",")}`);
    console.log(`      "${v.hits[0].span}"`);
    console.log(`      → ${v.reason}`);
  }
}
console.log(`\n===== ${grand} frames across ${grandLines} fixture lines = ${(grand/grandLines*100).toFixed(0)} per 100 lines =====`);

console.log("\n--- direct check on the tics you called out ---");
for (const t of [
  "That's not a basketball game, that's a public dismantling.",
  "That wasn't effort. That was a coaching decision.",
  "Same roster. New excuse.",
  "You just described a rebuild.",
  "This isn't about money, it's about respect.",
  "That's a coaching decision, not a character flaw.",
  "Not a slump, a collapse.",
  "You didn't lose a game, you lost the room.",
  "He's less a closer than a rumor.",
  "Not just bad, historically bad.",
  // controls — these must NOT trip
  "He went four for four with two doubles and they still lost by nine.",
  "I drove that kid to the airport myself. Six in the morning.",
]) {
  const h = findAntithesis(t);
  console.log(`${h.length ? "CAUGHT " + h.map(x=>x.kind).join(",") : "clean  "}  ${t}`);
}
