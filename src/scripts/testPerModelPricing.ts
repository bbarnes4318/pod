// A provider that serves two price tiers must be priced per model.
//
//   npm run test:per-model-pricing
//
// NETWORK-FREE.
//
// WHY IT EXISTS. Rates were keyed on the provider alone. That is correct while a
// provider serves one model and silently wrong the moment it serves two at
// different prices — which is exactly what the tiering plan asks for: Opus 5 on
// the two host writers, a cheaper Anthropic model on every other role.
//
// Production ran LLM_PRICE_ANTHROPIC_IN=5 / _OUT=25 — Opus 5's rates — applied
// to every Anthropic call. Under provider-only pricing, a Haiku 4.5 call would
// have been billed at 5x its true input rate and 5x its true output rate. The
// ledger would have reported the tiering change as barely cheaper than doing
// nothing, and the decision made from that number would have been backwards.
//
// These checks are about that failure specifically: same provider, two models,
// and the cheap one must not be priced as the expensive one.

import assert from "node:assert/strict";
import { estimateCostUsd, resolvedRatesFor } from "../lib/providers/llm/costLedger";

let failed = 0;
function check(name: string, fn: () => void) {
  const snapshot = { ...process.env };
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
    Object.assign(process.env, snapshot);
  }
}

/** Published Anthropic rates, per 1M tokens. */
const OPUS = { in: 5, out: 25 };
const HAIKU = { in: 1, out: 5 };

function setProdShape() {
  // Exactly what the worker had configured on 2026-08-12.
  process.env.LLM_PRICE_ANTHROPIC_IN = String(OPUS.in);
  process.env.LLM_PRICE_ANTHROPIC_OUT = String(OPUS.out);
}

function main() {
  console.log("\nPer-model pricing — one provider, two tiers\n");

  console.log("  -- the defect this exists to prevent --");

  check("a cheap model is NOT priced at the provider-wide (Opus) rate", () => {
    setProdShape();
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_IN = String(HAIKU.in);
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_OUT = String(HAIKU.out);

    // The turn-plan stage, measured: 16,191 in / 5,479 out.
    const asHaiku = estimateCostUsd(
      "anthropic",
      { tkIn: 16191, tkOut: 5479 },
      false,
      undefined,
      "claude-haiku-4-5"
    )!;
    const asOpus = estimateCostUsd(
      "anthropic",
      { tkIn: 16191, tkOut: 5479 },
      false,
      undefined,
      "claude-opus-5"
    )!;

    assert.ok(asHaiku < asOpus / 4, `Haiku (${asHaiku}) must be far below Opus (${asOpus})`);
    assert.equal(
      Number(asHaiku.toFixed(6)),
      Number(((16191 * 1 + 5479 * 5) / 1e6).toFixed(6)),
      "Haiku must bill at Haiku's published rate"
    );
    assert.equal(
      Number(asOpus.toFixed(6)),
      Number(((16191 * 5 + 5479 * 25) / 1e6).toFixed(6)),
      "Opus must still bill at Opus's rate"
    );
  });

  check("without a model override, the provider-wide rate still applies", () => {
    setProdShape();
    const cost = estimateCostUsd(
      "anthropic",
      { tkIn: 1000, tkOut: 1000 },
      false,
      undefined,
      "claude-sonnet-5"
    )!;
    assert.equal(Number(cost.toFixed(6)), Number(((1000 * 5 + 1000 * 25) / 1e6).toFixed(6)));
  });

  console.log("\n  -- resolution order and back-compat --");

  check("a model rate outranks the provider rate", () => {
    setProdShape();
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_IN = "1";
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_OUT = "5";
    const r = resolvedRatesFor("anthropic", "claude-haiku-4-5")!;
    assert.equal(r.in, 1);
    assert.equal(r.out, 5);
  });

  check("a single-model provider is unaffected (no model key set)", () => {
    process.env.LLM_PRICE_ZAI_IN = "0";
    process.env.LLM_PRICE_ZAI_OUT = "0";
    const r = resolvedRatesFor("zai", "glm-5.2")!;
    assert.equal(r.in, 0, "an explicit zero is a measurement, not an absence");
    assert.equal(r.out, 0);
  });

  check("an unpriced provider stays unpriced, model or not", () => {
    delete process.env.LLM_PRICE_MOONSHOT_IN;
    delete process.env.LLM_PRICE_MOONSHOT_OUT;
    assert.equal(resolvedRatesFor("moonshot", "kimi-k3"), null);
    assert.equal(resolvedRatesFor("moonshot"), null);
  });

  check("model ids with dots and slashes resolve to a usable env key", () => {
    process.env.LLM_PRICE_NVIDIA_Z_AI_GLM_5_2_IN = "2";
    process.env.LLM_PRICE_NVIDIA_Z_AI_GLM_5_2_OUT = "8";
    process.env.LLM_PRICE_NVIDIA_IN = "0";
    process.env.LLM_PRICE_NVIDIA_OUT = "0";
    const r = resolvedRatesFor("nvidia", "z-ai/glm-5.2")!;
    assert.equal(r.in, 2, "z-ai/glm-5.2 must map to Z_AI_GLM_5_2");
    assert.equal(r.out, 8);
  });

  console.log("\n  -- cache multipliers follow the model's own input rate --");

  check("cache read/write derive from the MODEL rate, not the provider rate", () => {
    setProdShape();
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_IN = "1";
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_OUT = "5";
    const r = resolvedRatesFor("anthropic", "claude-haiku-4-5")!;
    assert.equal(r.cacheRead, 0.1, "0.1x of Haiku's $1, not of Opus's $5");
    assert.equal(r.cacheWrite, 1.25, "1.25x of Haiku's $1");
  });

  check("an explicit cache rate still wins over the multiplier", () => {
    setProdShape();
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_IN = "1";
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_OUT = "5";
    process.env.LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_CACHE_WRITE = "9";
    assert.equal(resolvedRatesFor("anthropic", "claude-haiku-4-5")!.cacheWrite, 9);
  });

  console.log(failed === 0 ? "\nAll per-model pricing checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
