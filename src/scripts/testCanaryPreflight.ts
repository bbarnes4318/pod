// Executed test for the live-provider canary's contract.
//
// The canary's whole value is that an unconfigured or drifted run says WHY.
// These assertions pin the properties that make that true:
//   1. an empty environment names every missing variable, including the ones
//      meaning-aware audio QA needs,
//   2. no secret VALUE can reach the uploaded report,
//   3. a role served by something other than the model it requested is an
//      explicit drift alert, never a quietly passing run,
//   4. a judge sharing the writer's endpoint fails BEFORE anything is spent, and
//   5. the report written on an early failure still carries every block, so a
//      missing answer is never confused with an absent key.
//
// Network-free and spend-free: only pure functions and the report writer are
// exercised. Run: npm run test:canary-preflight

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  preflightCanaryEnv,
  preSpendCheck,
  assessRouteIndependence,
  classifyProviderError,
  classifyRoleDrift,
  configurationFailureReport,
  serializeCanaryReport,
  writeCanaryReport,
  emptyCanaryReport,
  roleEnvVars,
  CANARY_LLM_ROLES,
  CANARY_AUTHORING_ROLES,
  CANARY_EXPECTED_FISH_SCENE_MODEL,
  type CanaryEnv,
  type CanaryRoleRow,
  type CanaryRoute,
} from "./runLiveProviderCanary";
import { llmCostMark, llmCostSince } from "../lib/providers/llm/costLedger";
import { LlmProviderError } from "../lib/providers/llm/errors";
import { SceneGenerationError } from "../lib/providers/tts/sceneTypes";
import { SemanticQaUnavailableError } from "../lib/audio/audioSemanticQa";
import { compareToBaseline, voiceFingerprint } from "../lib/services/canaryBaseline";

const FAKE_SECRET = "SUPERSECRET_TOKEN_VALUE";
const FAKE_DEEPGRAM_SECRET = "SUPERSECRET_VALUE";
const FISH_A = "0123456789abcdef0123456789abcdef";
const FISH_B = "fedcba9876543210fedcba9876543210";

/** Exactly what an unconfigured repository (no secrets, no variables) is
 *  missing. If this list changes, the operator checklist changes with it. */
// CONTRACT CHANGE: no ElevenLabs variable belongs on this list.
//
// Production renders with Fish at s2.1-pro-free. ElevenLabs is a supported
// ADAPTER, not a dependency — demanding it refused release SHA 2172f718 over a
// provider production does not use. It is mandatory only when an operator names
// it in PRODUCTION_REQUIRED_TTS_PROVIDERS, which
// src/scripts/testTtsProviderPolicy.ts proves in both directions.
const EXPECTED_MISSING = [
  "ANTHROPIC_API_KEY",
  "CANARY_FISH_VOICE_A",
  "CANARY_FISH_VOICE_B",
  "DEEPGRAM_API_KEY",
  "FISH_API_KEY",
  "LLM_ROUTING_PROFILE",
  "QUALITY_JUDGE_LLM_MODEL",
  "QUALITY_JUDGE_LLM_PROVIDER",
  "RESEARCH_LLM_MODEL",
  "RESEARCH_LLM_PROVIDER",
  "SCRIPT_CONTINUITY_EDITOR_LLM_MODEL",
  "SCRIPT_CONTINUITY_EDITOR_LLM_PROVIDER",
  "SCRIPT_DEBATE_ARCHITECT_LLM_MODEL",
  "SCRIPT_DEBATE_ARCHITECT_LLM_PROVIDER",
  "SCRIPT_DIALOGUE_DIRECTOR_LLM_MODEL",
  "SCRIPT_DIALOGUE_DIRECTOR_LLM_PROVIDER",
  "SCRIPT_HOST_A_WRITER_LLM_MODEL",
  "SCRIPT_HOST_A_WRITER_LLM_PROVIDER",
  "SCRIPT_HOST_B_WRITER_LLM_MODEL",
  "SCRIPT_HOST_B_WRITER_LLM_PROVIDER",
  "SCRIPT_STORY_EDITOR_LLM_MODEL",
  "SCRIPT_STORY_EDITOR_LLM_PROVIDER",
  "TOPIC_GENERATION_LLM_MODEL",
  "TOPIC_GENERATION_LLM_PROVIDER",
  "TRANSCRIPT_QA_PROVIDER",
  "TTS_TRANSCRIPT_QA_ENABLED",
];

