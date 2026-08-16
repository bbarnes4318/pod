import { getRedisUrl, getNewsProvider } from "@/lib/env";
import {
  RoleRouteReport,
  credentialVarFor,
  legacyFallbackAllowed,
  legacyFallbackExplicit,
  providerCredentialPresent,
  providersInActiveRouting,
  roleRouteReport,
} from "@/lib/providers/llm/routing";
import { modelCapabilities, verificationState } from "@/lib/providers/llm/capabilities";
import { activeRoutingProfile, routingProfileIsUnrecognized } from "@/lib/providers/llm/profiles";
import { activeDeploymentStage, stageAdvisory } from "@/lib/providers/llm/deploymentStage";
import { currentEnvNameProblems } from "./envNameGuard";

export interface EnvCheck {
  key: string;
  status: "pass" | "fail" | "warning";
  value: string;
  message?: string;
}

export interface ReadinessResult {
  passed: boolean;
  checks: EnvCheck[];
}

/**
 * Statically-referenced snapshot of every variable this checklist inspects.
 *
 * WHY THIS EXISTS: Next.js inlines `process.env` into the server bundle at
 * build time. A LITERAL read (`process.env.REDIS_URL`) is substituted with the
 * real value, but a COMPUTED read (`process.env[key]`) can only find variables
 * that are ALSO referenced literally somewhere in that same bundle. Keys used
 * exclusively by the worker — FISH_API_KEY, ANTHROPIC_API_KEY — are never
 * referenced literally in anything the web app bundles, so `process.env[key]`
 * returned undefined for them and readiness reported MISSING for keys that
 * were demonstrably present in the container (`env | grep` showed them).
 *
 * Listing each name literally here forces it into the bundle. Any key added to
 * a checkRequired/checkOptional call MUST be added here too, or it will
 * silently read as missing in production while working fine in local dev
 * (where there is no bundler and process.env is the real thing).
 */
const ENV_SNAPSHOT: Record<string, string | undefined> = {
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ADMIN_USERNAME: process.env.ADMIN_USERNAME,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  AUDIO_STITCH_WORKER_CONCURRENCY: process.env.AUDIO_STITCH_WORKER_CONCURRENCY,
  BALLDONTLIE_API_KEY: process.env.BALLDONTLIE_API_KEY,
  BOSON_API_KEY: process.env.BOSON_API_KEY,
  BOSON_TTS_MODEL: process.env.BOSON_TTS_MODEL,
  BOSON_TTS_VOICE: process.env.BOSON_TTS_VOICE,
  CARTESIA_API_KEY: process.env.CARTESIA_API_KEY,
  CONTENT_WORKER_CONCURRENCY: process.env.CONTENT_WORKER_CONCURRENCY,
  DATABASE_URL: process.env.DATABASE_URL,
  DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  ELEVENLABS_HOST_A_VOICE_ID: process.env.ELEVENLABS_HOST_A_VOICE_ID,
  ELEVENLABS_HOST_B_VOICE_ID: process.env.ELEVENLABS_HOST_B_VOICE_ID,
  ELEVENLABS_MODEL: process.env.ELEVENLABS_MODEL,
  FISH_API_KEY: process.env.FISH_API_KEY,
  FISH_HOST_A_VOICE_ID: process.env.FISH_HOST_A_VOICE_ID,
  FISH_HOST_B_VOICE_ID: process.env.FISH_HOST_B_VOICE_ID,
  FISH_MODEL: process.env.FISH_MODEL,
  FISH_SCENE_MODEL: process.env.FISH_SCENE_MODEL,
  LLM_PROVIDER: process.env.LLM_PROVIDER,
  LLM_MODEL: process.env.LLM_MODEL,
  // Role-based routing. Same bundling rule as everything else in this snapshot:
  // a literal reference here is what lets the web app see a worker-set variable.
  LLM_ROUTING_PROFILE: process.env.LLM_ROUTING_PROFILE,
  LLM_ALLOW_LEGACY_FALLBACK: process.env.LLM_ALLOW_LEGACY_FALLBACK,
  APP_DEPLOYMENT_STAGE: process.env.APP_DEPLOYMENT_STAGE,
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  NVIDIA_BASE_URL: process.env.NVIDIA_BASE_URL,
  ZAI_API_KEY: process.env.ZAI_API_KEY,
  ZAI_BASE_URL: process.env.ZAI_BASE_URL,
  VERIFY_LLM_PROVIDER: process.env.VERIFY_LLM_PROVIDER,
  VERIFY_MODEL: process.env.VERIFY_MODEL,
  NEWS_PROVIDER: process.env.NEWS_PROVIDER,
  NEWS_RSS_FEEDS: process.env.NEWS_RSS_FEEDS,
  NODE_ENV: process.env.NODE_ENV,
  ODDS_API_KEY: process.env.ODDS_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  PODCAST_IMAGE_URL: process.env.PODCAST_IMAGE_URL,
  RSS_NEWS_FEEDS: process.env.RSS_NEWS_FEEDS,
  RSS_PREVIEW_TOKEN: process.env.RSS_PREVIEW_TOKEN,
  RSS_WORKER_CONCURRENCY: process.env.RSS_WORKER_CONCURRENCY,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_BUCKET: process.env.S3_BUCKET,
  S3_ENDPOINT: process.env.S3_ENDPOINT,
  S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL,
  S3_REGION: process.env.S3_REGION,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  SCRIPT_LLM_MODEL: process.env.SCRIPT_LLM_MODEL,
  SCRIPT_LLM_PROVIDER: process.env.SCRIPT_LLM_PROVIDER,
  SPORTSDATAIO_API_KEY: process.env.SPORTSDATAIO_API_KEY,
  SPORTS_PROVIDER: process.env.SPORTS_PROVIDER,
  STORAGE_PROVIDER: process.env.STORAGE_PROVIDER,
  TTS_PROVIDER: process.env.TTS_PROVIDER,
  TTS_WORKER_CONCURRENCY: process.env.TTS_WORKER_CONCURRENCY,
  WORKER_CONCURRENCY: process.env.WORKER_CONCURRENCY,
};

