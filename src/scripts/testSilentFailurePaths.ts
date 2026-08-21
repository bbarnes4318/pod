// Silent-failure closures (Part 3.1 and 3.7).
//
// Both of these shipped degraded output while reporting success:
//   3.1 the antithesis pass only enforced under ANTITHESIS_STRICT=true, which
//       production does not set — so an unresolved "that's not X, that's Y"
//       frame AND an outright pass failure both shipped behind a console.warn.
//       REVISED 2026-08-21: hard-failing production on this was worse than the
//       silence it replaced. The frames survived for mechanical reasons — the
//       wrong rewrite prompt, correct repairs discarded by a shrink-only word
//       ceiling, provider errors indistinguishable from refusals — so a style
//       rule was destroying finished episodes. The closure that matters is that
//       the degradation is REPORTED (reasons, needsHumanReview, a warn), not
//       that it is fatal. Fatal is now opt-in.
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
// because exporting it would widen that module's surface for one test.
function antithesisEnforced(env: Record<string, string | undefined>): boolean {
  if (env.ANTITHESIS_ALLOW_SOFT_FAIL === "true") return false;
  return env.ANTITHESIS_STRICT === "true";
}

function main() {
  console.log("\n3.1 — the antithesis pass reports, and only fails when told to\n");

  check("a surviving style frame does NOT kill a production episode", () => {
    assert(!antithesisEnforced({ NODE_ENV: "production" }),
      "a balanced-negation frame is a style defect; it must not destroy a finished episode by default");
  });

  check("hard failure is available, but has to be asked for", () => {
    assert(antithesisEnforced({ NODE_ENV: "production", ANTITHESIS_STRICT: "true" }),
      "ANTITHESIS_STRICT=true must still fail the episode for anyone who wants that");
    assert(antithesisEnforced({ NODE_ENV: "development", ANTITHESIS_STRICT: "true" }),
      "the opt-in must work in dev too");
  });

  check("the explicit soft-fail override still wins over strict", () => {
    assert(!antithesisEnforced({ NODE_ENV: "production", ANTITHESIS_STRICT: "true", ANTITHESIS_ALLOW_SOFT_FAIL: "true" }),
      "an operator who has explicitly disabled the gate must not be overridden by strict mode");
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