/** Every role route pinned to a real-looking provider/model pair. */
function roleEnv(): CanaryEnv {
  const env: CanaryEnv = {};
  for (const role of CANARY_LLM_ROLES) {
    const [providerVar, modelVar] = roleEnvVars(role);
    env[providerVar] = "anthropic";
    env[modelVar] = role === "quality_judge" ? "claude-sonnet-5" : "claude-opus-5";
  }
  return env;
}

function fullEnv(over: CanaryEnv = {}): CanaryEnv {
  return {
    LLM_ROUTING_PROFILE: "custom",
    ...roleEnv(),
    ANTHROPIC_API_KEY: FAKE_SECRET,
    FISH_API_KEY: "fake-fish-key-value",
    CANARY_FISH_VOICE_A: FISH_A,
    CANARY_FISH_VOICE_B: FISH_B,
    ELEVENLABS_API_KEY: "fake-elevenlabs-key-value",
    CANARY_ELEVENLABS_VOICE_A: "abcdEFGH1234ijklMNOP",
    CANARY_ELEVENLABS_VOICE_B: "zyxwVUTS9876rqpoNMLK",
    TTS_TRANSCRIPT_QA_ENABLED: "true",
    TRANSCRIPT_QA_PROVIDER: "deepgram",
    DEEPGRAM_API_KEY: FAKE_DEEPGRAM_SECRET,
    ...over,
  };
}

function route(role: string, label: string, identity = label): CanaryRoute {
  return { role, label, identity };
}

