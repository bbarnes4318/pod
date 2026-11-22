// Business research + demand providers.
//
// Rules this file enforces:
//   * A provider that is not configured or not integrated produces a VISIBLE
//     limitation, never a fabricated observation.
//   * A provider error is an error (thrown / reported), never an empty list
//     that looks like "nobody is interested".
//   * Metric kinds are not interchangeable. YouTube views are VIEWS; a count of
//     podcasts covering a topic is CONTENT_SUPPLY (a gap signal, not demand);
//     relative interest is never converted to absolute volume.
//   * Only official, documented APIs. No scraping of sites that forbid it.

import Exa from "exa-js";
import { safeFetch, type SafeFetchResult } from "../net/safeFetch";
import { getExaApiKey } from "../env";
import { contentHash } from "./claimVerification";

export type MetricKind =
  | "RELATIVE_INTEREST" | "ESTIMATED_VOLUME" | "IMPRESSIONS" | "VIEWS" | "ENGAGEMENT"
  | "DISCUSSION_ACTIVITY" | "CONTENT_SUPPLY" | "PUBLICATION_COVERAGE";

/** Kinds that measure listener/search INTEREST (vs supply or coverage). */
export const DEMAND_KINDS: MetricKind[] = ["RELATIVE_INTEREST", "ESTIMATED_VOLUME", "IMPRESSIONS", "VIEWS", "ENGAGEMENT", "DISCUSSION_ACTIVITY"];

export type AdapterId =
  | "SEARCH_TRENDS" | "SEARCH_CONSOLE" | "KEYWORD_RESEARCH" | "YOUTUBE" | "PODCAST_DISCOVERY"
  | "COMMUNITY_DISCUSSIONS" | "INDUSTRY_PUBLICATIONS" | "FIRST_PARTY_ANALYTICS";

export type AdapterStatus = "AVAILABLE" | "NOT_CONFIGURED" | "NOT_INTEGRATED";

export interface AdapterDefinition {
  id: AdapterId;
  label: string;
  sourceFamily: "search" | "video" | "podcast" | "community" | "publication" | "first_party";
  credentials: string[];
  metrics: { name: string; kind: MetricKind }[];
  geography: string;
  dateRanges: string;
  rateLimit: string;
  errors: string;
  freshness: string;
  limitations: string;
  /** Per-run request ceiling this engine applies. */
  maxRequestsPerRun: number;
  integrated: boolean;
}

