// Shared contract harness for the OpenAI-compatible providers (NVIDIA, Z.ai).
//
// Both providers extend the same base class, so both must satisfy the same
// contract. Writing it once means a fix or a regression is caught for both
// rather than for whichever provider someone remembered to update.
//
// Every request here is MOCKED. The live probe at the bottom is opt-in (--live)
// and runs only when a real credential is present, because a suite that
// silently skips a live check and still prints "passed" is how "we tested it
// against the real API" becomes untrue.

import { LLMProvider } from "../lib/providers/llm/interface";
import { LlmProviderError } from "../lib/providers/llm/errors";
import { StructuredOutputError } from "../lib/providers/llm/structured";
import { modelCapabilities } from "../lib/providers/llm/capabilities";
import { llmCostMark, llmCostSince } from "../lib/providers/llm/costLedger";

export interface HarnessConfig {
  /** "nvidia" | "zai" */
  provider: string;
  /** Human name for the header line. */
  displayName: string;
  /** Hostname substring that identifies this provider's endpoint. */
  host: string;
  /** Credential variable. */
  apiKeyVar: string;
  /** Base-URL variable. */
  baseUrlVar: string;
  /** A model id from the routing profiles. */
  model: string;
  /** Build the provider. Reads env at construction time. */
  build: (model?: string) => LLMProvider;
  /** Extra env this provider needs for the mocked tests. */
  env: Record<string, string>;
  /** Whether this model's ID was confirmed against the official catalog. */
  expectCatalogVerified: boolean;
  /**
   * Model-specific request assertions. Given the body of a structured call with
   * reasoning ON and with reasoning OFF, throw if the shape is wrong. This is
   * where "Nemotron must use enable_thinking, not thinking" is enforced.
   */
  assertRequestShape?: (bodies: { reasoningOn: any; reasoningOff: any }) => void;
}

interface Captured {
  url: string;
  body: any;
  headers: Record<string, string>;
}

export interface HarnessResult {
  passed: number;
  failed: number;
}

const realFetch = globalThis.fetch;

