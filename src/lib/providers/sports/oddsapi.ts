import { SportsDataProvider } from "./interface";

// Map league strings to The Odds API sport keys
const SPORT_KEY_MAP: Record<string, string> = {
  NBA: "basketball_nba",
  NFL: "americanfootball_nfl",
  MLB: "baseball_mlb",
  NCAAF: "americanfootball_ncaaf",
  NCAAB: "basketball_ncaab",
};

export class OddsApiProvider implements SportsDataProvider {
  name = "oddsapi";
  private apiKey: string;
  private baseUrl = "https://api.the-odds-api.com/v4";

  constructor() {
    const key = process.env.THEODDSAPI_API_KEY;
    if (!key || key === "your-theoddsapi-api-key") {
      throw new Error("[OddsAPI] Missing or default THEODDSAPI_API_KEY environment variable.");
    }
    this.apiKey = key;
  }

  private getSportKey(league: string): string {
    const sportKey = SPORT_KEY_MAP[league.toUpperCase()];
    if (!sportKey) {
      throw new Error(`[OddsAPI] League '${league}' is not mapped to an Odds API sport key.`);
    }
    return sportKey;
  }

  private async fetchFromApi<T = any>(path: string): Promise<T> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}${path}${separator}apiKey=${this.apiKey}`;
    
    console.log(`[OddsAPI] GET ${this.baseUrl}${path} (key hidden)`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`[OddsAPI] Request failed with status ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async getOdds(league: string, sport: string): Promise<any[]> {
    // If 'sport' parameter is provided, use it directly, otherwise resolve from league
    const sportKey = sport || this.getSportKey(league);
    const path = `/sports/${sportKey}/odds?regions=us&markets=h2h,spreads,totals&oddsFormat=american`;
    return this.fetchFromApi(path);
  }

  async getScores(league: string, date: string): Promise<any[]> {
    const sportKey = this.getSportKey(league);
    // The Odds API scores endpoint lists recent and live games
    // date parameter is ignored in favor of API's dynamic parameter matching recent days
    const path = `/sports/${sportKey}/scores?daysFrom=3`;
    return this.fetchFromApi(path);
  }

  // Unsupported methods - fail clearly
  async getSchedules(league: string, season: string): Promise<any[]> {
    throw new Error(`[OddsAPI] getSchedules is not supported by The Odds API provider.`);
  }

  async getStandings(league: string, season: string): Promise<any[]> {
    throw new Error(`[OddsAPI] getStandings is not supported by The Odds API provider.`);
  }

  async getTeamStats(league: string, season: string): Promise<any[]> {
    throw new Error(`[OddsAPI] getTeamStats is not supported by The Odds API provider.`);
  }

  async getPlayerStats(league: string, season: string, playerId?: string): Promise<any[]> {
    throw new Error(`[OddsAPI] getPlayerStats is not supported by The Odds API provider.`);
  }

  async getInjuries(league: string): Promise<any[]> {
    throw new Error(`[OddsAPI] getInjuries is not supported by The Odds API provider.`);
  }

  async getNews(league: string): Promise<any[]> {
    throw new Error(`[OddsAPI] getNews is not supported by The Odds API provider.`);
  }
}

export default OddsApiProvider;
