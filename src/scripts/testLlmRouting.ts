// Role-based LLM routing contract test. Run: npm run test:llm-routing
//
// All external requests are MOCKED — this suite makes no API call and needs no
// credential. Live provider checks are opt-in and live in
// testNvidiaProvider.ts / testZaiProvider.ts behind --live.
//
// THE RULES THIS PROTECTS:
//   1. LLM_ROUTING_PROFILE=legacy (the default) is byte-for-byte the behavior
//      that shipped before role routing. One variable, no code change.
//   2. Resolution order is override > primary > secondary > tertiary >
//      role-appropriate existing provider > clear failure, implemented ONCE.
//   3. An alias can never create a fallback loop.
//   4. Paid fallback is controllable and never silent.
//   5. Web and worker resolve the SAME role map.
//   6. APP_DEPLOYMENT_STAGE=live advises; it never silently re-routes.

import fs from "fs";
import path from "path";

import { ALL_ROLES, ROLE_DEFINITIONS, LLMRole } from "../lib/providers/llm/roles";
import {
  RoutedLLMProvider,
  candidateKey,
  endpointIdentity,
  getRoleLLMProvider,
  isPaidProvider,
  legacyFallbackAllowed,
  legacyFallbackExplicit,
  normalizedBaseUrl,
  resolveRolePlan,
  resolveScriptChallenger,
  roleHasRealProvider,
  roleRouteReport,
} from "../lib/providers/llm/routing";
import { fallbackDecision } from "../lib/providers/llm/fallbackPolicy";
import { LlmProviderError } from "../lib/providers/llm/errors";
import { activeRoutingProfile } from "../lib/providers/llm/profiles";
import { activeDeploymentStage, stageAdvisory } from "../lib/providers/llm/deploymentStage";
import { routingEnvKeys, roleOverrideKeys } from "../lib/providers/llm/routingEnv";
import {
  resolveMaxTokens,
  modelCapabilities,
  verificationState,
  UnsupportedOutputLimitError,
} from "../lib/providers/llm/capabilities";
import { llmCostMark, llmCostSince, recordLlmCall, withLlmAttribution } from "../lib/providers/llm/costLedger";
import { AnthropicLLMProvider } from "../lib/providers/llm/anthropic";
import { OpenAILLMProvider } from "../lib/providers/llm/openai";
import { StubLLMProvider } from "../lib/providers/llm/stub";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";
import { LLMProvider } from "../lib/providers/llm/interface";

let passed = 0;
let failed = 0;
function assert(c: boolean, m: string) {
  if (!c) throw new Error(m);
}
function ok(n: string) {
  passed++;
  console.log(`  ✓ ${n}`);
}
function bad(n: string, e: unknown) {
  failed++;
  console.error(`  ✗ ${n}\n      ${(e as Error)?.message || e}`);
}
function check(name: string, fn: () => void) {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    ok(name);
  } catch (e) {
    bad(name, e);
  }
}

// ---------------------------------------------------------------- env control

const ROUTING_KEYS = routingEnvKeys();
const realFetch = globalThis.fetch;

/** Run `fn` with EXACTLY the given routing env. Every other routing key is
 *  deleted, so a developer's local .env cannot make a test pass or fail. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  const touched = new Set([...ROUTING_KEYS, ...Object.keys(vars)]);
  for (const k of touched) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return fn();
  } finally {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function withEnvAsync<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  const touched = new Set([...ROUTING_KEYS, ...Object.keys(vars)]);
  for (const k of touched) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const k of touched) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

/** The repository's documented production configuration. */
const CURRENT_PROD_ENV = {
  LLM_PROVIDER: "anthropic",
  ANTHROPIC_MODEL: "claude-sonnet-5",
  ANTHROPIC_API_KEY: "sk-ant-test-key-value-1234567890",
  SCRIPT_LLM_PROVIDER: "anthropic",
  SCRIPT_LLM_MODEL: "claude-opus-5",
};

/**
 * Frontier profile in RESILIENT mode: paid fallback explicitly enabled, which is
 * what a full-pipeline development run wants. Note this now has to be SET — the
 * default is comparison mode (paid fallback forbidden), so a test that wants the
 * paid rung must ask for it.
 */
const FRONTIER_ENV = {
  ...CURRENT_PROD_ENV,
  LLM_ROUTING_PROFILE: "frontier_development",
  APP_DEPLOYMENT_STAGE: "development",
  LLM_ALLOW_LEGACY_FALLBACK: "true",
  NVIDIA_API_KEY: "nvapi-test-key-value-1234567890",
  ZAI_API_KEY: "zai-test-key-value-1234567890",
  NVIDIA_MAX_RETRIES: "0",
  ZAI_MAX_RETRIES: "0",
};

/** The same profile in the DEFAULT comparison mode: no paid fallback at all. */
const FRONTIER_COMPARISON_ENV: Record<string, string | undefined> = {
  ...FRONTIER_ENV,
  LLM_ALLOW_LEGACY_FALLBACK: undefined,
};

// ---------------------------------------------------------------- mock transport

interface MockRule {
  /** Substring of the request URL this rule applies to. */
  match: string;
  /** Return a Response, or throw to simulate a network failure. */
  respond: (body: any, url: string) => Response | Promise<Response>;
}

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
}

function mockFetch(rules: MockRule[]): { captured: Captured[]; restore: () => void } {
  const captured: Captured[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input?.url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    captured.push({ url, body, headers: (init?.headers || {}) as Record<string, string> });
    const rule = rules.find((r) => url.includes(r.match));
    if (!rule) throw new Error(`unmocked request to ${url}`);
    return rule.respond(body, url);
  }) as typeof fetch;
  return { captured, restore: () => { globalThis.fetch = realFetch; } };
}

