// Prove the prompt cache actually caches, in one command.
//
//   npm run verify:cache-proof            # dry — prints the plan and the cost, runs nothing
//   npm run verify:cache-proof -- --yes   # SPENDS REAL MONEY on the Anthropic account
//
// THIS SPENDS MONEY. It is gated behind --yes for that reason and must never be
// wired into CI.
//
// WHY IT EXISTS. The prompt restructure moved the private brief, the episode
// spine and the evidence packet into a cached prefix so a host's ~6 movement
// calls stop re-sending them. Offline tests prove the bytes are identical
// (`npm run test:prompt-cache-stability`), but "identical bytes" is not "the
// provider served it from cache" — only a real call can show `cacheRead > 0`.
//
// And a normal render cannot show it either. Under `verified_development`,
// Anthropic is the PAID BACKUP: a healthy episode never reaches it, so every
// call comes back from Z.ai or NVIDIA and the caching claim stays untested.
// Cache breakpoints are an Anthropic-only mechanism here — the OpenAI-compatible
// adapters concatenate `cacheableContext` into the system prompt, which is
// behaviour-neutral and caches nothing.
//
// So this pins EXACTLY the two host-writer roles to Anthropic and leaves every
// other role on the free chain. That is the whole trick: the roles that repeat
// are the ones that can cache, and they are a small fraction of an episode's
// spend. Pinning the profile instead would re-cost the entire episode on Opus 5
// for no additional proof.

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { evaluateRender, parseCostLines } from "./verifyLlmCostRender";

const MODEL = process.env.CACHE_PROOF_MODEL || "claude-opus-5";

/**
 * Rough first-run cost, stated as a range with its basis so it can be argued
 * with rather than trusted.
 *
 * Six host-writer calls per episode (two hosts x three movements). Each sends
 * the static block — private brief, spine, evidence packet — plus the turn plan
 * and the transcript so far, and returns a movement's worth of lines.
 *
 * The UNCACHED figure is the one quoted, deliberately: this run writes the cache
 * on each host's first call and reads it on the rest, so the real bill should
 * land BELOW this. A pleasant surprise is the correct direction for a number
 * printed before someone spends money.
 */
const COST = {
  calls: 6,
  inputTokensPerCall: 12_000,
  outputTokensPerCall: 1_500,
  inRate: 5, // $/1M — claude-opus-5
  outRate: 25,
};

function estimateUsd(): { low: number; high: number } {
  const uncached =
    (COST.calls * COST.inputTokensPerCall * COST.inRate +
      COST.calls * COST.outputTokensPerCall * COST.outRate) /
    1_000_000;
  // With caching the repeat calls bill their static block at ~0.1x input.
  return { low: uncached * 0.45, high: uncached * 1.3 };
}