/** Read a variable by name, preferring the statically-bundled snapshot. */
function readEnv(key: string): string | undefined {
  const snapshot = ENV_SNAPSHOT[key];
  if (snapshot !== undefined) return snapshot;
  return process.env[key];
}

export function isPlaceholderValue(val: string | undefined): boolean {
  if (!val) return false;
  const normalized = val.trim().toUpperCase();
  return (
    normalized === "CHANGE_ME" ||
    normalized === "CHANGE_ME_IN_COOLIFY_ONLY" ||
    normalized === "SET_IN_COOLIFY_ONLY" ||
    normalized === "SET_YOUR_REAL_KEY_IN_COOLIFY" ||
    normalized === "SET_YOUR_REAL_SECRET_IN_COOLIFY" ||
    normalized === "YOUR_KEY_HERE" ||
    normalized === "YOUR_SECRET_HERE" ||
    normalized === "PASTE_KEY_HERE" ||
    normalized === "PASTE_SECRET_HERE"
  );
}

export function maskSecretValue(val: string | undefined): string {
  if (!val) return "MISSING";
  if (isPlaceholderValue(val)) return "PLACEHOLDER (INVALID)";
  if (val.length <= 8) return "[MASKED]";
  return `${val.slice(0, 4)}...${val.slice(-4)}`;
}

