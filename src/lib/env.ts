import "server-only";

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
 * Asserts that all required production environment configurations are present.
 * Should be executed at application runtime in production.
 */
export function assertProductionEnv(): void {
  if (process.env.NODE_ENV !== "production") return;
  // Bypass checks during Next.js static build phase
  if (process.env.NEXT_PHASE === "phase-production-build") return;

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
}