function hasKey(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const fixture = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];

  console.log("\nCACHE PROOF — one episode, host writers pinned to Anthropic\n");

  // ---- preflight: refuse to produce a meaningless green --------------------
  //
  // A missing Anthropic key does not stop the pipeline. Routing would resolve
  // the host writers to the next candidate, the episode would complete on the
  // free chain, and every condition would come back "inconclusive — no
  // Anthropic calls". That reads like a clean run and proves nothing, which is
  // the exact failure this whole exercise exists to avoid. So: hard stop.
  if (!hasKey("ANTHROPIC_API_KEY")) {
    fail(
      "ABORT: ANTHROPIC_API_KEY is not set.\n\n" +
        "Without it the host writers fall through to a free model, the episode completes, and every\n" +
        "condition reports 'inconclusive'. That looks like a clean run and proves nothing about caching.\n" +
        "Refusing to spend the time producing it. Set ANTHROPIC_API_KEY and re-run."
    );
  }

  // The free chain has to actually work, or the REST of the episode falls back
  // to the paid Anthropic rung too — which still proves the cache, but bills
  // the whole episode on Opus 5 rather than the six calls that matter.
  const freeChainKeys = ["NVIDIA_API_KEY", "ZAI_API_KEY"].filter((k) => !hasKey(k));
  if (freeChainKeys.length) {
    console.log(
      `  WARNING: ${freeChainKeys.join(" and ")} not set.\n` +
        `  Every non-host-writer role will fall back to the PAID Anthropic rung, so this run will cost\n` +
        `  several times the estimate below. The cache proof is still valid; the bill is not what is quoted.\n`
    );
  }

  const priced = hasKey("LLM_PRICE_ANTHROPIC_IN") && hasKey("LLM_PRICE_ANTHROPIC_OUT");
  const { low, high } = estimateUsd();

  console.log("  What this does:");
  console.log(`    · pins ONLY script_host_a_writer and script_host_b_writer to anthropic/${MODEL}`);
  console.log("    · leaves every other role on the free chain (verified_development)");
  console.log("    · renders one episode through the real seven-role pipeline");
  console.log("    · pipes the [LLMCost] lines into the render verifier\n");
  console.log(`  Estimated cost: $${low.toFixed(2)} – $${high.toFixed(2)}`);
  console.log(
    `    (${COST.calls} host-writer calls, ~${COST.inputTokensPerCall.toLocaleString()} in / ` +
      `~${COST.outputTokensPerCall.toLocaleString()} out each, at $${COST.inRate}/$${COST.outRate} per MTok.\n` +
      `     Caching should land it near the low end — that is the thing being measured.)\n`
  );

  if (!priced) {
    console.log(
      "  NOTE: LLM_PRICE_ANTHROPIC_IN/_OUT are not set, so the run will report cost=unpriced and the\n" +
        "  'dollars, not unpriced' condition will FAIL. Exporting both (5 and 25) makes this run prove\n" +
        "  all four conditions instead of three.\n"
    );
  }

  if (!confirmed) {
    console.log("  Nothing has been spent. Re-run with --yes to proceed:\n");
    console.log("      npm run verify:cache-proof -- --yes\n");
    process.exit(0);
  }

  // ---- run ---------------------------------------------------------------

  const logPath = path.join(os.tmpdir(), `cache-proof-${Date.now()}.log`);
  console.log(`  Running. Full output: ${logPath}\n${"-".repeat(78)}\n`);

  const childEnv = {
    ...process.env,
    // The production profile, so the rest of the episode stays on the free
    // chain. Respected if the caller already set it.
    LLM_ROUTING_PROFILE: process.env.LLM_ROUTING_PROFILE || "verified_development",
    // The two pins. Role overrides beat the profile primary for these roles
    // ONLY — every other role resolves normally.
    SCRIPT_HOST_A_WRITER_LLM_PROVIDER: "anthropic",
    SCRIPT_HOST_A_WRITER_LLM_MODEL: MODEL,
    SCRIPT_HOST_B_WRITER_LLM_PROVIDER: "anthropic",
    SCRIPT_HOST_B_WRITER_LLM_MODEL: MODEL,
  };

  const childArgs = [
    "tsx",
    "--conditions=react-server",
    "src/scripts/writeSampleEpisode.ts",
    ...(fixture ? ["--fixture", fixture] : []),
  ];

  const child = spawn("npx", childArgs, {
    env: childEnv,
    shell: process.platform === "win32",
  });

  const chunks: string[] = [];
  const capture = (buf: Buffer) => {
    const s = buf.toString();
    chunks.push(s);
    process.stdout.write(s); // stream it — an episode takes minutes
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);

  child.on("close", (code) => {
    const output = chunks.join("");
    fs.writeFileSync(logPath, output);
    console.log(`\n${"-".repeat(78)}`);
    console.log(`\nEpisode process exited ${code}. Log: ${logPath}\n`);

    const lines = parseCostLines(output);
    if (lines.length === 0) {
      console.error(
        "No [LLMCost] lines were produced. The episode did not reach a real provider — read the log\n" +
          "above for the pipeline error. Nothing can be concluded about caching from this run.\n"
      );
      process.exit(2);
    }

    const anthropic = lines.filter((l) => l.provider === "anthropic");
    console.log(
      `${lines.length} LLM call(s) recorded, ${anthropic.length} served by Anthropic ` +
        `(the pinned host writers).\n`
    );

    const findings = evaluateRender(lines);
    for (const f of findings) {
      const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
      console.log(`  ${mark} ${f.title}`);
      console.log(`      ${f.detail}\n`);
    }

    const failed = findings.filter((f) => f.status === "fail");
    const inconclusive = findings.filter((f) => f.status === "inconclusive");
    const spent = anthropic.reduce((s, l) => s + (l.costUsd ?? 0), 0);
    if (anthropic.some((l) => l.costUsd !== null)) {
      console.log(`  Actual Anthropic spend on this run: $${spent.toFixed(4)}\n`);
    }

    console.log(
      `${findings.length - failed.length - inconclusive.length} passed, ${failed.length} failed, ` +
        `${inconclusive.length} inconclusive\n`
    );
    if (inconclusive.length && !failed.length) {
      console.log("INCONCLUSIVE IS NOT PASS — a condition that could not be evaluated is unproven.\n");
    }
    process.exit(failed.length ? 1 : inconclusive.length ? 3 : 0);
  });
}

main();
