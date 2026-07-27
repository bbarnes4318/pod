// NVIDIA NIM provider contract. Run:
//
//   npm run test:nvidia-provider            # mocked only, no credential needed
//   npm run test:nvidia-provider -- --live  # also probe the real API
//
// Two layers:
//   1. the shared protocol contract, run against the dialogue primary;
//   2. a PER-MODEL request-shape assertion for all six routed models, because
//      NVIDIA's models do not share one reasoning contract and the whole point of
//      the profile strategies is that each gets its own.
//
// The live probe is opt-in. For the full 17-point per-model contract probe that
// writes artifacts/nvidia-contract-report.{json,md}, use:
//
//   npm run probe:llm-contract -- --provider nvidia

import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
dotenv.config();

import { NvidiaNimLLMProvider, NVIDIA_DEFAULT_BASE_URL } from "../lib/providers/llm/nvidia";
import { MODEL_IDS, modelCapabilities } from "../lib/providers/llm/capabilities";
import { nemotronBudget } from "../lib/providers/llm/nvidiaRequestProfiles";
import { runProviderContract } from "./providerContractHarness";

const LIVE = process.argv.includes("--live");

const NV_ENV = {
  NVIDIA_BASE_URL: NVIDIA_DEFAULT_BASE_URL,
  NVIDIA_MAX_RETRIES: "0",
  NVIDIA_REQUEST_TIMEOUT_MS: "240000",
};

let extraPassed = 0;
let extraFailed = 0;
const assert = (c: boolean, m: string) => {
  if (!c) throw new Error(m);
};
function check(name: string, fn: () => void) {
  try {
    fn();
    extraPassed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    extraFailed++;
    console.error(`  ✗ ${name}\n      ${(e as Error)?.message || e}`);
  }
}

/**
 * Per-model shape assertions. Each mirrors NVIDIA's documented example for that
 * model, and each forbids the OTHER models' fields — sending DeepSeek's
 * `thinking` alias to Nemotron is precisely the bug this replaces.
 */
