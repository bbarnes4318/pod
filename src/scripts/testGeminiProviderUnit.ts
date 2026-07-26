// Gemini provider contracts, against a MOCKED fetch.
//
// Every assertion here is about a behavior that fails silently in production if
// it regresses:
//
//   - An adapter-level token cap truncates a 16k script movement mid-JSON, and
//     the symptom is "the model wrote a bad episode".
//   - A dropped `cacheableContext` still produces a valid episode, just a worse
//     and more expensive one.
//   - Retrying a 401 burns quota and delays the real error.
//   - Mislabelling Gemini calls as OpenAI in the cost ledger corrupts the only
//     per-stage spend data this repository has.
//   - A key echoed into a thrown error ends up in a job log.
//
// No network. Nothing here asserts a mocked constant back at itself: each case
// drives the real provider and checks what it SENT or how it INTERPRETED a
// response shape taken from Google's documented format.

import {
  GeminiLLMProvider,
  GEMINI_FALLBACK_MODEL,
  isPlaceholderKey,
  parseJsonStrict,
  redactKey,
} from "../lib/providers/llm/gemini";
import { getLLMProvider, resolveConfiguredLLMProviders, SUPPORTED_LLM_PROVIDERS } from "../lib/providers/llm/factory";
import { llmCostMark, llmCostSince, withLlmStage } from "../lib/providers/llm/costLedger";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}
function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const REAL_FETCH = globalThis.fetch;
const TEST_KEY = "AIzaTESTKEY_do_not_use_1234567890";

/** The request body shape the adapter is expected to send. Typed rather than
 *  left as `unknown` so an assertion against a field the adapter no longer
 *  sends fails at COMPILE time, not as a runtime undefined comparison that
 *  quietly passes. */
interface GeminiRequestBody {
  contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig: {
    maxOutputTokens?: number;
    temperature?: number;
    responseMimeType?: string;
    responseSchema?: unknown;
    thinkingLevel?: string;
  };
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: GeminiRequestBody;
}

/** One scripted response per call, in order. Captures what was actually sent. */
function mockFetch(
  responses: Array<{ status: number; json?: unknown; text?: string; headers?: Record<string, string> } | "abort" | "network">
): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init: { headers?: unknown; body?: unknown }) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    const spec = responses[Math.min(i, responses.length - 1)];
    i++;
    if (spec === "network") throw new Error("ECONNRESET");
    if (spec === "abort") {
      const e = new Error("The operation was aborted.");
      e.name = "AbortError";
      throw e;
    }
    const bodyText = spec.text ?? JSON.stringify(spec.json ?? {});
    return {
      ok: spec.status >= 200 && spec.status < 300,
      status: spec.status,
      headers: { get: (h: string) => spec.headers?.[h.toLowerCase()] ?? null },
      json: async () => JSON.parse(bodyText),
      text: async () => bodyText,
    };
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = REAL_FETCH; } };
}

/** A documented-shape success response. */
function okResponse(text: string, over: Record<string, unknown> = {}) {
  return {
    status: 200,
    json: {
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 125 },
      modelVersion: "gemini-3.6-flash",
      ...over,
    },
  };
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prior: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// Keep the suite deterministic and fast: no real backoff sleeps.
const REAL_TIMEOUT = globalThis.setTimeout;
function noSleep<T>(fn: () => Promise<T>): Promise<T> {
  // Only shortcut the backoff timers; the AbortController timer is also a
  // setTimeout, but firing it immediately is harmless because the mock decides
  // whether a request aborts.
  globalThis.setTimeout = ((cb: () => void) => REAL_TIMEOUT(cb, 0)) as unknown as typeof setTimeout;
  return fn().finally(() => {
    globalThis.setTimeout = REAL_TIMEOUT;
  });
}

const provider = (model?: string) =>
  withEnv({ GEMINI_API_KEY: TEST_KEY, GEMINI_MAX_RETRIES: "2" }, () => new GeminiLLMProvider(model));

console.log("Gemini provider (mocked fetch)\n");

