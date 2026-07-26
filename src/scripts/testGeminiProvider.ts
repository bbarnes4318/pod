// OPT-IN live Gemini integration check.
//
//   npm run test:gemini-provider          # skips cleanly with no GEMINI_API_KEY
//
// The mocked suite (testGeminiProviderUnit.ts) proves the adapter's LOGIC. This
// proves the things only a real endpoint can: that the request shape is accepted
// by Google, that the documented usage fields actually come back, that deeply
// nested podcast JSON survives the round trip, and — the one that matters most —
// that a 16,000-token script movement is not truncated by anything in the chain.
//
// It never prints the API key. It exits nonzero on any failure so it can gate a
// deployment.

import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import * as dotenv from "dotenv";

/** Load env from this checkout AND from the main worktree. `.env` files are
 *  gitignored, so a `git worktree` checkout does not have them — reading only
 *  cwd reports a missing key that has been configured for months. */
function loadEnv() {
  const roots = [process.cwd()];
  try {
    const commonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const mainRoot = path.dirname(commonDir);
    if (mainRoot && mainRoot !== process.cwd()) roots.push(mainRoot);
  } catch {
    // Not a git checkout — cwd is all there is.
  }
  for (const root of roots) {
    for (const file of [".env.coolify.local", ".env.local", ".env"]) {
      const full = path.join(root, file);
      if (fs.existsSync(full)) dotenv.config({ path: full });
    }
  }
}
loadEnv();