const SHAPE_ASSERTIONS: Record<string, (b: { reasoningOn: any; reasoningOff: any }) => void> = {
  [MODEL_IDS.nvidia.deepseekFlash]: ({ reasoningOn, reasoningOff }) => {
    assert(reasoningOn.chat_template_kwargs?.thinking === true, "deepseek: expected chat_template_kwargs.thinking=true");
    assert(
      typeof reasoningOn.chat_template_kwargs?.reasoning_effort === "string",
      "deepseek: reasoning_effort must be NESTED inside chat_template_kwargs"
    );
    assert(
      reasoningOn.reasoning_effort === undefined,
      "deepseek: reasoning_effort must NOT also be sent at the top level"
    );
    assert(reasoningOn.reasoning_budget === undefined, "deepseek: reasoning_budget is Nemotron's field, not DeepSeek's");
    assert(
      reasoningOn.chat_template_kwargs?.enable_thinking === undefined,
      "deepseek: enable_thinking is Nemotron's key, not DeepSeek's"
    );
    assert(reasoningOff.chat_template_kwargs?.thinking === false, "deepseek: reasoning off must send thinking=false");
  },
  [MODEL_IDS.nvidia.deepseekPro]: ({ reasoningOn, reasoningOff }) => {
    assert(reasoningOn.chat_template_kwargs?.thinking === true, "deepseek-pro: expected chat_template_kwargs.thinking=true");
    assert(
      typeof reasoningOn.chat_template_kwargs?.reasoning_effort === "string",
      "deepseek-pro: reasoning_effort must be nested"
    );
    assert(reasoningOff.chat_template_kwargs?.thinking === false, "deepseek-pro: reasoning off must send thinking=false");
  },
  [MODEL_IDS.nvidia.nemotron]: ({ reasoningOn, reasoningOff }) => {
    assert(
      reasoningOn.chat_template_kwargs?.enable_thinking === true,
      "nemotron: must use chat_template_kwargs.enable_thinking"
    );
    assert(
      reasoningOn.chat_template_kwargs?.thinking === undefined,
      "nemotron: must NOT be sent DeepSeek's `thinking` alias — nothing proves it is accepted"
    );
    assert(
      typeof reasoningOn.reasoning_budget === "number" && reasoningOn.reasoning_budget > 0,
      "nemotron: expected a TOP-LEVEL numeric reasoning_budget"
    );
    assert(
      reasoningOn.chat_template_kwargs?.reasoning_budget === undefined,
      "nemotron: reasoning_budget is top-level, not nested"
    );
    assert(
      reasoningOff.chat_template_kwargs?.enable_thinking === false,
      "nemotron: reasoning off must send enable_thinking=false"
    );
    assert(
      reasoningOff.reasoning_budget === undefined,
      "nemotron: no budget should be sent when thinking is disabled"
    );
  },
  [MODEL_IDS.nvidia.mistral]: ({ reasoningOn, reasoningOff }) => {
    assert(
      typeof reasoningOn.reasoning_effort === "string",
      "mistral: expected a TOP-LEVEL reasoning_effort when reasoning is requested"
    );
    assert(
      reasoningOn.chat_template_kwargs === undefined,
      "mistral: chat_template_kwargs is not Mistral's field"
    );
    assert(reasoningOn.reasoning_budget === undefined, "mistral: reasoning_budget is not Mistral's field");
    // The production path: dialogue asks for reasoning=off, so nothing goes out.
    assert(
      reasoningOff.reasoning_effort === undefined && reasoningOff.chat_template_kwargs === undefined,
      "mistral: with reasoning off, NO reasoning field may be added to a 16,000-token movement call"
    );
  },
  [MODEL_IDS.nvidia.kimi]: ({ reasoningOn, reasoningOff }) => {
    for (const [label, body] of [["reasoning on", reasoningOn], ["reasoning off", reasoningOff]] as const) {
      assert(body.response_format === undefined, `kimi (${label}): response_format must never be sent`);
      assert(body.chat_template_kwargs === undefined, `kimi (${label}): no chat_template_kwargs`);
      assert(body.thinking === undefined, `kimi (${label}): no thinking field`);
      assert(body.reasoning_effort === undefined, `kimi (${label}): no reasoning_effort`);
      assert(body.reasoning_budget === undefined, `kimi (${label}): no reasoning_budget`);
    }
  },
  [MODEL_IDS.nvidia.glm]: ({ reasoningOn, reasoningOff }) => {
    // Live-verified 2026-07-26: chat_template_kwargs.thinking is accepted AND the
    // response returned reasoning_content, so this model now gets a real control.
    assert(reasoningOn.chat_template_kwargs?.thinking === true, "glm-5.2: expected chat_template_kwargs.thinking=true");
    assert(
      typeof reasoningOn.chat_template_kwargs?.reasoning_effort === "string",
      "glm-5.2: reasoning_effort is nested, as verified"
    );
    assert(reasoningOff.chat_template_kwargs?.thinking === false, "glm-5.2: reasoning off must send thinking=false");
    for (const [label, body] of [["reasoning on", reasoningOn], ["reasoning off", reasoningOff]] as const) {
      // The probe 400'd on reasoning_budget for this model even though Nemotron
      // accepts it — two reasoning models, two contracts.
      assert(
        body.reasoning_budget === undefined,
        `glm-5.2 (${label}): reasoning_budget is REJECTED by this model (400) — it is Nemotron's field, not GLM's`
      );
      assert(
        body.chat_template_kwargs?.enable_thinking === undefined,
        `glm-5.2 (${label}): enable_thinking is Nemotron's key`
      );
      assert(body.thinking === undefined, `glm-5.2 (${label}): the top-level thinking object is Z.ai's shape`);
    }
  },
};

