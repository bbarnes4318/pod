import Exa from "exa-js";
import { ResearchProvider, ResearchSourceResult } from "./provider";
import { getExaApiKey, getResearchProviderStatus } from "../env";

export class ExaResearchProvider implements ResearchProvider {
  public name = "exa";
  private client: Exa | null = null;

  private getClient(): Exa {
    if (this.client) return this.client;
    const apiKey = getExaApiKey();
    this.client = new Exa(apiKey);
    return this.client;
  }

  public async search(input: {
    query: string;
    topicType?: string;
    numResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
  }): Promise<ResearchSourceResult[]> {
    const apiKey = getExaApiKey();
    if (!apiKey) {
      console.warn("[ExaResearchProvider] Search invoked without EXA_API_KEY.");
      return [];
    }

    const exa = this.getClient();
    const numResults = input.numResults ?? 10;

    const searchOptions: any = {
      type: "auto",
      numResults,
      contents: {
        highlights: true,
      },
    };

    if (input.includeDomains && input.includeDomains.length > 0) {
      searchOptions.includeDomains = input.includeDomains;
    }

    if (input.excludeDomains && input.excludeDomains.length > 0) {
      searchOptions.excludeDomains = input.excludeDomains;
    }

    try {
      console.log(`[Exa] Querying: "${input.query}" (numResults=${numResults})`);
      const response = await exa.search(input.query, searchOptions);
      
      const results = response.results || [];
      return results.map((r: any) => ({
        title: r.title || "No Title",
        url: r.url || "",
        publishedAt: r.publishedDate || undefined,
        highlights: r.highlights || [],
        relevanceScore: r.score || undefined,
        snippet: (r.highlights && r.highlights.length > 0) ? r.highlights.join(" | ") : undefined,
      }));
    } catch (err: any) {
      console.error(`[ExaResearchProvider] Search failed:`, err.message);
      return [];
    }
  }

  public async healthCheck(): Promise<"CONFIGURED" | "MISSING" | "ERROR"> {
    const status = getResearchProviderStatus();
    if (status === "MISSING") return "MISSING";
    if (status === "ERROR") return "ERROR";

    const key = getExaApiKey();
    if (key.startsWith("your-") || key === "SET_IN_COOLIFY_ONLY" || process.env.NODE_ENV !== "production") {
      return "CONFIGURED";
    }

    try {
      const exa = this.getClient();
      await exa.search("sports", { numResults: 1 });
      return "CONFIGURED";
    } catch (err: any) {
      console.error("[Exa] Healthcheck API test failed:", err.message);
      return "ERROR";
    }
  }
}