import { GeminiLLMProvider } from "../lib/providers/llm/gemini";
import { llmCostMark, llmCostSince } from "../lib/providers/llm/costLedger";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<string>) {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    console.log(`  ✓ ${name} (${Date.now() - startedAt}ms) — ${detail}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name} (${Date.now() - startedAt}ms)\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const EVIDENCE = [
  "[newsItem:n1] Riverton Vale's statement on the dismissal of head coach Marcus Deane runs twelve paragraphs and does not use the word 'roster'.",
  "[newsItem:n2] Forwards Anton Sarr and Petr Molnar both signed with Riverton Vale in February, eleven weeks before the dismissal.",
  "[teamStat:s1] Riverton Vale's record after the February trade deadline was 4 wins and 19 losses.",
].join("\n");

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !key.trim()) {
    console.log(
      "\nSKIPPED: GEMINI_API_KEY is not set.\n" +
        "  This is the OPT-IN live integration check. Run the offline suite with:\n" +
        "    npx tsx --conditions=react-server src/scripts/testGeminiProviderUnit.ts\n"
    );
    return;
  }

  const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  console.log(`\nLive Gemini integration — model: ${model}\n`);
  const mark = llmCostMark();
  const llm = new GeminiLLMProvider();

  // 1. Smallest possible round trip: is the request shape accepted at all?
  await check("1. plain-text request", async () => {
    const out = await llm.generateText({
      prompt: "Reply with exactly the word: ready",
      maxTokens: 64,
    });
    assert(out.trim().length > 0, "empty response");
    return `"${out.trim().slice(0, 40)}"`;
  });

  // 2. JSON mode with a schema — the semantic reviewer's exact mechanism.
  await check("2. structured output with a responseSchema", async () => {
    const out = await llm.generateStructuredOutput<{ status: string; count: number }>({
      prompt: "Return status 'passed' and count 3.",
      jsonSchema: {
        type: "object",
        properties: { status: { type: "string", enum: ["passed", "failed"] }, count: { type: "integer" } },
        required: ["status", "count"],
      },
      maxTokens: 512,
    });
    assert(typeof out.status === "string", `status missing: ${JSON.stringify(out)}`);
    assert(typeof out.count === "number", `count missing: ${JSON.stringify(out)}`);
    return `status=${out.status} count=${out.count}`;
  });

  // 3. A realistic outline: the first LLM call every episode makes.
  await check("3. realistic episode-outline request (no schema, 7k budget)", async () => {
    const out = await llm.generateStructuredOutput<{ beats: Array<Record<string, unknown>> }>({
      systemPrompt:
        "You are the head writer for a two-host sports debate podcast. Return valid JSON only.",
      cacheableContext: `EVIDENCE:\n${EVIDENCE}`,
      prompt: [
        'Build a story spine for the episode "Twelve Paragraphs" (about 10 minutes).',
        "Use 6 to 8 beats. Beat 1 is a cold open already in motion; the final beat is a closing payoff.",
        'Return: { "beats": [ { "beatIndex": 0, "segmentType": "cold_open|intro|topic|transition|closing", "title": "...", "goal": "...", "angle": "...", "factRefs": [] } ] }',
      ].join("\n"),
      maxTokens: 7000,
      temperature: 0.7,
    });
    assert(Array.isArray(out.beats), `no beats array: ${JSON.stringify(out).slice(0, 200)}`);
    assert(out.beats.length >= 5, `expected 5+ beats, got ${out.beats.length}`);
    assert(typeof out.beats[0].title === "string", "beats are missing their fields");
    return `${out.beats.length} beats`;
  });

  // 4. The real nested segment shape — the payload most likely to break.
  await check("4. realistic script-movement request with the production JSON shape", async () => {
    const out = await llm.generateStructuredOutput<{
      segments: Array<{ type: string; lines: Array<{ speakerName: string; text: string; energy: string }> }>;
      stateAfter?: Record<string, unknown>;
    }>({
      systemPrompt:
        "You are the head writer for a two-host sports debate podcast. The hosts are Zabala and Cal. Return valid JSON only.",
      cacheableContext: `EVIDENCE:\n${EVIDENCE}`,
      prompt: [
        "Write MOVEMENT 1 of 3 as a continuous conversation of roughly 400 spoken words.",
        "Every factual number must come from the evidence and carry its ref.",
        "Return valid JSON only:",
        '{ "segments": [ { "type": "cold_open", "title": "...", "lines": [ { "lineIndex": 0, "speakerName": "Zabala" | "Cal", "text": "...", "tone": "heated|analytical|reflective|setup|dismissive|amused|incredulous|conceding", "energy": "low|medium|high", "pauseBefore": "none|beat|breath|long", "isInterruption": false, "evidenceRefs": [], "isFactualClaim": false } ] } ],',
        '  "stateAfter": { "emotionalTemperature": "cool|warming|hot|settling", "unresolvedThreads": [], "positionShifts": [], "callbacksAvailable": [], "relationshipChange": "..." } }',
      ].join("\n"),
      maxTokens: 16000,
      temperature: 0.85,
    });
    assert(Array.isArray(out.segments) && out.segments.length > 0, "no segments");
    const lines = out.segments.flatMap((s) => s.lines ?? []);
    assert(lines.length > 0, "no lines in any segment");
    assert(typeof lines[0].speakerName === "string" && typeof lines[0].text === "string", "line shape is wrong");
    assert(
      lines.every((l) => ["low", "medium", "high"].includes(l.energy)),
      "at least one line has an out-of-enum energy value"
    );
    const words = lines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
    return `${out.segments.length} segment(s), ${lines.length} lines, ${words} words, stateAfter=${out.stateAfter ? "present" : "MISSING"}`;
  });

  // 5. The 8K-cap proof. A long-output request must come back long, which is
  //    only possible if nothing in the adapter silently lowered the budget.
  await check("5. long-output request proves there is no adapter-level 8K cap", async () => {
    const out = await llm.generateStructuredOutput<{ items: Array<{ index: number; text: string }> }>({
      systemPrompt: "Return valid JSON only.",
      prompt: [
        "Produce a JSON object with an array named items containing EXACTLY 220 entries.",
        'Each entry: { "index": <0-based integer>, "text": "<a distinct 30-40 word paragraph about the craft of sports broadcasting>" }.',
        "Do not abbreviate, do not summarise, do not stop early. All 220 entries must be present.",
      ].join("\n"),
      maxTokens: 16000,
      temperature: 0.4,
    });
    assert(Array.isArray(out.items), `no items array: ${JSON.stringify(out).slice(0, 200)}`);
    // The bar is a response that could not possibly fit in 8,192 output tokens.
    const chars = JSON.stringify(out).length;
    assert(
      chars > 40_000,
      `response was only ${chars} chars (~${Math.round(chars / 4)} tokens) across ${out.items.length} items — ` +
        `too small to prove the 16,000-token budget was honored. If this repeats, something is capping output.`
    );
    return `${out.items.length} items, ${chars} chars (~${Math.round(chars / 4)} output tokens)`;
  });

  // Usage must be real, not estimated — the cost ledger depends on it.
  const usage = llm.getAccumulatedUsage();
  const { totals, stages } = llmCostSince(mark);
  console.log(
    `\nUsage (provider-reported): in=${usage.inputTokens} out=${usage.outputTokens} requests=${usage.requestCount}`
  );
  console.log(
    `Ledger: tkIn=${totals.tkIn} tkOut=${totals.tkOut} cacheRead=${totals.tkCacheRead} calls=${totals.calls} wallMs=${totals.wallMs}`
  );
  console.log(`Models seen: ${[...new Set(stages.flatMap((s) => s.models))].join(", ")}`);

  await check("6. usage was reported by the provider, not estimated", async () => {
    assert(usage.requestCount > 0, "no requests recorded");
    assert(usage.inputTokens > 0, "no input tokens recorded — usageMetadata was not read");
    assert(usage.outputTokens > 0, "no output tokens recorded");
    assert(totals.calls === usage.requestCount, `ledger recorded ${totals.calls} calls vs ${usage.requestCount} usage`);
    return `${usage.requestCount} calls, ${usage.inputTokens} in / ${usage.outputTokens} out`;
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  // Never let a stack trace carry the key out of the process.
  const key = process.env.GEMINI_API_KEY || "";
  const msg = key ? String(err?.stack || err).split(key).join("[REDACTED]") : String(err?.stack || err);
  console.error(msg);
  process.exit(1);
});
