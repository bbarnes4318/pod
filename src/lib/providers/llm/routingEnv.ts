// Statically-referenced snapshot of every environment variable the LLM routing
// layer reads.
//
// WHY THIS EXISTS (same trap productionEnvService.ts documents): Next.js inlines
// `process.env` into the server bundle at build time. A LITERAL read
// (`process.env.NVIDIA_API_KEY`) is substituted with the real value; a COMPUTED
// read (`process.env[`${prefix}_LLM_PROVIDER`]`) can only find variables that
// are ALSO referenced literally somewhere in that bundle. Routing resolves role
// overrides by prefix, which is exactly a computed read — without this file the
// web app would resolve every role override as unset while the worker (plain
// tsx, real process.env) resolved them correctly, and web and worker would run
// DIFFERENT models for the same episode.
//
// Any new routing variable MUST be added here, or it silently reads as unset in
// the web bundle. testLlmRouting.ts asserts that every role's override pair and
// every provider credential/tuning key is present in this snapshot.

import { ALL_ROLES, ROLE_DEFINITIONS } from "./roles";

const SNAPSHOT: Record<string, string | undefined> = {
  // ---- profile / stage / fallback policy ----
  LLM_ROUTING_PROFILE: process.env.LLM_ROUTING_PROFILE,
  APP_DEPLOYMENT_STAGE: process.env.APP_DEPLOYMENT_STAGE,
  LLM_ALLOW_LEGACY_FALLBACK: process.env.LLM_ALLOW_LEGACY_FALLBACK,
  LLM_RATE_WINDOW_PASSES: process.env.LLM_RATE_WINDOW_PASSES,

  // ---- existing grouped configuration (unchanged semantics) ----
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  LLM_MODEL: process.env.LLM_MODEL,
  SCRIPT_LLM_PROVIDER: process.env.SCRIPT_LLM_PROVIDER,
  SCRIPT_LLM_MODEL: process.env.SCRIPT_LLM_MODEL,
  VERIFY_LLM_PROVIDER: process.env.VERIFY_LLM_PROVIDER,
  VERIFY_MODEL: process.env.VERIFY_MODEL,
  FACTCHECK_LLM_PROVIDER: process.env.FACTCHECK_LLM_PROVIDER,
  FACTCHECK_LLM_MODEL: process.env.FACTCHECK_LLM_MODEL,

  // ---- existing provider credentials / models ----
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  ANTHROPIC_REQUEST_TIMEOUT_MS: process.env.ANTHROPIC_REQUEST_TIMEOUT_MS,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,

  // ---- NVIDIA NIM ----
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  NVIDIA_BASE_URL: process.env.NVIDIA_BASE_URL,
  NVIDIA_MODEL: process.env.NVIDIA_MODEL,
  NVIDIA_REQUEST_TIMEOUT_MS: process.env.NVIDIA_REQUEST_TIMEOUT_MS,
  NVIDIA_MAX_RETRIES: process.env.NVIDIA_MAX_RETRIES,

  // ---- Z.ai (general-purpose API, NOT the coding-plan endpoint) ----
  ZAI_API_KEY: process.env.ZAI_API_KEY,
  ZAI_BASE_URL: process.env.ZAI_BASE_URL,
  ZAI_MODEL: process.env.ZAI_MODEL,
  ZAI_REQUEST_TIMEOUT_MS: process.env.ZAI_REQUEST_TIMEOUT_MS,
  ZAI_MAX_RETRIES: process.env.ZAI_MAX_RETRIES,

  // ---- xAI (Grok) ----
  XAI_API_KEY: process.env.XAI_API_KEY,
  XAI_BASE_URL: process.env.XAI_BASE_URL,
  XAI_MODEL: process.env.XAI_MODEL,
  XAI_REQUEST_TIMEOUT_MS: process.env.XAI_REQUEST_TIMEOUT_MS,
  XAI_MAX_RETRIES: process.env.XAI_MAX_RETRIES,

  // ---- Moonshot (Kimi) ----
  MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
  MOONSHOT_BASE_URL: process.env.MOONSHOT_BASE_URL,
  MOONSHOT_MODEL: process.env.MOONSHOT_MODEL,
  MOONSHOT_REQUEST_TIMEOUT_MS: process.env.MOONSHOT_REQUEST_TIMEOUT_MS,
  MOONSHOT_MAX_RETRIES: process.env.MOONSHOT_MAX_RETRIES,

  // ---- Google (Gemini, via the OpenAI-compatibility endpoint) ----
  // GEMINI_API_KEY is listed because google.ts accepts it as an alias; a
  // computed read of an alias that is never referenced literally would resolve
  // as unset in the web bundle even with the variable set.
  GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GOOGLE_BASE_URL: process.env.GOOGLE_BASE_URL,
  GOOGLE_MODEL: process.env.GOOGLE_MODEL,
  GOOGLE_REQUEST_TIMEOUT_MS: process.env.GOOGLE_REQUEST_TIMEOUT_MS,
  GOOGLE_MAX_RETRIES: process.env.GOOGLE_MAX_RETRIES,

  // ---- model-id overrides for the profile maps (a wrong catalog id is a
  //      one-variable fix, never a code change) ----
  NVIDIA_MODEL_DEEPSEEK_FLASH: process.env.NVIDIA_MODEL_DEEPSEEK_FLASH,
  NVIDIA_MODEL_DEEPSEEK_PRO: process.env.NVIDIA_MODEL_DEEPSEEK_PRO,
  NVIDIA_MODEL_GLM: process.env.NVIDIA_MODEL_GLM,
  NVIDIA_MODEL_NEMOTRON: process.env.NVIDIA_MODEL_NEMOTRON,
  NVIDIA_MODEL_MISTRAL: process.env.NVIDIA_MODEL_MISTRAL,
  NVIDIA_MODEL_KIMI: process.env.NVIDIA_MODEL_KIMI,
  ZAI_MODEL_GLM_FLASH: process.env.ZAI_MODEL_GLM_FLASH,

  // ---- dialogue challenger (development comparison) ----
  SCRIPT_CHALLENGER_ENABLED: process.env.SCRIPT_CHALLENGER_ENABLED,
  SCRIPT_CHALLENGER_PROVIDER: process.env.SCRIPT_CHALLENGER_PROVIDER,
  SCRIPT_CHALLENGER_MODEL: process.env.SCRIPT_CHALLENGER_MODEL,

  // ---- structured-output / retry tuning ----
  LLM_STRUCTURED_REPAIR_ENABLED: process.env.LLM_STRUCTURED_REPAIR_ENABLED,
  LLM_LOG_REASONING: process.env.LLM_LOG_REASONING,

  // ---- model-specific reasoning controls (see nvidiaRequestProfiles.ts) ----
  NVIDIA_REASONING_EFFORT: process.env.NVIDIA_REASONING_EFFORT,
  NVIDIA_NEMOTRON_REASONING_BUDGET: process.env.NVIDIA_NEMOTRON_REASONING_BUDGET,
  NVIDIA_NEMOTRON_REASONING_BUDGET_RESEARCH: process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_RESEARCH,
  NVIDIA_NEMOTRON_REASONING_BUDGET_VERIFY: process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_VERIFY,
  NVIDIA_NEMOTRON_REASONING_BUDGET_JUDGE: process.env.NVIDIA_NEMOTRON_REASONING_BUDGET_JUDGE,
  // Answer headroom for Z.ai GLM, which bills reasoning against max_tokens.
  ZAI_REASONING_HEADROOM_TOKENS: process.env.ZAI_REASONING_HEADROOM_TOKENS,

  // ---- per-role overrides (step 1 of resolution) ----
  TOPIC_GENERATION_LLM_PROVIDER: process.env.TOPIC_GENERATION_LLM_PROVIDER,
  TOPIC_GENERATION_LLM_MODEL: process.env.TOPIC_GENERATION_LLM_MODEL,
  TOPIC_CLASSIFICATION_LLM_PROVIDER: process.env.TOPIC_CLASSIFICATION_LLM_PROVIDER,
  TOPIC_CLASSIFICATION_LLM_MODEL: process.env.TOPIC_CLASSIFICATION_LLM_MODEL,
  TOPIC_RANKING_LLM_PROVIDER: process.env.TOPIC_RANKING_LLM_PROVIDER,
  TOPIC_RANKING_LLM_MODEL: process.env.TOPIC_RANKING_LLM_MODEL,
  RESEARCH_LLM_PROVIDER: process.env.RESEARCH_LLM_PROVIDER,
  RESEARCH_LLM_MODEL: process.env.RESEARCH_LLM_MODEL,
  EVIDENCE_LLM_PROVIDER: process.env.EVIDENCE_LLM_PROVIDER,
  EVIDENCE_LLM_MODEL: process.env.EVIDENCE_LLM_MODEL,
  SCRIPT_OUTLINE_LLM_PROVIDER: process.env.SCRIPT_OUTLINE_LLM_PROVIDER,
  SCRIPT_OUTLINE_LLM_MODEL: process.env.SCRIPT_OUTLINE_LLM_MODEL,
  // The seven-role writing pipeline. The two HOST WRITER pairs matter most:
  // pointing them at one provider is how an operator collapses the cast into a
  // single voice, and pointing them at two is how the separation is kept.
  SCRIPT_STORY_EDITOR_LLM_PROVIDER: process.env.SCRIPT_STORY_EDITOR_LLM_PROVIDER,
  SCRIPT_STORY_EDITOR_LLM_MODEL: process.env.SCRIPT_STORY_EDITOR_LLM_MODEL,
  SCRIPT_DEBATE_ARCHITECT_LLM_PROVIDER: process.env.SCRIPT_DEBATE_ARCHITECT_LLM_PROVIDER,
  SCRIPT_DEBATE_ARCHITECT_LLM_MODEL: process.env.SCRIPT_DEBATE_ARCHITECT_LLM_MODEL,
  SCRIPT_HOST_A_WRITER_LLM_PROVIDER: process.env.SCRIPT_HOST_A_WRITER_LLM_PROVIDER,
  SCRIPT_HOST_A_WRITER_LLM_MODEL: process.env.SCRIPT_HOST_A_WRITER_LLM_MODEL,
  SCRIPT_HOST_B_WRITER_LLM_PROVIDER: process.env.SCRIPT_HOST_B_WRITER_LLM_PROVIDER,
  SCRIPT_HOST_B_WRITER_LLM_MODEL: process.env.SCRIPT_HOST_B_WRITER_LLM_MODEL,
  SCRIPT_DIALOGUE_DIRECTOR_LLM_PROVIDER: process.env.SCRIPT_DIALOGUE_DIRECTOR_LLM_PROVIDER,
  SCRIPT_DIALOGUE_DIRECTOR_LLM_MODEL: process.env.SCRIPT_DIALOGUE_DIRECTOR_LLM_MODEL,
  SCRIPT_CONTINUITY_EDITOR_LLM_PROVIDER: process.env.SCRIPT_CONTINUITY_EDITOR_LLM_PROVIDER,
  SCRIPT_CONTINUITY_EDITOR_LLM_MODEL: process.env.SCRIPT_CONTINUITY_EDITOR_LLM_MODEL,
  SCRIPT_MOVEMENT_LLM_PROVIDER: process.env.SCRIPT_MOVEMENT_LLM_PROVIDER,
  SCRIPT_MOVEMENT_LLM_MODEL: process.env.SCRIPT_MOVEMENT_LLM_MODEL,
  SCRIPT_VERIFY_LLM_PROVIDER: process.env.SCRIPT_VERIFY_LLM_PROVIDER,
  SCRIPT_VERIFY_LLM_MODEL: process.env.SCRIPT_VERIFY_LLM_MODEL,
  SCRIPT_REWRITE_LLM_PROVIDER: process.env.SCRIPT_REWRITE_LLM_PROVIDER,
  SCRIPT_REWRITE_LLM_MODEL: process.env.SCRIPT_REWRITE_LLM_MODEL,
  CONTINUITY_REPORT_LLM_PROVIDER: process.env.CONTINUITY_REPORT_LLM_PROVIDER,
  CONTINUITY_REPORT_LLM_MODEL: process.env.CONTINUITY_REPORT_LLM_MODEL,
  FACT_CHECK_LLM_PROVIDER: process.env.FACT_CHECK_LLM_PROVIDER,
  FACT_CHECK_LLM_MODEL: process.env.FACT_CHECK_LLM_MODEL,
  SHOW_NOTES_LLM_PROVIDER: process.env.SHOW_NOTES_LLM_PROVIDER,
  SHOW_NOTES_LLM_MODEL: process.env.SHOW_NOTES_LLM_MODEL,
  EPISODE_METADATA_LLM_PROVIDER: process.env.EPISODE_METADATA_LLM_PROVIDER,
  EPISODE_METADATA_LLM_MODEL: process.env.EPISODE_METADATA_LLM_MODEL,
  QUALITY_JUDGE_LLM_PROVIDER: process.env.QUALITY_JUDGE_LLM_PROVIDER,
  QUALITY_JUDGE_LLM_MODEL: process.env.QUALITY_JUDGE_LLM_MODEL,
  // Declared with the cold_open_judge role but missed here at the time. Without
  // these two lines the web bundle resolves the override as unset while the
  // worker resolves it correctly — the exact web/worker split this file exists
  // to prevent, and invisible until an episode is judged by two different models.
  COLD_OPEN_JUDGE_LLM_PROVIDER: process.env.COLD_OPEN_JUDGE_LLM_PROVIDER,
  COLD_OPEN_JUDGE_LLM_MODEL: process.env.COLD_OPEN_JUDGE_LLM_MODEL,
};

/**
 * Read a routing variable.
 *
 * `process.env` is the runtime truth when it HAS the key, including when the
 * value is empty — an operator who blanked a variable means "unset", not "fall
 * back to whatever was baked in at build time". The static snapshot is consulted
 * only for keys the bundler dropped entirely, which is the web-bundle case this
 * module exists for.
 *
 * Empty strings normalize to undefined: `SCRIPT_LLM_PROVIDER=` in a compose file
 * means unset, not "a provider named empty string".
 */
export function readRoutingEnv(key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) {
    const live = process.env[key];
    return live && live !== "" ? live : undefined;
  }
  const snap = SNAPSHOT[key];
  return snap && snap !== "" ? snap : undefined;
}

/** Every key this module statically references. Used by the routing tests. */
export function routingEnvKeys(): string[] {
  return Object.keys(SNAPSHOT);
}

/** The two override keys for a role, in the exact spelling operators set. */
export function roleOverrideKeys(role: (typeof ALL_ROLES)[number]): {
  providerKey: string;
  modelKey: string;
} {
  const prefix = ROLE_DEFINITIONS[role].envPrefix;
  return { providerKey: `${prefix}_LLM_PROVIDER`, modelKey: `${prefix}_LLM_MODEL` };
}
