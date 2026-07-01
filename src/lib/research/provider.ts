import { getResearchProvider } from "../env";
import { ExaResearchProvider } from "./exa";
import { StubResearchProvider } from "./stub";

export type ResearchSourceResult = {
  title: string;
  url: string;
  sourceName?: string;
  publishedAt?: string;
  snippet?: string;
  highlights?: string[];
  summary?: string;
  relevanceScore?: number;
};

export interface ResearchProvider {
  name: string;
  search(input: {
    query: string;
    topicType?: string;
    numResults?: number;
    includeDomains?: string[];
    excludeDomains?: string[];
  }): Promise<ResearchSourceResult[]>;
  healthCheck(): Promise<"CONFIGURED" | "MISSING" | "ERROR">;
}

let providerInstance: ResearchProvider | null = null;

export function getResearchProviderInstance(): ResearchProvider {
  if (providerInstance) return providerInstance;

  const providerType = getResearchProvider();
  if (providerType === "exa") {
    providerInstance = new ExaResearchProvider();
  } else {
    providerInstance = new StubResearchProvider();
  }

  return providerInstance;
}