export const ADAPTERS: AdapterDefinition[] = [
  {
    id: "YOUTUBE", label: "YouTube Data API v3", sourceFamily: "video", credentials: ["YOUTUBE_API_KEY"],
    metrics: [{ name: "youtube_views", kind: "VIEWS" }, { name: "youtube_engagement", kind: "ENGAGEMENT" }],
    geography: "regionCode filter (country) when the profile has one market; otherwise global",
    dateRanges: "publishedAfter filter; metrics are lifetime-to-date per video",
    rateLimit: "10,000 quota units/day default; search.list = 100 units, videos.list = 1 unit",
    errors: "403 quotaExceeded / keyInvalid; 400 bad request",
    freshness: "Live at request time",
    limitations: "Views are lifetime totals for the top matching videos, not search volume. Engagement = likes+comments where the uploader exposes them.",
    maxRequestsPerRun: 12, integrated: true,
  },
  {
    id: "COMMUNITY_DISCUSSIONS", label: "Hacker News (Algolia API)", sourceFamily: "community", credentials: [],
    metrics: [{ name: "hn_points", kind: "DISCUSSION_ACTIVITY" }, { name: "hn_comments", kind: "DISCUSSION_ACTIVITY" }],
    geography: "Global, no geographic filter", dateRanges: "created_at filter; last 24 months used",
    rateLimit: "10,000 requests/hour per IP (documented by Algolia)", errors: "HTTP 429 / 5xx",
    freshness: "Near real-time", limitations: "Technology-skewed audience — silence here says little about non-tech niches.",
    maxRequestsPerRun: 8, integrated: true,
  },
  {
    id: "PODCAST_DISCOVERY", label: "Apple iTunes Search API (podcasts)", sourceFamily: "podcast", credentials: [],
    metrics: [{ name: "matching_podcast_count", kind: "CONTENT_SUPPLY" }],
    geography: "Store country (US by default, or the profile's single market)", dateRanges: "None — catalogue snapshot",
    rateLimit: "~20 calls/minute (Apple guidance)", errors: "HTTP 403/429 when throttled",
    freshness: "Catalogue at request time",
    limitations: "Measures how many shows cover a topic (supply/coverage gap), NOT downloads or listeners — Apple does not publish those.",
    maxRequestsPerRun: 8, integrated: true,
  },
  {
    id: "INDUSTRY_PUBLICATIONS", label: "Exa web search (publications)", sourceFamily: "publication", credentials: ["EXA_API_KEY"],
    metrics: [{ name: "independent_publications_12mo", kind: "PUBLICATION_COVERAGE" }],
    geography: "Global web; geography only via query terms", dateRanges: "startPublishedDate filter (last 12 months)",
    rateLimit: "Account plan limits", errors: "401 invalid key, 429 rate limit, 5xx",
    freshness: "Index freshness varies by site",
    limitations: "Counts distinct-origin articles recently published on the topic — coverage, not audience size.",
    maxRequestsPerRun: 10, integrated: true,
  },
  {
    id: "SEARCH_TRENDS", label: "Google Trends", sourceFamily: "search", credentials: [],
    metrics: [{ name: "relative_search_interest", kind: "RELATIVE_INTEREST" }],
    geography: "Country/region", dateRanges: "Up to 5 years", rateLimit: "No official public API", errors: "—", freshness: "—",
    limitations: "Not integrated: Google offers no official public Trends API (alpha access only). We do not scrape it. Relative interest would never be converted to absolute volume.",
    maxRequestsPerRun: 0, integrated: false,
  },
  {
    id: "SEARCH_CONSOLE", label: "Google Search Console", sourceFamily: "first_party", credentials: ["Google OAuth (site owner)"],
    metrics: [{ name: "site_impressions", kind: "IMPRESSIONS" }], geography: "Country", dateRanges: "16 months",
    rateLimit: "1,200 queries/min/site", errors: "—", freshness: "~2 day lag",
    limitations: "Not integrated yet: needs an OAuth connection to the customer's own verified property.",
    maxRequestsPerRun: 0, integrated: false,
  },
  {
    id: "KEYWORD_RESEARCH", label: "Keyword volume provider", sourceFamily: "search", credentials: ["Paid provider key"],
    metrics: [{ name: "estimated_monthly_searches", kind: "ESTIMATED_VOLUME" }], geography: "Country", dateRanges: "Monthly",
    rateLimit: "Provider-specific", errors: "—", freshness: "Monthly",
    limitations: "Not integrated: no keyword-volume provider has been contracted and tested. Estimated volume is never invented.",
    maxRequestsPerRun: 0, integrated: false,
  },
  {
    id: "FIRST_PARTY_ANALYTICS", label: "Your show's own listening data", sourceFamily: "first_party", credentials: [],
    metrics: [{ name: "episode_listens", kind: "IMPRESSIONS" }], geography: "Country (when the edge supplies it)", dateRanges: "Since first episode",
    rateLimit: "—", errors: "—", freshness: "Real-time",
    limitations: "Not yet used for topic demand: a new business show has no listening history to learn from.",
    maxRequestsPerRun: 0, integrated: false,
  },
];

export function adapterStatus(def: AdapterDefinition, env: NodeJS.ProcessEnv = process.env): AdapterStatus {
  if (!def.integrated) return "NOT_INTEGRATED";
  const keyed = def.credentials.filter((c) => /^[A-Z_]+$/.test(c));
  return keyed.every((k) => (env[k] ?? "").trim() && !/^(your-|SET_IN)/.test(env[k]!.trim())) ? "AVAILABLE" : "NOT_CONFIGURED";
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type JsonGet = (url: string) => Promise<SafeFetchResult>;
export const defaultJsonGet: JsonGet = (url) => safeFetch(url, { allowedContentTypes: ["application/json", "text/javascript"] });

export class ProviderError extends Error {
  constructor(public adapter: string, message: string, public retryable: boolean) {
    super(`${adapter}: ${message}`);
  }
}

async function getJson<T>(adapter: string, url: string, get: JsonGet): Promise<T> {
  const res = await get(url);
  if (!res.ok) {
    const retryable = res.category === "timeout" || /HTTP (429|5\d\d)/.test(res.internal ?? "") || res.category === "fetch_failed";
    throw new ProviderError(adapter, res.message + (res.internal ? ` (${res.internal.replace(/key=[^&\s]+/g, "key=…")})` : ""), retryable);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new ProviderError(adapter, "response was not JSON", false);
  }
}

/** Retry retryable provider errors with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, onRetry: () => void, attempts = 3, baseMs = 400): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!(e instanceof ProviderError) || !e.retryable || i === attempts - 1) throw e;
      onRetry();
      await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw last;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface RawSource {
  provider: string;
  sourceType: "WEB" | "PUBLICATION" | "GOVERNMENT" | "VIDEO" | "PODCAST" | "COMMUNITY" | "FIRST_PARTY_SITE";
  url: string;
  title: string | null;
  publisher: string | null;
  publishedAt: string | null;
  text: string;
}

export interface RawObservation {
  adapter: AdapterId;
  sourceFamily: AdapterDefinition["sourceFamily"];
  query: string;
  observedMetric: string;
  metricKind: MetricKind;
  metricValue: number | null;
  measurementWindow: string;
  geographicRelevance: string | null;
  publishedAt: string | null;
  title: string | null;
  url: string | null;
  limitations: string;
  /** Text used for origin grouping and topic relevance. */
  text: string;
}