function roleRow(over: Partial<CanaryRoleRow> = {}): CanaryRoleRow {
  return {
    role: "script_host_a_writer",
    order: 3,
    label: "Host A writer",
    status: "ok",
    required: true,
    provider: "anthropic",
    requestedModel: "claude-opus-5",
    actualProvider: "anthropic",
    actualModel: "claude-opus-5",
    modelObservation: "cost_ledger",
    fellBack: false,
    fallbackReason: null,
    latencyMs: 1200,
    violations: 0,
    error: null,
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

console.log("\nLive-provider canary contract\n");

// ---------------------------------------------------------------- 1. empty env

check("an empty environment fails preflight and names every missing variable", () => {
  const result = preflightCanaryEnv({});
  assert.equal(result.ok, false);
  assert.deepEqual([...result.missing].sort(), EXPECTED_MISSING);
  assert.equal(result.invalid.length, 0, "absent variables are missing, never 'invalid'");
  // Fish is what a release depends on; ElevenLabs is an optional adapter.
  assert.deepEqual(result.requiredProviders, ["fish"]);
  assert.deepEqual(result.optionalProviders, ["elevenlabs"]);
  assert.ok(result.summary.includes("MISSING"), "summary must lead with the missing names");
});

check("the preflight result carries names and booleans only", () => {
  const result = preflightCanaryEnv(fullEnv());
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(FAKE_SECRET), "preflight result leaked a secret value");
  assert.ok(!serialized.includes("fake-fish-key-value"), "preflight result leaked a secret value");
  assert.ok(!serialized.includes(FAKE_DEEPGRAM_SECRET), "preflight result leaked the Deepgram key");
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

check("every role this canary calls must have its route pinned by name", () => {
  for (const role of CANARY_LLM_ROLES) {
    const [providerVar, modelVar] = roleEnvVars(role);
    const withoutProvider = preflightCanaryEnv(fullEnv({ [providerVar]: "" }));
    assert.ok(
      withoutProvider.missing.includes(providerVar),
      `${role} must fail preflight when ${providerVar} is unset — an unpinned role falls down the profile chain silently`
    );
    const withoutModel = preflightCanaryEnv(fullEnv({ [modelVar]: "" }));
    assert.ok(withoutModel.missing.includes(modelVar), `${role} must fail preflight when ${modelVar} is unset`);
  }
});

// ---------------------------------------------------------------- 3. semantic QA

check("the preflight requires the semantic-QA variables and names them", () => {
  const none = preflightCanaryEnv(
    fullEnv({ TTS_TRANSCRIPT_QA_ENABLED: "", TRANSCRIPT_QA_PROVIDER: "", DEEPGRAM_API_KEY: "" })
  );
  assert.equal(none.ok, false);
  for (const name of ["TTS_TRANSCRIPT_QA_ENABLED", "TRANSCRIPT_QA_PROVIDER", "DEEPGRAM_API_KEY"]) {
    assert.ok(none.missing.includes(name), `the preflight must name ${name} when semantic QA is unconfigured`);
    assert.ok(none.summary.includes(name), `the summary must name ${name} so a CI log is actionable`);
  }

  // Enabled must be a REAL 'true'. `not_run` is the outcome this canary exists
  // to make impossible, so anything else is a rejected value.
  const off = preflightCanaryEnv(fullEnv({ TTS_TRANSCRIPT_QA_ENABLED: "false" }));
  assert.equal(off.ok, false);
  assert.deepEqual(off.invalid.map((i) => i.name), ["TTS_TRANSCRIPT_QA_ENABLED"]);

  // The alternative spelling of the credential is accepted, and the canonical
  // one is still what gets NAMED when neither is present.
  const alternative = preflightCanaryEnv(
    fullEnv({ DEEPGRAM_API_KEY: "", TRANSCRIPT_QA_DEEPGRAM_API_KEY: "another-fake-key" })
  );
  assert.equal(alternative.ok, true, `TRANSCRIPT_QA_DEEPGRAM_API_KEY must satisfy the requirement: ${alternative.summary}`);

  const unsupported = preflightCanaryEnv(fullEnv({ TRANSCRIPT_QA_PROVIDER: "whisper-at-home" }));
  assert.equal(unsupported.ok, false);
  assert.deepEqual(unsupported.invalid.map((i) => i.name), ["TRANSCRIPT_QA_PROVIDER"]);

  // A production waiver would let semantic QA be skipped. A canary run may not
  // use one — a run that skipped the only meaning-aware check proves nothing.
  const waived = preflightCanaryEnv(fullEnv({ TTS_TRANSCRIPT_QA_WAIVED: "true" }));
  assert.equal(waived.ok, false);
  assert.deepEqual(waived.invalid.map((i) => i.name), ["TTS_TRANSCRIPT_QA_WAIVED"]);
});

// ---------------------------------------------------------------- 4. fully configured

check("a fully populated environment passes preflight", () => {
  const result = preflightCanaryEnv(fullEnv());
  assert.equal(result.ok, true, `preflight rejected a complete env: ${result.summary}`);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.invalid, []);
  assert.ok(result.summary.startsWith("Preflight OK"));
  assert.deepEqual(result.requiredRoles, CANARY_LLM_ROLES);
});

// ---------------------------------------------------------------- 5. classification

// A rejected key used to share `configuration_failure` with an unset variable
// and an unfunded account. Those are three different jobs for three different
// people, so they are now three classes. See testProviderErrorClassification.ts
// for the full five-way matrix and the billing case that forced the split.
check("a rejected credential is credential_failure, an outage is provider_failure", () => {
  const rejectedKey = new LlmProviderError({
    provider: "anthropic",
    model: "claude-opus-5",
    category: "authentication_failed",
    message: "401 invalid x-api-key",
  });
  assert.equal(classifyProviderError(rejectedKey), "credential_failure");

  // The routing chain reports the LAST candidate's category, so the aggregated
  // message is what preserves the real cause.
  const chainExhausted = new LlmProviderError({
    provider: "routing",
    model: "script_movement",
    category: "unknown",
    message: "Every candidate failed:\n  - anthropic/claude-opus-5 failed (authentication_failed): 401\n  - stub failed (unknown)",
  });
  assert.equal(classifyProviderError(chainExhausted), "credential_failure");

  // An UNSET variable is still configuration — the distinction the split keeps.
  const missingKey = new LlmProviderError({
    provider: "nvidia",
    model: "some-model",
    category: "missing_api_key",
    message: "Missing NVIDIA_API_KEY",
  });
  assert.equal(classifyProviderError(missingKey), "configuration_failure");

  const outage = new LlmProviderError({
    provider: "anthropic",
    model: "claude-opus-5",
    category: "provider_internal_error",
    message: "503",
  });
  assert.equal(classifyProviderError(outage), "provider_failure");

  assert.equal(classifyProviderError(new SceneGenerationError("authentication", "401")), "credential_failure");
  assert.equal(classifyProviderError(new SceneGenerationError("provider_unavailable", "503")), "provider_failure");
  assert.equal(classifyProviderError(new Error("something else")), "provider_failure");

  // An unrunnable semantic-QA stage is a missing key, not an outage.
  assert.equal(
    classifyProviderError(new SemanticQaUnavailableError(["DEEPGRAM_API_KEY"])),
    "configuration_failure"
  );
});

// ---------------------------------------------------------------- 6. role drift

check("a role served by a different model than requested is a drift alert, not a pass", () => {
  const clean = classifyRoleDrift([roleRow(), roleRow({ role: "script_host_b_writer", order: 4 })]);
  assert.equal(clean.ok, true, `an honest run must not raise drift: ${clean.reason}`);
  assert.equal(clean.alertClass, null);

  const substituted = classifyRoleDrift([
    roleRow(),
    roleRow({ role: "script_host_b_writer", order: 4, actualModel: "claude-haiku-4" }),
  ]);
  assert.equal(substituted.ok, false, "a substituted model must never be swallowed");
  assert.equal(substituted.alertClass, "model_drift");
  assert.deepEqual(substituted.drifted, ["script_host_b_writer"]);
  assert.ok(substituted.reason!.includes("claude-haiku-4"), "the alert must name what actually served the call");
  assert.ok(substituted.reason!.includes("claude-opus-5"), "the alert must name what was requested");

  const otherProvider = classifyRoleDrift([roleRow({ actualProvider: "nvidia" })]);
  assert.equal(otherProvider.alertClass, "model_drift");
  assert.deepEqual(otherProvider.drifted, ["script_host_a_writer"]);

  // A fallback that landed on the requested endpoint anyway is still a fallback:
  // earlier candidates failed, and that is news.
  const fellBack = classifyRoleDrift([roleRow({ fellBack: true, fallbackReason: "2 earlier candidates failed" })]);
  assert.equal(fellBack.ok, false);
  assert.equal(fellBack.alertClass, "model_drift");

  // "We could not tell" is not a proof that the requested model ran.
  const unobserved = classifyRoleDrift([roleRow({ actualModel: null, actualProvider: null, modelObservation: "unobserved" })]);
  assert.equal(unobserved.ok, false, "an unobservable role must not be recorded as having run the requested model");
  assert.equal(unobserved.alertClass, "model_drift");
  assert.deepEqual(unobserved.unobserved, ["script_host_a_writer"]);

  // A provider that reports only its default model has substituted nothing.
  const providerDefault = classifyRoleDrift([roleRow({ actualModel: "(provider-default)" })]);
  assert.equal(providerDefault.ok, true, `a provider-default report is not a substitution: ${providerDefault.reason}`);

  // Roles that never ran are the pipeline's failure to report, not drift.
  const skipped = classifyRoleDrift([roleRow({ status: "skipped", actualModel: null, modelObservation: "unobserved" })]);
  assert.equal(skipped.ok, true);
});

// ---------------------------------------------------------------- 7. independence

check("identical writer and judge routes are a configuration_failure before any spend", () => {
  const shared = "anthropic|https://api.anthropic.com/v1|claude-opus-5";
  const authoring: CanaryRoute[] = CANARY_AUTHORING_ROLES.map((role) =>
    route(role, "anthropic/claude-opus-5", shared)
  );
  const judge = route("quality_judge", "anthropic/claude-opus-5", shared);

  const independence = assessRouteIndependence(authoring, judge);
  assert.equal(independence.independent, false);
  assert.deepEqual(independence.collisions.sort(), [...CANARY_AUTHORING_ROLES].sort());
  assert.ok(independence.reason!.includes("QUALITY_JUDGE_LLM_PROVIDER"), "the alert must name the variable to change");

  // The spend gate itself: a passing preflight plus a colliding judge must still
  // stop the run, and must stop it as a CONFIGURATION failure.
  const mark = llmCostMark();
  const verdict = preSpendCheck(preflightCanaryEnv(fullEnv()), authoring, judge);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.alertClass, "configuration_failure");
  assert.ok(verdict.reason!.includes("quality_judge"));
  assert.equal(llmCostSince(mark).callCount, 0, "the pre-spend check must not have cost a single LLM call");

  // A judge on a genuinely different endpoint passes.
  const distinct = preSpendCheck(
    preflightCanaryEnv(fullEnv()),
    authoring,
    route("quality_judge", "anthropic/claude-sonnet-5", "anthropic|https://api.anthropic.com/v1|claude-sonnet-5")
  );
  assert.equal(distinct.ok, true, `a distinct judge route must pass: ${distinct.reason}`);
  assert.equal(distinct.alertClass, null);

  // An incomplete environment is caught by the same gate, also before spending.
  const unconfigured = preSpendCheck(preflightCanaryEnv({}), authoring, judge);
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.alertClass, "configuration_failure");
  assert.ok(unconfigured.reason!.includes("ANTHROPIC_API_KEY"));
});

