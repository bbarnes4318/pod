// A limit that refills is not a limit that is spent.
//
//   npm run test:rate-window
//
// NETWORK-FREE.
//
// WHY IT EXISTS. On 2026-08-17 three consecutive episodes died at
// script:debate_architect. The ledger for those runs shows Cerebras answering
// the SAME role seconds earlier -- script:outline returned 3,262 tokens in
// 2.0s, script:private-agendas 1,054 tokens in 1.1s -- and then refusing the
// large turn-plan call with:
//
//   {"message":"Tokens per minute limit exceeded - too many tokens processed.",
//    "type":"too_many_tokens_error","param":"quota",
//    "code":"token_quota_exceeded"}
//
// The classifier tested /quota|credit|balance/ against the WHOLE body, so
// `"param":"quota"` -- a field NAME, not a sentence -- matched, and a
// per-minute window was filed as `quota_exhausted`. That is the one 429
// category deliberately excluded from retries, so the router abandoned Cerebras
// instantly, fell through to Groq (schema violation on the biggest schema) and
// Anthropic (unfunded), and failed the episode about 50 seconds after a
// one-minute wait would have cleared it.
//
// The first case below is that body verbatim. If it ever classifies as
// quota_exhausted again, the pipeline is back to killing episodes over a limit
// that clears by itself.

import assert from "node:assert/strict";
import { categorizeHttpFailure, isRetryableCategory, looksLikeRefillingRateWindow } from "../lib/providers/llm/errors";

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

const CEREBRAS_TPM = JSON.stringify({
  message: "Tokens per minute limit exceeded - too many tokens processed.",
  type: "too_many_tokens_error",
  param: "quota",
  code: "token_quota_exceeded",
});

function main() {
  console.log("\n429 classification — refilling window vs spent allowance\n");

  console.log("  -- the body that killed three episodes --");

  check("the verbatim Cerebras TPM refusal is a rate limit, not a spent quota", () => {
    const c = categorizeHttpFailure(429, CEREBRAS_TPM);
    assert.equal(
      c,
      "rate_limited",
      `classified as ${c} — a per-minute window filed as a spent allowance is never retried, and the episode dies`
    );
  });

  check("and it is therefore retried against the same endpoint", () => {
    // The whole point: Cerebras answers this role fine once the window clears.
    assert.ok(isRetryableCategory(categorizeHttpFailure(429, CEREBRAS_TPM)));
  });

  check("the bare word 'quota' as a FIELD NAME does not decide the category", () => {
    // This is the precise mechanism of the bug.
    assert.equal(looksLikeRefillingRateWindow(CEREBRAS_TPM), true);
    assert.equal(categorizeHttpFailure(429, JSON.stringify({ message: "Rate limit reached for requests" })), "rate_limited");
  });

  console.log("\n  -- spent allowances must still fall through --");

  check("a depleted balance is NOT treated as something waiting will fix", () => {
    // Z.ai and Google, observed live 2026-08-05. Waiting never adds money.
    const zai = JSON.stringify({ error: { message: "Insufficient balance or no resource package. Please recharge." } });
    const google = JSON.stringify({ error: { message: "Your prepayment credits are depleted." } });
    assert.equal(categorizeHttpFailure(429, zai), "insufficient_credit");
    assert.equal(categorizeHttpFailure(429, google), "insufficient_credit");
  });

  check("a daily allowance that is gone still advances to the next candidate", () => {
    const daily = JSON.stringify({ error: { message: "You have exceeded your current quota for the day." } });
    const c = categorizeHttpFailure(429, daily);
    assert.equal(c, "quota_exhausted", `got ${c} — a spent day does not refill, so waiting would be pure delay`);
  });

  check("funding language wins even when a time unit is present", () => {
    // "monthly credit limit" names a period but is settled with a payment.
    const monthly = JSON.stringify({ error: { message: "Monthly credit balance is too low — please add credits." } });
    assert.equal(looksLikeRefillingRateWindow(monthly), false);
    assert.equal(categorizeHttpFailure(429, monthly), "insufficient_credit");
  });

  console.log("\n  -- other real phrasings that refill --");

  for (const [label, msg] of [
    ["requests per minute", "Rate limit reached for requests per minute"],
    ["TPM abbreviation", "Limit exceeded: TPM"],
    ["too many requests", "Too many requests, please slow down"],
    ["per second", "Exceeded 5 requests per second"],
  ] as const) {
    check(`${label} is a refilling window`, () => {
      assert.equal(categorizeHttpFailure(429, JSON.stringify({ error: { message: msg } })), "rate_limited");
    });
  }

  check("an unstructured 429 body is still read", () => {
    // Not every provider sends JSON.
    assert.equal(categorizeHttpFailure(429, "429 Too Many Requests"), "rate_limited");
  });

  check("a 429 that says nothing useful stays a rate limit", () => {
    // The pre-existing default, unchanged: absent evidence of a spent
    // allowance, waiting is the safer assumption than abandoning the provider.
    assert.equal(categorizeHttpFailure(429, ""), "rate_limited");
  });

  console.log(failed === 0 ? "\nAll 429 classification checks passed.\n" : `\n${failed} check(s) FAILED.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
