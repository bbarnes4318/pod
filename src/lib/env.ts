import "server-only";
import Redis from "ioredis";

/**
 * Checks if a value is a generic placeholder.
 */
function isPlaceholder(val: string | undefined): boolean {
  if (!val) return false;
  const norm = val.trim().toUpperCase();
  return (
    norm === "CHANGE_ME" ||
    norm === "CHANGE_ME_IN_COOLIFY_ONLY" ||
    norm === "SET_IN_COOLIFY_ONLY" ||
    norm === "SET_YOUR_REAL_KEY_IN_COOLIFY" ||
    norm === "SET_YOUR_REAL_SECRET_IN_COOLIFY" ||
    norm === "YOUR_KEY_HERE" ||
    norm === "YOUR_SECRET_HERE" ||
    norm === "PASTE_KEY_HERE" ||
    norm === "PASTE_SECRET_HERE" ||
    norm === "YOUR-THEODDSAPI-API-KEY" ||
    norm === "YOUR-SPORTSDATAIO-API-KEY"
  );
}

/**
 * Returns the resolved Odds API key checking canonical and legacy fallback variables.
 */
export function getOddsApiKey(): string {
  const key = process.env.ODDS_API_KEY || process.env.THEODDSAPI_API_KEY || process.env.THE_ODDS_API_KEY || "";
  return key.trim();
}

/**
 * Returns the Odds API Key status: CONFIGURED or MISSING.
 */
export function getOddsApiKeyStatus(): "CONFIGURED" | "MISSING" {
  const key = getOddsApiKey();
  if (!key || isPlaceholder(key)) {
    return "MISSING";
  }
  return "CONFIGURED";
}

/**
 * Returns the configured news provider (default is "rss").
 */
export function getNewsProvider(): string {
  return (process.env.NEWS_PROVIDER || "rss").trim().toLowerCase();
}

/**
 * Parses and returns a clean list of valid RSS feed URLs.
 */
export function getRssNewsFeeds(): string[] {
  const rawFeeds = process.env.NEWS_RSS_FEEDS || process.env.RSS_NEWS_FEEDS || "";
  if (!rawFeeds) return [];

  return rawFeeds
    .split(",")
    .map((feed) => feed.trim())
    .filter((feed) => {
      if (feed.length === 0) return false;
      try {
        const url = new URL(feed);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch (_) {
        return false;
      }
    });
}

/**
 * Returns the RSS feed URL status: CONFIGURED or MISSING.
 */
export function getRssFeedStatus(): "CONFIGURED" | "MISSING" {
  const provider = getNewsProvider();
  if (provider !== "rss") {
    return "MISSING";
  }
  const feeds = getRssNewsFeeds();
  if (feeds.length === 0) {
    return "MISSING";
  }
  return "CONFIGURED";
}

/**
 * Returns the configured sports data provider (default is "stub").
 */
export function getSportsProvider(): string {
  return (process.env.SPORTS_PROVIDER || "stub").trim().toLowerCase();
}

/**
 * Returns the resolved Redis URL by checking process.env.REDIS_URL or building it dynamically.
 */
export function getRedisUrl(): string {
  const envUrl = process.env.REDIS_URL || "";
  if (envUrl.trim() && !isPlaceholder(envUrl)) {
    return envUrl.trim();
  }

  // Fallback to separate variables
  const host = process.env.REDIS_HOST || "";
  const port = process.env.REDIS_PORT || "6379";
  const password = process.env.REDIS_PASSWORD || "";
  const username = process.env.REDIS_USERNAME || "";

  if (host) {
    if (password) {
      const encodedUser = encodeURIComponent(username || "default");
      const encodedPass = encodeURIComponent(password);
      return `redis://${encodedUser}:${encodedPass}@${host}:${port}`;
    }
    return `redis://${host}:${port}`;
  }

  return "";
}

/**
 * Performs a Redis connection and PING check to evaluate authentication status.
 * Never exposes the raw Redis URL or credentials in the returned string.
 */
export async function getRedisStatus(): Promise<"CONFIGURED" | "MISSING" | "AUTH_FAILED" | "CONNECTION_FAILED"> {
  const redisUrl = getRedisUrl();
  if (!redisUrl || isPlaceholder(redisUrl)) {
    return "MISSING";
  }

  try {
    const urlObj = new URL(redisUrl);
    if (!urlObj.password) {
      return "AUTH_FAILED"; // Missing password counts as auth failure in production
    }
  } catch (_) {
    return "CONNECTION_FAILED";
  }

  return new Promise((resolve) => {
    let client: Redis | null = null;
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve("CONNECTION_FAILED");
        if (client) {
          try {
            client.disconnect();
          } catch (_) {}
        }
      }
    }, 2000);

    try {
      client = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        connectTimeout: 1500,
      });

      client.on("error", (err: any) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (err.message && err.message.includes("NOAUTH")) {
            resolve("AUTH_FAILED");
          } else {
            resolve("CONNECTION_FAILED");
          }
          try {
            client?.disconnect();
          } catch (_) {}
        }
      });

      client.ping().then((res) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (res === "PONG") {
            resolve("CONFIGURED");
          } else {
            resolve("CONNECTION_FAILED");
          }
          try {
            client?.disconnect();
          } catch (_) {}
        }
      }).catch((err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          if (err.message && err.message.includes("NOAUTH")) {
            resolve("AUTH_FAILED");
          } else {
            resolve("CONNECTION_FAILED");
          }
          try {
            client?.disconnect();
          } catch (_) {}
        }
      });
    } catch (_) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve("CONNECTION_FAILED");
      }
    }
  });
}

