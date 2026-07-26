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
};

/**
 * Read a routing variable. Prefers the live process value (so a test or a
 * worker that mutates process.env at runtime is honored), then the statically
 * bundled snapshot (so the web bundle can see worker-only keys).
 *
 * Empty strings normalize to undefined: `SCRIPT_LLM_PROVIDER=` in a compose
 * file means "unset", not "a provider named empty string".
 */
export function readRoutingEnv(key: string): string | undefined {
  const live = process.env[key];
  if (live !== undefined && live !== "") return live;
  const snap = SNAPSHOT[key];
  if (snap !== undefined && snap !== "") return snap;
  return undefined;
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
