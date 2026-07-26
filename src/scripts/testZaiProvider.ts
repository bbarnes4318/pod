// Z.ai provider contract. Run:
//
//   npm run test:zai-provider            # mocked only, no credential needed
//   npm run test:zai-provider -- --live  # also probe the real API
//
// Z.ai is the independent free provider: the secondary for every NVIDIA-primary
// role and the sole provider of the free_independent profile.

import * as dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
dotenv.config();

import { ZaiLLMProvider, ZAI_DEFAULT_BASE_URL } from "../lib/providers/llm/zai";
import { MODEL_IDS } from "../lib/providers/llm/capabilities";
import { runProviderContract } from "./providerContractHarness";

const LIVE = process.argv.includes("--live");

async function main(): Promise<void> {
  console.log("Z.ai provider — independent free provider and launch candidate.");

  // The one configuration mistake that silently breaks this integration.
  if (!/\/api\/paas\/v4$/.test(ZAI_DEFAULT_BASE_URL)) {
    console.error(
      `Z.ai default base URL is '${ZAI_DEFAULT_BASE_URL}', which is not the general-purpose API. ` +
        `This application must NOT use the coding-plan endpoint.`
    );
    process.exit(1);
  }
  console.log(`  ✓ default base URL is the general-purpose API: ${ZAI_DEFAULT_BASE_URL}`);

  const { passed, failed } = await runProviderContract(
    {
      provider: "zai",
      displayName: "Z.ai",
      host: "api.z.ai",
      apiKeyVar: "ZAI_API_KEY",
      baseUrlVar: "ZAI_BASE_URL",
      model: MODEL_IDS.zai.glmFlash,
      build: (model?: string) => new ZaiLLMProvider(model),
      env: {
        ZAI_BASE_URL: ZAI_DEFAULT_BASE_URL,
        ZAI_MAX_RETRIES: "0",
        ZAI_REQUEST_TIMEOUT_MS: "240000",
      },
    },
    { live: LIVE }
  );

  console.log(`\n${passed + 1} passed, ${failed} failed`);
  if (!LIVE) {
    console.log(
      "NOTE: every request above was MOCKED. Z.ai's free-tier quota, model id and parameter support have not been\n" +
        "confirmed by this run. Run with --live and a real ZAI_API_KEY to confirm them."
    );
  }
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Z.ai provider test harness failed:", err);
  process.exit(1);
});
