import fs from "node:fs";
import { analyzeSemanticRepetition } from "./src/lib/services/semanticRepetition";
const dir = "./src/scripts/fixtures/varietyEpisodes";
for (const f of fs.readdirSync(dir)) {
  const j = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8"));
  const r = analyzeSemanticRepetition(j.segments);
  console.log(`\n${f}: score ${r.repetitionScore} passed=${r.passed} words=${r.totals.words} lines=${r.totals.lines} budget=${r.budgets.lemmaAllowance}`);
  for (const fi of r.findings) console.log(`   -${fi.penalty.toFixed(1)} ${fi.category}: ${fi.message}`);
}