async function perModelShapeChecks(): Promise<void> {
  console.log("\nPer-model request shaping (mocked, one profile per NVIDIA model):");
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  Object.assign(process.env, NV_ENV, { NVIDIA_API_KEY: "nvidia-test-credential-abcdef0123456789" });

  for (const model of Object.values(MODEL_IDS.nvidia)) {
    const bodies: any[] = [];
    globalThis.fetch = (async (_i: any, init?: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const p = new NvidiaNimLLMProvider(model);
      await p.generateStructuredOutput<any>({ prompt: "x", reasoning: "on", maxTokens: 4000 });
      await p.generateStructuredOutput<any>({ prompt: "x", reasoning: "off", maxTokens: 4000 });
      check(`${model}`, () =>
        SHAPE_ASSERTIONS[model]({ reasoningOn: bodies[0], reasoningOff: bodies[1] })
      );
    } catch (err) {
      extraFailed++;
      console.error(`  ✗ ${model}\n      ${(err as Error).message}`);
    }
  }

  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

function nemotronBudgetChecks(): void {
  console.log("\nNemotron reasoning budget:");
  const caps = modelCapabilities("nvidia", MODEL_IDS.nvidia.nemotron);

  check("the documented 256-16384 range is recorded and clamped", () => {
    assert(
      JSON.stringify(caps.reasoningBudgetRange) === JSON.stringify([256, 16384]),
      `expected the documented range, got ${JSON.stringify(caps.reasoningBudgetRange)}`
    );
    process.env.NVIDIA_NEMOTRON_REASONING_BUDGET = "999999";
    const high = nemotronBudget({ wantsReasoning: true, caps, role: "research_brief", maxTokens: 100000 });
    assert(high.budget === 16384, `expected clamping to 16384, got ${high.budget}`);
    process.env.NVIDIA_NEMOTRON_REASONING_BUDGET = "1";
    const low = nemotronBudget({ wantsReasoning: true, caps, role: "research_brief", maxTokens: 100000 });
    assert(low.budget === 256, `expected clamping to 256, got ${low.budget}`);
    delete process.env.NVIDIA_NEMOTRON_REASONING_BUDGET;
  });

  check("the budget can never consume the whole allowance", () => {
    // A 1,200-token continuity call must not hand every token to thinking and
    // return no answer.
    const tight = nemotronBudget({ wantsReasoning: true, caps, role: "research_brief", maxTokens: 1200 });
    assert(tight.budget <= 600, `budget ${tight.budget} leaves no answer headroom in a 1200-token allowance`);
    assert(/capped/.test(tight.note), `the cap must be explained: ${tight.note}`);
  });

  check("role-specific budget variables are honored", () => {
    process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_RESEARCH = "8192";
    process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_VERIFY = "2048";
    process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_JUDGE = "1024";
    const research = nemotronBudget({ wantsReasoning: true, caps, role: "research_brief", maxTokens: 100000 });
    const verify = nemotronBudget({ wantsReasoning: true, caps, role: "fact_check", maxTokens: 100000 });
    const judge = nemotronBudget({ wantsReasoning: true, caps, role: "quality_judge", maxTokens: 100000 });
    assert(research.budget === 8192, `research: ${research.budget}`);
    assert(verify.budget === 2048, `verify: ${verify.budget}`);
    assert(judge.budget === 1024, `judge: ${judge.budget}`);
    delete process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_RESEARCH;
    delete process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_VERIFY;
    delete process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_JUDGE;
  });
}

/**
 * Kimi's structured path end to end: no native response_format, JSON demanded in
 * the prompt, parsed strictly, validated against the full application structure,
 * one repair on failure — and a successful prompt-enforced response does NOT get
 * treated as evidence of native JSON support.
 */
async function kimiStructuredChecks(): Promise<void> {
  console.log("\nKimi K2.6 prompt-enforced structured output:");
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  Object.assign(process.env, NV_ENV, { NVIDIA_API_KEY: "nvidia-test-credential-abcdef0123456789" });
  const { validateScriptShape } = await import("../lib/services/scriptOutlineEngine");

  const run = async (
    replies: string[],
    opts: { validate?: (v: unknown) => string | null } = {}
  ): Promise<{ result?: any; error?: any; bodies: any[] }> => {
    const bodies: any[] = [];
    let call = 0;
    globalThis.fetch = (async (_i: any, init?: any) => {
      bodies.push(JSON.parse(String(init.body)));
      const content = replies[Math.min(call++, replies.length - 1)];
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      const p = new NvidiaNimLLMProvider(MODEL_IDS.nvidia.kimi);
      const result = await p.generateStructuredOutput<any>({
        prompt: "Write the movement.",
        maxTokens: 16000,
        ...opts,
      });
      return { result, bodies };
    } catch (error) {
      return { error, bodies };
    }
  };

  const valid = '{"segments":[{"type":"topic","title":"t","lines":[{"lineIndex":0,"speakerName":"Zabala","text":"line"}]}]}';

  const first = await run([valid], { validate: validateScriptShape });
  check("returns validated application JSON with no response_format", () => {
    assert(first.error === undefined, `unexpected error: ${first.error?.message}`);
    assert(first.result?.segments?.[0]?.lines?.[0]?.text === "line", JSON.stringify(first.result));
    assert(first.bodies[0].response_format === undefined, "response_format must never be sent to Kimi");
    assert(
      /single valid JSON object/.test(String(first.bodies[0].messages[0]?.content || "")),
      "JSON must be demanded in the prompt instead"
    );
    assert(first.bodies[0].max_tokens === 16000, `the allowance must survive: ${first.bodies[0].max_tokens}`);
  });

  check("a successful prompt-enforced response does NOT imply native JSON support", () => {
    const caps = modelCapabilities("nvidia", MODEL_IDS.nvidia.kimi);
    assert(
      caps.supportsNativeJsonObject === false && caps.supportsNativeJsonSchema === false,
      "the registry must not be upgraded by a prompt-enforced success"
    );
  });

  const repaired = await run(["I'll help! " + valid], { validate: validateScriptShape });
  check("surrounding prose is stripped when a complete object can be isolated", () => {
    assert(repaired.error === undefined, `unexpected error: ${repaired.error?.message}`);
    assert(repaired.result?.segments?.length === 1, JSON.stringify(repaired.result));
  });

  const truncated = await run(['{"segments":[{"lines":[{"text":"half a mov'], { validate: validateScriptShape });
  check("truncated movement data is rejected, then one repair is attempted", () => {
    assert(truncated.error !== undefined, "truncated JSON must not be accepted");
    assert(
      truncated.error.category === "structured_output_invalid_after_repair",
      `expected structured_output_invalid_after_repair, got ${truncated.error.category}`
    );
    assert(truncated.bodies.length === 2, `expected exactly one repair attempt, saw ${truncated.bodies.length} calls`);
  });

  const emptyLines = await run(['{"segments":[{"type":"topic","lines":[]}]}'], { validate: validateScriptShape });
  check("a movement with no lines is rejected by the application validator", () => {
    assert(emptyLines.error !== undefined, "an empty movement must not be accepted");
  });

  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

function registryCorrectionChecks(): void {
  console.log("\nRegistry corrections:");

  check("DeepSeek V4 Flash is a reasoning model (the old record said otherwise)", () => {
    const flash = modelCapabilities("nvidia", MODEL_IDS.nvidia.deepseekFlash);
    assert(flash.supportsThinking === true, "Flash must be declared thinking-capable");
    assert(flash.supportsReasoningEffort === true, "Flash takes a nested reasoning_effort");
    assert(flash.requestParameterProfile === "deepseek-v4", flash.requestParameterProfile);
  });

  check("Kimi K2.6 declares no native structured output and no reasoning", () => {
    const kimi = modelCapabilities("nvidia", MODEL_IDS.nvidia.kimi);
    assert(kimi.supportsNativeJsonObject === false, "no native json_object");
    assert(kimi.supportsNativeJsonSchema === false, "no native json_schema");
    assert(kimi.supportsThinking === false, "no reasoning");
    assert(kimi.supportsPromptEnforcedJson === true, "prompt-enforced JSON is how Kimi returns structure");
  });

  // The live probe run of 2026-07-26 (artifacts/nvidia-contract-report.json).
  // These assertions pin what was ACTUALLY observed, so a future edit that
  // upgrades a record without a probe to justify it fails here.
  check("the registry matches the live probe: 4 verified, 2 unreachable", () => {
    const verified = [
      MODEL_IDS.nvidia.deepseekPro,
      MODEL_IDS.nvidia.nemotron,
      MODEL_IDS.nvidia.glm,
      MODEL_IDS.nvidia.mistral,
    ];
    for (const model of verified) {
      const caps = modelCapabilities("nvidia", model);
      assert(caps.catalogVerified === true, `${model}: should be catalog verified`);
      assert(caps.liveContractVerified === true, `${model}: answered the live probe`);
      assert(
        caps.maximumOutputTokens === undefined,
        `${model}: being callable does NOT establish an output ceiling — the enforceable cap must stay unknown`
      );
    }

    // 503 ResourceExhausted (worker 48/48) — capacity, not capability. Catalog
    // stands; nothing else may be concluded.
    const flash = modelCapabilities("nvidia", MODEL_IDS.nvidia.deepseekFlash);
    assert(flash.catalogVerified === true, "deepseek flash: a 503 does not invalidate the catalog entry");
    assert(flash.liveContractVerified === false, "deepseek flash: never answered, so not live-verified");

    // 404 "Not found for account" — the id does not resolve for this key.
    const kimi = modelCapabilities("nvidia", MODEL_IDS.nvidia.kimi);
    assert(kimi.catalogVerified === false, "kimi: 404 for this account means catalog-unavailable, not assumed present");
    assert(kimi.liveContractVerified === false, "kimi: never answered");
  });

  check("probe findings that contradict the docs are recorded per model", () => {
    // reasoning_budget: Nemotron yes, DeepSeek and GLM no — observed 400s.
    assert(modelCapabilities("nvidia", MODEL_IDS.nvidia.nemotron).supportsReasoningBudget === true, "nemotron budget");
    assert(modelCapabilities("nvidia", MODEL_IDS.nvidia.deepseekPro).supportsReasoningBudget === false, "deepseek budget");
    assert(modelCapabilities("nvidia", MODEL_IDS.nvidia.glm).supportsReasoningBudget === false, "glm budget");

    // Mistral accepted a `thinking` object but returned NO reasoning content, so
    // an accepted-but-inert field must not read as a thinking mode.
    const mistral = modelCapabilities("nvidia", MODEL_IDS.nvidia.mistral);
    assert(
      mistral.supportsThinking === false,
      "mistral: acceptance without observed reasoning output is not evidence of a thinking mode"
    );
    assert(/chat_template is not supported/.test(mistral.provenance.requestFields), "mistral: record the 400 we observed");
    assert(/latency|30-88s|s for/i.test(mistral.provenance.requestFields + mistral.provenance.limits), "mistral: record the latency");

    // Native JSON was observed working on all four reachable models.
    for (const model of [MODEL_IDS.nvidia.deepseekPro, MODEL_IDS.nvidia.nemotron, MODEL_IDS.nvidia.glm, MODEL_IDS.nvidia.mistral]) {
      const caps = modelCapabilities("nvidia", model);
      assert(caps.supportsNativeJsonObject === true, `${model}: json_object was observed working`);
      assert(caps.supportsNativeJsonSchema === true, `${model}: json_schema was observed working`);
    }
  });

  check("Z.ai flags were NOT upgraded from acceptance on a lenient endpoint", () => {
    // Z.ai returned 200 for chat_template_kwargs — an NVIDIA-only field — so it
    // does not validate unknown parameters and a 200 there proves nothing.
    const zai = modelCapabilities("zai", MODEL_IDS.zai.glmFlash);
    assert(zai.liveContractVerified === true, "zai answered a live request");
    assert(zai.supportsNativeJsonObject === false, "zai: acceptance on a lenient endpoint is not evidence");
    assert(zai.supportsNativeJsonSchema === false, "zai: acceptance on a lenient endpoint is not evidence");
    assert(zai.supportsReasoningBudget === false, "zai: it accepted Nemotron's field too — that is leniency, not support");
    assert(zai.supportsSeed === false, "zai: not upgraded from a bare 200");
    // Confirmed by OUTPUT, not acceptance: reasoning_content came back.
    assert(zai.supportsThinking === true, "zai: reasoning_content was observed in the response");
    assert(
      /reasons by default|EMPTY/i.test(zai.provenance.limits),
      "zai: the empty-answer / reasons-by-default finding must be recorded"
    );
  });
}

async function main(): Promise<void> {
  console.log("NVIDIA NIM provider — hosted trial endpoint, active development primary.");

  const { passed, failed } = await runProviderContract(
    {
      provider: "nvidia",
      displayName: "NVIDIA NIM",
      host: "integrate.api.nvidia.com",
      apiKeyVar: "NVIDIA_API_KEY",
      baseUrlVar: "NVIDIA_BASE_URL",
      // The frontier dialogue primary — the most quality-critical assignment.
      model: MODEL_IDS.nvidia.mistral,
      build: (model?: string) => new NvidiaNimLLMProvider(model),
      env: NV_ENV,
      expectCatalogVerified: true,
      expectLiveContractVerified: true,
      assertRequestShape: SHAPE_ASSERTIONS[MODEL_IDS.nvidia.mistral],
    },
    { live: LIVE }
  );

  await perModelShapeChecks();
  await kimiStructuredChecks();
  nemotronBudgetChecks();
  registryCorrectionChecks();

  console.log(`\n${passed + extraPassed} passed, ${failed + extraFailed} failed`);
  if (!LIVE) {
    console.log(
      "NOTE: every request above was MOCKED. These tests prove the request SHAPES match NVIDIA's documented examples;\n" +
        "they do NOT prove the hosted endpoint accepts them. No model here is liveContractVerified. Run\n" +
        "`npm run probe:llm-contract -- --provider nvidia` with a real NVIDIA_API_KEY to establish that."
    );
  }
  if (failed + extraFailed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("NVIDIA provider test harness failed:", err);
  process.exit(1);
});
