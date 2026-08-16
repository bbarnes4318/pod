// A tier a user picks must actually route their episode, and must not leak into
// anyone else's.
//
//   npm run test:quality-tiers
//
// NETWORK-FREE.
//
// WHY IT EXISTS. `activeRoutingProfile()` read LLM_ROUTING_PROFILE and nothing
// else. One worker process serves every podcast, so an environment variable
// cannot express "this episode is Free and that one is Premium" — a tier
// dropdown would have had nowhere to write, and the honest failure mode is that
// the toggle appears to work while every episode keeps using the env default.
//
// The concurrency checks are the point. The cost ledger shipped a bug of exactly
// this shape (a process-wide watermark that attributed one job's tokens to
// another) and it was invisible until two jobs overlapped. A per-job override
// that leaks is the same bug wearing different clothes, so these tests
// interleave rather than running one tier after another.

import assert from "node:assert/strict";
import {
  activeRoutingProfile,
  currentRoutingProfileOverride,
  withRoutingProfile,
  declaredProfileChainFor,
} from "../lib/providers/llm/profiles";
import {
  DEFAULT_QUALITY_TIER,
  QUALITY_TIERS,
  formatTierCost,
  formatTierDuration,
  profileForTier,
  tierBadge,
  tierInfo,
  toQualityTier,
} from "../lib/providers/llm/qualityTiers";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  console.log("\nQuality tiers — selection, isolation, and honest copy\n");

  console.log("  -- the override actually overrides --");

  await check("a tier override beats the environment default", () => {
    process.env.LLM_ROUTING_PROFILE = "legacy";
    assert.equal(activeRoutingProfile(), "legacy");
    withRoutingProfile("free_independent", () => {
      assert.equal(activeRoutingProfile(), "free_independent", "the user's tier must win over the deployment default");
    });
    assert.equal(activeRoutingProfile(), "legacy", "the override must not outlive its scope");
  });

  await check("the override survives async boundaries", async () => {
    await withRoutingProfile("balanced", async () => {
      await tick();
      await (async () => {
        await tick();
        assert.equal(activeRoutingProfile(), "balanced", "several awaits deep, the tier must still apply");
      })();
    });
  });

  console.log("\n  -- isolation between concurrent episodes --");

  await check("two interleaved episodes do not see each other's tier", async () => {
    process.env.LLM_ROUTING_PROFILE = "legacy";
    const seen: Record<string, string[]> = { free: [], premium: [] };

    const freeJob = withRoutingProfile("free_independent", async () => {
      seen.free.push(activeRoutingProfile());
      await tick();
      seen.free.push(activeRoutingProfile());
      await tick();
      seen.free.push(activeRoutingProfile());
    });
    // Starts inside the free job's window — the shape that broke the ledger.
    const premiumJob = withRoutingProfile("verified_development", async () => {
      await tick();
      seen.premium.push(activeRoutingProfile());
      await tick();
      seen.premium.push(activeRoutingProfile());
    });

    await Promise.all([freeJob, premiumJob]);
    assert.ok(
      seen.free.every((p) => p === "free_independent"),
      `the free episode saw ${JSON.stringify(seen.free)} — a paid tier leaked into it`
    );
    assert.ok(
      seen.premium.every((p) => p === "verified_development"),
      `the premium episode saw ${JSON.stringify(seen.premium)} — it was downgraded mid-run`
    );
  });

  await check("work outside any tier still uses the environment", () => {
    process.env.LLM_ROUTING_PROFILE = "verified_development";
    assert.equal(currentRoutingProfileOverride(), undefined);
    assert.equal(activeRoutingProfile(), "verified_development");
  });

  console.log("\n  -- every tier maps to a real, distinct chain --");

  await check("each tier resolves to a profile with real chains", () => {
    for (const tier of QUALITY_TIERS) {
      const profile = profileForTier(tier);
      const writers = declaredProfileChainFor(profile, "script_host_a_writer" as any);
      assert.ok(writers.length > 0, `tier ${tier} -> ${profile} has no host-writer chain`);
    }
  });

  await check("the three tiers are genuinely different products", () => {
    const writerFor = (t: (typeof QUALITY_TIERS)[number]) => {
      const c = declaredProfileChainFor(profileForTier(t), "script_host_a_writer" as any);
      return `${c[0].provider}/${c[0].model}`;
    };
    const all = QUALITY_TIERS.map(writerFor);
    assert.equal(
      new Set(all).size,
      all.length,
      `two tiers use the same host-A writer (${all.join(", ")}) — a user paying more must get something different`
    );
  });

  console.log("\n  -- the copy is honest --");

  await check("the free tier is marked slow, and cannot silently not be", () => {
    const free = tierInfo("free");
    assert.equal(free.approxCostUsd, null, "free must not carry a price");
    assert.ok(free.speedWarning, "the free tier MUST carry a speed warning — this is the whole point");
    assert.match(free.speedWarning!, /\d+-\d+ minutes/, "the warning must state actual minutes, not 'slower'");
    assert.ok(
      free.approxMinutes[0] >= 8,
      "if the free tier ever gets fast, re-measure and rewrite the warning rather than deleting it"
    );
  });

  await check("the free tier's badge leads with time, not with 'free'", () => {
    // A chooser that shows the upside first is how a user ends up surprised.
    const badge = tierBadge("free");
    assert.ok(
      badge.indexOf("min") < badge.indexOf("Free"),
      `free badge is "${badge}" — the duration must come before the price`
    );
  });

  await check("paid tiers state a real per-episode cost", () => {
    for (const tier of ["balanced", "premium"] as const) {
      const info = tierInfo(tier);
      assert.ok(typeof info.approxCostUsd === "number" && info.approxCostUsd > 0, `${tier} must carry a price`);
      assert.ok(info.billable, `${tier} must be marked billable`);
      assert.equal(info.speedWarning, null, `${tier} is fast; a warning here would train users to ignore them`);
    }
  });

  await check("balanced is cheaper than premium and dearer than free", () => {
    assert.ok(tierInfo("balanced").approxCostUsd! < tierInfo("premium").approxCostUsd!);
    assert.equal(tierInfo("free").approxCostUsd, null);
  });

  await check("an unknown stored value falls back rather than throwing", () => {
    assert.equal(toQualityTier("nonsense"), DEFAULT_QUALITY_TIER);
    assert.equal(toQualityTier(undefined), DEFAULT_QUALITY_TIER);
    assert.equal(toQualityTier("free"), "free");
  });

  console.log("\n  -- what a user would see --");
  for (const tier of QUALITY_TIERS) {
    const i = tierInfo(tier);
    console.log(`     ${i.label.padEnd(9)} ${tierBadge(tier).padEnd(28)} ${i.writers}`);
    console.log(`               ${i.summary}`);
    if (i.speedWarning) console.log(`               ⚠ ${i.speedWarning}`);
  }

  console.log(failed === 0 ? "\nAll quality-tier checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
