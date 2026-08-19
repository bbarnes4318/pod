// A minute-long limit must cost a minute, not an episode.
//
//   npm run test:rate-window-recovery
//
// NETWORK-FREE. A local HTTP server stands in for the provider endpoints, so
// this runs anywhere and asserts on OUR behaviour rather than on a vendor's
// current mood.
//
// WHY IT EXISTS. Three consecutive episodes died at script:debate_architect
// while the free tier's own provider was answering the same role seconds
// earlier. The shape was always the same:
//
//   cerebras  429  "Tokens per minute limit exceeded"
//   groq      429/schema failure
//   anthropic unfunded
//   -> episode dead, ~50 seconds after a one-minute wait would have fixed it
//
// testRateWindowClassification.ts covers the first half of that: the 429 is now
// read as a window that refills rather than an allowance that is spent. This
// file covers the half that actually saves the episode — that the ROUTER waits
// the window out and runs the chain again, instead of reporting an exhausted
// chain as a dead role.
//
// The three checks below are the three ways it can regress:
//   1. the chain gives up while every rung is inside a window that refills
//   2. the transport fires requests into a window it has already been told about
//   3. the wait becomes unbounded, so a limit that never clears hangs a job

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resetRateWindows } from "../lib/providers/llm/rateWindow";

let failed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

/** The exact body Cerebras refuses an oversized call with. */
const TPM_BODY = JSON.stringify({
  message: "Tokens per minute limit exceeded - too many tokens processed.",
  type: "too_many_tokens_error",
  param: "quota",
  code: "token_quota_exceeded",
});

