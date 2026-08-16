// The free tier must be a real chain, not one flaky model wearing five hats.
//
//   npm run test:free-profile
//
// NETWORK-FREE. Asserts the SHAPE of free_independent — the properties that make
// it safe to offer a user — not model quality, which was measured by live probe
// on 2026-08-15 and is recorded in profiles.ts.
//
// WHY IT EXISTS. `free_independent` used to return `[ZAI_FLASH()]` for every
// role: one model doing structural planning, both hosts' dialogue and its own
// judging, with no fallback anywhere. Every invariant the paid profiles are held
// to — two writer families, judges independent of writers, a second rung per
// role — was silently absent from the tier we were about to put in front of
// users.

import assert from "node:assert/strict";
import { ALL_ROLES } from "../lib/providers/llm/roles";
import { declaredProfileChainFor } from "../lib/providers/llm/profiles";

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

const chain = (role: string) => declaredProfileChainFor("free_independent", role as any);
const key = (r: { provider: string; model: string }) => `${r.provider}/${r.model}`;

function main() {
  console.log("\nFree tier — profile shape\n");

  console.log("  -- coverage --");

  check("every role resolves to a non-empty chain", () => {
    for (const role of ALL_ROLES) {
      const c = chain(role);
      assert.ok(c.length > 0, `role ${role} has an EMPTY free chain — it would fall through to paid`);
    }
  });

  check("every role has a fallback rung", () => {
    const single = ALL_ROLES.filter((r) => chain(r).length < 2);
    assert.equal(
      single.length,
      0,
      `single-candidate roles have no failover: ${single.join(", ")}`
    );
  });

  check("no chain repeats the same provider/model twice", () => {
    for (const role of ALL_ROLES) {
      const keys = chain(role).map(key);
      assert.equal(new Set(keys).size, keys.length, `role ${role} lists a duplicate rung: ${keys.join(" -> ")}`);
    }
  });

  console.log("\n  -- the invariants a paid profile is held to --");

  check("the two host writers lead with DIFFERENT model families", () => {
    const a = chain("script_host_a_writer")[0];
    const b = chain("script_host_b_writer")[0];
    assert.notEqual(
      key(a),
      key(b),
      "both hosts lead with the same model — that is the voice-convergence failure, " +
        "and a free tier is not an excuse to reintroduce it"
    );
  });

  check("no judge shares a model with either host writer", () => {
    const writers = new Set([
      ...chain("script_host_a_writer").map(key),
      ...chain("script_host_b_writer").map(key),
    ]);
    for (const judge of ["quality_judge", "cold_open_judge"]) {
      for (const rung of chain(judge)) {
        assert.ok(
          !writers.has(key(rung)),
          `${judge} rung ${key(rung)} also writes a host — a judge cannot grade its own output`
        );
      }
    }
  });

  check("verification does not share a model with either host writer", () => {
    const writers = new Set([
      ...chain("script_host_a_writer").map(key),
      ...chain("script_host_b_writer").map(key),
    ]);
    for (const role of ["script_verification", "fact_check"]) {
      for (const rung of chain(role)) {
        assert.ok(!writers.has(key(rung)), `${role} rung ${key(rung)} also writes a host`);
      }
    }
  });

  console.log("\n  -- measured-provider rules --");

  check("no host writer is routed to gpt-oss", () => {
    // 35.8 on EQ-Bench longform creative writing (Opus 5 is 86.3). Superb at
    // emitting a verdict, hopeless at writing a line anyone wants to hear.
    for (const role of ["script_host_a_writer", "script_host_b_writer"]) {
      for (const rung of chain(role)) {
        assert.ok(
          !/gpt-oss/i.test(rung.model),
          `${role} routes to ${key(rung)} — gpt-oss must never write audible dialogue`
        );
      }
    }
  });

  check("schema-critical roles route only to strict-schema-capable rungs", () => {
    // Measured: on Groq only the gpt-oss models honour json_schema —
    // llama-3.3-70b returns HTTP 400. On Cerebras, gpt-oss is the verified one.
    for (const role of ["quality_judge", "cold_open_judge", "script_verification", "fact_check", "script_debate_architect"]) {
      for (const rung of chain(role)) {
        const ok = (rung.provider === "groq" || rung.provider === "cerebras") && /gpt-oss/i.test(rung.model);
        assert.ok(ok, `${role} rung ${key(rung)} is not a verified strict-schema route`);
      }
    }
  });

  check("no free rung routes to NVIDIA gpt-oss", () => {
    // Same weights as Cerebras', and it TIMED OUT at 300,775 ms on the identical
    // request that Cerebras answered in 703 ms. Provider, not model.
    for (const role of ALL_ROLES) {
      for (const rung of chain(role)) {
        assert.ok(
          !(rung.provider === "nvidia" && /gpt-oss/i.test(rung.model)),
          `${role} routes to ${key(rung)} — NVIDIA's gpt-oss timed out where Cerebras took 703 ms`
        );
      }
    }
  });

  check("structured roles avoid Z.ai, which fails schema", () => {
    // GLM-5.2 on Z.ai answers 8x faster than on NVIDIA and returns output that
    // does not match the schema. Fast-and-broken loses to slow-and-correct.
    for (const role of ["script_verification", "fact_check", "quality_judge", "cold_open_judge"]) {
      for (const rung of chain(role)) {
        assert.notEqual(rung.provider, "zai", `${role} routes to Z.ai, whose structured output omits required fields`);
      }
    }
  });

  console.log("\n  -- what the tier actually resolves to --");
  for (const role of ALL_ROLES) {
    console.log(`     ${String(role).padEnd(28)} ${chain(role).map(key).join("  ->  ")}`);
  }

  console.log(failed === 0 ? "\nAll free-profile checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
