// Live LLM provider smoke test — ONE tiny completion per provider.
//
//   npm run smoke:llm-providers
//
// THIS SPENDS MONEY, so it is deliberately NOT in CI. Run it after changing a
// credential, adding a provider, or before trusting an evaluation run.
//
// WHY IT EXISTS. A 200 from a provider's /v1/models endpoint proves the key is
// syntactically valid and proves nothing else. It does not prove the account is
// funded, and it does not prove our request shape is accepted. On 2026-08-05 a
// single pass of this script found three things a catalog listing had reported
// as perfectly healthy:
//
//   - kimi-k3 rejects every temperature except 1 (HTTP 400), so every call this
//     application would have made to it failed on the first request;
//   - Google and Z.ai were both out of money, and both said so with HTTP 429,
//     which the error classifier was reading as an ordinary rate limit;
//   - the Gemini Pro model id had no un-suffixed form, so the configured default
//     did not exist.
//
// None of those are visible without spending a few tokens on purpose.
import "dotenv/config";
import { getLLMProvider } from "../lib/providers/llm/factory";
import { SUPPORTED_LLM_PROVIDERS } from "../lib/providers/llm/factory";

/** Provider + a model that is CONFIRMED present in that provider's catalog. */
const CASES: Array<{ provider: string; model: string }> = [
  { provider: "anthropic", model: "claude-opus-5" },
  { provider: "xai", model: "grok-4.3" },
  { provider: "moonshot", model: "kimi-k3" },
  { provider: "google", model: "gemini-3.1-pro-preview" },
  { provider: "nvidia", model: "nvidia/nemotron-3-ultra-550b-a55b" },
  { provider: "zai", model: "glm-5.2" },
];

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const cases = only.length ? CASES.filter((c) => only.includes(c.provider)) : CASES;

  console.log("\nLive provider smoke test — one completion each. THIS SPENDS MONEY.\n");
  let passed = 0;
  const failures: string[] = [];

  for (const c of cases) {
    const label = `${c.provider}/${c.model}`.padEnd(46);
    const started = Date.now();
    try {
      const provider = getLLMProvider({ provider: c.provider, model: c.model });
      const text = await provider.generateText({
        prompt: "Reply with exactly one word: OK",
        maxTokens: 64,
        temperature: 0,
      });
      const clean = String(text).replace(/\s+/g, " ").trim().slice(0, 50);
      console.log(`PASS  ${label} ${String(Date.now() - started).padStart(6)}ms  -> ${clean}`);
      passed++;
    } catch (e) {
      // The provider's own message is the useful part; credentials are redacted
      // upstream in errors.ts before any body reaches a log line.
      const msg = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 190);
      console.log(`FAIL  ${label} ${String(Date.now() - started).padStart(6)}ms  -> ${msg}`);
      failures.push(`${c.provider}/${c.model}`);
    }
  }

  console.log(`\n${passed}/${cases.length} reachable and funded.`);
  if (failures.length) {
    console.log(`Not usable: ${failures.join(", ")}`);
    console.log(
      "A failure here is a REAL blocker for any role routed at that provider — an evaluation\n" +
        "run would score it as a loss when the truth is that it never ran."
    );
  }
  console.log(`\nFactory can build: ${SUPPORTED_LLM_PROVIDERS.join(", ")}\n`);
  process.exit(failures.length ? 1 : 0);
}

main();