export function getRequiredProductionEnvChecklist(): EnvCheck[] {
  const checks: EnvCheck[] = [];

  const checkRequired = (key: string, sensitive = false) => {
    const val = readEnv(key);
    const isPlaceholder = isPlaceholderValue(val);
    if (!val || val.trim() === "") {
      checks.push({ key, status: "fail", value: "MISSING", message: `Required variable ${key} is missing.` });
    } else if (isPlaceholder) {
      checks.push({ key, status: "fail", value: "PLACEHOLDER", message: `Required variable ${key} still has a placeholder value.` });
    } else {
      checks.push({ key, status: "pass", value: sensitive ? maskSecretValue(val) : val });
    }
  };

  const checkOptional = (key: string, sensitive = false) => {
    const val = readEnv(key);
    const isPlaceholder = isPlaceholderValue(val);
    if (!val || val.trim() === "") {
      checks.push({ key, status: "warning", value: "MISSING", message: `Optional variable ${key} is missing.` });
    } else if (isPlaceholder) {
      checks.push({ key, status: "warning", value: "PLACEHOLDER", message: `Optional variable ${key} still has a placeholder value.` });
    } else {
      checks.push({ key, status: "pass", value: sensitive ? maskSecretValue(val) : val });
    }
  };

  // 1. Basic App Config
  checkRequired("NODE_ENV");
  checkRequired("ADMIN_USERNAME");
  
  // ADMIN_PASSWORD checklist
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass || adminPass.trim() === "" || isPlaceholderValue(adminPass)) {
    checks.push({ key: "ADMIN_PASSWORD", status: "fail", value: adminPass || "MISSING", message: "ADMIN_PASSWORD must be configured in production." });
  } else {
    checks.push({ key: "ADMIN_PASSWORD", status: "pass", value: "[MASKED]" });
  }

  // 2. Postgres & Redis
  checkRequired("DATABASE_URL", true);
  
  const resolvedRedisUrl = getRedisUrl();
  if (!resolvedRedisUrl || isPlaceholderValue(resolvedRedisUrl)) {
    checks.push({ key: "REDIS_URL", status: "fail", value: "MISSING", message: "Required variable REDIS_URL is missing." });
  } else {
    let masked = resolvedRedisUrl;
    try {
      const urlObj = new URL(resolvedRedisUrl);
      if (urlObj.password) {
        urlObj.password = "[MASKED]";
      }
      if (urlObj.username) {
        urlObj.username = "[MASKED]";
      }
      masked = urlObj.toString();
    } catch (_) {
      masked = "[INVALID_URL]";
    }
    checks.push({ key: "REDIS_URL", status: "pass", value: masked });
  }

  // Concurrencies
  checkOptional("WORKER_CONCURRENCY");
  checkOptional("TTS_WORKER_CONCURRENCY");
  checkOptional("AUDIO_STITCH_WORKER_CONCURRENCY");
  checkOptional("CONTENT_WORKER_CONCURRENCY");
  checkOptional("RSS_WORKER_CONCURRENCY");

  // 3. S3 Configuration
  checkRequired("STORAGE_PROVIDER");
  checkRequired("S3_ENDPOINT");
  checkRequired("S3_REGION");
  checkRequired("S3_BUCKET");
  checkRequired("S3_ACCESS_KEY_ID", true);
  checkRequired("S3_SECRET_ACCESS_KEY", true);
  checkRequired("S3_PUBLIC_BASE_URL");

  // 4. LLM — validate the keys the CONFIGURED provider actually needs. The
  // chain is SCRIPT_LLM_PROVIDER (script writing) > LLM_PROVIDER (everything
  // else), so both are resolved and every provider in play gets checked.
  checkRequired("LLM_PROVIDER");
  const baseLlm = (process.env.LLM_PROVIDER || "").trim().toLowerCase();
  const scriptLlm = (process.env.SCRIPT_LLM_PROVIDER || baseLlm).trim().toLowerCase();
  const llmProviders = new Set([baseLlm, scriptLlm].filter(Boolean));
  if (llmProviders.has("anthropic")) {
    checkRequired("ANTHROPIC_API_KEY", true);
    checkRequired("ANTHROPIC_MODEL");
  }
  if (llmProviders.has("openai")) {
    checkRequired("OPENAI_API_KEY", true);
    checkRequired("OPENAI_MODEL");
  }
  if (llmProviders.has("stub")) {
    checks.push({ key: "LLM_PROVIDER", status: "fail", value: "stub", message: "LLM_PROVIDER=stub is not a real provider — set anthropic in production." });
  }

  // 4b. ROLE-BASED ROUTING. Validates the credentials the ACTIVE profile needs
  // and reports the resolved role map's health. Never prints a credential.
  checks.push(...getLlmRoutingChecks());

  // 5. Providers Specifics
  const ttsProvider = (process.env.TTS_PROVIDER || "fish").trim().toLowerCase();
  checkRequired("TTS_PROVIDER");
  if (ttsProvider === "fish") {
    checkRequired("FISH_API_KEY", true);
    // Both model vars have working code defaults (FISH_MODEL and scene
    // generation both default to s2.1-pro-free; Pro is an explicit opt-in),
    // so leaving them unset is legitimate — warn, never fail.
    checkOptional("FISH_MODEL");
    checkOptional("FISH_SCENE_MODEL");
    // Seat-keyed voices. Optional because the seeded hosts carry their own
    // reference ids; setting them is what guarantees a roster change cannot
    // drop a chair onto the shared FISH_TTS_VOICE.
    checkOptional("FISH_HOST_A_VOICE_ID");
    checkOptional("FISH_HOST_B_VOICE_ID");
    checkOptional("ELEVENLABS_API_KEY", true);
    checkOptional("BOSON_API_KEY", true);
    checkOptional("CARTESIA_API_KEY", true);
  } else if (ttsProvider === "elevenlabs") {
    checkRequired("ELEVENLABS_API_KEY", true);
    checkRequired("ELEVENLABS_MODEL");
    // ElevenLabs has no safe default voice, so both chairs must be set.
    checkRequired("ELEVENLABS_HOST_A_VOICE_ID");
    checkRequired("ELEVENLABS_HOST_B_VOICE_ID");
    checkOptional("BOSON_API_KEY", true);
    checkOptional("CARTESIA_API_KEY", true);
  } else if (ttsProvider === "boson") {
    checkRequired("BOSON_API_KEY", true);
    checkRequired("BOSON_TTS_MODEL");
    checkRequired("BOSON_TTS_VOICE");
    checkOptional("ELEVENLABS_API_KEY", true);
    checkOptional("CARTESIA_API_KEY", true);
  } else if (ttsProvider === "cartesia") {
    checkRequired("CARTESIA_API_KEY", true);
    checkOptional("ELEVENLABS_API_KEY", true);
    checkOptional("BOSON_API_KEY", true);
  } else {
    checkOptional("ELEVENLABS_API_KEY", true);
    checkOptional("BOSON_API_KEY", true);
    checkOptional("CARTESIA_API_KEY", true);
  }

  // Sports provider readiness. api-sports was never implemented (no adapter, no
  // factory case) — the old check pointed at a phantom API_SPORTS_KEY. Validate
  // the providers that actually exist instead.
  const sportsProvider = (process.env.SPORTS_PROVIDER || "").trim().toLowerCase();
  checkRequired("SPORTS_PROVIDER");
  if (sportsProvider === "sportsdataio") {
    checkRequired("SPORTSDATAIO_API_KEY", true);
  } else if (sportsProvider === "oddsapi") {
    checkRequired("ODDS_API_KEY", true);
  } else if (sportsProvider === "rss-news" || sportsProvider === "rss") {
    checkRequired("NEWS_RSS_FEEDS");
  } else if (sportsProvider === "stub") {
    checks.push({ key: "SPORTS_PROVIDER", status: "fail", value: "stub", message: "SPORTS_PROVIDER=stub is not a real provider — set sportsdataio in production." });
  } else if (sportsProvider) {
    checks.push({ key: "SPORTS_PROVIDER", status: "fail", value: sportsProvider, message: `Unsupported SPORTS_PROVIDER '${sportsProvider}' — no adapter implemented. Use sportsdataio (recommended) or oddsapi.` });
  }

  // 6. Preview Token
  const previewToken = process.env.RSS_PREVIEW_TOKEN;
  if (!previewToken || previewToken.trim() === "" || isPlaceholderValue(previewToken)) {
    checks.push({ key: "RSS_PREVIEW_TOKEN", status: "fail", value: previewToken || "MISSING", message: "RSS_PREVIEW_TOKEN must be configured for draft access." });
  } else {
    checks.push({ key: "RSS_PREVIEW_TOKEN", status: "pass", value: "[MASKED]" });
  }

  // 7. HTTPS Production URL Checks
  const isProduction = process.env.NODE_ENV === "production";
  
  const checkHttpsUrl = (key: string) => {
    const val = process.env[key];
    if (!val) {
      checks.push({ key, status: "fail", value: "MISSING", message: `${key} is missing.` });
    } else {
      const startsWithHttps = val.startsWith("https://");
      if (isProduction && !startsWithHttps) {
        checks.push({ key, status: "fail", value: val, message: `${key} must start with https:// in production.` });
      } else {
        checks.push({ key, status: "pass", value: val });
      }
    }
  };

  // 6b. ENVIRONMENT VARIABLE NAMES.
  //
  // Checked BEFORE the value checks below, because a malformed NAME does not
  // produce a bad value — it stops the deployment before any value exists. On
  // 2026-08-16 a variable called `CEREBRAS API KEY` broke `source` and
  // `--build-arg` at once, and Coolify's failure handler removed the running web
  // container: a typo in a text field took the site down with a 503.
  //
  // Names only. No value is read or reported, so this is safe against the full
  // environment including credentials.
  const nameProblems = currentEnvNameProblems();
  if (nameProblems.length === 0) {
    checks.push({ key: "ENV_VARIABLE_NAMES", status: "pass", value: `${Object.keys(process.env).length} names valid` });
  } else {
    for (const problem of nameProblems) {
      checks.push({
        key: "ENV_VARIABLE_NAMES",
        status: "fail",
        value: problem.key,
        message: `Environment variable "${problem.key}" ${problem.reason} Rename it before the next deploy.`,
      });
    }
  }

  checkHttpsUrl("APP_BASE_URL");
  checkHttpsUrl("NEXT_PUBLIC_APP_BASE_URL");
  checkHttpsUrl("PODCAST_SITE_URL");
  checkHttpsUrl("PODCAST_RSS_URL");

  // Cookie Secure
  const cookieSecure = process.env.COOKIE_SECURE;
  if (isProduction && cookieSecure !== "true") {
    checks.push({ key: "COOKIE_SECURE", status: "fail", value: cookieSecure || "false", message: "COOKIE_SECURE must be set to 'true' in production." });
  } else {
    checks.push({ key: "COOKIE_SECURE", status: "pass", value: cookieSecure || "false" });
  }

  // 8. Integration API keys & RSS news configurations
  checkRequired("NEWS_PROVIDER");

  // ODDS_API_KEY check
  const oddsKey = process.env.ODDS_API_KEY;
  const legacyOddsKey1 = process.env.THE_ODDS_API_KEY;
  const legacyOddsKey2 = process.env.THEODDSAPI_API_KEY;

  if (oddsKey && oddsKey.trim() !== "" && !isPlaceholderValue(oddsKey)) {
    checks.push({ key: "ODDS_API_KEY", status: "pass", value: "CONFIGURED" });
  } else if ((legacyOddsKey1 && legacyOddsKey1.trim() !== "" && !isPlaceholderValue(legacyOddsKey1)) ||
             (legacyOddsKey2 && legacyOddsKey2.trim() !== "" && !isPlaceholderValue(legacyOddsKey2))) {
    checks.push({ key: "ODDS_API_KEY", status: "pass", value: "LEGACY DETECTED", message: "Using legacy environment variable fallback." });
  } else {
    checks.push({ key: "ODDS_API_KEY", status: "warning", value: "MISSING", message: "ODDS_API_KEY is missing." });
  }

  // NEWS_RSS_FEEDS. This was a hard FAIL whenever the variable was absent,
  // which is wrong twice over: the block's own message claims it is "required
  // when NEWS_PROVIDER is 'rss'" but it never read NEWS_PROVIDER, and more
  // importantly getRssNewsFeeds() falls back to the curated
  // DEFAULT_NEWS_RSS_FEEDS list, so an absent variable is a supported,
  // working configuration — not a deployment blocker. Operators who
  // deliberately drop the variable were being told production was broken.
  const rssFeeds = process.env.NEWS_RSS_FEEDS;
  const legacyRssFeeds = process.env.RSS_NEWS_FEEDS;
  const newsProvider = getNewsProvider();

  if (rssFeeds && rssFeeds.trim() !== "") {
    checks.push({ key: "NEWS_RSS_FEEDS", status: "pass", value: "CONFIGURED" });
  } else if (legacyRssFeeds && legacyRssFeeds.trim() !== "") {
    checks.push({ key: "NEWS_RSS_FEEDS", status: "pass", value: "LEGACY DETECTED", message: "Using legacy RSS_NEWS_FEEDS environment variable fallback." });
  } else if (newsProvider === "rss") {
    checks.push({ key: "NEWS_RSS_FEEDS", status: "pass", value: "USING BUILT-IN DEFAULTS", message: "Unset — falling back to the curated DEFAULT_NEWS_RSS_FEEDS list. Set NEWS_RSS_FEEDS only to override those feeds." });
  } else {
    checks.push({ key: "NEWS_RSS_FEEDS", status: "pass", value: "NOT APPLICABLE", message: `Not required — NEWS_PROVIDER is '${newsProvider}', not 'rss'.` });
  }

  checkOptional("BALLDONTLIE_API_KEY", true);
  checkOptional("DEEPGRAM_API_KEY", true);
  checkOptional("CARTESIA_API_KEY", true);
  checkOptional("PODCAST_IMAGE_URL");

  return checks;
}