/**
 * Asserts that all required production environment configurations are present.
 * Should be executed at application runtime in production.
 */
export function assertProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  // Bypass checks during Next.js static build phase
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  // 1. Redis Configuration Checks
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    throw new Error("Missing required production env var: REDIS_URL");
  }
  if (isPlaceholder(redisUrl)) {
    throw new Error("Placeholder detected in production env var: REDIS_URL");
  }

  try {
    const urlObj = new URL(redisUrl);
    if (!urlObj.password) {
      throw new Error("Redis connection requires authentication in production. The REDIS_URL is missing a password.");
    }
  } catch (err: any) {
    if (err.message && err.message.includes("requires authentication")) {
      throw err;
    }
    throw new Error(`Invalid REDIS_URL configured in production: ${err.message}`);
  }

  // 2. Integration Provider Checks
  const sports = getSportsProvider();
  if (sports === "oddsapi") {
    if (getOddsApiKeyStatus() !== "CONFIGURED") {
      throw new Error("Missing required production env var: ODDS_API_KEY");
    }
  }

  const news = getNewsProvider();
  if (news === "rss") {
    if (getRssFeedStatus() !== "CONFIGURED") {
      throw new Error("Missing required production env var: NEWS_RSS_FEEDS");
    }
  }

  // 3. Research Provider Checks
  const research = getResearchProvider();
  if (research === "exa") {
    if (getResearchProviderStatus() !== "CONFIGURED") {
      throw new Error("Missing required production env var: EXA_API_KEY when RESEARCH_PROVIDER=exa");
    }
  } else if (research === "stub") {
    throw new Error("Production environments must use a real Research Provider (e.g. exa), 'stub' is not allowed in production.");
  } else {
    throw new Error(`Unsupported RESEARCH_PROVIDER: ${research}`);
  }
  // 4. TTS Provider Checks
  const tts = (process.env.TTS_PROVIDER || "elevenlabs").trim().toLowerCase();
  if (tts === "boson") {
    if (getBosonTtsStatus() !== "CONFIGURED") {
      throw new Error("Missing required production env var: BOSON_API_KEY");
    }
  }
}

/**
 * Returns the configured research provider (default is "stub").
 */
export function getResearchProvider(): string {
  return (process.env.RESEARCH_PROVIDER || "stub").trim().toLowerCase();
}

/**
 * Returns the resolved Exa API key.
 */
export function getExaApiKey(): string {
  return (process.env.EXA_API_KEY || "").trim();
}

/**
 * Returns the research provider configuration status.
 */
export function getResearchProviderStatus(): "CONFIGURED" | "MISSING" | "ERROR" {
  const provider = getResearchProvider();
  if (provider === "exa") {
    const key = getExaApiKey();
    if (!key || isPlaceholder(key)) {
      return "MISSING";
    }
    return "CONFIGURED";
  }
  if (provider === "stub") {
    return "CONFIGURED";
  }
  return "ERROR";
}

/**
 * Returns the resolved Boson API key.
 */
export function getBosonApiKey(): string {
  return (process.env.BOSON_API_KEY || "").trim();
}

/**
 * Returns the Boson TTS status.
 */
export function getBosonTtsStatus(): "CONFIGURED" | "MISSING" {
  const key = getBosonApiKey();
  if (!key || isPlaceholder(key)) {
    return "MISSING";
  }
  return "CONFIGURED";
}

/**
 * Returns the resolved Fish Audio API key.
 */
export function getFishApiKey(): string {
  return (process.env.FISH_API_KEY || "").trim();
}

/**
 * Returns the Fish Audio TTS status.
 */
export function getFishTtsStatus(): "CONFIGURED" | "MISSING" {
  const key = getFishApiKey();
  if (!key || isPlaceholder(key)) {
    return "MISSING";
  }
  return "CONFIGURED";
}
