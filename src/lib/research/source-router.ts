import { getResearchProviderInstance, ResearchSourceResult } from "./provider";

export type ResearchRoutingInput = {
  title: string;
  summary: string;
  classification: string;
  hasOddsApi: boolean;
  hasRssFeeds: boolean;
  resolvedOddsCount: number;
  resolvedNewsCount: number;
  resolvedGamesCount: number;
};

export type ResearchRoutingOutput = {
  researchResults: ResearchSourceResult[];
  sourceNotes: string;
  providerName: string;
};

export async function runResearchRouting(input: ResearchRoutingInput): Promise<ResearchRoutingOutput> {
  const provider = getResearchProviderInstance();
  const providerName = provider.name;
  
  let numResults = 10;
  let query = input.title;

  // Refine query for player/coach/team topics to make it high-quality
  if (input.summary && input.summary.length > 5 && input.summary.length < 150) {
    query = `${input.title} ${input.summary}`;
  }

  // Adjust result counts based on topic classification
  if (input.classification === "betting_market") {
    numResults = 5; // Focus more on Odds API, but still get 5 context results
  } else if (input.classification === "game_preview") {
    numResults = 8;
  } else {
    numResults = 10;
  }

  let researchResults: ResearchSourceResult[] = [];
  let providerNote = "";

  try {
    researchResults = await provider.search({
      query,
      topicType: input.classification,
      numResults,
    });

    if (researchResults.length > 0) {
      providerNote = `Research Provider: ${providerName.toUpperCase()}, ${researchResults.length} results`;
    } else {
      providerNote = `Research Provider: ${providerName.toUpperCase()}, no matching results found`;
    }
  } catch (err: any) {
    console.error(`[SourceRouter] Research provider ${providerName} search failed:`, err.message);
    providerNote = `Research Provider: ${providerName.toUpperCase()}, error (offline/rate-limited)`;
  }

  // Build the Sources Used transparency audit log
  const sourcesList: string[] = [providerNote];

  // RSS News headlines check
  if (input.resolvedNewsCount > 0) {
    sourcesList.push(`RSS Headlines: configured, ${input.resolvedNewsCount} relevant headlines`);
  } else if (input.hasRssFeeds) {
    sourcesList.push("RSS Headlines: configured, no matching headlines");
  } else {
    sourcesList.push("RSS Headlines: unavailable");
  }

  // Odds API check
  const isBettingTopic = input.classification === "betting_market" || 
    `${input.title} ${input.summary}`.toLowerCase().match(/\b(odds|spread|total|moneyline|betting|wager)\b/i);

  if (input.resolvedOddsCount > 0) {
    sourcesList.push(`Odds API: used, odds matched`);
  } else if (isBettingTopic) {
    if (input.hasOddsApi) {
      sourcesList.push("Odds API: used, no matching markets found");
    } else {
      sourcesList.push("Odds API: unavailable (missing API key)");
    }
  } else {
    sourcesList.push("Odds API: skipped, not relevant to topic");
  }

  const sourceNotes = sourcesList.map(s => `- ${s}`).join("\n");

  return {
    researchResults,
    sourceNotes,
    providerName,
  };
}