export interface LlmRoutingReadiness {
  profile: string;
  stage: string;
  /** Advisory for hosted trial endpoints at APP_DEPLOYMENT_STAGE=live. */
  advisory: string | null;
  /** Whether paid Anthropic/OpenAI fallback may be used. */
  paidFallbackAllowed: boolean;
  /** One row per role: primary / secondary / legacy backup / status. */
  roles: RoleRouteReport[];
  /** Providers the active profile would actually call. */
  providers: string[];
}

/**
 * The resolved role map, for the readiness API and the admin configuration page.
 *
 * Reports only NAMES and verdicts — a credential's presence, never its value.
 */
export function getLlmRoutingReadiness(): LlmRoutingReadiness {
  const providers = providersInActiveRouting();
  const advisory = stageAdvisory(providers);
  return {
    profile: activeRoutingProfile(),
    stage: activeDeploymentStage(),
    advisory: advisory.message,
    paidFallbackAllowed: legacyFallbackAllowed(),
    roles: roleRouteReport(),
    providers,
  };
}

/**
 * Readiness checks for role-based routing.
 *
 * Deliberate severities:
 *  - A missing credential for a provider the ACTIVE profile calls is a FAIL:
 *    that role will burn its way down the chain on every request.
 *  - APP_DEPLOYMENT_STAGE=live with hosted trial endpoints is a WARNING and
 *    nothing more. The launch decision is the operator's; this code never
 *    disables or re-routes a provider on its own.
 *  - An unrecognized LLM_ROUTING_PROFILE value is a FAIL, because it silently
 *    resolves to legacy and an operator who typed "frontier-development"
 *    (hyphen) would otherwise believe the new routing was live.
 */
