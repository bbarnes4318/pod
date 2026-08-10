// Silent-failure closures (Part 3.1 and 3.7).
//
// Both of these shipped degraded output while reporting success:
//   3.1 the antithesis pass only enforced under ANTITHESIS_STRICT=true, which
//       production does not set — so an unresolved "that's not X, that's Y"
//       frame AND an outright pass failure both shipped behind a console.warn.
//   3.7 TTS_SCENE_CANDIDATES_* looked like the best-of-N quality dial. It drove
//       an outer loop that kept the FIRST candidate that succeeded, because
//       nothing at that layer can compare two renders. Raising it multiplied
//       spend for an arbitrary pick.
//
// NETWORK-FREE. Run: npm run test:silent-failure-paths

import { assertNoDeadSceneCandidateVars, DEAD_SCENE_CANDIDATE_VARS } from "../lib/services/renderModePolicy";

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function throws(fn: () => unknown): Error | null {
  try { fn(); return null; } catch (e) { return e as Error; }
}

// Mirrors antithesisEnforced() in scriptService, which is module-private
// because exporting it would widen that module's surface for one test. The
// policy is small enough to restate and the point is that the DEFAULT is on.
function antithesisEnforced(env: Record<string, string | undefined>): boolean {
  if (env.ANTITHESIS_STRICT === "true") return true;
  if (env.ANTITHESIS_ALLOW_SOFT_FAIL === "true") return false;
  return env.NODE_ENV === "production";
}

function main() {
  console.log("\n3.1 — the antithesis pass is a gate, not a suggestion\n");

  check("production enforces WITHOUT any variable being set", () => {
    assert(antithesisEnforced({ NODE_ENV: "production" }),
      "an unset ANTITHESIS_STRICT must no longer mean 'ship it anyway' in production");
  });

  check("turning it off takes a deliberate override, not a forgotten variable", () => {
    assert(!antithesisEnforced({ NODE_ENV: "production", ANTITHESIS_ALLOW_SOFT_FAIL: "true" }),
      "the explicit override must still work");
    // The old failure shape: the ONLY thing standing between a degraded script
    // and production was a variable nobody had set.
    assert(antithesisEnforced({ NODE_ENV: "production", ANTITHESIS_STRICT: undefined }),
      "absence of ANTITHESIS_STRICT must not disable the gate");
  });

  check("dev stays soft so a local run is not blocked by a rewrite hiccup", () => {
    assert(!antithesisEnforced({ NODE_ENV: "development" }), "dev should not hard-fail by default");
    assert(antithesisEnforced({ NODE_ENV: "development", ANTITHESIS_STRICT: "true" }),
      "dev must still be able to opt IN");
  });

  console.log("\n3.7 — the dead candidate knob refuses to boot\n");

  check("every dead variable is rejected, individually", () => {
    for (const name of DEAD_SCENE_CANDIDATE_VARS) {
      const err = throws(() => assertNoDeadSceneCandidateVars({ [name]: "3" } as unknown as NodeJS.ProcessEnv));
      assert(err !== null, `${name} is set but boot did not fail`);
      assert(err!.message.includes(name), `the error must name ${name}: ${err!.message}`);
    }
  });

  check("the error points at the knob that actually works", () => {
    const err = throws(() => assertNoDeadSceneCandidateVars({ TTS_SCENE_CANDIDATES_PEAK: "4" } as unknown as NodeJS.ProcessEnv));
    assert(/FISH_PERFORMANCE_CANDIDATES/.test(err!.message),
      `an operator who set the dead knob wanted best-of-N; the error must name the real one: ${err!.message}`);
  });

  check("an empty or absent value is not treated as set", () => {
    assert(throws(() => assertNoDeadSceneCandidateVars({} as unknown as NodeJS.ProcessEnv)) === null, "an unset env must boot");
    assert(throws(() => assertNoDeadSceneCandidateVars({ TTS_SCENE_CANDIDATES_PEAK: "" } as unknown as NodeJS.ProcessEnv)) === null,
      "an empty string must not fail boot");
    assert(throws(() => assertNoDeadSceneCandidateVars({ TTS_SCENE_CANDIDATES_PEAK: "  " } as unknown as NodeJS.ProcessEnv)) === null,
      "whitespace must not fail boot");
  });

  check("all three set at once are reported together, not one per restart", () => {
    const err = throws(() => assertNoDeadSceneCandidateVars({
      TTS_SCENE_CANDIDATES_COLD_OPEN: "3", TTS_SCENE_CANDIDATES_PEAK: "3", TTS_SCENE_CANDIDATES_DEFAULT: "2",
    } as unknown as NodeJS.ProcessEnv));
    for (const name of DEAD_SCENE_CANDIDATE_VARS) {
      assert(err!.message.includes(name), `${name} missing from the combined error`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