export async function runProviderContract(cfg: HarnessConfig, opts: { live: boolean }): Promise<HarnessResult> {
  let passed = 0;
  let failed = 0;

  const assert = (c: boolean, m: string) => {
    if (!c) throw new Error(m);
  };
  const ok = (n: string) => {
    passed++;
    console.log(`  ✓ ${n}`);
  };
  const bad = (n: string, e: unknown) => {
    failed++;
    console.error(`  ✗ ${n}\n      ${(e as Error)?.message || e}`);
  };
  const checkAsync = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      ok(name);
    } catch (e) {
      bad(name, e);
    }
  };

  // ---------------------------------------------------------------- env + mock

  const TEST_KEY = `${cfg.provider}-test-credential-abcdef0123456789`;
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (vars: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in savedEnv)) savedEnv[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  // Retries disabled so the suite never sits in a backoff sleep; the retry
  // BEHAVIOUR gets its own test that raises the count deliberately.
  setEnv({ [cfg.apiKeyVar]: TEST_KEY, ...cfg.env });

  let captured: Captured[] = [];
  const mock = (handler: (body: any, call: number) => Response | Promise<Response> | never) => {
    captured = [];
    let call = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      captured.push({ url, body, headers: (init?.headers || {}) as Record<string, string> });
      return handler(body, call++);
    }) as typeof fetch;
  };
  const json = (payload: any, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json", ...headers } });
  const chat = (content: string, extra: { reasoning?: string; finish?: string; usage?: any } = {}) =>
    json({
      choices: [
        {
          finish_reason: extra.finish ?? "stop",
          message: { role: "assistant", content, ...(extra.reasoning ? { reasoning_content: extra.reasoning } : {}) },
        },
      ],
      usage: extra.usage ?? {
        prompt_tokens: 120,
        completion_tokens: 80,
        completion_tokens_details: { reasoning_tokens: 33 },
      },
    });

  console.log(`\n${cfg.displayName} provider contract (mocked transport):`);

  // ---------------------------------------------------------------- basics

  await checkAsync("posts to the chat-completions endpoint beneath the configured base URL", async () => {
    mock(() => chat("hello"));
    const p = cfg.build(cfg.model);
    await p.generateText({ prompt: "hi" });
    assert(captured.length === 1, `expected 1 request, got ${captured.length}`);
    assert(captured[0].url.includes(cfg.host), `wrong host: ${captured[0].url}`);
    assert(captured[0].url.endsWith("/chat/completions"), `wrong path: ${captured[0].url}`);
  });

  await checkAsync("a trailing slash on the base URL does not double up the path", async () => {
    setEnv({ [cfg.baseUrlVar]: `${cfg.env[cfg.baseUrlVar] ?? process.env[cfg.baseUrlVar] ?? ""}` });
    mock(() => chat("hello"));
    const original = process.env[cfg.baseUrlVar];
    setEnv({ [cfg.baseUrlVar]: `${original}///` });
    try {
      await cfg.build(cfg.model).generateText({ prompt: "hi" });
      assert(!captured[0].url.includes("//chat"), `path was mangled: ${captured[0].url}`);
      assert(captured[0].url.endsWith("/chat/completions"), captured[0].url);
    } finally {
      setEnv({ [cfg.baseUrlVar]: original });
    }
  });

  await checkAsync("records the call under its OWN provider name, never as openai", async () => {
    mock(() => chat("hi"));
    const mark = llmCostMark();
    await cfg.build(cfg.model).generateText({ prompt: "hi" });
    const stages = llmCostSince(mark).stages;
    const models = stages.flatMap((s) => s.models);
    assert(
      models.some((m) => m === `${cfg.provider}/${cfg.model}`),
      `expected ${cfg.provider}/${cfg.model} in the ledger, got ${models.join(", ")}`
    );
    assert(!models.some((m) => m.startsWith("openai/")), "the call was recorded as OpenAI");
    assert(stages.some((s) => s.tkReasoning === 33), "provider-reported reasoning tokens were not recorded");
    assert(
      stages.every((s) => s.estimatedCostUsd === null),
      "a free trial endpoint must report null cost, never a fabricated figure"
    );
  });

  await checkAsync("text output parses", async () => {
    mock(() => chat("The Foxes are 3-1."));
    assert((await cfg.build(cfg.model).generateText({ prompt: "x" })) === "The Foxes are 3-1.", "wrong text");
  });

  await checkAsync("content returned as an array of parts parses", async () => {
    mock(() =>
      json({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "part-ok" }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })
    );
    assert((await cfg.build(cfg.model).generateText({ prompt: "x" })) === "part-ok", "array content not handled");
  });

  await checkAsync("structured output parses", async () => {
    mock(() => chat('{"segments":[{"lines":[{"text":"a"}]}]}'));
    const res = await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x" });
    assert(res.segments[0].lines[0].text === "a", JSON.stringify(res));
  });

  await checkAsync("structured output survives markdown fences and surrounding prose", async () => {
    mock(() => chat('Sure! Here you go:\n```json\n{"ok":true}\n```\nLet me know.'));
    const res = await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x" });
    assert(res.ok === true, JSON.stringify(res));
  });

  // ---------------------------------------------------------------- reasoning

  await checkAsync("reasoning content NEVER reaches text output", async () => {
    const secretThought = "INTERNAL_CHAIN_OF_THOUGHT_MARKER";
    mock(() => chat("Clean spoken line.", { reasoning: secretThought }));
    const out = await cfg.build(cfg.model).generateText({ prompt: "x", reasoning: "on" });
    assert(!out.includes(secretThought), "reasoning leaked into the returned text");
    assert(out === "Clean spoken line.", `unexpected text: ${out}`);
  });

  await checkAsync("reasoning content NEVER reaches structured/script output or TTS input", async () => {
    const secretThought = "INTERNAL_CHAIN_OF_THOUGHT_MARKER";
    mock(() =>
      chat('{"segments":[{"lines":[{"text":"Spoken words only.","speakerName":"Zabala"}]}]}', { reasoning: secretThought })
    );
    const res = await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", reasoning: "on" });
    const serialized = JSON.stringify(res);
    assert(!serialized.includes(secretThought), "reasoning leaked into structured output");
    // The line text is what the TTS layer synthesizes — assert on it directly.
    const ttsInput = res.segments[0].lines[0].text;
    assert(!ttsInput.includes(secretThought), "reasoning leaked into the text that would be spoken");
    assert(ttsInput === "Spoken words only.", ttsInput);
  });

  await checkAsync("an empty answer after reasoning is a clear failure, not an empty success", async () => {
    mock(() => chat("", { reasoning: "thought a lot", finish: "length" }));
    let err: any = null;
    try {
      await cfg.build(cfg.model).generateText({ prompt: "x", reasoning: "on" });
    } catch (e) {
      err = e;
    }
    assert(err instanceof LlmProviderError, `expected LlmProviderError, got ${err}`);
    assert(err.category === "output_limit", `expected output_limit, got ${err.category}`);
    assert(/reasoning/i.test(err.message), `the message must explain what happened: ${err.message}`);
  });

  // ---------------------------------------------------------------- limits

  await checkAsync("a 16,000-token request leaves as 16,000", async () => {
    mock(() => chat('{"segments":[{"lines":[{"text":"a"}]}]}'));
    await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", maxTokens: 16000 });
    assert(captured[0].body.max_tokens === 16000, `max_tokens was changed to ${captured[0].body.max_tokens}`);
  });

  await checkAsync("catalog verification and LIVE verification are separate claims", async () => {
    const caps = modelCapabilities(cfg.provider, cfg.model);
    assert(caps.provider === cfg.provider, `capability record has the wrong provider: ${caps.provider}`);
    assert(
      caps.catalogVerified === cfg.expectCatalogVerified,
      `catalogVerified should be ${cfg.expectCatalogVerified} for ${cfg.model}, got ${caps.catalogVerified}`
    );
    // Nothing in this repository has called these endpoints yet.
    assert(
      caps.liveContractVerified === false,
      "liveContractVerified must stay false until a live probe actually succeeds"
    );
    assert(
      caps.maximumOutputTokens === undefined,
      "an ENFORCEABLE output cap must be unknown until probed — a model-card figure belongs in documentedMaximumOutputTokens"
    );
    assert(caps.unpriced === true, "a free trial endpoint must be marked unpriced");
    assert(
      caps.provenance.limits.length > 20,
      "every record must say where its limit claim came from"
    );
  });

  // ---------------------------------------------------------------- structured failures

  await checkAsync("invalid JSON triggers exactly ONE repair request", async () => {
    mock((_body, call) => (call === 0 ? chat("this is not json at all") : chat('{"repaired":true}')));
    const res = await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "original prompt" });
    assert(res.repaired === true, JSON.stringify(res));
    assert(captured.length === 2, `expected exactly 2 requests (original + one repair), got ${captured.length}`);
    const repairPrompt = String(captured[1].body.messages.at(-1).content);
    assert(repairPrompt.includes("original prompt"), "the repair must resend the original prompt");
    assert(repairPrompt.includes("STRUCTURED OUTPUT REPAIR"), "the repair must state what went wrong");
  });

  await checkAsync("a failed repair reports both failures and does NOT retry again", async () => {
    mock(() => chat("still not json"));
    let err: any = null;
    try {
      await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x" });
    } catch (e) {
      err = e;
    }
    assert(err instanceof LlmProviderError, `expected LlmProviderError, got ${err?.name}`);
    assert(err.category === "structured_output_invalid_after_repair", err.category);
    assert(/repair attempt also failed/.test(err.message), err.message);
    assert(captured.length === 2, `expected 2 requests, got ${captured.length}`);
  });

  await checkAsync("truncated JSON is REJECTED, never patched", async () => {
    // Balanced-looking prefix, cut off mid-structure.
    mock(() => chat('{"segments":[{"lines":[{"text":"half a movem'));
    let err: any = null;
    try {
      // Repair disabled so the raw classification is visible.
      process.env.LLM_STRUCTURED_REPAIR_ENABLED = "false";
      await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x" });
    } catch (e) {
      err = e;
    } finally {
      delete process.env.LLM_STRUCTURED_REPAIR_ENABLED;
    }
    assert(err instanceof StructuredOutputError, `expected StructuredOutputError, got ${err?.name}`);
    assert(err.kind === "truncated_json", `expected truncated_json, got ${err.kind}`);
    assert(/TRUNCATED/.test(err.message), err.message);
  });

  await checkAsync("an empty object is rejected — never returned as success", async () => {
    mock(() => chat("{}"));
    let err: any = null;
    try {
      process.env.LLM_STRUCTURED_REPAIR_ENABLED = "false";
      await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x" });
    } catch (e) {
      err = e;
    } finally {
      delete process.env.LLM_STRUCTURED_REPAIR_ENABLED;
    }
    assert(err?.kind === "empty_object", `expected empty_object, got ${err?.kind}: ${err?.message}`);
  });

  await checkAsync("a missing required array from the caller's schema is rejected", async () => {
    mock(() => chat('{"status":"passed"}'));
    let err: any = null;
    try {
      process.env.LLM_STRUCTURED_REPAIR_ENABLED = "false";
      await cfg.build(cfg.model).generateStructuredOutput<any>({
        prompt: "x",
        jsonSchema: {
          type: "object",
          properties: { status: { type: "string" }, lineResults: { type: "array" } },
          required: ["status", "lineResults"],
        },
      });
    } catch (e) {
      err = e;
    } finally {
      delete process.env.LLM_STRUCTURED_REPAIR_ENABLED;
    }
    assert(err?.kind === "schema_violation", `expected schema_violation, got ${err?.kind}`);
    assert(/lineResults/.test(err.message), err.message);
  });

  await checkAsync("a movement with no lines is rejected by the caller's validator", async () => {
    mock(() => chat('{"segments":[{"type":"topic","lines":[]}]}'));
    let err: any = null;
    try {
      process.env.LLM_STRUCTURED_REPAIR_ENABLED = "false";
      const { validateScriptShape } = await import("../lib/services/scriptOutlineEngine");
      await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", validate: validateScriptShape });
    } catch (e) {
      err = e;
    } finally {
      delete process.env.LLM_STRUCTURED_REPAIR_ENABLED;
    }
    assert(err?.kind === "schema_violation", `expected schema_violation, got ${err?.kind}: ${err?.message}`);
    assert(/no lines/.test(err.message), err.message);
  });

  await checkAsync("a script missing its segments array is rejected", async () => {
    mock(() => chat('{"stateAfter":{"emotionalTemperature":"hot"}}'));
    let err: any = null;
    try {
      process.env.LLM_STRUCTURED_REPAIR_ENABLED = "false";
      const { validateScriptShape } = await import("../lib/services/scriptOutlineEngine");
      await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", validate: validateScriptShape });
    } catch (e) {
      err = e;
    } finally {
      delete process.env.LLM_STRUCTURED_REPAIR_ENABLED;
    }
    assert(/segments/.test(err?.message || ""), err?.message);
  });

  // ---------------------------------------------------------------- retries

  await checkAsync("a 503 is retried and then succeeds", async () => {
    setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "2" });
    mock((_b, call) => (call === 0 ? json({ error: "unavailable" }, 503) : chat("recovered")));
    try {
      assert((await cfg.build(cfg.model).generateText({ prompt: "x" })) === "recovered", "did not recover");
      assert(captured.length === 2, `expected 2 attempts, got ${captured.length}`);
    } finally {
      setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "0" });
    }
  });

  await checkAsync("a 401 is NOT retried and is classified as an auth failure", async () => {
    setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "2" });
    mock(() => json({ error: "invalid api key" }, 401));
    let err: any = null;
    try {
      await cfg.build(cfg.model).generateText({ prompt: "x" });
    } catch (e) {
      err = e;
    } finally {
      setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "0" });
    }
    assert(err?.category === "authentication_failed", `expected authentication_failed, got ${err?.category}`);
    assert(captured.length === 1, `an auth failure must not be retried; saw ${captured.length} attempts`);
  });

  await checkAsync("an unknown model id is classified, not retried", async () => {
    setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "2" });
    mock(() => json({ error: { message: "model does not exist" } }, 404));
    let err: any = null;
    try {
      await cfg.build("vendor/not-a-real-model").generateText({ prompt: "x" });
    } catch (e) {
      err = e;
    } finally {
      setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "0" });
    }
    assert(err?.category === "invalid_model", `expected invalid_model, got ${err?.category}`);
    assert(captured.length === 1, `expected no retry, saw ${captured.length}`);
  });

  await checkAsync("a hard quota 429 is classified as quota_exhausted, not a rate limit", async () => {
    setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "2" });
    mock(() => json({ error: "you have exceeded your current quota / credit balance" }, 429));
    let err: any = null;
    try {
      await cfg.build(cfg.model).generateText({ prompt: "x" });
    } catch (e) {
      err = e;
    } finally {
      setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "0" });
    }
    assert(err?.category === "quota_exhausted", `expected quota_exhausted, got ${err?.category}`);
    assert(captured.length === 1, `an exhausted quota must not be retried; saw ${captured.length}`);
  });

  await checkAsync("Retry-After is honored on a rate-limit 429", async () => {
    setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "1" });
    mock((_b, call) => (call === 0 ? json({ error: "slow down" }, 429, { "retry-after": "1" }) : chat("ok")));
    const startedAt = Date.now();
    try {
      assert((await cfg.build(cfg.model).generateText({ prompt: "x" })) === "ok", "did not recover");
      const waited = Date.now() - startedAt;
      assert(waited >= 900, `expected to wait ~1s for Retry-After, waited ${waited}ms`);
    } finally {
      setEnv({ [`${cfg.provider.toUpperCase()}_MAX_RETRIES`]: "0" });
    }
  });

  await checkAsync("a request timeout aborts and is reported as such", async () => {
    setEnv({ [`${cfg.provider.toUpperCase()}_REQUEST_TIMEOUT_MS`]: "60" });
    globalThis.fetch = (async (_i: any, init?: any) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted.");
          e.name = "AbortError";
          reject(e);
        });
      })) as typeof fetch;
    let err: any = null;
    try {
      await cfg.build(cfg.model).generateText({ prompt: "x" });
    } catch (e) {
      err = e;
    } finally {
      setEnv({ [`${cfg.provider.toUpperCase()}_REQUEST_TIMEOUT_MS`]: cfg.env[`${cfg.provider.toUpperCase()}_REQUEST_TIMEOUT_MS`] });
    }
    assert(err instanceof LlmProviderError, `expected LlmProviderError, got ${err?.name}`);
    assert(/timed out after 60ms/.test(err.message), err.message);
  });

  // ---------------------------------------------------------------- credentials

  await checkAsync("a missing credential is a clear, actionable error naming the variable", async () => {
    setEnv({ [cfg.apiKeyVar]: undefined });
    let err: any = null;
    try {
      cfg.build(cfg.model);
    } catch (e) {
      err = e;
    } finally {
      setEnv({ [cfg.apiKeyVar]: TEST_KEY });
    }
    assert(err?.category === "missing_api_key", `expected missing_api_key, got ${err?.category}`);
    assert(err.message.includes(cfg.apiKeyVar), `must name ${cfg.apiKeyVar}: ${err.message}`);
  });

  await checkAsync("a placeholder credential is rejected like a missing one", async () => {
    setEnv({ [cfg.apiKeyVar]: "SET_IN_SECRET_MANAGER" });
    let err: any = null;
    try {
      cfg.build(cfg.model);
    } catch (e) {
      err = e;
    } finally {
      setEnv({ [cfg.apiKeyVar]: TEST_KEY });
    }
    assert(err?.category === "missing_api_key", `expected missing_api_key, got ${err?.category}`);
    assert(/placeholder/.test(err.message), err.message);
  });

  await checkAsync("the credential never appears in an error message", async () => {
    // Worst case: the provider echoes the key back inside its own error body.
    mock(() => json({ error: `bad key: ${TEST_KEY}` }, 400));
    let message = "";
    try {
      await cfg.build(cfg.model).generateText({ prompt: "x" });
    } catch (e: any) {
      message = e.message;
    }
    assert(message.length > 0, "expected an error");
    assert(!message.includes(TEST_KEY), `the credential leaked into the error: ${message}`);
    assert(message.includes("[REDACTED]"), `expected redaction, got: ${message}`);
  });

  await checkAsync("the credential is sent as a bearer token and nowhere else", async () => {
    mock(() => chat("ok"));
    await cfg.build(cfg.model).generateText({ prompt: "x" });
    const headers = captured[0].headers;
    assert(headers.Authorization === `Bearer ${TEST_KEY}`, "the Authorization header is wrong");
    assert(!JSON.stringify(captured[0].body).includes(TEST_KEY), "the credential was placed in the request body");
    assert(!captured[0].url.includes(TEST_KEY), "the credential was placed in the URL");
  });

  // ---------------------------------------------------------------- downgrade

  await checkAsync("a 400 that NAMES a field narrows the request once and re-sends", async () => {
    // Find a field this model actually sends, rather than assuming response_format
    // (which is deliberately NOT sent to models whose native support is unconfirmed).
    mock(() => chat('{"ok":true}'));
    await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", reasoning: "on" });
    const field = ["chat_template_kwargs", "thinking", "reasoning_effort", "reasoning_budget", "response_format"].find(
      (f) => captured[0].body[f] !== undefined
    );
    if (!field) {
      // Kimi sends no optional fields at all — nothing to downgrade, which is
      // itself the correct behavior and is asserted by the shape test.
      console.log(`      (skipped: ${cfg.model} sends no downgradeable field, which is correct for it)`);
      return;
    }
    mock((body, call) => {
      if (call === 0) return json({ error: `${field} is not supported for this model` }, 400);
      assert(body[field] === undefined, `the retry must have dropped '${field}'`);
      return chat('{"ok":true}');
    });
    const res = await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", reasoning: "on" });
    assert(res.ok === true, JSON.stringify(res));
    assert(captured.length === 2, `expected 2 requests, got ${captured.length}`);
  });

  await checkAsync("an AMBIGUOUS 400 strips nothing and does not retry", async () => {
    mock(() => json({ error: "unsupported parameter in request" }, 400));
    let err: any = null;
    try {
      await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", reasoning: "on" });
    } catch (e) {
      err = e;
    }
    assert(err?.category === "unsupported_parameter", `expected unsupported_parameter, got ${err?.category}`);
    assert(
      captured.length === 1,
      `an ambiguous 400 must not license guessing which field to strip; saw ${captured.length} attempts`
    );
  });

  await checkAsync("reasoning=off never sends an enabled reasoning flag", async () => {
    mock(() => chat("ok"));
    await cfg.build(cfg.model).generateText({ prompt: "x", reasoning: "off" });
    const body = captured[0].body;
    const enabled =
      body.chat_template_kwargs?.thinking === true ||
      body.chat_template_kwargs?.enable_thinking === true ||
      body.thinking?.type === "enabled" ||
      body.reasoning_effort !== undefined;
    assert(!enabled, `reasoning was enabled when the role asked for it off: ${JSON.stringify(body)}`);
  });

  await checkAsync("model-specific request shape is correct for this exact model", async () => {
    if (!cfg.assertRequestShape) {
      throw new Error(`no assertRequestShape supplied for ${cfg.model} — every probed model needs one`);
    }
    mock(() => chat('{"ok":true}'));
    await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", reasoning: "on", maxTokens: 4000 });
    const reasoningOn = captured[0].body;
    mock(() => chat('{"ok":true}'));
    await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x", reasoning: "off", maxTokens: 4000 });
    const reasoningOff = captured[0].body;
    cfg.assertRequestShape({ reasoningOn, reasoningOff });
  });

  await checkAsync("structured output uses the mode this model actually supports", async () => {
    const caps = modelCapabilities(cfg.provider, cfg.model);
    mock(() => chat('{"ok":true}'));
    await cfg.build(cfg.model).generateStructuredOutput<any>({ prompt: "x" });
    const rf = captured[0].body.response_format;
    if (caps.supportsNativeJsonSchema || caps.supportsNativeJsonObject) {
      assert(rf !== undefined, "a model with native JSON support should have been sent response_format");
    } else {
      assert(
        rf === undefined,
        `response_format must NOT be sent to a model whose native support is unconfirmed: ${JSON.stringify(rf)}`
      );
      const system = String(captured[0].body.messages[0]?.content || "");
      assert(
        /single valid JSON object/.test(system),
        "prompt-enforced mode must carry the JSON instruction in the system message"
      );
    }
  });

  // ---------------------------------------------------------------- live probe

  globalThis.fetch = realFetch;

  const liveKey = savedEnv[cfg.apiKeyVar];
  if (!opts.live) {
    console.log(`  – live probe SKIPPED (pass --live to run it against the real ${cfg.displayName} API)`);
  } else if (!liveKey || liveKey.trim().length < 8) {
    console.log(`  – live probe SKIPPED: ${cfg.apiKeyVar} is not set. Nothing was verified against the real API.`);
  } else {
    restoreEnv();
    await checkAsync(`LIVE: ${cfg.model} returns parseable structured output`, async () => {
      const p = cfg.build(cfg.model);
      const res = await p.generateStructuredOutput<any>({
        prompt: 'Return exactly {"ready": true} and nothing else.',
        systemPrompt: "You return only JSON.",
        temperature: 0,
        maxTokens: 200,
      });
      assert(res && typeof res === "object", `expected an object, got ${JSON.stringify(res)}`);
      console.log(`      live response: ${JSON.stringify(res).slice(0, 200)}`);
    });
    await checkAsync(`LIVE: ${cfg.model} honors a large output allowance`, async () => {
      const p = cfg.build(cfg.model);
      const out = await p.generateText({
        prompt: "Write one short sentence about a coordinator's contract option.",
        maxTokens: 16000,
        temperature: 0,
      });
      assert(out.trim().length > 0, "empty response");
      console.log(`      live text: ${out.slice(0, 120)}`);
    });
  }

  restoreEnv();
  globalThis.fetch = realFetch;
  return { passed, failed };
}