function jsonResponse(payload: any, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** An OpenAI-compatible success carrying `content`, plus optional reasoning. */
function oaiOk(content: string, opts: { reasoning?: string; finish?: string } = {}): Response {
  return jsonResponse({
    choices: [
      {
        finish_reason: opts.finish ?? "stop",
        message: {
          role: "assistant",
          content,
          ...(opts.reasoning ? { reasoning_content: opts.reasoning } : {}),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 20 } },
  });
}

/** An Anthropic-shaped success. */
function anthropicOk(text: string): Response {
  return jsonResponse({
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

const NVIDIA_HOST = "integrate.api.nvidia.com";
const ZAI_HOST = "api.z.ai";
const ANTHROPIC_HOST = "api.anthropic.com";
const OPENAI_HOST = "api.openai.com";

// ================================================================ 1. legacy

function legacyTests(): void {
  console.log("\nLegacy profile — the rollback contract:");

  check("unset LLM_ROUTING_PROFILE defaults to legacy", () => {
    withEnv(CURRENT_PROD_ENV, () => {
      assert(activeRoutingProfile() === "legacy", `got '${activeRoutingProfile()}'`);
    });
  });

  check("legacy resolves every role to the grouped config it uses TODAY", () => {
    withEnv({ ...CURRENT_PROD_ENV, LLM_ROUTING_PROFILE: "legacy" }, () => {
      const expected: Record<string, string> = {
        // global family: LLM_PROVIDER, provider-default model
        topic_generation: "anthropic/(provider-default)",
        topic_classification: "anthropic/(provider-default)",
        topic_ranking: "anthropic/(provider-default)",
        research_brief: "anthropic/(provider-default)",
        evidence_extraction: "anthropic/(provider-default)",
        show_notes: "anthropic/(provider-default)",
        episode_metadata: "anthropic/(provider-default)",
        // script family: SCRIPT_LLM_*
        script_outline: "anthropic/claude-opus-5",
        script_movement: "anthropic/claude-opus-5",
        continuity_report: "anthropic/claude-opus-5",
        // verify family: VERIFY_* > factcheck chain, sonnet-5 on Anthropic
        script_verification: "anthropic/claude-sonnet-5",
        script_rewrite: "anthropic/claude-sonnet-5",
        fact_check: "anthropic/claude-sonnet-5",
        quality_judge: "anthropic/claude-sonnet-5",
      };
      for (const role of ALL_ROLES) {
        const plan = resolveRolePlan(role);
        assert(plan.isLegacyBypass, `${role}: expected a legacy bypass`);
        assert(plan.candidates.length === 1, `${role}: legacy must be a single candidate, got ${plan.candidates.length}`);
        const got = candidateKey(plan.candidates[0]);
        assert(got === expected[role], `${role}: expected ${expected[role]}, got ${got}`);
      }
    });
  });

  check("legacy script_rewrite keeps TODAY's verifier, not the script provider", () => {
    withEnv({ ...CURRENT_PROD_ENV, LLM_ROUTING_PROFILE: "legacy" }, () => {
      const rw = candidateKey(resolveRolePlan("script_rewrite").candidates[0]);
      assert(rw === "anthropic/claude-sonnet-5", `expected the verify family, got ${rw}`);
    });
  });

  check("legacy returns a PLAIN provider instance, not the routed wrapper", () => {
    withEnv({ ...CURRENT_PROD_ENV, LLM_ROUTING_PROFILE: "legacy" }, () => {
      const p = getRoleLLMProvider("script_movement");
      assert(p instanceof AnthropicLLMProvider, `expected AnthropicLLMProvider, got ${p.constructor.name}`);
      assert(!(p instanceof RoutedLLMProvider), "legacy must not wrap the provider in the router");
    });
  });

  check("legacy with no LLM_PROVIDER is stub, exactly as before", () => {
    withEnv({ LLM_ROUTING_PROFILE: "legacy" }, () => {
      assert(candidateKey(resolveRolePlan("topic_generation").candidates[0]) === "stub/(provider-default)", "expected stub");
      assert(!roleHasRealProvider("topic_classification"), "classification must report no real provider (heuristic path)");
      assert(getRoleLLMProvider("show_notes") instanceof StubLLMProvider, "expected StubLLMProvider");
    });
  });

  check("one-variable rollback: frontier -> legacy restores every role", () => {
    const frontier = withEnv(FRONTIER_ENV, () =>
      ALL_ROLES.map((r) => candidateKey(resolveRolePlan(r).candidates[0]))
    );
    const rolledBack = withEnv({ ...FRONTIER_ENV, LLM_ROUTING_PROFILE: "legacy" }, () =>
      ALL_ROLES.map((r) => candidateKey(resolveRolePlan(r).candidates[0]))
    );
    const pureLegacy = withEnv({ ...CURRENT_PROD_ENV }, () =>
      ALL_ROLES.map((r) => candidateKey(resolveRolePlan(r).candidates[0]))
    );
    assert(
      JSON.stringify(rolledBack) === JSON.stringify(pureLegacy),
      `rollback did not restore legacy routing:\n  rolled back: ${rolledBack.join(", ")}\n  pure legacy: ${pureLegacy.join(", ")}`
    );
    assert(
      JSON.stringify(frontier) !== JSON.stringify(pureLegacy),
      "the frontier profile resolved identically to legacy — the test proves nothing"
    );
    // The credentials stay in place; only the profile variable changed.
    assert(FRONTIER_ENV.NVIDIA_API_KEY.length > 0 && FRONTIER_ENV.ZAI_API_KEY.length > 0, "credentials must not need deleting");
  });
}

// ================================================================ 2. profiles

function profileTests(): void {
  console.log("\nProfile resolution:");

  check("frontier_development resolves a full chain for every role", () => {
    withEnv(FRONTIER_ENV, () => {
      for (const role of ALL_ROLES) {
        const plan = resolveRolePlan(role);
        assert(!plan.isLegacyBypass, `${role}: must not be a legacy bypass`);
        assert(plan.candidates.length >= 2, `${role}: expected a chain, got ${plan.candidates.length}`);
        assert(
          plan.candidates[0].source === "profile_primary",
          `${role}: first candidate must be the profile primary, got ${plan.candidates[0].source}`
        );
        assert(
          plan.candidates[plan.candidates.length - 1].source === "legacy_backup",
          `${role}: last candidate must be the legacy backup`
        );
      }
    });
  });

  check("frontier primaries match the documented role map", () => {
    withEnv(FRONTIER_ENV, () => {
      const expected: Partial<Record<LLMRole, string>> = {
        topic_generation: "nvidia/deepseek-ai/deepseek-v4-flash",
        topic_classification: "nvidia/deepseek-ai/deepseek-v4-flash",
        topic_ranking: "nvidia/z-ai/glm-5.2",
        research_brief: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
        evidence_extraction: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
        script_outline: "nvidia/z-ai/glm-5.2",
        script_movement: "nvidia/mistralai/mistral-medium-3.5-128b",
        script_verification: "nvidia/deepseek-ai/deepseek-v4-pro",
        script_rewrite: "nvidia/mistralai/mistral-medium-3.5-128b",
        fact_check: "nvidia/deepseek-ai/deepseek-v4-pro",
        show_notes: "nvidia/deepseek-ai/deepseek-v4-flash",
        episode_metadata: "nvidia/mistralai/mistral-medium-3.5-128b",
        quality_judge: "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
      };
      for (const [role, want] of Object.entries(expected)) {
        const got = candidateKey(resolveRolePlan(role as LLMRole).candidates[0]);
        assert(got === want, `${role}: expected ${want}, got ${got}`);
      }
    });
  });

  check("frontier: script_verification and script_rewrite are DIFFERENT models", () => {
    withEnv(FRONTIER_ENV, () => {
      const v = resolveRolePlan("script_verification").candidates.map(candidateKey);
      const r = resolveRolePlan("script_rewrite").candidates.map(candidateKey);
      assert(v[0] !== r[0], `both roles resolved to ${v[0]} — the diagnoser must not be the rewriter`);
      assert(
        r[0].includes("mistral"),
        `rewrite must go to the creative dialogue model, got ${r[0]}`
      );
      assert(
        v[0].includes("deepseek-v4-pro"),
        `verification must go to the reasoning model, got ${v[0]}`
      );
    });
  });

  check("frontier: quality_judge shares no model with script_movement", () => {
    withEnv(FRONTIER_ENV, () => {
      const judge = new Set(resolveRolePlan("quality_judge").candidates.map((c) => c.model));
      const writer = new Set(resolveRolePlan("script_movement").candidates.map((c) => c.model));
      for (const m of judge) {
        assert(!writer.has(m), `${m} both writes and judges — a writer must never be the sole judge of its own output`);
      }
    });
  });

  check("free_independent routes every role to Z.ai, legacy still the backup", () => {
    withEnv({ ...FRONTIER_ENV, LLM_ROUTING_PROFILE: "free_independent" }, () => {
      for (const role of ALL_ROLES) {
        const plan = resolveRolePlan(role);
        assert(plan.candidates[0].provider === "zai", `${role}: expected zai primary, got ${plan.candidates[0].provider}`);
        assert(plan.candidates[0].model === "glm-4.7-flash", `${role}: expected glm-4.7-flash`);
        assert(
          plan.candidates.some((c) => c.source === "legacy_backup" && c.provider === "anthropic"),
          `${role}: the existing provider must remain configured as the backup`
        );
        assert(
          plan.candidates.every((c) => c.provider !== "nvidia"),
          `${role}: free_independent must not depend on NVIDIA`
        );
      }
    });
  });

  check("custom profile uses ONLY overrides plus the legacy backup", () => {
    withEnv(
      {
        ...FRONTIER_ENV,
        LLM_ROUTING_PROFILE: "custom",
        SCRIPT_MOVEMENT_LLM_PROVIDER: "zai",
        SCRIPT_MOVEMENT_LLM_MODEL: "glm-4.7-flash",
      },
      () => {
        const plan = resolveRolePlan("script_movement");
        assert(plan.candidates[0].source === "role_override", "override must be first");
        assert(candidateKey(plan.candidates[0]) === "zai/glm-4.7-flash", candidateKey(plan.candidates[0]));
        assert(plan.candidates.length === 2, `expected override + backup, got ${plan.candidates.map(candidateKey).join(", ")}`);
        assert(plan.candidates[1].source === "legacy_backup", "second must be the legacy backup");
      }
    );
  });

  check("role override beats the profile primary AND the grouped config", () => {
    withEnv(
      { ...FRONTIER_ENV, FACT_CHECK_LLM_PROVIDER: "zai", FACT_CHECK_LLM_MODEL: "glm-4.7-flash" },
      () => {
        const first = resolveRolePlan("fact_check").candidates[0];
        assert(first.source === "role_override", `expected role_override, got ${first.source}`);
        assert(candidateKey(first) === "zai/glm-4.7-flash", candidateKey(first));
        // other roles are untouched
        assert(
          candidateKey(resolveRolePlan("script_verification").candidates[0]) === "nvidia/deepseek-ai/deepseek-v4-pro",
          "an override must not leak into another role"
        );
      }
    );
  });

  check("profile primary beats the legacy grouped configuration", () => {
    withEnv(FRONTIER_ENV, () => {
      const first = candidateKey(resolveRolePlan("script_movement").candidates[0]);
      assert(first !== "anthropic/claude-opus-5", "SCRIPT_LLM_MODEL must not win over the profile primary");
      assert(first === "nvidia/mistralai/mistral-medium-3.5-128b", first);
    });
  });

  check("a catalog rename is a one-variable fix", () => {
    withEnv({ ...FRONTIER_ENV, NVIDIA_MODEL_MISTRAL: "mistralai/mistral-medium-9" }, () => {
      assert(
        candidateKey(resolveRolePlan("script_movement").candidates[0]) === "nvidia/mistralai/mistral-medium-9",
        "NVIDIA_MODEL_MISTRAL must override the built-in id"
      );
    });
  });

  check("an unrecognized profile falls back to legacy and is reported", () => {
    withEnv({ ...CURRENT_PROD_ENV, LLM_ROUTING_PROFILE: "frontier-development" }, () => {
      assert(activeRoutingProfile() === "legacy", "must fall back to legacy");
      assert(resolveRolePlan("script_movement").isLegacyBypass, "must behave as legacy");
    });
  });
}

// ================================================================ 3. loop safety

function loopSafetyTests(): void {
  console.log("\nLoop safety and de-duplication:");

  check("an override that names the primary does not create a second attempt", () => {
    withEnv(
      {
        ...FRONTIER_ENV,
        SCRIPT_MOVEMENT_LLM_PROVIDER: "nvidia",
        SCRIPT_MOVEMENT_LLM_MODEL: "mistralai/mistral-medium-3.5-128b",
      },
      () => {
        const keys = resolveRolePlan("script_movement").candidates.map(candidateKey);
        assert(new Set(keys).size === keys.length, `duplicate endpoint in chain: ${keys.join(", ")}`);
        assert(keys.filter((k) => k.includes("mistral-medium-3.5")).length === 1, keys.join(", "));
      }
    );
  });

  check("no role's chain ever contains a duplicate endpoint, in any profile", () => {
    for (const profile of ["legacy", "frontier_development", "free_independent", "custom"]) {
      withEnv({ ...FRONTIER_ENV, LLM_ROUTING_PROFILE: profile }, () => {
        for (const role of ALL_ROLES) {
          const keys = resolveRolePlan(role).candidates.map(candidateKey);
          assert(new Set(keys).size === keys.length, `${profile}/${role}: ${keys.join(", ")}`);
        }
      });
    }
  });

  check("a legacy backup identical to the tertiary collapses to one attempt", () => {
    withEnv(
      { LLM_ROUTING_PROFILE: "free_independent", ZAI_API_KEY: "zai-test-key-value-1234567890", LLM_PROVIDER: "zai" },
      () => {
        const keys = resolveRolePlan("topic_generation").candidates.map(candidateKey);
        assert(new Set(keys).size === keys.length, `duplicate: ${keys.join(", ")}`);
      }
    );
  });
}

// ================================================================ 4. fallback

async function fallbackTests(): Promise<void> {
  console.log("\nFallback execution (mocked transport):");

  await checkAsync("secondary runs after the primary fails", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      let nvidiaCalls = 0;
      const m = mockFetch([
        {
          match: NVIDIA_HOST,
          respond: (body) => {
            nvidiaCalls++;
            // Fail the primary (mistral); succeed for the secondary (kimi).
            if (String(body.model).includes("mistral")) return jsonResponse({ error: "upstream exploded" }, 500);
            return oaiOk('{"segments":[{"lines":[{"text":"hi"}]}]}');
          },
        },
      ]);
      try {
        const p = getRoleLLMProvider("script_movement");
        const res = await p.generateStructuredOutput<any>({ prompt: "x", maxTokens: 16000 });
        assert(Array.isArray(res.segments), "expected the secondary's result");
        assert(nvidiaCalls >= 2, `expected the secondary to be attempted, saw ${nvidiaCalls} call(s)`);
        const kimi = m.captured.find((c) => String(c.body?.model).includes("kimi"));
        assert(!!kimi, `secondary model was never called: ${m.captured.map((c) => c.body?.model).join(", ")}`);
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("Z.ai runs after every NVIDIA candidate fails", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      const m = mockFetch([
        { match: NVIDIA_HOST, respond: () => jsonResponse({ error: "nvidia down" }, 503) },
        { match: ZAI_HOST, respond: () => oaiOk('{"ok":true,"from":"zai"}') },
      ]);
      try {
        const res = await getRoleLLMProvider("fact_check").generateStructuredOutput<any>({ prompt: "x" });
        assert(res.from === "zai", `expected the Z.ai result, got ${JSON.stringify(res)}`);
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("the existing SCRIPT provider runs after all free script models fail", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      const m = mockFetch([
        { match: NVIDIA_HOST, respond: () => jsonResponse({ error: "down" }, 503) },
        { match: ZAI_HOST, respond: () => jsonResponse({ error: "down" }, 503) },
        { match: ANTHROPIC_HOST, respond: () => anthropicOk('{"segments":[{"lines":[{"text":"from opus"}]}]}') },
      ]);
      try {
        const res = await getRoleLLMProvider("script_movement").generateStructuredOutput<any>({ prompt: "x" });
        assert(res.segments?.[0]?.lines?.[0]?.text === "from opus", JSON.stringify(res));
        const anth = m.captured.find((c) => c.url.includes(ANTHROPIC_HOST));
        assert(anth?.body?.model === "claude-opus-5", `expected the SCRIPT model, got ${anth?.body?.model}`);
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("the existing VERIFIER runs after all free verification models fail", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      const m = mockFetch([
        { match: NVIDIA_HOST, respond: () => jsonResponse({ error: "down" }, 503) },
        { match: ZAI_HOST, respond: () => jsonResponse({ error: "down" }, 503) },
        { match: ANTHROPIC_HOST, respond: () => anthropicOk('{"status":"passed"}') },
      ]);
      try {
        await getRoleLLMProvider("script_verification").generateStructuredOutput<any>({ prompt: "x" });
        const anth = m.captured.find((c) => c.url.includes(ANTHROPIC_HOST));
        assert(anth?.body?.model === "claude-sonnet-5", `expected the VERIFY model, got ${anth?.body?.model}`);
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("LLM_ALLOW_LEGACY_FALLBACK=false forbids the paid call and says so", async () => {
    await withEnvAsync({ ...FRONTIER_ENV, LLM_ALLOW_LEGACY_FALLBACK: "false" }, async () => {
      assert(!legacyFallbackAllowed(), "flag not honored");
      const plan = resolveRolePlan("script_movement");
      assert(
        plan.candidates.every((c) => !isPaidProvider(c.provider)),
        `paid candidate survived: ${plan.candidates.map(candidateKey).join(", ")}`
      );
      assert(plan.suppressedPaid.length > 0, "the suppressed paid candidate must be recorded");

      const m = mockFetch([
        { match: NVIDIA_HOST, respond: () => jsonResponse({ error: "down" }, 503) },
        { match: ZAI_HOST, respond: () => jsonResponse({ error: "down" }, 503) },
        { match: ANTHROPIC_HOST, respond: () => { throw new Error("Anthropic must NOT be called"); } },
      ]);
      try {
        let message = "";
        try {
          await getRoleLLMProvider("script_movement").generateStructuredOutput<any>({ prompt: "x" });
          assert(false, "expected the role to fail rather than spend money");
        } catch (err: any) {
          message = err.message;
        }
        assert(
          message.includes("LLM_ALLOW_LEGACY_FALLBACK"),
          `the error must name the suppression: ${message}`
        );
        assert(message.includes("suppressed"), `the error must say what was suppressed: ${message}`);
        assert(
          !m.captured.some((c) => c.url.includes(ANTHROPIC_HOST)),
          "a paid provider was called while paid fallback was forbidden"
        );
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("paid fallback is FORBIDDEN BY DEFAULT (comparison mode)", async () => {
    // The default flipped deliberately: while candidate models are being
    // measured, a quiet paid fallback makes a failing free model look like a
    // working one, and the A/B number you end up trusting came from Anthropic.
    await withEnvAsync(FRONTIER_COMPARISON_ENV, async () => {
      assert(!legacyFallbackAllowed(), "the DEFAULT must forbid paid fallback");
      assert(!legacyFallbackExplicit(), "an unset variable is not an explicit decision");
      const plan = resolveRolePlan("script_movement");
      assert(
        plan.candidates.every((c) => !isPaidProvider(c.provider)),
        `a paid candidate survived by default: ${plan.candidates.map(candidateKey).join(", ")}`
      );
      assert(plan.suppressedPaid.length > 0, "the suppressed paid candidate must still be reported");
    });
  });

  await checkAsync("paid fallback IS used when explicitly enabled (resilient mode)", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      assert(legacyFallbackAllowed(), "LLM_ALLOW_LEGACY_FALLBACK=true must allow paid fallback");
      assert(legacyFallbackExplicit(), "an explicitly set variable must read as explicit");
      const plan = resolveRolePlan("show_notes");
      assert(plan.candidates.some((c) => c.paid), "expected a paid backup in the chain");
    });
  });

  await checkAsync("a CONFIGURATION failure cannot silently cross into a paid provider", async () => {
    // Missing NVIDIA key + missing Z.ai key, paid fallback NOT explicitly set.
    // The paid candidate must not be used to paper over the misconfiguration.
    await withEnvAsync(
      { ...FRONTIER_COMPARISON_ENV, NVIDIA_API_KEY: undefined, ZAI_API_KEY: undefined },
      async () => {
        const m = mockFetch([
          {
            match: ANTHROPIC_HOST,
            respond: () => {
              throw new Error("Anthropic must NOT be called for a configuration failure");
            },
          },
        ]);
        try {
          let message = "";
          try {
            await getRoleLLMProvider("research_brief").generateStructuredOutput<any>({ prompt: "x" });
            assert(false, "expected the role to fail rather than spend money");
          } catch (err: any) {
            message = err.message;
          }
          assert(message.includes("NVIDIA_API_KEY"), `the original configuration failure must stay visible: ${message}`);
          assert(
            !m.captured.some((c) => c.url.includes(ANTHROPIC_HOST)),
            "a paid provider was called to work around a configuration failure"
          );
        } finally {
          m.restore();
        }
      }
    );
  });

  await checkAsync("a missing optional NVIDIA key may advance to Z.ai", async () => {
    await withEnvAsync({ ...FRONTIER_COMPARISON_ENV, NVIDIA_API_KEY: undefined }, async () => {
      const m = mockFetch([{ match: ZAI_HOST, respond: () => oaiOk('{"from":"zai"}') }]);
      try {
        const res = await getRoleLLMProvider("show_notes").generateStructuredOutput<any>({ prompt: "x" });
        assert(res.from === "zai", `expected the Z.ai result, got ${JSON.stringify(res)}`);
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("an authentication failure stays visible in the final error", async () => {
    await withEnvAsync({ ...FRONTIER_COMPARISON_ENV, ZAI_API_KEY: undefined }, async () => {
      const m = mockFetch([{ match: NVIDIA_HOST, respond: () => jsonResponse({ error: "invalid api key" }, 401) }]);
      try {
        let message = "";
        try {
          await getRoleLLMProvider("fact_check").generateStructuredOutput<any>({ prompt: "x" });
        } catch (err: any) {
          message = err.message;
        }
        assert(
          message.includes("authentication_failed"),
          `the auth failure category must survive to the final error: ${message}`
        );
        assert(message.includes("HTTP 401"), `the status must survive too: ${message}`);
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("an explicit role override is never suppressed by the paid gate", async () => {
    await withEnvAsync(
      {
        ...FRONTIER_ENV,
        LLM_ALLOW_LEGACY_FALLBACK: "false",
        SHOW_NOTES_LLM_PROVIDER: "anthropic",
        SHOW_NOTES_LLM_MODEL: "claude-sonnet-5",
      },
      async () => {
        const plan = resolveRolePlan("show_notes");
        assert(plan.candidates[0].source === "role_override", "the operator's explicit choice must survive");
        assert(plan.candidates[0].provider === "anthropic", candidateKey(plan.candidates[0]));
      }
    );
  });

  await checkAsync("every-candidate failure names each candidate and its category", async () => {
    await withEnvAsync({ ...FRONTIER_ENV, ANTHROPIC_API_KEY: undefined }, async () => {
      const m = mockFetch([
        { match: NVIDIA_HOST, respond: () => jsonResponse({ error: "bad auth" }, 401) },
        { match: ZAI_HOST, respond: () => jsonResponse({ error: "quota exceeded, no credit" }, 429) },
      ]);
      try {
        let message = "";
        try {
          await getRoleLLMProvider("show_notes").generateStructuredOutput<any>({ prompt: "x" });
          assert(false, "expected a failure");
        } catch (err: any) {
          message = err.message;
        }
        assert(message.includes("authentication_failed"), `NVIDIA's category missing: ${message}`);
        assert(message.includes("quota_exhausted"), `Z.ai's quota category missing: ${message}`);
        assert(message.includes("ANTHROPIC_API_KEY"), `the absent Anthropic key must be visible: ${message}`);
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("a missing NVIDIA key is a clear, actionable error", async () => {
    await withEnvAsync({ ...FRONTIER_ENV, NVIDIA_API_KEY: undefined, ZAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
      let message = "";
      try {
        await getRoleLLMProvider("research_brief").generateStructuredOutput<any>({ prompt: "x" });
      } catch (err: any) {
        message = err.message;
      }
      assert(message.includes("NVIDIA_API_KEY"), `must name the variable: ${message}`);
      assert(message.includes("ZAI_API_KEY"), `must name the Z.ai variable too: ${message}`);
      assert(message.includes("build.nvidia.com"), `must say where to get the key: ${message}`);
    });
  });

  await checkAsync("a placeholder credential is treated as missing", async () => {
    await withEnvAsync({ ...FRONTIER_ENV, NVIDIA_API_KEY: "SET_IN_SECRET_MANAGER" }, async () => {
      const report = roleRouteReport().find((r) => r.role === "research_brief")!;
      assert(
        report.notes.some((n) => n.includes("NVIDIA_API_KEY")),
        `readiness must flag the placeholder: ${report.notes.join(" | ")}`
      );
    });
  });
}

// ================================================================ 5. existing providers

async function existingProviderTests(): Promise<void> {
  console.log("\nExisting providers still work:");

  await checkAsync("Anthropic text + structured output", async () => {
    await withEnvAsync(CURRENT_PROD_ENV, async () => {
      const m = mockFetch([{ match: ANTHROPIC_HOST, respond: () => anthropicOk('{"a":1}') }]);
      try {
        const p = new AnthropicLLMProvider("claude-sonnet-5");
        assert((await p.generateText({ prompt: "x" })) === '{"a":1}', "text");
        assert((await p.generateStructuredOutput<any>({ prompt: "x" })).a === 1, "structured");
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("OpenAI text + structured output", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "sk-openai-test-key-1234567890", OPENAI_MODEL: "gpt-4o-mini" }, async () => {
      const m = mockFetch([
        {
          match: OPENAI_HOST,
          respond: () =>
            jsonResponse({ choices: [{ message: { content: '{"b":2}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
        },
      ]);
      try {
        const p = new OpenAILLMProvider();
        assert((await p.generateText({ prompt: "x" })) === '{"b":2}', "text");
        assert((await p.generateStructuredOutput<any>({ prompt: "x" })).b === 2, "structured");
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("Stub behaves exactly as before: it refuses real generation", async () => {
    // The stub's contract is to REFUSE, not to fabricate output. Unchanged.
    const p = new StubLLMProvider();
    for (const call of [() => p.generateText({ prompt: "x" }), () => p.generateStructuredOutput({ prompt: "x" })]) {
      let message = "";
      try {
        await call();
      } catch (err: any) {
        message = err.message;
      }
      assert(/stub/i.test(message), `expected the documented stub refusal, got: ${message}`);
    }
  });
}

// ================================================================ 6. stage

function stageTests(): void {
  console.log("\nDeployment stage:");

  check("unset APP_DEPLOYMENT_STAGE defaults to development", () => {
    withEnv({}, () => assert(activeDeploymentStage() === "development", activeDeploymentStage()));
  });

  check("development permits NVIDIA with no advisory", () => {
    withEnv({ ...FRONTIER_ENV, APP_DEPLOYMENT_STAGE: "development" }, () => {
      const adv = stageAdvisory(["nvidia", "zai", "anthropic"]);
      assert(adv.message === null, `expected no advisory, got: ${adv.message}`);
      assert(candidateKey(resolveRolePlan("script_movement").candidates[0]).startsWith("nvidia/"), "NVIDIA must stay primary");
    });
  });

  check("staging permits NVIDIA with no advisory", () => {
    withEnv({ ...FRONTIER_ENV, APP_DEPLOYMENT_STAGE: "staging" }, () => {
      const adv = stageAdvisory(["nvidia"]);
      assert(adv.message === null, `expected no advisory, got: ${adv.message}`);
      assert(candidateKey(resolveRolePlan("script_movement").candidates[0]).startsWith("nvidia/"), "NVIDIA must stay primary");
    });
  });

  check("live ADVISES but changes nothing", () => {
    const dev = withEnv({ ...FRONTIER_ENV, APP_DEPLOYMENT_STAGE: "development" }, () =>
      ALL_ROLES.map((r) => resolveRolePlan(r).candidates.map(candidateKey).join(">"))
    );
    withEnv({ ...FRONTIER_ENV, APP_DEPLOYMENT_STAGE: "live" }, () => {
      const adv = stageAdvisory(["nvidia", "zai"]);
      assert(adv.message !== null, "live must produce an advisory");
      assert(adv.blocksTrialProviders === false, "the stage must never block a provider");
      assert(/trial/i.test(adv.message!), `the advisory must explain the trial nature: ${adv.message}`);
      assert(/capacity/i.test(adv.message!), "the advisory must mention capacity");
      const live = ALL_ROLES.map((r) => resolveRolePlan(r).candidates.map(candidateKey).join(">"));
      assert(JSON.stringify(live) === JSON.stringify(dev), "live silently changed the routing — it must not");
    });
  });

  check("live with no trial provider produces no advisory", () => {
    withEnv({ ...CURRENT_PROD_ENV, APP_DEPLOYMENT_STAGE: "live" }, () => {
      assert(stageAdvisory(["anthropic"]).message === null, "no advisory is due when no trial endpoint is in use");
    });
  });
}

// ================================================================ 7. web/worker parity

function parityTests(): void {
  console.log("\nWeb/worker parity and env plumbing:");

  check("every role's override pair is in the static env snapshot", () => {
    const keys = new Set(routingEnvKeys());
    for (const role of ALL_ROLES) {
      const { providerKey, modelKey } = roleOverrideKeys(role);
      assert(keys.has(providerKey), `${providerKey} is missing from routingEnv.ts — the web bundle cannot see it`);
      assert(keys.has(modelKey), `${modelKey} is missing from routingEnv.ts — the web bundle cannot see it`);
    }
  });

  check("every provider credential and tuning key is in the snapshot", () => {
    const keys = new Set(routingEnvKeys());
    for (const k of [
      "LLM_ROUTING_PROFILE", "APP_DEPLOYMENT_STAGE", "LLM_ALLOW_LEGACY_FALLBACK",
      "LLM_PROVIDER", "LLM_MODEL", "SCRIPT_LLM_PROVIDER", "SCRIPT_LLM_MODEL",
      "VERIFY_LLM_PROVIDER", "VERIFY_MODEL", "FACTCHECK_LLM_PROVIDER", "FACTCHECK_LLM_MODEL",
      "NVIDIA_API_KEY", "NVIDIA_BASE_URL", "ZAI_API_KEY", "ZAI_BASE_URL",
      "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
      "SCRIPT_CHALLENGER_ENABLED", "SCRIPT_CHALLENGER_PROVIDER", "SCRIPT_CHALLENGER_MODEL",
    ]) {
      assert(keys.has(k), `${k} is missing from routingEnv.ts`);
    }
  });

  check("routingEnv.ts reads every snapshot key LITERALLY", () => {
    // A computed read in this file would defeat its own purpose.
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "lib", "providers", "llm", "routingEnv.ts"),
      "utf8"
    );
    for (const k of routingEnvKeys()) {
      assert(src.includes(`process.env.${k}`), `${k} is not read literally as process.env.${k}`);
    }
  });

  check("resolution is a pure function of the environment", () => {
    // Same env in, same map out — which is what makes web and worker agree.
    const a = withEnv(FRONTIER_ENV, () => JSON.stringify(roleRouteReport().map((r) => [r.role, r.candidates])));
    const b = withEnv(FRONTIER_ENV, () => JSON.stringify(roleRouteReport().map((r) => [r.role, r.candidates])));
    assert(a === b, "two resolutions of the same environment disagreed");
  });

  check("no service duplicates the fallback logic", () => {
    // Resolution lives in exactly one file. A second implementation is how the
    // web app and the worker drift apart.
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(entry.name)) {
          const rel = path.relative(root, p).replace(/\\/g, "/");
          if (rel.startsWith("lib/providers/llm/") || rel.startsWith("scripts/")) continue;
          const src = fs.readFileSync(p, "utf8");
          // The tell-tale of a re-implemented chain outside the routing module.
          if (/process\.env\.SCRIPT_LLM_PROVIDER\s*\|\|\s*process\.env\.LLM_PROVIDER/.test(src)) {
            offenders.push(rel);
          }
        }
      }
    };
    walk(root);
    assert(offenders.length === 0, `these files re-implement provider fallback: ${offenders.join(", ")}`);
  });
}

// ================================================================ 8. limits + ledger

function limitAndLedgerTests(): void {
  console.log("\nOutput limits and the cost ledger:");

  check("a 16,000-token request stays 16,000 on a live-untested model", () => {
    const caps = modelCapabilities("nvidia", "mistralai/mistral-medium-3.5-128b");
    assert(caps.catalogVerified === true, "this model's ID is confirmed in NVIDIA's catalog");
    assert(caps.liveContractVerified === false, "nothing in this repo has called it live yet");
    assert(caps.maximumOutputTokens === undefined, "an unprobed cap must be UNKNOWN, not a guess");
    assert(resolveMaxTokens(caps, 16000) === 16000, "the caller's allowance was altered");
  });

  check("a documented output limit is informational and never shrinks a request", () => {
    // A number copied off a model card is not a measurement. The enforceable
    // field stays undefined until a probe sets it.
    const caps = {
      ...modelCapabilities("nvidia", "nvidia/nemotron-3-ultra-550b-a55b"),
      documentedMaximumOutputTokens: 4096,
    };
    assert(caps.maximumOutputTokens === undefined, "documented != enforceable");
    assert(resolveMaxTokens(caps, 16000) === 16000, "a documented figure must not shrink the request");
  });

  check("an unknown limit never shrinks any request", () => {
    const caps = modelCapabilities("nvidia", "some/model-nobody-registered");
    for (const n of [1200, 7000, 8192, 16000, 32000]) {
      assert(resolveMaxTokens(caps, n) === n, `${n} was altered to ${resolveMaxTokens(caps, n)}`);
    }
  });

  check("a LIVE-VERIFIED limit rejects loudly instead of shrinking", () => {
    const caps = {
      ...modelCapabilities("zai", "glm-4.7-flash"),
      maximumOutputTokens: 8192,
      liveContractVerified: true,
    };
    let err: unknown = null;
    try {
      resolveMaxTokens(caps, 16000);
    } catch (e) {
      err = e;
    }
    assert(err instanceof UnsupportedOutputLimitError, "expected UnsupportedOutputLimitError");
    assert(/NOT silently shrunk/.test((err as Error).message), (err as Error).message);
    assert(resolveMaxTokens(caps, 8000) === 8000, "a request within the confirmed cap must pass through");
  });

  check("the ledger records the REAL provider and model, with role and profile", () => {
    withEnv(FRONTIER_ENV, () => {
      const mark = llmCostMark();
      // Simulate what the provider records after a successful NVIDIA call.
      withLlmAttribution(
        { role: "script_movement", profile: "frontier_development", candidateSource: "profile_primary", fallbacks: 0 },
        () =>
          recordLlmCall({
            provider: "nvidia",
            model: "mistralai/mistral-medium-3.5-128b",
            tkIn: 100,
            tkOut: 50,
            tkReasoning: 10,
            durationMs: 1234,
            stage: "script:acts",
            attempts: 1,
            ok: true,
          })
      );
      const { stages } = llmCostSince(mark);
      const stage = stages.find((s) => s.stage === "script:acts");
      assert(!!stage, "the stage was not recorded");
      assert(
        stage!.models.includes("nvidia/mistralai/mistral-medium-3.5-128b"),
        `expected the nvidia model, got ${stage!.models.join(", ")}`
      );
      assert(!stage!.models.some((m) => m.startsWith("openai/")), "an NVIDIA call must never be recorded as OpenAI");
      assert(stage!.roles.includes("script_movement"), `role not attributed: ${stage!.roles.join(", ")}`);
      assert(stage!.tkReasoning === 10, `reasoning tokens not recorded: ${stage!.tkReasoning}`);
      assert(stage!.estimatedCostUsd === null, "a free trial endpoint must report null cost, never $0.00");
    });
  });

  check("a paid call with no configured rate still reports null, not a guess", () => {
    withEnv(CURRENT_PROD_ENV, () => {
      const mark = llmCostMark();
      recordLlmCall({ provider: "anthropic", model: "claude-opus-5", tkIn: 1000, tkOut: 1000, durationMs: 1, stage: "t" });
      const stage = llmCostSince(mark).stages.find((s) => s.stage === "t")!;
      assert(stage.estimatedCostUsd === null, `expected null, got ${stage.estimatedCostUsd}`);
    });
  });
}

// ================================================================ 9. roles

function roleDefinitionTests(): void {
  console.log("\nRole definitions:");

  check("every role has a distinct env prefix", () => {
    const prefixes = ALL_ROLES.map((r) => ROLE_DEFINITIONS[r].envPrefix);
    assert(new Set(prefixes).size === prefixes.length, `duplicate prefix: ${prefixes.join(", ")}`);
  });

  check("verification and rewrite are separate roles with separate config", () => {
    const v = ROLE_DEFINITIONS.script_verification;
    const r = ROLE_DEFINITIONS.script_rewrite;
    assert(v.envPrefix !== r.envPrefix, "they must be independently overridable");
    assert(v.reasoning === "on" && r.reasoning === "off", "the diagnoser reasons; the rewriter writes");
    assert(r.userFacingDialogue && !v.userFacingDialogue, "only the rewriter touches listener-facing dialogue");
  });

  check("research_brief and script_movement are separate roles", () => {
    assert(
      ROLE_DEFINITIONS.research_brief.envPrefix !== ROLE_DEFINITIONS.script_movement.envPrefix,
      "research organisation and spoken dialogue must not share configuration"
    );
  });

  check("dialogue roles never request visible reasoning", () => {
    for (const role of ALL_ROLES) {
      const def = ROLE_DEFINITIONS[role];
      if (!def.userFacingDialogue) continue;
      assert(def.reasoning === "off", `${role} writes listener-facing text and must not enable reasoning`);
    }
  });

  check("every role declares its real call sites, or is marked as not wired", () => {
    const wired = ALL_ROLES.filter((r) => ROLE_DEFINITIONS[r].callSites.length > 0);
    const notWired = ALL_ROLES.filter((r) => ROLE_DEFINITIONS[r].callSites.length === 0);
    assert(wired.length >= 11, `expected at least 11 wired roles, got ${wired.length}`);
    // These three are deterministic in the current pipeline; the readiness map
    // must say so rather than implying a model is doing the work.
    assert(
      JSON.stringify(notWired.sort()) === JSON.stringify(["episode_metadata", "evidence_extraction", "topic_ranking"]),
      `unexpected not-wired set: ${notWired.join(", ")}`
    );
  });

  check("every declared call site names a file that exists", () => {
    for (const role of ALL_ROLES) {
      for (const site of ROLE_DEFINITIONS[role].callSites) {
        const file = site.split(" ")[0];
        assert(fs.existsSync(path.join(process.cwd(), file)), `${role}: ${file} does not exist`);
      }
    }
  });

  check("the readiness report never contains a credential value", () => {
    withEnv(FRONTIER_ENV, () => {
      const serialized = JSON.stringify(roleRouteReport());
      for (const secret of [FRONTIER_ENV.NVIDIA_API_KEY, FRONTIER_ENV.ZAI_API_KEY, FRONTIER_ENV.ANTHROPIC_API_KEY]) {
        assert(!serialized.includes(secret), "a credential leaked into the readiness report");
      }
    });
  });

  check("unwired roles are reported as not-wired, not as failures", () => {
    withEnv(FRONTIER_ENV, () => {
      const report = roleRouteReport();
      for (const role of ["topic_ranking", "evidence_extraction", "episode_metadata"] as LLMRole[]) {
        const row = report.find((r) => r.role === role)!;
        assert(row.status === "not-wired", `${role}: expected not-wired, got ${row.status}`);
        assert(row.hasCallSite === false, `${role}: hasCallSite should be false`);
      }
    });
  });
}

// ================================================================ 10. challenger

async function challengerTests(): Promise<void> {
  console.log("\nDialogue challenger:");

  check("the challenger is OFF unless explicitly enabled", () => {
    withEnv(FRONTIER_ENV, () => assert(resolveScriptChallenger() === null, "must be off by default"));
    withEnv({ ...FRONTIER_ENV, SCRIPT_CHALLENGER_ENABLED: "true" }, () =>
      assert(resolveScriptChallenger() === null, "enabled with no provider must be a no-op, not a crash")
    );
  });

  check("an enabled challenger resolves to its configured model", () => {
    withEnv(
      {
        ...FRONTIER_ENV,
        SCRIPT_CHALLENGER_ENABLED: "true",
        SCRIPT_CHALLENGER_PROVIDER: "nvidia",
        SCRIPT_CHALLENGER_MODEL: "moonshotai/kimi-k2.6",
      },
      () => {
        const c = resolveScriptChallenger();
        assert(c !== null, "expected a challenger");
        assert(c!.label === "nvidia/moonshotai/kimi-k2.6", c!.label);
      }
    );
  });

  await checkAsync("primary and challenger receive BYTE-IDENTICAL movement inputs", async () => {
    const seen: { who: string; prompt: string; systemPrompt?: string; maxTokens?: number; temperature?: number }[] = [];
    const fake = (who: string, behavior: "ok" | "throw"): LLMProvider => ({
      name: who,
      async generateText() {
        return "";
      },
      async generateStructuredOutput<T>(o: any): Promise<T> {
        // The outline call comes first and is not part of the comparison. Match
        // on the movement prompt's own opening, not on "story spine" — the
        // movement prompt quotes the spine back, so that would match both.
        const isOutline = !/^Write MOVEMENT /.test(o.prompt);
        if (!isOutline) {
          seen.push({ who, prompt: o.prompt, systemPrompt: o.systemPrompt, maxTokens: o.maxTokens, temperature: o.temperature });
          if (behavior === "throw") throw new Error("challenger could not complete the movement");
        }
        if (isOutline) {
          return {
            beats: Array.from({ length: 6 }, (_, i) => ({
              beatIndex: i,
              segmentType: i === 0 ? "cold_open" : i === 5 ? "closing" : "topic",
              title: `beat ${i}`,
              goal: "g",
              angle: "a",
              factRefs: [],
            })),
          } as unknown as T;
        }
        return {
          segments: [{ type: "topic", title: "t", lines: [{ lineIndex: 0, speakerName: "Zabala", text: "line" }] }],
          stateAfter: { emotionalTemperature: "warming" },
        } as unknown as T;
      },
    });

    const primary = fake("primary", "ok");
    const challenger = fake("challenger", "throw");
    const out = await generateOutlineDrivenScript(primary, {
      systemPrompt: "PERSONA",
      episodeTitle: "T",
      topicsPrompts: "EVIDENCE",
      targetDuration: 10,
      version: 1,
      temperature: 0.85,
      maxTokens: 16000,
      speakerNames: ["Zabala", "Mulkey"],
      challengerLlm: challenger,
      challengerLabel: "challenger",
      log: () => {},
    });

    const primaryCalls = seen.filter((s) => s.who === "primary");
    const challengerCalls = seen.filter((s) => s.who === "challenger");
    assert(primaryCalls.length === challengerCalls.length, `${primaryCalls.length} vs ${challengerCalls.length} movement calls`);
    assert(primaryCalls.length >= 3, `expected three movements, got ${primaryCalls.length}`);
    for (let i = 0; i < primaryCalls.length; i++) {
      assert(primaryCalls[i].prompt === challengerCalls[i].prompt, `movement ${i + 1}: prompts differ`);
      assert(primaryCalls[i].systemPrompt === challengerCalls[i].systemPrompt, `movement ${i + 1}: system prompts differ`);
      assert(primaryCalls[i].maxTokens === challengerCalls[i].maxTokens, `movement ${i + 1}: token allowance differs`);
      assert(primaryCalls[i].maxTokens === 16000, `movement ${i + 1}: allowance must stay 16000, got ${primaryCalls[i].maxTokens}`);
      assert(primaryCalls[i].temperature === challengerCalls[i].temperature, `movement ${i + 1}: temperature differs`);
    }

    // Honest failure reporting, and no mixing.
    assert(!!out.challenger, "challenger results must be reported");
    assert(out.challenger!.every((c) => c.ok === false), "the failing challenger must be reported as failed");
    assert(
      out.challenger!.every((c) => (c.error || "").includes("could not complete")),
      "the challenger's real error must be preserved"
    );
    assert(
      out.segments.every((s: any) => s.lines.every((l: any) => l.text === "line")),
      "the challenger's dialogue must never be spliced into the episode"
    );
  });
}

// ================================================================ 10b. category-aware fallback

async function categoryPolicyTests(): Promise<void> {
  console.log("\nCategory-aware fallback policy:");

  const free = { provider: "nvidia", model: "m", paid: false, source: "profile_primary" };
  const freeNext = { provider: "zai", model: "z", paid: false, source: "profile_secondary" };
  const paidNext = { provider: "anthropic", model: "claude-opus-5", paid: true, source: "legacy_backup" };
  const allowExplicit = { paidFallbackAllowed: true, paidFallbackExplicit: true };
  const allowDefault = { paidFallbackAllowed: true, paidFallbackExplicit: false };
  const forbid = { paidFallbackAllowed: false, paidFallbackExplicit: true };

  const err = (category: string) =>
    new LlmProviderError({ provider: "nvidia", model: "m", category: category as never, message: "x" });

  check("TERMINAL categories stop the chain even with a candidate available", () => {
    for (const category of [
      "safety_refusal",
      "invalid_application_schema",
      "programming_error",
      "unsupported_role",
      "prompt_policy_violation",
      "data_validation_bug",
    ]) {
      const d = fallbackDecision(err(category), free, freeNext, allowExplicit);
      assert(d.verdict === "stop", `${category} should stop, got ${d.verdict}`);
      assert(d.category === category, `${category} category was lost: ${d.category}`);
      assert(d.reason.length > 20, `${category}: a stop needs a stated reason`);
    }
  });

  check("RECOVERABLE categories advance to the next candidate", () => {
    for (const category of [
      "rate_limited",
      "temporary_unavailable",
      "network_error",
      "timeout",
      "provider_internal_error",
      "model_temporarily_unavailable",
      "empty_response",
      "output_limit",
      "structured_output_invalid_after_repair",
      "quota_exhausted",
    ]) {
      const d = fallbackDecision(err(category), free, freeNext, forbid);
      assert(d.verdict === "continue", `${category} should continue, got ${d.verdict}: ${d.reason}`);
    }
  });

  check("a CONFIGURATION failure may advance to a FREE candidate", () => {
    for (const category of ["missing_api_key", "authentication_failed", "invalid_model", "unsupported_parameter"]) {
      const d = fallbackDecision(err(category), free, freeNext, forbid);
      assert(d.verdict === "continue", `${category} should advance among free candidates: ${d.reason}`);
      assert(/still reported|not resolved/i.test(d.reason), `${category}: the failure must remain reported`);
    }
  });

  check("a CONFIGURATION failure may NOT cross into paid on a default-enabled flag", () => {
    const d = fallbackDecision(err("missing_api_key"), free, paidNext, allowDefault);
    assert(d.verdict === "stop", `expected stop, got ${d.verdict}: ${d.reason}`);
    assert(/explicitly/i.test(d.reason), `the reason must say the flag was not explicit: ${d.reason}`);
  });

  check("a CONFIGURATION failure MAY cross into paid when explicitly enabled", () => {
    const d = fallbackDecision(err("authentication_failed"), free, paidNext, allowExplicit);
    assert(d.verdict === "continue", `expected continue, got ${d.verdict}: ${d.reason}`);
    assert(/original failure remains/i.test(d.reason), `the original failure must stay visible: ${d.reason}`);
  });

  check("an exhausted chain stops and still names the category", () => {
    const d = fallbackDecision(err("rate_limited"), free, undefined, allowExplicit);
    assert(d.verdict === "stop", "no candidate left means stop");
    assert(d.category === "rate_limited", d.category);
  });

  await checkAsync("a SAFETY REFUSAL stops the chain — later candidates are never called", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      const m = mockFetch([
        {
          match: NVIDIA_HOST,
          respond: (body) =>
            String(body.model).includes("mistral")
              ? jsonResponse({
                  choices: [{ finish_reason: "stop", message: { refusal: "I cannot write that." } }],
                  usage: { prompt_tokens: 1, completion_tokens: 0 },
                })
              : jsonResponse({ error: "should not be reached" }, 500),
        },
        { match: ZAI_HOST, respond: () => jsonResponse({ error: "should not be reached" }, 500) },
        { match: ANTHROPIC_HOST, respond: () => jsonResponse({ error: "should not be reached" }, 500) },
      ]);
      try {
        let err: any = null;
        try {
          await getRoleLLMProvider("script_movement").generateStructuredOutput<any>({ prompt: "x" });
        } catch (e) {
          err = e;
        }
        assert(err?.category === "safety_refusal", `expected safety_refusal, got ${err?.category}`);
        assert(m.captured.length === 1, `expected exactly ONE request, saw ${m.captured.length}`);
        assert(
          !m.captured.some((c) => c.url.includes(ZAI_HOST) || c.url.includes(ANTHROPIC_HOST)),
          "a refusal must not be retried on other providers"
        );
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("an INVALID APPLICATION SCHEMA stops the chain", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      // An invalid json_schema is our own defect. Only a model with native schema
      // support is sent one, so use OpenAI here.
      const m = mockFetch([
        {
          match: OPENAI_HOST,
          respond: () => jsonResponse({ error: { message: "Invalid schema for response_format" } }, 400),
        },
        { match: ANTHROPIC_HOST, respond: () => jsonResponse({ error: "should not be reached" }, 500) },
      ]);
      try {
        await withEnvAsync(
          {
            ...FRONTIER_ENV,
            LLM_ROUTING_PROFILE: "custom",
            OPENAI_API_KEY: "sk-openai-test-key-1234567890",
            SHOW_NOTES_LLM_PROVIDER: "openai",
            SHOW_NOTES_LLM_MODEL: "gpt-4o-mini",
          },
          async () => {
            let err: any = null;
            try {
              await getRoleLLMProvider("show_notes").generateStructuredOutput<any>({
                prompt: "x",
                jsonSchema: { type: "object", properties: { a: { type: "nonsense" } }, required: ["a"] },
              });
            } catch (e) {
              err = e;
            }
            assert(
              err?.category === "invalid_application_schema",
              `expected invalid_application_schema, got ${err?.category}: ${err?.message}`
            );
            assert(
              !m.captured.some((c) => c.url.includes(ANTHROPIC_HOST)),
              "our own bad schema must not be retried against a paid provider"
            );
          }
        );
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("a PROGRAMMING ERROR (unknown provider) stops the chain", async () => {
    await withEnvAsync(
      { ...FRONTIER_ENV, LLM_ROUTING_PROFILE: "custom", SHOW_NOTES_LLM_PROVIDER: "not-a-provider" },
      async () => {
        const m = mockFetch([
          { match: ANTHROPIC_HOST, respond: () => jsonResponse({ error: "should not be reached" }, 500) },
        ]);
        try {
          let err: any = null;
          try {
            await getRoleLLMProvider("show_notes").generateStructuredOutput<any>({ prompt: "x" });
          } catch (e) {
            err = e;
          }
          assert(err?.category === "programming_error", `expected programming_error, got ${err?.category}`);
          assert(m.captured.length === 0, "an unbuildable provider must not trigger any HTTP call");
        } finally {
          m.restore();
        }
      }
    );
  });

  await checkAsync("a RATE LIMIT advances to the next candidate", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      const m = mockFetch([
        { match: NVIDIA_HOST, respond: () => jsonResponse({ error: "too many requests" }, 429) },
        { match: ZAI_HOST, respond: () => oaiOk('{"from":"zai"}') },
      ]);
      try {
        const res = await getRoleLLMProvider("show_notes").generateStructuredOutput<any>({ prompt: "x" });
        assert(res.from === "zai", `expected the Z.ai result, got ${JSON.stringify(res)}`);
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("a provider TIMEOUT advances to the next candidate", async () => {
    await withEnvAsync({ ...FRONTIER_ENV, NVIDIA_REQUEST_TIMEOUT_MS: "50" }, async () => {
      const realFetchLocal = globalThis.fetch;
      globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(typeof input === "string" ? input : input?.url ?? input);
        if (url.includes(NVIDIA_HOST)) {
          return new Promise((_res, rej) => {
            init?.signal?.addEventListener("abort", () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              rej(e);
            });
          });
        }
        return oaiOk('{"from":"zai"}');
      }) as typeof fetch;
      try {
        const res = await getRoleLLMProvider("show_notes").generateStructuredOutput<any>({ prompt: "x" });
        assert(res.from === "zai", `expected the Z.ai result after a timeout, got ${JSON.stringify(res)}`);
      } finally {
        globalThis.fetch = realFetchLocal;
      }
    });
  });

  await checkAsync("malformed JSON advances ONLY after the one repair attempt also fails", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      let nvidiaCalls = 0;
      const m = mockFetch([
        {
          match: NVIDIA_HOST,
          respond: () => {
            nvidiaCalls++;
            return oaiOk("not json at all");
          },
        },
        { match: ZAI_HOST, respond: () => oaiOk('{"from":"zai"}') },
      ]);
      try {
        const res = await getRoleLLMProvider("show_notes").generateStructuredOutput<any>({ prompt: "x" });
        assert(res.from === "zai", `expected the fallback result, got ${JSON.stringify(res)}`);
        assert(
          nvidiaCalls === 2,
          `the primary must get exactly one repair attempt before fallback; saw ${nvidiaCalls} call(s)`
        );
      } finally {
        m.restore();
      }
    });
  });

  await checkAsync("a repaired-successfully response does NOT fall back", async () => {
    await withEnvAsync(FRONTIER_ENV, async () => {
      let nvidiaCalls = 0;
      const m = mockFetch([
        {
          match: NVIDIA_HOST,
          respond: () => {
            nvidiaCalls++;
            return nvidiaCalls === 1 ? oaiOk("nope") : oaiOk('{"from":"nvidia-after-repair"}');
          },
        },
        { match: ZAI_HOST, respond: () => { throw new Error("must not fall back after a successful repair"); } },
      ]);
      try {
        const res = await getRoleLLMProvider("show_notes").generateStructuredOutput<any>({ prompt: "x" });
        assert(res.from === "nvidia-after-repair", JSON.stringify(res));
        assert(nvidiaCalls === 2, `expected 2 primary calls, saw ${nvidiaCalls}`);
      } finally {
        m.restore();
      }
    });
  });
}

// ================================================================ 10c. endpoint identity

function endpointIdentityTests(): void {
  console.log("\nTrue endpoint identity:");

  check("identity is provider + normalized base URL + model", () => {
    withEnv(FRONTIER_ENV, () => {
      const id = endpointIdentity({ provider: "nvidia", model: "a/b" });
      assert(id.startsWith("nvidia|"), id);
      assert(id.includes("integrate.api.nvidia.com"), `the base URL must be part of identity: ${id}`);
      assert(id.endsWith("|a/b"), id);
    });
  });

  check("base-URL spellings that mean the same endpoint normalize together", () => {
    const variants = [
      "https://integrate.api.nvidia.com/v1",
      "https://integrate.api.nvidia.com/v1/",
      "https://INTEGRATE.API.NVIDIA.COM/v1///",
      "https://integrate.api.nvidia.com:443/v1",
    ];
    const ids = variants.map((v) =>
      withEnv({ ...FRONTIER_ENV, NVIDIA_BASE_URL: v }, () => endpointIdentity({ provider: "nvidia", model: "m" }))
    );
    assert(new Set(ids).size === 1, `these spellings should be ONE endpoint: ${ids.join(" | ")}`);
  });

  check("a DIFFERENT base URL is a different endpoint, even for the same model", () => {
    const a = withEnv(FRONTIER_ENV, () => endpointIdentity({ provider: "nvidia", model: "m" }));
    const b = withEnv({ ...FRONTIER_ENV, NVIDIA_BASE_URL: "https://my-self-hosted-nim.internal/v1" }, () =>
      endpointIdentity({ provider: "nvidia", model: "m" })
    );
    assert(a !== b, "provider/model alone is NOT endpoint identity — the base URL must count");
  });

  check("an alias cannot make the chain attempt the same endpoint twice", () => {
    // The override names the profile primary with a differently-cased model, and
    // the legacy backup is pointed at the same provider/model as the tertiary.
    withEnv(
      {
        ...FRONTIER_ENV,
        SCRIPT_MOVEMENT_LLM_PROVIDER: "NVIDIA",
        SCRIPT_MOVEMENT_LLM_MODEL: "MistralAI/Mistral-Medium-3.5-128B",
      },
      () => {
        const plan = resolveRolePlan("script_movement");
        const ids = plan.candidates.map(endpointIdentity);
        assert(new Set(ids).size === ids.length, `the same endpoint appears twice: ${ids.join(" | ")}`);
        const mistralAttempts = ids.filter((i) => i.includes("mistral-medium-3.5")).length;
        assert(mistralAttempts === 1, `one endpoint, one attempt — saw ${mistralAttempts}`);
      }
    );
  });

  check("every role's chain is endpoint-unique in every profile", () => {
    for (const profile of ["legacy", "frontier_development", "free_independent", "custom"]) {
      withEnv({ ...FRONTIER_ENV, LLM_ROUTING_PROFILE: profile }, () => {
        for (const role of ALL_ROLES) {
          const ids = resolveRolePlan(role).candidates.map(endpointIdentity);
          assert(new Set(ids).size === ids.length, `${profile}/${role}: duplicate endpoint`);
        }
      });
    }
  });

  check("normalizedBaseUrl never returns a credential", () => {
    withEnv(FRONTIER_ENV, () => {
      for (const p of ["nvidia", "zai", "anthropic", "openai", "stub"]) {
        const url = normalizedBaseUrl(p);
        assert(!url.includes(FRONTIER_ENV.NVIDIA_API_KEY), "credential leaked into the endpoint identity");
        assert(!url.includes(FRONTIER_ENV.ZAI_API_KEY), "credential leaked into the endpoint identity");
      }
    });
  });
}

// ================================================================ 10d. verification display

function verificationDisplayTests(): void {
  console.log("\nCatalog vs live verification:");

  check("the two verification claims are reported separately per candidate", () => {
    withEnv(FRONTIER_ENV, () => {
      const row = roleRouteReport().find((r) => r.role === "script_movement")!;
      const nvidiaCandidate = row.candidates.find((c) => c.key.startsWith("nvidia/"))!;
      assert(nvidiaCandidate.catalogVerified === true, "the NVIDIA model ID is catalog-confirmed");
      assert(nvidiaCandidate.liveContractVerified === false, "nothing here has called it live");
      assert(
        nvidiaCandidate.verification === "catalog-verified-live-untested",
        `expected catalog-verified-live-untested, got ${nvidiaCandidate.verification}`
      );
    });
  });

  check("the three readiness states are all representable", () => {
    const states = new Set([
      verificationState(modelCapabilities("nvidia", "deepseek-ai/deepseek-v4-pro")),
      verificationState(modelCapabilities("anthropic", "claude-sonnet-5")),
      verificationState(modelCapabilities("zai", "glm-4.7-flash")),
    ]);
    assert(states.has("catalog-verified-live-untested"), "NVIDIA models are catalog-only");
    assert(states.has("live-contract-verified"), "the in-production Anthropic models are live-verified");
    assert(states.has("catalog-unavailable"), "Z.ai's catalog was not confirmed in this work");
  });

  check("readiness notes distinguish catalog-only from catalog-unavailable", () => {
    withEnv(FRONTIER_ENV, () => {
      const notes = roleRouteReport()
        .filter((r) => r.hasCallSite)
        .flatMap((r) => r.notes)
        .join(" ");
      assert(/LIVE CONTRACT UNTESTED/.test(notes), `expected a catalog-only note: ${notes.slice(0, 300)}`);
      assert(/Catalog\/model unavailable/.test(notes), `expected an unconfirmed-catalog note: ${notes.slice(0, 300)}`);
    });
  });

  check("a catalog-verified model is never described as validated", () => {
    const caps = modelCapabilities("nvidia", "mistralai/mistral-medium-3.5-128b");
    assert(caps.catalogVerified && !caps.liveContractVerified, "expected the catalog-only state");
    assert(
      caps.provenance.requestFields.length > 20 && caps.provenance.limits.length > 20,
      "a catalog-only record must state what is still unverified"
    );
  });
}

// ================================================================ 11. source contracts

function sourceContractTests(): void {
  console.log("\nSource-level contracts:");

  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  check("show notes are generated from the FINAL persisted script", () => {
    const src = read("src/lib/services/contentAssetService.ts");
    // The evidence packet handed to the show-notes model reads the persisted
    // script's plainText — the approved, self-verified, antithesis-passed text —
    // not any in-memory draft.
    assert(/transcriptText:\s*script\.plainText/.test(src), "the show-notes packet must use script.plainText");
    assert(/getRoleLLMProvider\("show_notes"\)/.test(src), "show notes must use the show_notes role");
  });

  check("the 16,000-token movement allowance is still the default", () => {
    const src = read("src/lib/services/scriptService.ts");
    assert(/SCRIPT_GEN_MAX_TOKENS\) \|\| 16000/.test(src), "the 16000 default was changed");
  });

  check("the outline call still allows 7,000 tokens", () => {
    const src = read("src/lib/services/scriptOutlineEngine.ts");
    assert(/Math\.min\(args\.maxTokens, 7000\)/.test(src), "the outline allowance was changed");
  });

  check("no call site resolves its own provider from raw env any more", () => {
    for (const rel of [
      "src/lib/queue/worker.ts",
      "src/lib/services/scriptService.ts",
      "src/lib/services/factCheckService.ts",
      "src/lib/services/contentAssetService.ts",
    ]) {
      const src = read(rel);
      assert(
        !/process\.env\.LLM_PROVIDER/.test(src),
        `${rel} still reads process.env.LLM_PROVIDER directly — ask routing instead`
      );
    }
  });

  check("the deterministic quality scorer was not re-tuned", () => {
    const src = read("src/lib/services/episodeQualityService.ts");
    assert(!/nvidia|zai|routing/i.test(src), "the scorer must know nothing about providers or profiles");
  });
}

// ================================================================ main

async function main(): Promise<void> {
  console.log("LLM role routing contract (all transport mocked — no API calls, no credentials needed):");

  legacyTests();
  profileTests();
  loopSafetyTests();
  await fallbackTests();
  await existingProviderTests();
  stageTests();
  parityTests();
  limitAndLedgerTests();
  await categoryPolicyTests();
  endpointIdentityTests();
  verificationDisplayTests();
  roleDefinitionTests();
  await challengerTests();
  sourceContractTests();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(
      "\nROUTING CONTRACT VIOLATED. The most important of these is the legacy contract: " +
        "LLM_ROUTING_PROFILE=legacy must reproduce the pre-feature behavior exactly."
    );
    process.exit(1);
  }
}

main().catch((err) => {
  globalThis.fetch = realFetch;
  console.error("Routing test harness failed:", err);
  process.exit(1);
});
