import { getRedisUrl, getNewsProvider } from "@/lib/env";

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
  ELEVENLABS_DR_LINEBREAK_VOICE_ID: process.env.ELEVENLABS_DR_LINEBREAK_VOICE_ID,
  ELEVENLABS_MAX_VOLTAGE_VOICE_ID: process.env.ELEVENLABS_MAX_VOLTAGE_VOICE_ID,
  ELEVENLABS_MODEL: process.env.ELEVENLABS_MODEL,
  FISH_API_KEY: process.env.FISH_API_KEY,
  FISH_MODEL: process.env.FISH_MODEL,
  FISH_SCENE_MODEL: process.env.FISH_SCENE_MODEL,
  LLM_PROVIDER: process.env.LLM_PROVIDER,
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

  // 5. Providers Specifics
  const ttsProvider = (process.env.TTS_PROVIDER || "fish").trim().toLowerCase();
  checkRequired("TTS_PROVIDER");
  if (ttsProvider === "fish") {
    checkRequired("FISH_API_KEY", true);
    // Both model vars have working code defaults (FISH_MODEL -> s2.1-pro-free
    // for single lines, FISH_SCENE_MODEL -> s2-pro for multi-speaker scenes),
    // so leaving them unset is legitimate — warn, never fail.
    checkOptional("FISH_MODEL");
    checkOptional("FISH_SCENE_MODEL");
    checkOptional("ELEVENLABS_API_KEY", true);
    checkOptional("BOSON_API_KEY", true);
    checkOptional("CARTESIA_API_KEY", true);
  } else if (ttsProvider === "elevenlabs") {
    checkRequired("ELEVENLABS_API_KEY", true);
    checkRequired("ELEVENLABS_MODEL");
    checkRequired("ELEVENLABS_MAX_VOLTAGE_VOICE_ID");
    checkRequired("ELEVENLABS_DR_LINEBREAK_VOICE_ID");
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