// ---------------------------------------------------------------- 8. the report

check("the preflight-failure report is classified configuration_failure", () => {
  const report = configurationFailureReport(preflightCanaryEnv({}));
  assert.equal(report.status, "failed");
  assert.equal(report.alertClass, "configuration_failure");
  assert.equal(report.private, true);
  assert.equal(report.published, false);
  assert.equal(report.uploadedAnywhere, false);
  assert.ok((report.alertReason || "").includes("ANTHROPIC_API_KEY"), "the alert must name what to go set");
});

check("an early-failure report still carries every block", () => {
  const env = fullEnv({ ANTHROPIC_API_KEY: "" });
  const report = configurationFailureReport(preflightCanaryEnv(env));
  const parsed = JSON.parse(serializeCanaryReport(report, env)) as Record<string, unknown>;

  // Present-but-empty is a fact; absent is ambiguous. Every block a consumer
  // reads must exist on the very first failure, or "did semantic QA run?" gets
  // answered by omission.
  for (const key of [
    "preflight", "routing", "stages", "story", "brief", "roles", "roleDrift", "script",
    "fish", "providers", "semanticQa", "mix", "cost", "baseline", "comparison", "errors",
  ]) {
    assert.ok(key in parsed, `the report is missing the '${key}' block on an early failure`);
  }
  assert.deepEqual(parsed.roles, []);
  assert.deepEqual(parsed.providers, {});
  assert.deepEqual(parsed.semanticQa, {});
  assert.equal(parsed.story, null);
  assert.equal(parsed.mix, null);
  assert.equal((parsed.roleDrift as { ok: boolean }).ok, false, "drift is unproven, not proven-clean, before the roles run");
  assert.equal((parsed.comparison as { compared: boolean }).compared, false);
  assert.equal(parsed.version, 3);
});