const GOV_RE = /\.(gov|mil)(\.[a-z]{2})?$|\.gov\.[a-z]{2}$|(^|\.)europa\.eu$/i;

export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|mc_)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

// --- Exa (general web + publications) ---------------------------------------

export interface ExaLike {
  search(query: string, opts: Record<string, unknown>): Promise<{ results?: Array<Record<string, unknown>> }>;
}

export function exaClient(): ExaLike | null {
  const key = getExaApiKey();
  if (!key || /^(your-|SET_IN)/.test(key)) return null;
  return new Exa(key) as unknown as ExaLike;
}

/** Web research. Throws on provider failure (unlike the sports adapter, which returns []). */
export async function exaSearch(
  client: ExaLike,
  query: string,
  opts: { numResults?: number; startPublishedDate?: string; includeDomains?: string[]; maxChars?: number } = {}
): Promise<RawSource[]> {
  let res: Awaited<ReturnType<ExaLike["search"]>>;
  try {
    res = await client.search(query, {
      type: "auto",
      numResults: opts.numResults ?? 6,
      ...(opts.startPublishedDate ? { startPublishedDate: opts.startPublishedDate } : {}),
      ...(opts.includeDomains?.length ? { includeDomains: opts.includeDomains } : {}),
      contents: { text: { maxCharacters: opts.maxChars ?? 4000 } },
    });
  } catch (e) {
    const msg = (e as Error).message || "search failed";
    throw new ProviderError("exa", msg, /429|5\d\d|timeout|ECONN/i.test(msg));
  }
  return (res.results ?? [])
    .map((r) => {
      const url = String(r.url ?? "");
      let host = "";
      try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* skip */ }
      return {
        provider: "exa",
        sourceType: GOV_RE.test(host) ? "GOVERNMENT" : "PUBLICATION",
        url,
        title: (r.title as string) || null,
        publisher: host || null,
        publishedAt: (r.publishedDate as string) || null,
        text: String(r.text ?? "").slice(0, opts.maxChars ?? 4000),
      } as RawSource;
    })
    .filter((s) => s.url && s.text.length >= 120);
}

// --- YouTube -------------------------------------------------------------------

