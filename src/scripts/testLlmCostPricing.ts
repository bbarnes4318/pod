// Dollar telemetry: rate resolution and exact cost arithmetic.
//
//   npm run test:llm-cost-pricing
//
// NETWORK-FREE and credential-free.
//
// WHY IT EXISTS. The cost ledger was fully wired and reported `cost=unpriced`
// on every single call, for two independent reasons that looked identical from
// the log line:
//
//   1. No LLM_PRICE_<PROVIDER>_IN/_OUT were set anywhere, so no rate resolved.
//   2. The Anthropic and OpenAI adapters never called estimateCostUsd AT ALL —
//      they recorded token counts and passed no cost. Setting the env rates
//      would have fixed nothing for the one PAID rung in the chain, and the
//      symptom would have been unchanged: still `cost=unpriced`, now with rates
//      configured and an operator reasonably concluding the rates were wrong.
//
// Cache tokens get their own rates because pricing them as input is wrong in
// both directions — a read is ~0.1x input and a write ~1.25x. Billing reads as
// input makes a well-cached workload look an order of magnitude more expensive
// than it is, which would make the prompt-caching work in this same change set
// read as a cost regression on the dashboard built to measure it.

import assert from "node:assert/strict";
import { estimateCostUsd, resolvedRatesFor } from "../lib/providers/llm/costLedger";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

