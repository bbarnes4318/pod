// Regression proof that an ElevenLabs adapter cannot block a Fish release.
//
// The canary refused release SHA 2172f718 with
// `configuration_failure: MISSING CANARY_ELEVENLABS_VOICE_A, _B` — for a
// provider production does not use. Production renders with Fish at
// s2.1-pro-free; ElevenLabs is a supported adapter, not a dependency.
//
// These tests hold that line in both directions: Fish alone is sufficient, and
// ElevenLabs becomes mandatory only when an operator explicitly asks for it.

import assert from "node:assert/strict";
import {
  DEFAULT_OPTIONAL_TTS_PROVIDERS,
  DEFAULT_REQUIRED_TTS_PROVIDERS,
  OPTIONAL_TTS_PROVIDERS_VAR,
  REQUIRED_TTS_PROVIDERS_VAR,
  elevenLabsIsRequired,
  resolveTtsProviderPolicy,
} from "../lib/services/ttsProviderPolicy";
import { preflightCanaryEnv } from "./runLiveProviderCanary";
import { requiredTtsProviders, optionalTtsProviders } from "../lib/services/readinessProbes";
import { resolveFishSceneModel } from "../lib/providers/tts/fishDialogue";

let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

/** A complete, VALID canary environment that configures Fish and NOT ElevenLabs. */
function fishOnlyEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const roles = [
    "TOPIC_GENERATION", "RESEARCH", "SCRIPT_STORY_EDITOR", "SCRIPT_DEBATE_ARCHITECT",
    "SCRIPT_HOST_A_WRITER", "SCRIPT_HOST_B_WRITER", "SCRIPT_DIALOGUE_DIRECTOR",
    "SCRIPT_CONTINUITY_EDITOR", "QUALITY_JUDGE",
  ];
  const env: Record<string, string | undefined> = {
    LLM_ROUTING_PROFILE: "custom",
    ANTHROPIC_API_KEY: "test-anthropic-key",
    FISH_API_KEY: "test-fish-key",
    // Two DISTINCT 32-hex Fish reference ids.
    CANARY_FISH_VOICE_A: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1",
    CANARY_FISH_VOICE_B: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2",
    TTS_TRANSCRIPT_QA_ENABLED: "true",
    TRANSCRIPT_QA_PROVIDER: "deepgram",
    DEEPGRAM_API_KEY: "test-deepgram-key",
  };
  for (const r of roles) {
    env[`${r}_LLM_PROVIDER`] = "anthropic";
    // The judge must not share an endpoint with the authoring roles.
    env[`${r}_LLM_MODEL`] = r === "QUALITY_JUDGE" ? "claude-sonnet-5" : "claude-opus-5";
  }
  return { ...env, ...over };
}

console.log("\nTTS provider policy: Fish is the release, ElevenLabs is an adapter\n");

console.log("  -- 1. Fish alone passes the mandatory production canary --");

check("the DEFAULT required set is Fish only", () => {
  assert.deepEqual([...DEFAULT_REQUIRED_TTS_PROVIDERS], ["fish"]);
  assert.deepEqual([...DEFAULT_OPTIONAL_TTS_PROVIDERS], ["elevenlabs"]);
  const p = resolveTtsProviderPolicy({});
  assert.deepEqual(p.required, ["fish"], "production renders on Fish");
  assert.deepEqual(p.optional, ["elevenlabs"], "ElevenLabs is exercised, never demanded");
});

check("preflight PASSES with Fish + two Fish voices + Deepgram and NO ElevenLabs", () => {
  const result = preflightCanaryEnv(fishOnlyEnv() as never);
  assert.equal(
    result.ok,
    true,
    `a Fish-only release must pass preflight; missing=${result.missing.join(", ")} invalid=${result.invalid.map((i) => i.name).join(", ")}`
  );
  assert.deepEqual(result.requiredProviders, ["fish"]);
});

check("no ElevenLabs variable appears in the missing list", () => {
  const result = preflightCanaryEnv(fishOnlyEnv() as never);
  const leaked = result.missing.filter((m) => m.toUpperCase().includes("ELEVENLABS"));
  assert.deepEqual(leaked, [], `ElevenLabs must not be demanded: ${leaked.join(", ")}`);
});

check("the unconfigured ElevenLabs adapter is reported as SKIPPED, not missing", () => {
  const result = preflightCanaryEnv(fishOnlyEnv() as never);
  assert.deepEqual(result.optionalProviders, ["elevenlabs"]);
  const note = result.checks.find((c) => c.name === "optional provider: elevenlabs");
  assert.ok(note, "the report must say what happened to the optional adapter");
  assert.match(String(note!.note), /SKIPPED/i);
  assert.equal(note!.valid, true, "an unconfigured optional adapter is not an error");
});

check("the exact failure that refused SHA 2172f718 no longer occurs", () => {
  // Reproduces the real refusal: everything configured except the two
  // ElevenLabs voices, which production has never had.
  const result = preflightCanaryEnv(fishOnlyEnv({ ELEVENLABS_API_KEY: undefined }) as never);
  assert.equal(result.ok, true, "the historical blocker must be gone");
  assert.ok(
    !result.missing.includes("CANARY_ELEVENLABS_VOICE_A") &&
      !result.missing.includes("CANARY_ELEVENLABS_VOICE_B"),
    "the two voices that blocked the release must no longer be required"
  );
});