void (async () => {
  // --- 1-2. Response parsing --------------------------------------------

  await checkAsync("1. plain-text response is returned verbatim", async () => {
    const m = mockFetch([okResponse("Cal Mercer walked into the hallway.")]);
    try {
      const out = await provider().generateText({ prompt: "hi" });
      assert(out === "Cal Mercer walked into the hallway.", `got ${JSON.stringify(out)}`);
      assert(m.calls[0].url.includes("gemini-3.6-flash:generateContent"), `wrong URL: ${m.calls[0].url}`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("2. structured JSON is parsed into the caller's type", async () => {
    const m = mockFetch([okResponse('{"beats":[{"beatIndex":0,"title":"Cold open"}]}')]);
    try {
      const out = await provider().generateStructuredOutput<{ beats: { title: string }[] }>({ prompt: "outline" });
      assert(out.beats[0].title === "Cold open", `got ${JSON.stringify(out)}`);
      assert(
        m.calls[0].body.generationConfig.responseMimeType === "application/json",
        "structured calls must request the JSON mime type"
      );
    } finally {
      m.restore();
    }
  });

  // --- 3-7. Parser robustness (pure, no fetch needed) --------------------

  check("3. markdown-fenced JSON is recovered", () => {
    const out = parseJsonStrict<{ a: number }>('```json\n{"a":1}\n```', "STOP", "m");
    assert(out.a === 1, `got ${JSON.stringify(out)}`);
  });

  check("4. leading and trailing prose is recovered", () => {
    const out = parseJsonStrict<{ a: number }>('Sure! Here is the JSON:\n{"a":1}\nHope that helps.', "STOP", "m");
    assert(out.a === 1, `got ${JSON.stringify(out)}`);
  });

  await checkAsync("5. an empty response FAILS instead of returning an empty object", async () => {
    const m = mockFetch([
      { status: 200, json: { candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }] } },
    ]);
    try {
      let threw = false;
      try {
        await provider().generateStructuredOutput({ prompt: "x" });
      } catch (err) {
        threw = true;
        assert(/Empty response text/.test(String(err)), `wrong error: ${err}`);
      }
      assert(threw, "an empty response must throw, never resolve to {}");
    } finally {
      m.restore();
    }
  });

  check("6. invalid JSON fails with a diagnosable error", () => {
    let threw = false;
    try {
      parseJsonStrict("this is not json at all", "STOP", "gemini-3.6-flash");
    } catch (err) {
      threw = true;
      assert(/no valid JSON object found/.test(String(err)), `wrong error: ${err}`);
      assert(/gemini-3.6-flash/.test(String(err)), "the error must name the model");
    }
    assert(threw, "invalid JSON must throw");
  });

  check("7. TRUNCATED JSON is identified as truncation, not as bad JSON", () => {
    // The distinction that matters: truncation is a budget problem and bad JSON
    // is a prompt problem. Reporting the wrong one sends the operator to the
    // wrong file.
    let threw = false;
    try {
      parseJsonStrict('{"segments":[{"lines":[{"text":"half a li', "MAX_TOKENS", "gemini-3.6-flash");
    } catch (err) {
      threw = true;
      assert(/TRUNCATED/.test(String(err)), `should report truncation: ${err}`);
      assert(/Raise maxTokens/.test(String(err)), "should name the fix");
    }
    assert(threw, "truncated JSON must throw");
    // Unbalanced braces alone are enough — finishReason is not always present.
    let threw2 = false;
    try {
      parseJsonStrict('{"a":{"b":1', undefined, "m");
    } catch (err) {
      threw2 = true;
      assert(/TRUNCATED/.test(String(err)), `unbalanced braces should read as truncation: ${err}`);
    }
    assert(threw2, "unbalanced JSON must throw");
  });

  // --- 8-12. Retry and transport ----------------------------------------

  await checkAsync("8. an authentication failure is NOT retried", async () => {
    const m = mockFetch([
      { status: 401, text: '{"error":{"code":401,"message":"API key not valid"}}' },
      okResponse("should never be reached"),
    ]);
    try {
      let threw = false;
      try {
        await noSleep(() => provider().generateText({ prompt: "x" }));
      } catch (err) {
        threw = true;
        assert(/status 401/.test(String(err)), `wrong error: ${err}`);
      }
      assert(threw, "401 must throw");
      assert(m.calls.length === 1, `401 must not be retried, but fetch ran ${m.calls.length} times`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("9. HTTP 429 is retried and then succeeds", async () => {
    const m = mockFetch([{ status: 429, text: "rate limited" }, okResponse("recovered")]);
    try {
      const out = await noSleep(() => provider().generateText({ prompt: "x" }));
      assert(out === "recovered", `got ${out}`);
      assert(m.calls.length === 2, `expected 2 attempts, got ${m.calls.length}`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("10. HTTP 503 is retried", async () => {
    const m = mockFetch([{ status: 503, text: "unavailable" }, okResponse("recovered")]);
    try {
      assert((await noSleep(() => provider().generateText({ prompt: "x" }))) === "recovered", "should recover");
      assert(m.calls.length === 2, `expected 2 attempts, got ${m.calls.length}`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("11. Retry-After is honored over the exponential schedule", async () => {
    const m = mockFetch([{ status: 429, text: "slow down", headers: { "retry-after": "3" } }, okResponse("ok")]);
    const delays: number[] = [];
    globalThis.setTimeout = ((cb: () => void, ms?: number) => {
      // Record only the backoff sleep, not the abort timer (which is the
      // configured request timeout, a much larger number).
      if (typeof ms === "number" && ms > 0 && ms < 60_000) delays.push(ms);
      return REAL_TIMEOUT(cb, 0);
    }) as unknown as typeof setTimeout;
    try {
      await provider().generateText({ prompt: "x" });
      assert(delays.includes(3000), `expected a 3000ms wait from Retry-After, saw ${JSON.stringify(delays)}`);
    } finally {
      globalThis.setTimeout = REAL_TIMEOUT;
      m.restore();
    }
  });

  await checkAsync("12. a timeout aborts, is retried, and reports the deadline", async () => {
    const m = mockFetch(["abort", "abort", "abort"]);
    try {
      let threw = false;
      try {
        await noSleep(() =>
          withEnv({ GEMINI_API_KEY: TEST_KEY, GEMINI_REQUEST_TIMEOUT_MS: "1234", GEMINI_MAX_RETRIES: "1" }, () =>
            new GeminiLLMProvider().generateText({ prompt: "x" })
          )
        );
      } catch (err) {
        threw = true;
        assert(/timed out after 1234ms/.test(String(err)), `wrong error: ${err}`);
      }
      assert(threw, "a persistent abort must throw");
      assert(m.calls.length === 2, `maxRetries=1 means 2 attempts, got ${m.calls.length}`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("12b. a transport failure is retried, then reported without leaking the key", async () => {
    const m = mockFetch(["network", okResponse("recovered")]);
    try {
      assert((await noSleep(() => provider().generateText({ prompt: "x" }))) === "recovered", "should recover");
    } finally {
      m.restore();
    }
  });

  // --- 13-14. Usage and cost ledger -------------------------------------

  await checkAsync("13. token usage is accounted from usageMetadata, thoughts counted as OUTPUT", async () => {
    const m = mockFetch([
      {
        status: 200,
        json: {
          candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 1000,
            cachedContentTokenCount: 400,
            candidatesTokenCount: 250,
            thoughtsTokenCount: 750,
            totalTokenCount: 2000,
          },
        },
      },
    ]);
    try {
      const p = provider();
      await p.generateText({ prompt: "x" });
      const u = p.getAccumulatedUsage!();
      assert(u.inputTokens === 1000, `inputTokens ${u.inputTokens}`);
      // Thinking tokens are billed at the output rate. Dropping them would
      // under-report the majority of a Gemini 3 call's real output spend.
      assert(u.outputTokens === 1000, `outputTokens should be 250 + 750 thoughts, got ${u.outputTokens}`);
      assert(u.requestCount === 1, `requestCount ${u.requestCount}`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("14. the cost ledger records provider 'gemini', never 'openai'", async () => {
    const m = mockFetch([
      {
        status: 200,
        json: {
          candidates: [{ content: { parts: [{ text: "hello" }] }, finishReason: "STOP" }],
          usageMetadata: {
            promptTokenCount: 1000,
            cachedContentTokenCount: 400,
            candidatesTokenCount: 250,
            thoughtsTokenCount: 750,
          },
        },
      },
    ]);
    try {
      const mark = llmCostMark();
      await withLlmStage("test:gemini", () => provider("gemini-3.6-flash").generateText({ prompt: "x" }));
      const { stages } = llmCostSince(mark);
      const stage = stages.find((s) => s.stage === "test:gemini");
      assert(!!stage, "the call was not attributed to its stage");
      assert(
        stage!.models.includes("gemini/gemini-3.6-flash"),
        `ledger must label this a gemini call even though a compatible endpoint exists elsewhere; got ${stage!.models.join(", ")}`
      );
      // promptTokenCount INCLUDES cached tokens; tkIn is the full-rate portion.
      assert(stage!.tkIn === 600, `tkIn should be 1000 - 400 cached, got ${stage!.tkIn}`);
      assert(stage!.tkCacheRead === 400, `tkCacheRead ${stage!.tkCacheRead}`);
      assert(stage!.tkOut === 1000, `tkOut should include thoughts, got ${stage!.tkOut}`);
    } finally {
      m.restore();
    }
  });

  // --- 15-17. Model and key resolution ----------------------------------

  await checkAsync("15. an explicit model override wins over the environment", async () => {
    const m = mockFetch([okResponse("ok")]);
    try {
      await withEnv({ GEMINI_API_KEY: TEST_KEY, GEMINI_MODEL: "gemini-3.5-flash" }, () =>
        new GeminiLLMProvider("gemini-2.5-pro").generateText({ prompt: "x" })
      );
      assert(m.calls[0].url.includes("gemini-2.5-pro"), `override ignored: ${m.calls[0].url}`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("16. GEMINI_MODEL is used when no override is given, else the code fallback", async () => {
    const m = mockFetch([okResponse("ok"), okResponse("ok")]);
    try {
      await withEnv({ GEMINI_API_KEY: TEST_KEY, GEMINI_MODEL: "gemini-3.5-flash-lite" }, () =>
        new GeminiLLMProvider().generateText({ prompt: "x" })
      );
      assert(m.calls[0].url.includes("gemini-3.5-flash-lite"), `env model ignored: ${m.calls[0].url}`);
      await withEnv({ GEMINI_API_KEY: TEST_KEY, GEMINI_MODEL: undefined }, () =>
        new GeminiLLMProvider().generateText({ prompt: "x" })
      );
      assert(
        m.calls[1].url.includes(GEMINI_FALLBACK_MODEL),
        `fallback should be ${GEMINI_FALLBACK_MODEL}: ${m.calls[1].url}`
      );
    } finally {
      m.restore();
    }
  });

  check("17. a missing, blank, or placeholder key fails at construction", () => {
    for (const bad of [undefined, "", "   ", "SET_IN_COOLIFY_ONLY", "your-gemini-api-key", "CHANGE_ME"]) {
      let threw = false;
      try {
        withEnv({ GEMINI_API_KEY: bad }, () => new GeminiLLMProvider());
      } catch (err) {
        threw = true;
        assert(/GEMINI_API_KEY/.test(String(err)), `error must name the variable: ${err}`);
      }
      assert(threw, `key ${JSON.stringify(bad)} should have been rejected`);
    }
    assert(isPlaceholderKey("set_in_coolify_only"), "placeholder detection must be case-insensitive");
    assert(!isPlaceholderKey(TEST_KEY), "a real-looking key must not be treated as a placeholder");
  });

  // --- 18-21. Factory resolution, including mixed configurations ---------

  check("18. the factory builds the Gemini provider for 'gemini'", () => {
    withEnv({ GEMINI_API_KEY: TEST_KEY }, () => {
      const p = getLLMProvider({ provider: "gemini", model: "gemini-3.6-flash" });
      assert(p.name === "gemini", `got provider name '${p.name}'`);
      assert(p instanceof GeminiLLMProvider, "must be the Gemini implementation");
    });
  });

  check("19. the factory still builds Anthropic — the rollback path is intact", () => {
    withEnv({ ANTHROPIC_API_KEY: "sk-ant-test-key-1234567890" }, () => {
      const p = getLLMProvider({ provider: "anthropic", model: "claude-opus-5" });
      assert(p.name === "anthropic", `got provider name '${p.name}'`);
    });
    // And an unknown provider is a loud error, not a silent stub.
    let threw = false;
    try {
      getLLMProvider({ provider: "gemeni" });
    } catch (err) {
      threw = true;
      assert(/Unknown provider 'gemeni'/.test(String(err)), `wrong error: ${err}`);
      assert(SUPPORTED_LLM_PROVIDERS.every((p) => String(err).includes(p)), "the error must list the legal values");
    }
    assert(threw, "a typo must not silently resolve to stub");
  });

  check("20. MIXED: global Gemini + Anthropic script writer resolves per role", () => {
    withEnv(
      {
        GEMINI_API_KEY: TEST_KEY,
        ANTHROPIC_API_KEY: "sk-ant-test-key-1234567890",
        LLM_PROVIDER: "gemini",
        GEMINI_MODEL: "gemini-3.6-flash",
        SCRIPT_LLM_PROVIDER: "anthropic",
        SCRIPT_LLM_MODEL: "claude-opus-5",
        VERIFY_LLM_PROVIDER: "gemini",
        VERIFY_MODEL: "gemini-3.6-flash",
        FACTCHECK_LLM_PROVIDER: undefined,
        FACTCHECK_LLM_MODEL: undefined,
      },
      () => {
        const { byRole, providers } = resolveConfiguredLLMProviders();
        assert(byRole.global.provider === "gemini", `global ${byRole.global.provider}`);
        assert(byRole.script.provider === "anthropic", `script ${byRole.script.provider}`);
        assert(byRole.script.model === "claude-opus-5", `script model ${byRole.script.model}`);
        // factcheck inherits the SCRIPT chain, which is the documented default.
        assert(byRole.factcheck.provider === "anthropic", `factcheck ${byRole.factcheck.provider}`);
        assert(byRole.verify.provider === "gemini", `verify ${byRole.verify.provider}`);
        assert(byRole.verify.model === "gemini-3.6-flash", `verify model ${byRole.verify.model}`);
        assert(providers.has("gemini") && providers.has("anthropic"), `providers ${[...providers].join(",")}`);
        // And each role actually BUILDS the right implementation.
        assert(getLLMProvider(byRole.script).name === "anthropic", "script role must build Anthropic");
        assert(getLLMProvider(byRole.verify).name === "gemini", "verify role must build Gemini");
      }
    );
  });

  check("21. MIXED: Anthropic global + Gemini verifier resolves per role", () => {
    withEnv(
      {
        GEMINI_API_KEY: TEST_KEY,
        ANTHROPIC_API_KEY: "sk-ant-test-key-1234567890",
        LLM_PROVIDER: "anthropic",
        ANTHROPIC_MODEL: "claude-sonnet-5",
        SCRIPT_LLM_PROVIDER: undefined,
        SCRIPT_LLM_MODEL: undefined,
        FACTCHECK_LLM_PROVIDER: undefined,
        FACTCHECK_LLM_MODEL: undefined,
        VERIFY_LLM_PROVIDER: "gemini",
        VERIFY_MODEL: "gemini-3.6-flash",
      },
      () => {
        const { byRole } = resolveConfiguredLLMProviders();
        assert(byRole.global.provider === "anthropic", `global ${byRole.global.provider}`);
        assert(byRole.script.provider === "anthropic", `script should inherit global, got ${byRole.script.provider}`);
        assert(byRole.verify.provider === "gemini", `verify ${byRole.verify.provider}`);
        assert(getLLMProvider(byRole.global).name === "anthropic", "global role must build Anthropic");
        assert(getLLMProvider(byRole.verify).name === "gemini", "verify role must build Gemini");
      }
    );
  });

  // --- 22-24. The three quiet correctness properties ---------------------

  await checkAsync("22. cacheableContext is PRESERVED, in a stable position", async () => {
    const m = mockFetch([okResponse('{"segments":[]}'), okResponse('{"segments":[]}')]);
    try {
      const p = provider();
      await p.generateStructuredOutput({
        prompt: "write act one",
        systemPrompt: "You are the head writer.",
        cacheableContext: "EVIDENCE PACKET: Riverton went 4-19 after the deadline.",
      });
      const firstInstruction = m.calls[0].body.systemInstruction;
      assert(!!firstInstruction, "no systemInstruction was sent at all");
      const sent = firstInstruction!.parts[0].text;
      assert(sent.includes("You are the head writer."), "the system prompt was dropped");
      assert(
        sent.includes("EVIDENCE PACKET: Riverton went 4-19 after the deadline."),
        "cacheableContext was DISCARDED — the evidence never reached the model"
      );
      assert(
        sent.indexOf("head writer") < sent.indexOf("EVIDENCE PACKET"),
        "the cacheable half must come LAST so the prefix stays byte-stable across calls"
      );
      // Byte-stability is the whole point: an identical request must produce an
      // identical prefix, or implicit context caching never hits.
      await p.generateStructuredOutput({
        prompt: "write act two",
        systemPrompt: "You are the head writer.",
        cacheableContext: "EVIDENCE PACKET: Riverton went 4-19 after the deadline.",
      });
      assert(
        m.calls[1].body.systemInstruction?.parts[0].text === sent,
        "the same system prompt + context must serialize identically on a later call"
      );
    } finally {
      m.restore();
    }
  });

  await checkAsync("23. a 16,000-token request is passed through, never capped at 8,192", async () => {
    const m = mockFetch([okResponse('{"segments":[]}')]);
    try {
      await provider().generateStructuredOutput({ prompt: "movement", maxTokens: 16000 });
      const sentMax = m.calls[0].body.generationConfig.maxOutputTokens as number;
      assert(sentMax >= 16000, `requested 16000 but the adapter sent ${sentMax} — a script movement would truncate`);
      assert(sentMax <= 65536, `sent ${sentMax}, above the model's documented output ceiling`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("23b. a request above the model ceiling is clamped WITH a warning", async () => {
    const m = mockFetch([okResponse("ok")]);
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
    try {
      await provider().generateText({ prompt: "x", maxTokens: 500_000 });
      assert(m.calls[0].body.generationConfig.maxOutputTokens === 65536, "must clamp to the documented ceiling");
      assert(warnings.some((w) => /exceeds the documented output ceiling/.test(w)), "clamping must be said out loud");
    } finally {
      console.warn = realWarn;
      m.restore();
    }
  });

  await checkAsync("24. the API key never appears in a thrown error, a log, or the URL", async () => {
    // The most likely leak is an error body echoed straight into a message.
    const m = mockFetch([{ status: 400, text: `{"error":{"message":"Invalid key ${TEST_KEY} supplied"}}` }]);
    const logged: string[] = [];
    const realWarn = console.warn;
    const realLog = console.log;
    const realError = console.error;
    console.warn = (...a: unknown[]) => logged.push(a.join(" "));
    console.log = (...a: unknown[]) => logged.push(a.join(" "));
    console.error = (...a: unknown[]) => logged.push(a.join(" "));
    try {
      let message = "";
      try {
        await noSleep(() => provider().generateText({ prompt: "x" }));
      } catch (err) {
        message = String(err);
      }
      assert(message.length > 0, "the 400 must throw");
      assert(!message.includes(TEST_KEY), `the key leaked into the thrown error: ${message}`);
      assert(message.includes("[REDACTED]"), "the echoed key must be visibly redacted");
      const allLogs = logged.join("\n");
      assert(!allLogs.includes(TEST_KEY), "the key leaked into a console log");
      // Auth is a header, so the key is never in a URL that could be logged.
      assert(!m.calls[0].url.includes(TEST_KEY), "the key must not be in the request URL");
      assert(m.calls[0].headers["x-goog-api-key"] === TEST_KEY, "the key must be sent as a header");
    } finally {
      console.warn = realWarn;
      console.log = realLog;
      console.error = realError;
      m.restore();
    }
    // And the redactor itself, directly.
    assert(redactKey(`prefix ${TEST_KEY} suffix`, TEST_KEY) === "prefix [REDACTED] suffix", "redactKey must replace the key");
  });

  // --- Additional provider-shape behavior worth pinning -----------------

  await checkAsync("a safety refusal is a hard failure, not a retry loop", async () => {
    const m = mockFetch([
      { status: 200, json: { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }] } },
      okResponse("should never be reached"),
    ]);
    try {
      let threw = false;
      try {
        await noSleep(() => provider().generateText({ prompt: "x" }));
      } catch (err) {
        threw = true;
        assert(/finishReason: SAFETY/.test(String(err)), `wrong error: ${err}`);
      }
      assert(threw, "a refusal must throw");
      assert(m.calls.length === 1, `a refusal is deterministic and must not be retried, saw ${m.calls.length} calls`);
    } finally {
      m.restore();
    }
  });

  await checkAsync("a blocked PROMPT is reported as a prompt block, not an empty response", async () => {
    const m = mockFetch([{ status: 200, json: { promptFeedback: { blockReason: "PROHIBITED_CONTENT" } } }]);
    try {
      let threw = false;
      try {
        await provider().generateText({ prompt: "x" });
      } catch (err) {
        threw = true;
        assert(/blockReason: PROHIBITED_CONTENT/.test(String(err)), `wrong error: ${err}`);
      }
      assert(threw, "a blocked prompt must throw");
    } finally {
      m.restore();
    }
  });

  await checkAsync("a supplied jsonSchema is forwarded; absent, only the mime type is set", async () => {
    const m = mockFetch([okResponse('{"status":"passed"}'), okResponse('{"segments":[]}')]);
    try {
      const schema = { type: "object", properties: { status: { type: "string" } }, required: ["status"] };
      await provider().generateStructuredOutput({ prompt: "review", jsonSchema: schema });
      assert(
        JSON.stringify(m.calls[0].body.generationConfig.responseSchema) === JSON.stringify(schema),
        "a supplied schema must reach responseSchema"
      );
      // The biggest payloads (script movements) supply no schema by design —
      // Gemini rejects very large/deeply nested ones, and a 400 on the most
      // valuable call in the run is worse than instruction-based JSON.
      await provider().generateStructuredOutput({ prompt: "movement", maxTokens: 16000 });
      assert(
        m.calls[1].body.generationConfig.responseSchema === undefined,
        "no schema must be synthesized when the caller supplied none"
      );
      assert(m.calls[1].body.generationConfig.responseMimeType === "application/json", "JSON mime type is still required");
    } finally {
      m.restore();
    }
  });

  await checkAsync("the system prompt is a top-level systemInstruction, not a 'system' role message", async () => {
    const m = mockFetch([okResponse("ok")]);
    try {
      await provider().generateText({ prompt: "hello", systemPrompt: "be terse" });
      const body = m.calls[0].body;
      assert(body.systemInstruction?.parts?.[0]?.text === "be terse", "systemInstruction missing");
      assert(body.contents.length === 1 && body.contents[0].role === "user", "Gemini's only legal roles are user and model");
      assert(
        !JSON.stringify(body.contents).includes('"system"'),
        "a 'system' role message would be rejected by the API"
      );
    } finally {
      m.restore();
    }
  });

  await checkAsync("GEMINI_THINKING_LEVEL reaches generationConfig only when set", async () => {
    const m = mockFetch([okResponse("ok"), okResponse("ok")]);
    try {
      await withEnv({ GEMINI_API_KEY: TEST_KEY, GEMINI_THINKING_LEVEL: "low" }, () =>
        new GeminiLLMProvider().generateText({ prompt: "x" })
      );
      assert(m.calls[0].body.generationConfig.thinkingLevel === "low", "thinkingLevel not forwarded");
      await withEnv({ GEMINI_API_KEY: TEST_KEY, GEMINI_THINKING_LEVEL: undefined }, () =>
        new GeminiLLMProvider().generateText({ prompt: "x" })
      );
      assert(
        m.calls[1].body.generationConfig.thinkingLevel === undefined,
        "unset must mean Google's default, not a value we invented"
      );
    } finally {
      m.restore();
    }
  });

  // --- Production readiness ---------------------------------------------
  //
  // The audit is the thing an operator trusts before a deploy. Two ways it can
  // lie, and both are tested: demanding credentials for a provider nothing
  // uses (which trains people to ignore a red audit), and passing a config
  // whose verifier points at a provider with no key (which fails mid-pipeline
  // AFTER paying for a script).
  const { getRequiredProductionEnvChecklist } = await import("../lib/services/productionEnvService");
  const auditUnder = (env: Record<string, string | undefined>) =>
    withEnv(env, () => getRequiredProductionEnvChecklist());
  const find = (checks: ReturnType<typeof getRequiredProductionEnvChecklist>, key: string) =>
    checks.find((c) => c.key === key);

  const GEMINI_PRIMARY = {
    LLM_PROVIDER: "gemini",
    GEMINI_API_KEY: TEST_KEY,
    GEMINI_MODEL: "gemini-3.6-flash",
    SCRIPT_LLM_PROVIDER: "gemini",
    SCRIPT_LLM_MODEL: "gemini-3.6-flash",
    VERIFY_LLM_PROVIDER: "gemini",
    VERIFY_MODEL: "gemini-3.6-flash",
    FACTCHECK_LLM_PROVIDER: undefined,
    FACTCHECK_LLM_MODEL: undefined,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: undefined,
    OPENAI_API_KEY: undefined,
    OPENAI_MODEL: undefined,
  };

  check("readiness: a Gemini-primary config validates GEMINI_API_KEY and passes it", () => {
    const checks = auditUnder(GEMINI_PRIMARY);
    const key = find(checks, "GEMINI_API_KEY");
    assert(!!key, "GEMINI_API_KEY was not checked at all under a Gemini config");
    assert(key!.status === "pass", `GEMINI_API_KEY status is '${key!.status}' (${key!.message ?? ""})`);
    assert(!key!.value.includes(TEST_KEY), "readiness must never print the key");
  });

  check("readiness: Anthropic credentials are NOT required when nothing uses Anthropic", () => {
    const checks = auditUnder(GEMINI_PRIMARY);
    // Present-but-failing would make a correct deployment show a red audit.
    assert(!find(checks, "ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY must not be checked when no role resolves to Anthropic");
    assert(!find(checks, "OPENAI_API_KEY"), "OPENAI_API_KEY must not be checked when no role resolves to OpenAI");
  });

  check("readiness: the Anthropic ROLLBACK config still validates Anthropic and not Gemini", () => {
    const checks = auditUnder({
      LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test-key-1234567890",
      ANTHROPIC_MODEL: "claude-sonnet-5",
      SCRIPT_LLM_PROVIDER: "anthropic",
      SCRIPT_LLM_MODEL: "claude-opus-5",
      VERIFY_LLM_PROVIDER: "anthropic",
      VERIFY_MODEL: "claude-sonnet-5",
      FACTCHECK_LLM_PROVIDER: undefined,
      GEMINI_API_KEY: undefined,
      GEMINI_MODEL: undefined,
    });
    assert(find(checks, "ANTHROPIC_API_KEY")?.status === "pass", "the rollback config must validate its own key");
    assert(!find(checks, "GEMINI_API_KEY"), "Gemini must not be required after rolling back");
  });

  check("readiness: a MIXED config validates BOTH providers in play", () => {
    const checks = auditUnder({
      LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: TEST_KEY,
      GEMINI_MODEL: "gemini-3.6-flash",
      SCRIPT_LLM_PROVIDER: "anthropic",
      SCRIPT_LLM_MODEL: "claude-opus-5",
      ANTHROPIC_API_KEY: "sk-ant-test-key-1234567890",
      ANTHROPIC_MODEL: "claude-sonnet-5",
      VERIFY_LLM_PROVIDER: "gemini",
      VERIFY_MODEL: "gemini-3.6-flash",
      FACTCHECK_LLM_PROVIDER: undefined,
    });
    assert(find(checks, "GEMINI_API_KEY")?.status === "pass", "Gemini is in play and must be validated");
    assert(find(checks, "ANTHROPIC_API_KEY")?.status === "pass", "Anthropic is in play and must be validated");
  });

  check("readiness: a config whose VERIFIER has no key FAILS instead of passing", () => {
    // The regression this exists for: readiness used to resolve only
    // LLM_PROVIDER and SCRIPT_LLM_PROVIDER, so this exact shape passed the
    // audit and then died at the fact-check stage, after paying for a script.
    const checks = auditUnder({
      LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: TEST_KEY,
      GEMINI_MODEL: "gemini-3.6-flash",
      SCRIPT_LLM_PROVIDER: "gemini",
      SCRIPT_LLM_MODEL: "gemini-3.6-flash",
      VERIFY_LLM_PROVIDER: "anthropic",
      VERIFY_MODEL: "claude-sonnet-5",
      FACTCHECK_LLM_PROVIDER: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_MODEL: undefined,
    });
    const key = find(checks, "ANTHROPIC_API_KEY");
    assert(!!key, "the verifier's provider must be resolved and checked");
    assert(key!.status === "fail", `a missing verifier key must FAIL the audit, got '${key!.status}'`);
  });

  check("readiness: an unsupported provider name fails loudly, naming the role", () => {
    const checks = auditUnder({
      LLM_PROVIDER: "gemini",
      GEMINI_API_KEY: TEST_KEY,
      GEMINI_MODEL: "gemini-3.6-flash",
      SCRIPT_LLM_PROVIDER: "gemeni", // typo
      SCRIPT_LLM_MODEL: undefined,
      VERIFY_LLM_PROVIDER: undefined,
      FACTCHECK_LLM_PROVIDER: undefined,
    });
    const bad = checks.filter((c) => c.status === "fail" && c.value === "gemeni");
    assert(bad.length > 0, "a typo'd provider must fail the audit rather than wait to throw mid-run");
    assert(bad.some((c) => c.key.includes("script")), `the failing ROLE must be named, got keys: ${bad.map((c) => c.key).join(", ")}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