const ANSWER = JSON.stringify({
  choices: [{ message: { content: '{"turns":[{"turnIndex":0}]}' }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 10 },
});

interface Hit {
  at: number;
  path: string;
}

/**
 * A provider endpoint that refuses the first `refusals` calls with a per-minute
 * 429 and answers everything after that.
 *
 * `retry-after: 1` keeps the test honest AND fast: the wait is driven by the
 * header the provider sends, which is the same code path a 60-second window
 * takes. Hard-coding a shorter default in the ledger to make tests quick would
 * have tested a constant instead of the behaviour.
 */
function refusingServer(refusals: number) {
  return refusingServerWith(refusals, "1");
}

function refusingServerWith(refusals: number, retryAfter: string) {
  const hits: Hit[] = [];
  let seen = 0;
  const server = http.createServer((req, res) => {
    hits.push({ at: Date.now(), path: req.url || "" });
    seen++;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (seen <= refusals) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": retryAfter });
        res.end(TPM_BODY);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(ANSWER);
    });
  });
  return {
    hits,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${port}/v1`);
        });
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Point the free tier's two structural rungs at one fake endpoint.
 *
 * maxRetries is 0 on both on purpose. The transport's own retry loop would mask
 * what this file is testing: we want the ROUTER's behaviour after the chain has
 * genuinely been spent, not the provider's second attempt.
 */
function useFakeEndpoints(baseUrl: string, passes: string) {
  process.env.LLM_ROUTING_PROFILE = "free_independent";
  process.env.LLM_ALLOW_LEGACY_FALLBACK = "false";
  process.env.LLM_RATE_WINDOW_PASSES = passes;
  process.env.CEREBRAS_API_KEY = "test-cerebras-key-000000000000";
  process.env.CEREBRAS_BASE_URL = baseUrl;
  process.env.CEREBRAS_MAX_RETRIES = "0";
  process.env.GROQ_API_KEY = "test-groq-key-0000000000000000";
  process.env.GROQ_BASE_URL = baseUrl;
  process.env.GROQ_MAX_RETRIES = "0";
}

async function main() {
  console.log("\nA refilling window costs a wait, not an episode\n");

  const { getRoleLLMProvider } = await import("../lib/providers/llm/routing");
  const call = () =>
    getRoleLLMProvider("script_debate_architect").generateStructuredOutput<{ turns: unknown[] }>({
      systemPrompt: "s",
      prompt: "p",
      maxTokens: 64,
    });

  // 1 -------------------------------------------------------------------
  await check("the chain WAITS OUT a window both rungs are inside, and then succeeds", async () => {
    resetRateWindows();
    // Two refusals: one per rung. The chain is then exhausted with nothing but
    // rate-limit failures, which is precisely the state that used to kill the
    // episode.
    const server = refusingServer(2);
    const url = await server.listen();
    useFakeEndpoints(url, "2");
    try {
      const started = Date.now();
      const result = await call();
      const elapsed = Date.now() - started;
      assert.ok(Array.isArray(result.turns), "the role must return the answer the endpoint eventually gave");
      assert.ok(
        server.hits.length >= 3,
        `expected the chain to be re-run after the wait; the endpoint saw ${server.hits.length} request(s)`
      );
      assert.ok(elapsed >= 900, `expected the router to wait out the published 1s window, took ${elapsed}ms`);
    } finally {
      await server.close();
    }
  });

  // 2 -------------------------------------------------------------------
  await check("a window recorded by one rung is honoured by the NEXT rung, not rediscovered", async () => {
    resetRateWindows();
    const server = refusingServer(1);
    const url = await server.listen();
    useFakeEndpoints(url, "2");
    try {
      await call();
      assert.ok(server.hits.length >= 2, "expected at least the refusal and the answer");
      const gap = server.hits[1].at - server.hits[0].at;
      // The second rung is a DIFFERENT provider account, so it is free to try
      // immediately — what must not happen is a second request to an account
      // already known to be closed. Both fake rungs share this server, so the
      // observable proof is the gap: nothing arrives inside the window.
      assert.ok(
        gap >= 900,
        `the second request arrived ${gap}ms after a 1s window was published — the ledger was not consulted`
      );
    } finally {
      await server.close();
    }
  });

  // 3 -------------------------------------------------------------------
  await check("the wait is BOUNDED — a window that never clears fails instead of hanging", async () => {
    resetRateWindows();
    // Refuses far more times than any number of passes could absorb.
    const server = refusingServer(50);
    const url = await server.listen();
    useFakeEndpoints(url, "1");
    try {
      await assert.rejects(
        call(),
        /rate_limited|Every candidate/i,
        "a limit that does not clear must surface as a failure with the whole history"
      );
      // The budget is arithmetic, not a feeling: 2 rungs x (1 attempt + 2
      // transport retries, because a 1s window is under the ceiling this
      // transport absorbs) x 2 passes = 12. Anything above that means a pass
      // budget stopped being enforced somewhere.
      assert.ok(
        server.hits.length <= 12,
        `the chain must stop after its pass budget; the endpoint saw ${server.hits.length} requests`
      );
    } finally {
      await server.close();
    }
  });

  // 4 -------------------------------------------------------------------
  await check("a LONG window is handed to the router instead of held at one endpoint", async () => {
    resetRateWindows();
    const server = refusingServerWith(50, "8");
    const url = await server.listen();
    // No extra passes: this check is only about who does the waiting, and with
    // the pass budget at zero the whole run should take almost no time at all.
    useFakeEndpoints(url, "0");
    try {
      const started = Date.now();
      await assert.rejects(call(), /rate_limited|Every candidate/i);
      const elapsed = Date.now() - started;
      // One attempt per rung and nothing else. If the transport went back to
      // absorbing long windows, this is 6 requests and roughly 48 seconds —
      // which is how one saturated minute used to become seven.
      assert.equal(
        server.hits.length,
        2,
        `expected one attempt per rung, the endpoint saw ${server.hits.length}`
      );
      assert.ok(elapsed < 3_000, `the transport must not sit on an 8s window; the chain took ${elapsed}ms`);
    } finally {
      await server.close();
    }
  });

  console.log(failed === 0 ? "\nAll rate-window recovery checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
