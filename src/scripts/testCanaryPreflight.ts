// Executed test for the live-provider canary preflight.
//
// The canary's whole value is that an unconfigured run says WHY. These
// assertions pin the three properties that make that true:
//   1. an empty environment names every missing variable,
//   2. no secret VALUE can reach the uploaded report, and
//   3. the report written when preflight fails is valid JSON on disk and is
//      classified `configuration_failure` rather than a generic crash.
//
// Network-free: only the pure preflight and the report writer are exercised.
// Run: npm run test:canary-preflight

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  preflightCanaryEnv,
  classifyProviderError,
  configurationFailureReport,
  serializeCanaryReport,
  writeCanaryReport,
  emptyCanaryReport,
  CANARY_EXPECTED_FISH_SCENE_MODEL,
  type CanaryEnv,
} from "./runLiveProviderCanary";
import { LlmProviderError } from "../lib/providers/llm/errors";
import { SceneGenerationError } from "../lib/providers/tts/sceneTypes";

const FAKE_SECRET = "SUPERSECRET_TOKEN_VALUE";
const FISH_A = "0123456789abcdef0123456789abcdef";
const FISH_B = "fedcba9876543210fedcba9876543210";

/** Exactly what an unconfigured repository (no secrets, no variables) is
 *  missing. If this list changes, the operator checklist changes with it. */
const EXPECTED_MISSING = [
  "ANTHROPIC_API_KEY",
  "CANARY_ELEVENLABS_VOICE_A",
  "CANARY_ELEVENLABS_VOICE_B",
  "CANARY_FISH_VOICE_A",
  "CANARY_FISH_VOICE_B",
  "ELEVENLABS_API_KEY",
  "FISH_API_KEY",
  "LLM_ROUTING_PROFILE",
  "QUALITY_JUDGE_LLM_MODEL",
  "QUALITY_JUDGE_LLM_PROVIDER",
  "SCRIPT_MOVEMENT_LLM_MODEL",
  "SCRIPT_MOVEMENT_LLM_PROVIDER",
];

