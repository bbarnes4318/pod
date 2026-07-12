import { SportsDataProvider } from "./interface";
import { XMLParser } from "fast-xml-parser";
import { getRssNewsFeeds } from "@/lib/env";

export class RssNewsProvider implements SportsDataProvider {
  name = "rss-news";

  /** Per-feed diagnostics from the most recent getNews() run — the worker
   *  copies these into the job output so a dead feed, a parse failure, or an
   *  empty configured list is visible in the JobLog instead of only in
   *  container stdout (the old failure mode: weeks of 0-row runs whose cause
   *  was invisible). */
  public lastRunIssues: string[] = [];

  private getFeedUrls(): string[] {
    return getRssNewsFeeds();
  }

  async getNews(league: string): Promise<any[]> {
    this.lastRunIssues = [];
    const urls = this.getFeedUrls();
    if (urls.length === 0) {
      this.lastRunIssues.push(
        "RSS feed list is EMPTY on this runtime (NEWS_RSS_FEEDS unset/invalid and no defaults resolved) — no fetch was attempted."
      );
      return [];
    }

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    });

    const allNews: any[] = [];

    for (const url of urls) {
      try {
        console.log(`[RSSNewsProvider] Fetching RSS feed: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
          console.error(`[RSSNewsProvider] Failed to fetch feed ${url}: ${response.statusText}`);
          this.lastRunIssues.push(`Feed ${url}: HTTP ${response.status} ${response.statusText}`);
          continue;
        }

        const xmlText = await response.text();
        const result = parser.parse(xmlText);

        // Determine source name
        const sourceName = result.rss?.channel?.title || new URL(url).hostname;

        // Handle RSS <item> array/object
        let items = result.rss?.channel?.item || [];
        if (!Array.isArray(items)) {
          items = [items];
        }
        // Filter out the empty-object artifact from parsing a childless channel.
        items = items.filter((it: any) => it && (it.title || it.link || it.guid));

        // Handle Atom <entry> array/object if RSS is empty
        if (items.length === 0) {
          let entries = result.feed?.entry || [];
          if (!Array.isArray(entries)) {
            entries = [entries];
          }
          items = entries.map((e: any) => ({
            title: e.title?.["#text"] || e.title || "",
            link: e.link?.["@_href"] || (Array.isArray(e.link) ? e.link[0]?.["@_href"] : e.link) || "",
            description: e.summary?.["#text"] || e.summary || e.content?.["#text"] || e.content || "",
            pubDate: e.updated || e.published || "",
          }));
        }

        if (items.length === 0) {
          // SOFT BLOCK diagnostic: a host can return 2xx with an empty or
          // HTML body to datacenter IPs (ESPN does). Without this line such a
          // feed is indistinguishable from a genuinely empty one.
          const sample = xmlText.slice(0, 160).replace(/\s+/g, " ");
          this.lastRunIssues.push(
            `Feed ${url}: HTTP ${response.status} but 0 parseable items (content-type=${response.headers.get("content-type")}, bytes=${xmlText.length}, body sample: ${JSON.stringify(sample)})`
          );
          continue;
        }
        // Per-feed success line so the job output shows exactly which feeds
        // delivered from this runtime's IP.
        this.lastRunIssues.push(`Feed ${url}: OK — HTTP ${response.status}, ${items.length} items ("${String(sourceName).slice(0, 40)}")`);

        for (const item of items) {
          const title = item.title || "";
          const link = item.link || item.guid?.["#text"] || item.guid || "";
          const description = item.description || "";
          const pubDate = item.pubDate || item.date || "";

          // Filter by league keyword if provided
          if (league) {
            const keyword = league.toLowerCase();
            const matchesTitle = title.toLowerCase().includes(keyword);
            const matchesDesc = description.toLowerCase().includes(keyword);
            if (!matchesTitle && !matchesDesc) {
              continue; // Skip if no matches
            }
          }

          allNews.push({
            title: title.trim(),
            source: sourceName,
            url: link.trim(),
            publishedAt: pubDate ? new Date(pubDate) : new Date(),
            summary: description.trim() ? description.trim().substring(0, 500) : null,
            entities: [], // Empty by default (no NLP extraction in this phase)
            raw: item, // Store raw payload in raw JSON field
          });
        }
      } catch (err: any) {
        console.error(`[RSSNewsProvider] Error parsing feed ${url}:`, err.message);
        this.lastRunIssues.push(`Feed ${url}: fetch/parse error — ${err.message}`);
      }
    }

    return allNews;
  }

  // Unsupported methods - fail clearly
  async getSchedules(league: string, season: string): Promise<any[]> {
    throw new Error(`[RSSNewsProvider] getSchedules is not supported by RSS/news provider.`);
  }

  async getScores(league: string, date: string): Promise<any[]> {
    throw new Error(`[RSSNewsProvider] getScores is not supported by RSS/news provider.`);
  }

  async getStandings(league: string, season: string): Promise<any[]> {
    throw new Error(`[RSSNewsProvider] getStandings is not supported by RSS/news provider.`);
  }

  async getTeamStats(league: string, season: string): Promise<any[]> {
    throw new Error(`[RSSNewsProvider] getTeamStats is not supported by RSS/news provider.`);
  }

  async getPlayerStats(league: string, season: string, playerId?: string): Promise<any[]> {
    throw new Error(`[RSSNewsProvider] getPlayerStats is not supported by RSS/news provider.`);
  }

  async getInjuries(league: string): Promise<any[]> {
    throw new Error(`[RSSNewsProvider] getInjuries is not supported by RSS/news provider.`);
  }

  async getOdds(league: string, sport: string): Promise<any[]> {
    throw new Error(`[RSSNewsProvider] getOdds is not supported by RSS/news provider.`);
  }
}

export default RssNewsProvider;
