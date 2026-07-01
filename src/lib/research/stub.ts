import { ResearchProvider, ResearchSourceResult } from "./provider";

export class StubResearchProvider implements ResearchProvider {
  public name = "stub";

  public async search(input: {
    query: string;
    topicType?: string;
    numResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
  }): Promise<ResearchSourceResult[]> {
    console.log(`[StubResearch] Simulating search query: "${input.query}"`);
    const count = input.numResults ?? 5;
    const mockResults: ResearchSourceResult[] = [];

    for (let i = 1; i <= count; i++) {
      mockResults.push({
        title: `Mock Research Article #${i} for "${input.query}"`,
        url: `https://example.com/research/mock-article-${i}`,
        publishedAt: new Date().toISOString(),
        highlights: [
          `This is a mock highlight note about ${input.query} to ground arguments in facts.`,
          `Secondary research point showing statistical significance for ${input.query}.`
        ],
        snippet: `Mock article snippet discussing details about ${input.query}.`,
        relevanceScore: 0.95 - (i * 0.05),
      });
    }

    return mockResults;
  }

  public async healthCheck(): Promise<"CONFIGURED" | "MISSING" | "ERROR"> {
    return "CONFIGURED";
  }
}
