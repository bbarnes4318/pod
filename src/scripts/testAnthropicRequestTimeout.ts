// The Anthropic adapter must BOUND one HTTP attempt, and the failure it
// produces must be one the router can act on.
//
// WHY THIS EXISTS. This adapter is the hand-written one; every other provider
// goes through openaiCompatible.ts, which has had an AbortController and a 240s
// default since it was written. Anthropic's fetch passed no `signal` at all, so
// nothing bounded a request that stopped producing bytes.
//
// Production 2026-08-25, episode e579f96e: the script:turn-plan call recorded
// 912,305 ms across three attempts — about 304s each — and returned ZERO tokens
// in and zero out before dying with `fetch failed`. Fifteen minutes bought
// nothing on a tier that advertises two to four.
//
// This asserts BOTH halves, because either alone is useless. A bounded attempt
// whose error is terminal still ends the episode; a recoverable error that never
// arrives still hangs. So: the call rejects near the deadline, AND categoryOf
// maps that rejection to a category the chain advances past.

import assert from "node:assert";
import {
  ANTHROPIC_DEFAULT_TIMEOUT_MS,
  ANTHROPIC_TIMEOUT_ENV,
  anthropicRequestTimeoutMs,
} from "../lib/providers/llm/anthropic";
import { categoryOf } from "../lib/providers/llm/errors";

let failed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => {
      failed++;
      console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
    });
}

async function main() {
  console.log("\nAnthropic request timeout\n");

  await check("the default matches the other providers rather than inventing a number", () => {
    // zai / nvidia / moonshot all default to 240s. A ceiling that differs per
    // provider for no measured reason is a number nobody can reason about.
    assert.equal(ANTHROPIC_DEFAULT_TIMEOUT_MS, 240_000);
    delete process.env[ANTHROPIC_TIMEOUT_ENV];
    assert.equal(anthropicRequestTimeoutMs(), 240_000);
  });

  await check("an operator override is honoured, and a nonsense one is not", () => {
    process.env[ANTHROPIC_TIMEOUT_ENV] = "90000";
    assert.equal(anthropicRequestTimeoutMs(), 90_000);
    // numberFromEnv only accepts a finite positive; anything else falls back
    // rather than disabling the ceiling, which is the failure mode that matters.
    process.env[ANTHROPIC_TIMEOUT_ENV] = "0";
    assert.equal(anthropicRequestTimeoutMs(), 240_000);
    process.env[ANTHROPIC_TIMEOUT_ENV] = "not-a-number";
    assert.equal(anthropicRequestTimeoutMs(), 240_000);
    delete process.env[ANTHROPIC_TIMEOUT_ENV];
  });

  await check("a hung endpoint is aborted instead of held open forever", async () => {
    // The real regression, reproduced: a server that accepts the connection and
    // then never answers. Before the fix this promise never settled.
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key-not-real";
    process.env[ANTHROPIC_TIMEOUT_ENV] = "300";

    const realFetch = globalThis.fetch;
    let sawSignal = false;
    globalThis.fetch = ((_url: any, init: any) =>
      new Promise((_resolve, reject) => {
        const signal: AbortSignal | undefined = init?.signal;
        sawSignal = Boolean(signal);
        // Never resolve. Only the caller's own abort can end this.
        signal?.addEventListener("abort", () => {
          const err: any = new Error("This operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as typeof fetch;

    try {
      const { default: AnthropicLLMProvider } = await import("../lib/providers/llm/anthropic");
      const provider = new AnthropicLLMProvider("claude-haiku-4-5");

      const startedAt = Date.now();
      let thrown: unknown = null;
      try {
        await provider.generateText({ prompt: "hello", maxTokens: 16 } as any);
      } catch (err) {
        thrown = err;
      }
      const elapsed = Date.now() - startedAt;

      assert.ok(sawSignal, "fetch was called without an AbortSignal — nothing bounds the attempt");
      assert.ok(thrown, "a hung endpoint must reject, not hang");

      // Three attempts at 300ms plus the adapter's own backoff between them.
      // The ceiling that matters is that it FINISHES; a generous bound here
      // keeps the test from being a latency benchmark on a loaded CI runner.
      assert.ok(
        elapsed < 60_000,
        `the call took ${elapsed}ms, so the abort is not ending the attempt`
      );

      // The half that decides whether an episode survives this. `timeout` is not
      // in TERMINAL, so the router advances to the next rung; `programming_error`
      // would stop the chain dead, which is exactly what happened in production
      // when a dropped connection was read as a code defect.
      assert.equal(
        categoryOf(thrown),
        "timeout",
        "an aborted attempt must be recoverable, or bounding it changes nothing"
      );
    } finally {
      globalThis.fetch = realFetch;
      delete process.env[ANTHROPIC_TIMEOUT_ENV];
    }
  });

  if (failed) {
    console.error(`\n${failed} check(s) FAILED.\n`);
    process.exit(1);
  }
  console.log("\nAll Anthropic request timeout checks passed.\n");
}

void main();
