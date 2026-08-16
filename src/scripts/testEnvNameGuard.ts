// A variable name that cannot survive a build must be caught before the build.
//
//   npm run test:env-name-guard
//
// NETWORK-FREE.
//
// WHY IT EXISTS. On 2026-08-16 a variable named `CEREBRAS API KEY` — spaces
// instead of underscores — was added through the Coolify UI, which accepted it.
// The next build produced:
//
//   /artifacts/build-time.env: line 134: CEREBRAS: command not found
//   ERROR: docker: 'docker buildx build' requires 1 argument
//
// Coolify then ran "Deployment failed. Removing the new version of your
// application" and the RUNNING web container went with it. The site served 503
// with no container present at all. A typo in a text field caused a production
// outage, and the only warning was a line in a build log.
//
// The first case below is that exact string. If this file ever stops failing on
// it, the guard has been broken.

import assert from "node:assert/strict";
import {
  currentEnvNameProblems,
  diagnoseEnvName,
  findEnvNameProblems,
  VALID_ENV_NAME,
} from "../lib/services/envNameGuard";

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

function main() {
  console.log("\nEnvironment variable names — deploy safety\n");

  console.log("  -- the outage this exists to prevent --");

  check("the exact name that took production down is rejected", () => {
    const reason = diagnoseEnvName("CEREBRAS API KEY");
    assert.ok(reason, "`CEREBRAS API KEY` must be flagged — this is the 2026-08-16 outage verbatim");
    assert.match(reason!, /space/i, "the message must name the space as the cause");
    assert.match(reason!, /docker build|build/i, "and say what it does to a build");
  });

  check("the problem is reported without reading any value", () => {
    // The guard runs against the whole environment, credentials included, so it
    // must never surface a value. It takes keys only — this asserts the shape.
    const problems = findEnvNameProblems(["GOOD_KEY", "BAD KEY"]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].key, "BAD KEY");
    assert.ok(!("value" in problems[0]), "a problem record must not carry a value field");
  });

  console.log("\n  -- other names that break a build --");

  const bad: Array<[string, RegExp]> = [
    ["MY KEY", /space/i],
    ["2FA_SECRET", /digit/i],
    ["API-KEY", /hyphen/i],
    ["KEY!", /letter|digit|underscore/i],
    ["KEY.NAME", /letter|digit|underscore/i],
    ["KEY$VAR", /letter|digit|underscore/i],
    ["", /letter|digit|underscore/i],
  ];
  for (const [key, expect] of bad) {
    check(`rejects ${JSON.stringify(key)}`, () => {
      const reason = diagnoseEnvName(key);
      assert.ok(reason, `${JSON.stringify(key)} should be rejected`);
      assert.match(reason!, expect);
    });
  }

  console.log("\n  -- names that must keep working --");

  const good = [
    "CEREBRAS_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "_PRIVATE",
    "LLM_PRICE_ANTHROPIC_CLAUDE_HAIKU_4_5_IN",
    "A",
    "NODE_ENV",
    "npm_config_cache", // lowercase is legal and common in real environments
  ];
  for (const key of good) {
    check(`accepts ${key}`, () => {
      assert.ok(VALID_ENV_NAME.test(key), `${key} must be considered valid`);
      assert.equal(diagnoseEnvName(key), null);
    });
  }

  console.log("\n  -- scanning a whole environment --");

  check("a clean environment yields no problems", () => {
    assert.deepEqual(findEnvNameProblems(["PATH", "HOME", "GROQ_API_KEY"]), []);
  });

  check("every bad name is reported, not just the first", () => {
    const problems = findEnvNameProblems(["OK_ONE", "BAD ONE", "OK_TWO", "BAD-TWO", "3BAD"]);
    assert.equal(problems.length, 3, `expected 3 problems, got ${problems.map((p) => p.key).join(", ")}`);
  });

  check("the live environment is clean, ignoring platform-injected names", () => {
    // currentEnvNameProblems filters names no operator can set — Windows'
    // ProgramFiles(x86), header-derived SENTRY-TRACE. The raw scan flags those
    // on every Windows machine, and three permanent failures on a readiness page
    // is how a warning becomes wallpaper.
    const problems = currentEnvNameProblems();
    assert.deepEqual(
      problems.map((p) => p.key),
      [],
      `this environment has operator-settable names that would break a build: ${problems.map((p) => p.key).join(", ")}`
    );
  });

  check("the filter does NOT hide an operator-typed bad name", () => {
    // The filter's whole risk is masking a real problem. `CEREBRAS API KEY`
    // matches no platform pattern and must still be caught by the same function
    // the readiness page calls.
    process.env["CEREBRAS API KEY"] = "x";
    try {
      const keys = currentEnvNameProblems().map((p) => p.key);
      assert.ok(
        keys.includes("CEREBRAS API KEY"),
        "the filter swallowed the exact name that caused the outage"
      );
    } finally {
      delete process.env["CEREBRAS API KEY"];
    }
  });

  console.log(failed === 0 ? "\nAll env-name checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
