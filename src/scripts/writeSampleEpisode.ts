// WRITE ONE EPISODE AND LOOK AT IT.
//
//   npm run write:sample                      default fixture
//   npm run write:sample -- --fixture fast_humorous
//
// WHY THIS EXISTS. The model-evaluation harness calls generateOutlineDrivenScript
// directly — one provider, no role routing. Production calls
// runSevenRolePipeline, which resolves a SEPARATE provider per role and is the
// only path where Host A and Host B can be written by different models. So every
// host-distinctness number the bake-off produced was measuring one model writing
// both characters: not the thing this show actually ships.
//
// This runs the production path, with whatever role routing the environment
// declares, and prints the dialogue so a person can read it. Numbers are useful;
// for "does this sound like two humans arguing" the transcript is the evidence.
//
// THIS SPENDS MONEY. One episode's worth of generation.
import "dotenv/config";
import { runSevenRolePipeline } from "../lib/services/scriptSevenRolePipeline";
import { measureHostDistinctness } from "../lib/services/scriptSevenRolePipeline";
import { findRepetitions } from "../lib/services/scriptRepetition";
import { HOST_NAMES, PERSONA_PROMPT, SITUATIONS } from "./roleExperimentFixtures";
import { roleRoutingTable, PRODUCTION_WRITING_ROLES } from "../lib/providers/llm/routingAudit";

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`) || a === `--${name}`);
  if (!hit) return undefined;
  if (hit.includes("=")) return hit.split("=").slice(1).join("=");
  return process.argv[process.argv.indexOf(hit) + 1];
}

async function main() {
  const wanted = flag("fixture") || "character_revealing";
  const situation = SITUATIONS.find((s) => s.key === wanted) || SITUATIONS[0];

  // MEASURED 2026-08-06: these fixtures plateau at ~730 spoken words no matter
  // how many turns are planned — 15 turns gave 411, 27 gave 720, 44 gave 733 by
  // writing shorter lines. The material supports roughly five minutes of real
  // argument, and demanding eight buys padding, which is the exact texture that
  // makes generated dialogue sound generated. Override deliberately.
  const minutes = Number(flag("minutes")) || situation.targetDuration;

  // Print WHO IS WRITING before spending anything. A surprising transcript is
  // much easier to interpret when the routing that produced it is on the page.
  console.log("\nROUTING FOR THIS EPISODE");
  for (const row of roleRoutingTable(PRODUCTION_WRITING_ROLES)) {
    console.log(`  ${row.role.padEnd(26)} ${row.provider}/${row.model}`);
  }
  console.log(
    `\nFixture: ${situation.key} — "${situation.episodeTitle}" (${minutes} min` +
      `${minutes !== situation.targetDuration ? `, overridden from ${situation.targetDuration}` : ""})\n`
  );

  const started = Date.now();
  const seven = await runSevenRolePipeline({
    systemPrompt: PERSONA_PROMPT,
    episodeTitle: situation.episodeTitle,
    topicsPrompts: situation.topicsPrompts,
    targetDuration: minutes,
    temperature: 0.85,
    maxTokens: 16000,
    speakerNames: HOST_NAMES,
    log: (msg) => console.log(`  · ${msg}`),
  });

  console.log(`\n${"=".repeat(78)}`);
  if (!seven.ok) {
    console.error(`\nPIPELINE DID NOT COMPLETE: ${seven.error}\n`);
    for (const r of seven.trace.stageRecords) {
      console.log(`  ${r.role.padEnd(26)} ${r.status}${r.error ? ` — ${r.error}` : ""}`);
    }
    process.exit(1);
  }

  const lines: Array<{ speakerName: string; text: string }> = [];
  for (const segment of seven.segments as Array<{ lines?: Array<{ speakerName: string; text: string }> }>) {
    for (const line of segment.lines || []) lines.push(line);
  }

  console.log(`\nTRANSCRIPT — ${lines.length} lines, ${Math.round((Date.now() - started) / 1000)}s\n`);
  for (const line of lines) {
    console.log(`${line.speakerName.toUpperCase()}:`);
    console.log(`  ${line.text}\n`);
  }

  // The two measurable tells that a script was written by one brain wearing two
  // hats: the hosts sound alike, and points get restated.
  const distinctness = measureHostDistinctness(lines);
  const repeats = findRepetitions(lines.map((l) => l.text));
  const repeated = new Set((repeats.repeats || []).map((r: { index: number }) => r.index)).size;

  console.log("=".repeat(78));
  console.log(`\nHost distinctness: ${JSON.stringify(distinctness)}`);
  console.log(`Repeated lines:    ${repeated}/${lines.length}`);
  console.log(`Role violations:   ${seven.trace.violations.length}`);
  for (const v of seven.trace.violations.slice(0, 10)) {
    console.log(`  ${JSON.stringify(v).slice(0, 180)}`);
  }
  console.log("");
}

main();