function fullEnv(over: CanaryEnv = {}): CanaryEnv {
  return {
    LLM_ROUTING_PROFILE: "custom",
    SCRIPT_MOVEMENT_LLM_PROVIDER: "anthropic",
    SCRIPT_MOVEMENT_LLM_MODEL: "claude-opus-5",
    QUALITY_JUDGE_LLM_PROVIDER: "anthropic",
    QUALITY_JUDGE_LLM_MODEL: "claude-sonnet-5",
    ANTHROPIC_API_KEY: FAKE_SECRET,
    FISH_API_KEY: "fake-fish-key-value",
    CANARY_FISH_VOICE_A: FISH_A,
    CANARY_FISH_VOICE_B: FISH_B,
    ELEVENLABS_API_KEY: "fake-elevenlabs-key-value",
    CANARY_ELEVENLABS_VOICE_A: "abcdEFGH1234ijklMNOP",
    CANARY_ELEVENLABS_VOICE_B: "zyxwVUTS9876rqpoNMLK",
    ...over,
  };
}

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(error as Error).message}`);
  }
}

console.log("\nLive-provider canary preflight\n");

// ---------------------------------------------------------------- 1. empty env

check("an empty environment fails preflight and names every missing variable", () => {
  const result = preflightCanaryEnv({});
  assert.equal(result.ok, false);
  assert.deepEqual([...result.missing].sort(), EXPECTED_MISSING);
  assert.equal(result.invalid.length, 0, "absent variables are missing, never 'invalid'");
  assert.deepEqual(result.requiredProviders, ["fish", "elevenlabs"]);
  assert.ok(result.summary.includes("MISSING"), "summary must lead with the missing names");
});

check("the preflight result carries names and booleans only", () => {
  const result = preflightCanaryEnv(fullEnv());
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(FAKE_SECRET), "preflight result leaked a secret value");
  assert.ok(!serialized.includes("fake-fish-key-value"), "preflight result leaked a secret value");
  assert.ok(!serialized.includes(FISH_A), "preflight result leaked a voice id");
  for (const entry of result.checks) {
    assert.equal(typeof entry.present, "boolean");
    assert.equal(typeof entry.valid, "boolean");
  }
});

// ---------------------------------------------------------------- 2. shapes

check("a malformed Fish voice id is invalid, not missing", () => {
  const result = preflightCanaryEnv(fullEnv({ CANARY_FISH_VOICE_A: "not-a-reference-id" }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid.map((i) => i.name), ["CANARY_FISH_VOICE_A"]);
  assert.ok(!JSON.stringify(result).includes("not-a-reference-id"), "invalid reason must describe the rule, not the value");
});

check("an unknown routing profile and a non-S2 Fish model are rejected", () => {
  const profile = preflightCanaryEnv(fullEnv({ LLM_ROUTING_PROFILE: "made_up" }));
  assert.equal(profile.ok, false);
  assert.deepEqual(profile.invalid.map((i) => i.name), ["LLM_ROUTING_PROFILE"]);

  const model = preflightCanaryEnv(fullEnv({ FISH_SCENE_MODEL: "s1" }));
  assert.equal(model.ok, false);
  assert.deepEqual(model.invalid.map((i) => i.name), ["FISH_SCENE_MODEL"]);

  const kept = preflightCanaryEnv(fullEnv({ FISH_SCENE_MODEL: CANARY_EXPECTED_FISH_SCENE_MODEL }));
  assert.equal(kept.ok, true, "the mandated free S2.1 model must pass");
});

check("a non-Anthropic role provider additionally requires its own credential", () => {
  const result = preflightCanaryEnv(fullEnv({ QUALITY_JUDGE_LLM_PROVIDER: "nvidia" }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["NVIDIA_API_KEY"]);
});

// ---------------------------------------------------------------- 3. fully configured

check("a fully populated environment passes preflight", () => {
  const result = preflightCanaryEnv(fullEnv());
  assert.equal(result.ok, true, `preflight rejected a complete env: ${result.summary}`);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
  assert.ok(result.summary.startsWith("Preflight OK"));
});

// ---------------------------------------------------------------- 4. classification

check("a rejected credential is configuration_failure, an outage is provider_failure", () => {
  const rejectedKey = new LlmProviderError({
    provider: "anthropic",
    model: "claude-opus-5",
    category: "authentication_failed",
    message: "401 invalid x-api-key",
  });
  assert.equal(classifyProviderError(rejectedKey), "configuration_failure");

  // The routing chain reports the LAST candidate's category, so the aggregated
  // message is what preserves the real cause.
  const chainExhausted = new LlmProviderError({
    provider: "routing",
    model: "script_movement",
    category: "unknown",
    message: "Every candidate failed:\n  - anthropic/claude-opus-5 failed (authentication_failed): 401\n  - stub failed (unknown)",
  });
  assert.equal(classifyProviderError(chainExhausted), "configuration_failure");

  const outage = new LlmProviderError({
    provider: "anthropic",
    model: "claude-opus-5",
    category: "provider_internal_error",
    message: "503",
  });
  assert.equal(classifyProviderError(outage), "provider_failure");

  assert.equal(classifyProviderError(new SceneGenerationError("authentication", "401")), "configuration_failure");
  assert.equal(classifyProviderError(new SceneGenerationError("provider_unavailable", "503")), "provider_failure");
  assert.equal(classifyProviderError(new Error("something else")), "provider_failure");
});

// ---------------------------------------------------------------- 5. the report

check("the preflight-failure report is classified configuration_failure", () => {
  const report = configurationFailureReport(preflightCanaryEnv({}));
  assert.equal(report.status, "failed");
  assert.equal(report.alertClass, "configuration_failure");
  assert.equal(report.private, true);
  assert.equal(report.published, false);
  assert.ok((report.alertReason || "").includes("ANTHROPIC_API_KEY"), "the alert must name what to go set");
});

check("a report never serializes a secret value", () => {
  const env = fullEnv({ CANARY_FISH_VOICE_A: "" });
  const report = configurationFailureReport(preflightCanaryEnv(env));
  // Simulate a provider SDK echoing the key into an error string.
  report.errors.push(`upstream said: Authorization Bearer ${FAKE_SECRET} rejected`);
  report.alertReason = `provider rejected key ${FAKE_SECRET}`;
  const serialized = serializeCanaryReport(report, env);
  assert.ok(!serialized.includes(FAKE_SECRET), "report leaked ANTHROPIC_API_KEY's value");
  assert.ok(!serialized.includes("fake-fish-key-value"), "report leaked FISH_API_KEY's value");
  assert.ok(serialized.includes("[redacted]"), "the leak should be visibly redacted, not silently dropped");
  assert.ok(serialized.includes("ANTHROPIC_API_KEY"), "variable NAMES stay in the report");
});

check("the report is always written to disk and is valid JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-preflight-"));
  try {
    const env = fullEnv({ ANTHROPIC_API_KEY: FAKE_SECRET, LLM_ROUTING_PROFILE: "" });
    const written = writeCanaryReport(dir, configurationFailureReport(preflightCanaryEnv(env)), env);
    assert.ok(fs.existsSync(written), "report.json must exist after a preflight failure");
    const raw = fs.readFileSync(written, "utf8");
    assert.ok(!raw.includes(FAKE_SECRET), "the report on disk leaked a secret value");
    const parsed = JSON.parse(raw) as { alertClass: string; status: string; preflight: { missing: string[] } };
    assert.equal(parsed.alertClass, "configuration_failure");
    assert.equal(parsed.status, "failed");
    assert.deepEqual(parsed.preflight.missing, ["LLM_ROUTING_PROFILE"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("every report starts with an explicit alert class", () => {
  const report = emptyCanaryReport(preflightCanaryEnv({}));
  assert.equal(report.alertClass, "configuration_failure");
  assert.equal(report.status, "failed");
  assert.equal(report.fish.expectedSceneModel, "s2.1-pro-free");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