check("a report never serializes a secret value", () => {
  const env = fullEnv({ CANARY_FISH_VOICE_A: "" });
  const report = configurationFailureReport(preflightCanaryEnv(env));
  // Simulate a provider SDK echoing the keys into error strings.
  report.errors.push(`upstream said: Authorization Bearer ${FAKE_SECRET} rejected`);
  report.errors.push(`deepgram said: Token ${FAKE_DEEPGRAM_SECRET} is not authorized`);
  report.alertReason = `provider rejected key ${FAKE_SECRET}`;
  const serialized = serializeCanaryReport(report, env);

  assert.ok(!serialized.includes(FAKE_SECRET), "report leaked ANTHROPIC_API_KEY's value");
  assert.ok(!serialized.includes("fake-fish-key-value"), "report leaked FISH_API_KEY's value");
  assert.ok(!serialized.includes(FAKE_DEEPGRAM_SECRET), "report leaked DEEPGRAM_API_KEY's value");
  assert.ok(serialized.includes("[redacted]"), "the leak should be visibly redacted, not silently dropped");
  assert.ok(serialized.includes("ANTHROPIC_API_KEY"), "variable NAMES stay in the report");
  assert.ok(serialized.includes("DEEPGRAM_API_KEY"), "variable NAMES stay in the report");
});