console.log("\n  -- 2. ElevenLabs is mandatory ONLY when explicitly required --");

check("naming elevenlabs in PRODUCTION_REQUIRED_TTS_PROVIDERS makes it required", () => {
  const p = resolveTtsProviderPolicy({ [REQUIRED_TTS_PROVIDERS_VAR]: "fish,elevenlabs" });
  assert.deepEqual(p.required.sort(), ["elevenlabs", "fish"]);
  assert.deepEqual(p.optional, [], "a required provider is not also optional");
  assert.equal(elevenLabsIsRequired({ [REQUIRED_TTS_PROVIDERS_VAR]: "fish,elevenlabs" }), true);
  assert.equal(elevenLabsIsRequired({}), false, "it must not be required by default");
});

check("once required, its MISSING voices fail preflight again", () => {
  const env = fishOnlyEnv({ [REQUIRED_TTS_PROVIDERS_VAR]: "fish,elevenlabs" });
  const result = preflightCanaryEnv(env as never);
  assert.equal(result.ok, false, "an explicitly required provider must be enforced");
  for (const name of ["ELEVENLABS_API_KEY", "CANARY_ELEVENLABS_VOICE_A", "CANARY_ELEVENLABS_VOICE_B"]) {
    assert.ok(result.missing.includes(name), `${name} must be demanded once elevenlabs is required`);
  }
});

check("once required AND configured, preflight passes", () => {
  const env = fishOnlyEnv({
    [REQUIRED_TTS_PROVIDERS_VAR]: "fish,elevenlabs",
    ELEVENLABS_API_KEY: "test-elevenlabs-key",
    CANARY_ELEVENLABS_VOICE_A: "voiceAAAAAAAA1",
    CANARY_ELEVENLABS_VOICE_B: "voiceBBBBBBBB2",
  });
  const result = preflightCanaryEnv(env as never);
  assert.equal(result.ok, true, `expected pass; missing=${result.missing.join(", ")}`);
  assert.deepEqual(result.requiredProviders.sort(), ["elevenlabs", "fish"]);
});

check("the readiness preflight uses the SAME policy", () => {
  assert.deepEqual(requiredTtsProviders({} as NodeJS.ProcessEnv), ["fish"]);
  assert.deepEqual(optionalTtsProviders({} as NodeJS.ProcessEnv), ["elevenlabs"]);
  assert.deepEqual(
    requiredTtsProviders({ [REQUIRED_TTS_PROVIDERS_VAR]: "fish,elevenlabs" } as never).sort(),
    ["elevenlabs", "fish"],
    "readiness and the canary must not disagree about what a release needs"
  );
});

check("the deployment's own TTS_PROVIDER is still required", () => {
  // If the pipeline will actually select an engine, that engine must work —
  // making a provider optional must not make the CONFIGURED one optional.
  const got = requiredTtsProviders({ TTS_PROVIDER: "elevenlabs" } as never).sort();
  assert.deepEqual(got, ["elevenlabs", "fish"], "the engine production selects must still be proven");
});

check("an optional adapter can be disabled entirely", () => {
  const p = resolveTtsProviderPolicy({ [OPTIONAL_TTS_PROVIDERS_VAR]: "none-such" });
  assert.deepEqual(p.optional, [], "an unbuildable optional adapter is ignored, not fatal");
  assert.deepEqual(p.required, ["fish"], "and it never affects the required set");
});

console.log("\n  -- 3. Fish still resolves to s2.1-pro-free by default --");

check("resolveFishSceneModel() defaults to s2.1-pro-free", () => {
  const before = { m: process.env.FISH_MODEL, s: process.env.FISH_SCENE_MODEL, t: process.env.FISH_SCENE_MODEL_TIER };
  delete process.env.FISH_MODEL;
  delete process.env.FISH_SCENE_MODEL;
  delete process.env.FISH_SCENE_MODEL_TIER;
  try {
    assert.equal(resolveFishSceneModel(), "s2.1-pro-free", "the free S2.1 tier is the mandated default");
  } finally {
    for (const [k, v] of Object.entries({ FISH_MODEL: before.m, FISH_SCENE_MODEL: before.s, FISH_SCENE_MODEL_TIER: before.t })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

check("nothing in this change promotes Fish to the paid tier", () => {
  const before = process.env.FISH_SCENE_MODEL;
  delete process.env.FISH_SCENE_MODEL;
  try {
    const result = preflightCanaryEnv(fishOnlyEnv() as never);
    assert.equal(result.ok, true);
    // The canary's own contract constant, unchanged.
    assert.equal(resolveFishSceneModel(), "s2.1-pro-free");
  } finally {
    if (before === undefined) delete process.env.FISH_SCENE_MODEL;
    else process.env.FISH_SCENE_MODEL = before;
  }
});

if (failed) {
  console.error(`\n${failed} check(s) FAILED.\n`);
  process.exit(1);
}
console.log("\nAll TTS provider policy checks passed.\n");
