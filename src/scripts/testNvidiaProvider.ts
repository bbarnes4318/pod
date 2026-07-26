// NVIDIA NIM provider contract. Run:
//
//   npm run test:nvidia-provider            # mocked only, no credential needed
//   npm run test:nvidia-provider -- --live  # also probe the real API
//
// The mocked suite is the contract. The live probe is opt-in and reports
// SKIPPED loudly when NVIDIA_API_KEY is absent — a suite that quietly skips the
// live check and still prints "passed" is how "verified against the real API"
// stops being true.

import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
dotenv.config();

import { NvidiaNimLLMProvider, NVIDIA_DEFAULT_BASE_URL } from "../lib/providers/llm/nvidia";
import { MODEL_IDS } from "../lib/providers/llm/capabilities";
import { runProviderContract } from "./providerContractHarness";

const LIVE = process.argv.includes("--live");

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
      env: {
        NVIDIA_BASE_URL: NVIDIA_DEFAULT_BASE_URL,
        NVIDIA_MAX_RETRIES: "0",
        NVIDIA_REQUEST_TIMEOUT_MS: "240000",
      },
    },
    { live: LIVE }
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (!LIVE) {
    console.log(
      "NOTE: every request above was MOCKED. No NVIDIA model id, rate limit or parameter has been confirmed\n" +
        "against the live catalog by this run — the capability registry still marks them unverified. Run with\n" +
        "--live and a real NVIDIA_API_KEY to confirm them."
    );
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("NVIDIA provider test harness failed:", err);
  process.exit(1);
});