check("the report is always written to disk and is valid JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canary-preflight-"));
  try {
    const env = fullEnv({ ANTHROPIC_API_KEY: FAKE_SECRET, LLM_ROUTING_PROFILE: "" });
    const written = writeCanaryReport(dir, configurationFailureReport(preflightCanaryEnv(env)), env);
    assert.ok(fs.existsSync(written), "report.json must exist after a preflight failure");
    const raw = fs.readFileSync(written, "utf8");
    assert.ok(!raw.includes(FAKE_SECRET), "the report on disk leaked a secret value");
    assert.ok(!raw.includes(FAKE_DEEPGRAM_SECRET), "the report on disk leaked the Deepgram key");
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
  assert.equal(report.cost, null, "cost is unknown, not zero, before anything runs");
});

// ---------------------------------------------------------------- 9. baseline

check("the baseline comparison detects voice, model, quality and latency drift", () => {
  const fingerprintNow = voiceFingerprint(["fish", "s2.1-pro-free", FISH_A, FISH_B]);
  const fingerprintBefore = voiceFingerprint(["fish", "s2.1-pro-free", FISH_A, "0000000000000000cafecafecafecafe"]);
  assert.notEqual(fingerprintNow, fingerprintBefore);
  assert.ok(!fingerprintNow.includes(FISH_A), "a fingerprint must not embed the voice id it digests");

  const comparison = compareToBaseline(
    {
      ranAt: "2026-08-02T00:00:00.000Z",
      status: "ok",
      providers: {
        fish: { model: "s2.1-pro", endpoint: "https://api.fish.audio", latencyMs: 30000, performanceScore: 60, voiceFingerprint: fingerprintNow },
      },
      roles: [{ role: "script_host_a_writer", requestedModel: "claude-opus-5", actualProvider: "nvidia", actualModel: "deepseek" }],
      cost: { tokens: 20000, estimatedCostUsd: null },
    },
    {
      ranAt: "2026-08-01T00:00:00.000Z",
      status: "ok",
      providers: {
        fish: { model: "s2.1-pro-free", endpoint: "https://api.fish.audio", latencyMs: 10000, performanceScore: 88, voiceFingerprint: fingerprintBefore },
      },
      roles: [{ role: "script_host_a_writer", requestedModel: "claude-opus-5", actualProvider: "anthropic", actualModel: "claude-opus-5" }],
      cost: { tokens: 10000, estimatedCostUsd: null },
    }
  );
  assert.equal(comparison.compared, true);
  const classes = comparison.regressions.map((r) => r.alertClass);
  assert.ok(classes.includes("quality_regression"), "a 28-point score drop must be a quality regression");
  assert.ok(classes.includes("latency_regression"), "a 3x latency increase must be a latency regression");
  assert.ok(classes.includes("voice_drift"), "a changed voice digest and rendered model must be voice drift");
  assert.ok(classes.includes("model_drift"), "a role served by a different provider than the baseline is model drift");
  // Cost is REPORTED, never failed: the canary writes a new script every run.
  assert.equal(comparison.cost!.ratio, 2);
  assert.ok(!comparison.regressions.some((r) => r.message.includes("Token spend")));

  const noBaseline = compareToBaseline(
    { ranAt: "x", status: "ok", providers: {}, roles: [], cost: null },
    null
  );
  assert.equal(noBaseline.compared, false);
  assert.deepEqual(noBaseline.regressions, []);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