/** Run `fn` with exactly these LLM_PRICE_* vars set, then restore. */
function withRates(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Anthropic's published per-1M rates for claude-opus-5 — the model this
// repository's paid rung actually uses. Source cited in COOLIFY_ENV_CHANGES.md.
const OPUS5_IN = "5";
const OPUS5_OUT = "25";

console.log("\nLLM cost pricing\n");

// =============================================================================
console.log("  -- rate resolution --");

check("no configured rate means unpriced, never zero", () => {
  withRates({ LLM_PRICE_TESTPROV_IN: undefined, LLM_PRICE_TESTPROV_OUT: undefined }, () => {
    assert.equal(resolvedRatesFor("testprov"), null);
    assert.equal(estimateCostUsd("testprov", { tkIn: 1_000_000, tkOut: 1_000_000 }, false), null);
  });
});

check("a half-configured rate is unpriced, not half-counted", () => {
  // IN without OUT would otherwise produce a confident total that omits every
  // output token — the most expensive half of most calls.
  withRates({ LLM_PRICE_TESTPROV_IN: "5", LLM_PRICE_TESTPROV_OUT: undefined }, () => {
    assert.equal(resolvedRatesFor("testprov"), null);
  });
  withRates({ LLM_PRICE_TESTPROV_IN: undefined, LLM_PRICE_TESTPROV_OUT: "25" }, () => {
    assert.equal(resolvedRatesFor("testprov"), null);
  });
});

check("an empty string is 'not configured', not a zero rate", () => {
  // Number("") is 0. A blank Coolify variable must not silently price a paid
  // provider at $0.00 and report it as a real measurement.
  withRates({ LLM_PRICE_TESTPROV_IN: "", LLM_PRICE_TESTPROV_OUT: "" }, () => {
    assert.equal(resolvedRatesFor("testprov"), null);
  });
});

check("an explicit zero rate IS a rate — free endpoints price at $0", () => {
  // NVIDIA and Z.ai are trial endpoints: $0 is the true current rate, and
  // reporting $0.0000 is a real measurement where "unpriced" is an absence.
  withRates({ LLM_PRICE_NVIDIA_IN: "0", LLM_PRICE_NVIDIA_OUT: "0" }, () => {
    assert.deepEqual(resolvedRatesFor("nvidia"), { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(estimateCostUsd("nvidia", { tkIn: 500_000, tkOut: 500_000 }, false), 0);
  });
});

check("provider names are normalised to the env-var spelling", () => {
  withRates({ LLM_PRICE_SOME_PROV_IN: "10", LLM_PRICE_SOME_PROV_OUT: "20" }, () => {
    assert.deepEqual(resolvedRatesFor("some-prov"), { in: 10, out: 20, cacheRead: 1, cacheWrite: 12.5 });
  });
});

// =============================================================================
console.log("\n  -- exact arithmetic --");

check("plain in/out priced at Opus 5's published rates", () => {
  withRates({ LLM_PRICE_ANTHROPIC_IN: OPUS5_IN, LLM_PRICE_ANTHROPIC_OUT: OPUS5_OUT }, () => {
    // 1M in @ $5 + 1M out @ $25 = $30.00 exactly.
    assert.equal(estimateCostUsd("anthropic", { tkIn: 1_000_000, tkOut: 1_000_000 }, false), 30);
    // 200k in @ $5 = $1.00; 40k out @ $25 = $1.00 → $2.00
    assert.equal(estimateCostUsd("anthropic", { tkIn: 200_000, tkOut: 40_000 }, false), 2);
  });
});

check("cache tokens default to 0.1x read / 1.25x write of the input rate", () => {
  withRates({ LLM_PRICE_ANTHROPIC_IN: OPUS5_IN, LLM_PRICE_ANTHROPIC_OUT: OPUS5_OUT }, () => {
    const rates = resolvedRatesFor("anthropic")!;
    assert.equal(rates.cacheRead, 0.5, "0.1 x $5");
    assert.equal(rates.cacheWrite, 6.25, "1.25 x $5");

    // The whole call, one number, checked by hand:
    //   tkIn        100_000 @ $5.00/1M  = $0.50
    //   tkOut        20_000 @ $25.00/1M = $0.50
    //   tkCacheRead 800_000 @ $0.50/1M  = $0.40
    //   tkCacheWrite 50_000 @ $6.25/1M  = $0.3125
    //                                     -------
    //                                     $1.7125
    const cost = estimateCostUsd(
      "anthropic",
      { tkIn: 100_000, tkOut: 20_000, tkCacheRead: 800_000, tkCacheWrite: 50_000 },
      false
    );
    assert.equal(cost, 1.7125);
  });
});

check("pricing cache reads as input would overstate a cached call ~6x", () => {
  // The number this test exists to protect. Same call, both ways.
  withRates({ LLM_PRICE_ANTHROPIC_IN: OPUS5_IN, LLM_PRICE_ANTHROPIC_OUT: OPUS5_OUT }, () => {
    const correct = estimateCostUsd("anthropic", { tkIn: 10_000, tkOut: 5_000, tkCacheRead: 900_000 }, false)!;
    const asIfInput = estimateCostUsd("anthropic", { tkIn: 910_000, tkOut: 5_000 }, false)!;
    assert.equal(correct, 0.625); // 0.05 + 0.125 + 0.45
    assert.equal(asIfInput, 4.675); // 4.55 + 0.125
    assert.ok(asIfInput / correct > 5, "the distinction has to be worth making, and it is");
  });
});

check("explicit cache rates override the multipliers", () => {
  withRates({
    LLM_PRICE_ANTHROPIC_IN: OPUS5_IN,
    LLM_PRICE_ANTHROPIC_OUT: OPUS5_OUT,
    LLM_PRICE_ANTHROPIC_CACHE_READ: "0.6",
    LLM_PRICE_ANTHROPIC_CACHE_WRITE: "10",
  }, () => {
    const rates = resolvedRatesFor("anthropic")!;
    assert.equal(rates.cacheRead, 0.6);
    assert.equal(rates.cacheWrite, 10);
    // 1M read @ $0.60 + 1M write @ $10.00 = $10.60
    assert.equal(estimateCostUsd("anthropic", { tkIn: 0, tkOut: 0, tkCacheRead: 1_000_000, tkCacheWrite: 1_000_000 }, false), 10.6);
  });
});

check("an explicit cache rate of 0 is honoured, not treated as unset", () => {
  withRates({
    LLM_PRICE_ANTHROPIC_IN: OPUS5_IN,
    LLM_PRICE_ANTHROPIC_OUT: OPUS5_OUT,
    LLM_PRICE_ANTHROPIC_CACHE_READ: "0",
  }, () => {
    // A `||` fallback would treat the configured 0 as absent and quietly
    // substitute 0.1x input; `??` only falls back on null.
    assert.equal(resolvedRatesFor("anthropic")!.cacheRead, 0, "a configured rate of 0 was overridden by the default multiplier");
    assert.equal(estimateCostUsd("anthropic", { tkIn: 0, tkOut: 0, tkCacheRead: 1_000_000 }, false), 0);
  });
});

check("an unpriced endpoint stays null even with rates configured", () => {
  withRates({ LLM_PRICE_ZAI_IN: "1", LLM_PRICE_ZAI_OUT: "2" }, () => {
    assert.equal(estimateCostUsd("zai", { tkIn: 1_000_000, tkOut: 1_000_000 }, true), null);
  });
});

// =============================================================================
console.log("\n  -- the pre-cache call signature still works --");

check("the positional (provider, tkIn, tkOut, unpriced) form is unchanged", () => {
  // Kept so adding cache pricing did not become a rewrite of every call site.
  withRates({ LLM_PRICE_ANTHROPIC_IN: OPUS5_IN, LLM_PRICE_ANTHROPIC_OUT: OPUS5_OUT }, () => {
    assert.equal(estimateCostUsd("anthropic", 1_000_000, 1_000_000, false), 30);
    assert.equal(estimateCostUsd("anthropic", 1_000_000, 1_000_000, true), null);
  });
});

console.log(
  failed === 0 ? "\nAll LLM cost pricing checks passed.\n" : `\n${failed} check(s) FAILED.\n`
);
process.exit(failed === 0 ? 0 : 1);