export function getLlmRoutingChecks(): EnvCheck[] {
  const checks: EnvCheck[] = [];
  const profile = activeRoutingProfile();
  const stage = activeDeploymentStage();

  const bad = routingProfileIsUnrecognized();
  if (bad.unrecognized) {
    checks.push({
      key: "LLM_ROUTING_PROFILE",
      status: "fail",
      value: bad.raw,
      message:
        `'${bad.raw}' is not a routing profile, so routing fell back to 'legacy'. ` +
        `Valid values: legacy, frontier_development, free_independent, custom.`,
    });
  } else {
    checks.push({
      key: "LLM_ROUTING_PROFILE",
      status: "pass",
      value: profile,
      message:
        profile === "legacy"
          ? "Legacy routing: every role uses the existing LLM_* / SCRIPT_LLM_* / VERIFY_* configuration, exactly as before."
          : `Role-based routing active under the '${profile}' profile.`,
    });
  }

  checks.push({
    key: "APP_DEPLOYMENT_STAGE",
    status: "pass",
    value: stage,
    message:
      stage === "live"
        ? "Live stage: hosted trial endpoints are still permitted; see the advisory in the routing panel."
        : `${stage}: hosted NVIDIA NIM and Z.ai endpoints are fully permitted.`,
  });

  // Paid fallback: FORBIDDEN by default. Reported with which mode is in force,
  // because the two modes answer different questions and mixing them up is how a
  // model-comparison run ends up measuring Anthropic.
  const paidAllowed = legacyFallbackAllowed();
  const paidExplicit = legacyFallbackExplicit();
  checks.push({
    key: "LLM_ALLOW_LEGACY_FALLBACK",
    status: "pass",
    value: paidAllowed ? "true (resilient mode)" : paidExplicit ? "false (comparison mode)" : "unset → false (comparison mode, default)",
    message: paidAllowed
      ? "RESILIENT MODE: after the free candidates fail, the role-appropriate paid provider runs. Every paid call is logged with a full audit record. Use this for full-pipeline runs where finishing the episode matters more than isolating the candidate."
      : "COMPARISON MODE (default): a role that exhausts its free candidates FAILS instead of being quietly rescued by Anthropic. This is what makes an A/B result trustworthy. Set LLM_ALLOW_LEGACY_FALLBACK=true for resilient runs.",
  });

  // Credentials for the providers this profile actually calls.
  for (const provider of providersInActiveRouting()) {
    if (provider === "stub") continue;
    const key = credentialVarFor(provider);
    const present = providerCredentialPresent(provider);
    checks.push({
      key,
      status: present ? "pass" : "fail",
      value: present ? maskSecretValue(process.env[key]) : "MISSING",
      message: present
        ? undefined
        : `The '${profile}' profile routes at least one role to ${provider}, but ${key} is not set (or is a placeholder). ` +
          `Those roles will fall through to their next candidate on every request.`,
    });
  }

  // Role map health, summarized. The full per-role table is in the panel.
  const roles = roleRouteReport().filter((r) => r.hasCallSite);
  const unroutable = roles.filter((r) => r.status === "unroutable");
  const degraded = roles.filter((r) => r.status === "degraded");
  if (unroutable.length > 0) {
    checks.push({
      key: "LLM_ROLE_MAP",
      status: "fail",
      value: `${unroutable.length} UNROUTABLE`,
      message: `No usable candidate for: ${unroutable.map((r) => r.role).join(", ")}.`,
    });
  } else if (degraded.length > 0) {
    checks.push({
      key: "LLM_ROLE_MAP",
      status: "warning",
      value: `${degraded.length} degraded`,
      message: `Running on a reduced candidate chain: ${degraded.map((r) => r.role).join(", ")}.`,
    });
  } else {
    checks.push({
      key: "LLM_ROLE_MAP",
      status: "pass",
      value: `${roles.length} roles ready`,
      message: `Every wired role has a usable provider under the '${profile}' profile.`,
    });
  }

  // Catalog verification vs LIVE verification, reported separately. A
  // catalog-verified model with unverified request parameters is the normal
  // starting state and must not read as "validated".
  const routedModels = new Map<string, ReturnType<typeof modelCapabilities>>();
  for (const r of roleRouteReport()) {
    // Include the models the availability filter REMOVED, or the census would
    // report "0 unreachable" precisely because they were taken out of the chains.
    for (const f of r.filteredUnavailable) {
      const [provider, ...rest] = f.key.split("/");
      const model = rest.join("/");
      if (model) routedModels.set(f.key, modelCapabilities(provider, model));
    }
    for (const c of r.candidates) {
      const [provider, ...rest] = c.key.split("/");
      const model = rest.join("/");
      if (!model || model === "(provider-default)") continue;
      routedModels.set(c.key, modelCapabilities(provider, model));
    }
  }
  // The FIVE states, reported separately. "the endpoint answered" and "the model
  // is good at its job" are different claims and are never merged here.
  const byState = new Map<string, string[]>();
  for (const [key, caps] of routedModels.entries()) {
    const state = verificationState(caps);
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state)!.push(key);
  }
  const inState = (state: string) => byState.get(state) ?? [];
  const validated = inState("live-contract-passed");
  const untested = inState("not-quality-tested");
  const catalogOnly = inState("catalog-available");
  const liveFailed = inState("live-contract-failed");
  const noAccount = inState("unavailable-for-account");
  // Reported separately from liveFailed: "the provider throttled us" and "the
  // probe and production disagree" need different responses from the operator.
  const prodBroken = inState("broken-in-production");
  // Permanent, unlike every other non-routable state — worth its own line so an
  // operator does not go looking for a probe to re-run.
  const retired = inState("retired");

  const detail =
    (validated.length ? `LIVE CONTRACT PASSED and quality-tested: ${validated.join(", ")}. ` : "") +
    (untested.length
      ? `LIVE CONTRACT PASSED but NOT YET QUALITY-TESTED — the endpoint and its request fields work; nothing has ` +
        `measured whether the model is good at its role: ${untested.join(", ")}. `
      : "") +
    (catalogOnly.length
      ? `CATALOG AVAILABLE, live contract never attempted: ${catalogOnly.join(", ")}. `
      : "") +
    (liveFailed.length
      ? `LIVE CONTRACT FAILED (the endpoint would not serve this account) — REMOVED from the default chains, reachable ` +
        `only via an explicit role override: ${liveFailed.join(", ")}. `
      : "") +
    (noAccount.length
      ? `UNAVAILABLE FOR THIS ACCOUNT (the ID does not resolve for the credential in use) — REMOVED from the default ` +
        `chains, reachable only via an explicit role override: ${noAccount.join(", ")}. `
      : "") +
    (prodBroken.length
      ? `BROKEN IN PRODUCTION (a contract probe passed, but real pipeline traffic failed on every attempt) — REMOVED ` +
        `from the default chains, reachable only via an explicit role override: ${prodBroken.join(", ")}. `
      : "") +
    (retired.length
      ? `RETIRED BY THE PROVIDER (end of life, 410 Gone) — PERMANENTLY removed from every chain; no probe will bring ` +
        `these back and any role still naming one needs a different model: ${retired.join(", ")}. `
      : "");

  checks.push({
    key: "LLM_MODEL_VERIFICATION",
    status:
      liveFailed.length > 0 ||
      noAccount.length > 0 ||
      prodBroken.length > 0 ||
      retired.length > 0 ||
      untested.length > 0 ||
      catalogOnly.length > 0
        ? "warning"
        : "pass",
    value:
      `${validated.length} live+quality, ${untested.length} live but untested, ` +
      `${catalogOnly.length} catalog-only, ` +
      `${liveFailed.length + noAccount.length + prodBroken.length + retired.length} unreachable`,
    message:
      detail +
      "Re-run `npm run probe:llm-contract` after a credential rotation, and `npm run test:role-experiments` to turn " +
      '"live but untested" into quality evidence. A model is never "validated" on an HTTP 200 alone.',
  });

  const advisory = stageAdvisory(providersInActiveRouting());
  if (advisory.message) {
    checks.push({
      key: "LLM_TRIAL_ENDPOINTS",
      status: "warning",
      value: "ADVISORY",
      message: advisory.message,
    });
  }

  return checks;
}

export function validateProviderSelection(): { valid: boolean; messages: string[] } {
  const messages: string[] = [];
  const llm = process.env.LLM_PROVIDER || "stub";
  const tts = process.env.TTS_PROVIDER || "stub";
  const sports = process.env.SPORTS_PROVIDER || "stub";

  if (llm === "stub") {
    messages.push("LLM_PROVIDER is set to 'stub'. Make sure this is updated to a real provider in production.");
  }
  if (tts === "stub") {
    messages.push("TTS_PROVIDER is set to 'stub'. Make sure this is updated to a real provider in production.");
  }
  if (sports === "stub") {
    messages.push("SPORTS_PROVIDER is set to 'stub'. Make sure this is updated to a real provider in production.");
  }

  return {
    valid: messages.length === 0,
    messages,
  };
}

export function validateProductionReadiness(): ReadinessResult {
  const checks = getRequiredProductionEnvChecklist();
  const passed = !checks.some((c) => c.status === "fail");
  return {
    passed,
    checks,
  };
}