export async function youtubeObservations(query: string, opts: { key: string; regionCode?: string | null; get?: JsonGet; now?: Date }): Promise<RawObservation[]> {
  const get = opts.get ?? defaultJsonGet;
  const after = new Date((opts.now ?? new Date()).getTime() - 730 * 86_400_000).toISOString();
  const q = new URLSearchParams({ part: "snippet", type: "video", maxResults: "8", q: query, publishedAfter: after, key: opts.key, relevanceLanguage: "en" });
  if (opts.regionCode) q.set("regionCode", opts.regionCode);
  const search = await getJson<{ items?: { id?: { videoId?: string } }[] }>("youtube", `https://www.googleapis.com/youtube/v3/search?${q}`, get);
  const ids = (search.items ?? []).map((i) => i.id?.videoId).filter(Boolean) as string[];
  if (ids.length === 0) return [];
  const vq = new URLSearchParams({ part: "snippet,statistics", id: ids.join(","), key: opts.key });
  const videos = await getJson<{ items?: { id: string; snippet?: { title?: string; description?: string; publishedAt?: string; channelTitle?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }[] }>(
    "youtube", `https://www.googleapis.com/youtube/v3/videos?${vq}`, get
  );
  const out: RawObservation[] = [];
  for (const v of videos.items ?? []) {
    const views = v.statistics?.viewCount != null ? Number(v.statistics.viewCount) : null;
    const likes = v.statistics?.likeCount != null ? Number(v.statistics.likeCount) : null;
    const comments = v.statistics?.commentCount != null ? Number(v.statistics.commentCount) : null;
    const base = {
      adapter: "YOUTUBE" as const, sourceFamily: "video" as const, query,
      measurementWindow: "LIFETIME_TO_DATE", geographicRelevance: opts.regionCode ?? null,
      publishedAt: v.snippet?.publishedAt ?? null, title: v.snippet?.title ?? null,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      text: `${v.snippet?.title ?? ""}\n${(v.snippet?.description ?? "").slice(0, 600)}`,
    };
    out.push({ ...base, observedMetric: "youtube_views", metricKind: "VIEWS", metricValue: Number.isFinite(views!) ? views : null, limitations: "Lifetime views of one video; not search volume." });
    if (likes != null || comments != null) {
      out.push({ ...base, observedMetric: "youtube_engagement", metricKind: "ENGAGEMENT", metricValue: (likes ?? 0) + (comments ?? 0), limitations: "Likes + comments where exposed; hidden counts read as missing." });
    }
  }
  return out;
}

// --- Hacker News ---------------------------------------------------------------

export async function hackerNewsObservations(query: string, opts: { get?: JsonGet; now?: Date } = {}): Promise<RawObservation[]> {
  const get = opts.get ?? defaultJsonGet;
  const since = Math.floor(((opts.now ?? new Date()).getTime() - 730 * 86_400_000) / 1000);
  const q = new URLSearchParams({ query, tags: "story", hitsPerPage: "10", numericFilters: `created_at_i>${since}` });
  const res = await getJson<{ hits?: { objectID: string; title?: string; url?: string; points?: number; num_comments?: number; created_at?: string; story_text?: string }[] }>(
    "hackernews", `https://hn.algolia.com/api/v1/search?${q}`, get
  );
  return (res.hits ?? []).map((h) => ({
    adapter: "COMMUNITY_DISCUSSIONS" as const, sourceFamily: "community" as const, query,
    observedMetric: "hn_points", metricKind: "DISCUSSION_ACTIVITY" as const,
    metricValue: typeof h.points === "number" ? h.points : null,
    measurementWindow: "LIFETIME_TO_DATE", geographicRelevance: null,
    publishedAt: h.created_at ?? null, title: h.title ?? null,
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    limitations: `Points on one story (${h.num_comments ?? 0} comments). Tech-skewed audience.`,
    text: `${h.title ?? ""} ${h.url ?? ""} ${(h.story_text ?? "").slice(0, 400)}`,
  }));
}

// --- Apple podcasts catalogue ----------------------------------------------------

export async function podcastSupplyObservation(query: string, opts: { country?: string | null; get?: JsonGet } = {}): Promise<RawObservation> {
  const get = opts.get ?? defaultJsonGet;
  const country = (opts.country ?? "US").slice(0, 2).toUpperCase();
  const q = new URLSearchParams({ term: query, media: "podcast", entity: "podcast", limit: "50", country });
  const res = await getJson<{ resultCount?: number; results?: { collectionName?: string; collectionViewUrl?: string; releaseDate?: string; trackCount?: number }[] }>(
    "itunes", `https://itunes.apple.com/search?${q}`, get
  );
  const results = res.results ?? [];
  return {
    adapter: "PODCAST_DISCOVERY", sourceFamily: "podcast", query,
    observedMetric: "matching_podcast_count", metricKind: "CONTENT_SUPPLY",
    metricValue: typeof res.resultCount === "number" ? res.resultCount : results.length,
    measurementWindow: "CATALOGUE_SNAPSHOT", geographicRelevance: country, publishedAt: null,
    title: `Apple Podcasts shows matching "${query}" (capped at 50)`,
    url: `https://podcasts.apple.com/search?term=${encodeURIComponent(query)}`,
    limitations: "Count of shows matching the terms (max 50). Coverage, not listenership.",
    text: results.slice(0, 15).map((r) => r.collectionName ?? "").join("; "),
  };
}

// --- Publication coverage (Exa) ----------------------------------------------------

export function publicationCoverageObservation(query: string, sources: RawSource[], origins: string[]): RawObservation {
  return {
    adapter: "INDUSTRY_PUBLICATIONS", sourceFamily: "publication", query,
    observedMetric: "independent_publications_12mo", metricKind: "PUBLICATION_COVERAGE",
    metricValue: new Set(origins).size, measurementWindow: "LAST_12_MONTHS", geographicRelevance: null,
    publishedAt: null, title: `Distinct-origin articles on "${query}" in the last 12 months (sample of ${sources.length})`,
    url: null, limitations: "Capped by the search sample size; syndicated copies count once.",
    text: sources.map((s) => s.title ?? "").join("; "),
  };
}

export const obsHash = (o: RawObservation) => contentHash(`${o.adapter}|${o.url ?? ""}|${o.observedMetric}|${o.text}`);
