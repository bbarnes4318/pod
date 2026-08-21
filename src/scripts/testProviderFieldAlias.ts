// A provider that renames the field it rejects must still trigger the downgrade.
//
// Production evidence (2026-08-21, role research_brief / topic_generation):
//   nvidia/nemotron-3-ultra-550b-a55b HTTP 400:
//   "ValueError: thinking_token_budget is not yet supported by the V2 model
//    runner. Run vLLM with VLLM_USE_V2_MODEL_RUNNER=0 to use
//    thinking_token_budget."
// We send `reasoning_budget`; NVIDIA reports `thinking_token_budget`. The
// downgrade only fires on a field we NAMED, so nothing was stripped, the
// re-send never happened, and the top rung of the chain failed deterministically
// on every call and every rate-window pass.
//
// NETWORK-FREE. Run: npm run test:provider-field-alias

import { namedUnsupportedField } from "../lib/providers/llm/errors";

const NVIDIA_400 =
  "ValueError: thinking_token_budget is not yet supported by the V2 model runner. " +
  "Run vLLM with VLLM_USE_V2_MODEL_RUNNER=0 to use thinking_token_budget.";

// Mirrors the private helper in openaiCompatible.ts.
const PROVIDER_FIELD_ALIASES: Record<string, readonly string[]> = {
  reasoning_budget: ["thinking_token_budget"],
};
function namedUnsupportedFieldOrAlias(errorText: string, candidateFields: string[]): string | null {
  const direct = namedUnsupportedField(errorText, candidateFields);
  if (direct) return direct;
  const body = (errorText || "").toLowerCase();
  for (const field of candidateFields) {
    for (const alias of PROVIDER_FIELD_ALIASES[field] ?? []) {
      if (body.includes(alias.toLowerCase())) return field;
    }
  }
  return null;
}

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  OK  ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}\n       ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

// What nemotron-3-ultra actually sends for a reasoning-enabled call.
const SENT = ["chat_template_kwargs", "reasoning_budget"];

console.log("\nprovider field aliases\n");

check("the OLD matcher cannot see NVIDIA's rename — this is the bug", () => {
  assert(namedUnsupportedField(NVIDIA_400, SENT) === null,
    "if this ever matches directly, the alias table is no longer needed for this case");
});

check("the alias-aware matcher strips the field we actually sent", () => {
  assert(namedUnsupportedFieldOrAlias(NVIDIA_400, SENT) === "reasoning_budget",
    `expected reasoning_budget, got ${namedUnsupportedFieldOrAlias(NVIDIA_400, SENT)}`);
});

check("a field we did NOT send is never stripped", () => {
  assert(namedUnsupportedFieldOrAlias(NVIDIA_400, ["chat_template_kwargs"]) === null,
    "an alias must only resolve to a field present in this request");
});

check("an unrelated 400 still strips nothing", () => {
  assert(namedUnsupportedFieldOrAlias("Internal server error while loading weights", SENT) === null,
    "guessing a field to remove is worse than failing");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
