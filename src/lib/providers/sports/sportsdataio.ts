import { SportsDataProvider } from "./interface";

interface EndpointConfig {
  baseUrl: string;
  schedules: (season: string) => string;
  scores: (date: string) => string;
  standings: (season: string) => string;
  teamStats: (season: string) => string;
  playerStats: (season: string) => string;
  injuries: () => string;
  odds: (date: string) => string;
  news: () => string;
}

// Map endpoints by league to prevent silent errors on unsupported configurations
const ENDPOINT_MAP: Record<string, EndpointConfig> = {
  NBA: {
    baseUrl: "https://api.sportsdata.io/v3/nba",
    schedules: (season) => `/scores/json/Games/${season}`,
    scores: (date) => `/scores/json/GamesByDate/${date}`,
    standings: (season) => `/scores/json/Standings/${season}`,
    teamStats: (season) => `/scores/json/TeamSeasonStats/${season}`,
    playerStats: (season) => `/stats/json/PlayerSeasonStats/${season}`,
    injuries: () => "/scores/json/Injuries",
    odds: (date) => `/odds/json/GameOddsByDate/${date}`,
    news: () => "/scores/json/News",
  },
  NFL: {
    baseUrl: "https://api.sportsdata.io/v3/nfl",
    schedules: (season) => `/scores/json/Schedules/${season}`,
    scores: (date) => `/scores/json/ScoresByDate/${date}`,
    standings: (season) => `/scores/json/Standings/${season}`,
    teamStats: (season) => `/scores/json/TeamSeasonStats/${season}`,
    playerStats: (season) => `/stats/json/PlayerSeasonStats/${season}`,
    injuries: () => "/scores/json/Injuries",
    odds: (date) => `/odds/json/GameOddsByDate/${date}`,
    news: () => "/scores/json/News",
  },
  MLB: {
    baseUrl: "https://api.sportsdata.io/v3/mlb",
    schedules: (season) => `/scores/json/Games/${season}`,
    scores: (date) => `/scores/json/GamesByDate/${date}`,
    standings: (season) => `/scores/json/Standings/${season}`,
    teamStats: (season) => `/scores/json/TeamSeasonStats/${season}`,
    playerStats: (season) => `/stats/json/PlayerSeasonStats/${season}`,
    injuries: () => "/scores/json/Injuries",
    odds: (date) => `/odds/json/GameOddsByDate/${date}`,
    news: () => "/scores/json/News",
  },
};

export class SportsDataIOProvider implements SportsDataProvider {
  name = "sportsdataio";
  private apiKey: string;

  constructor() {
    const key = process.env.SPORTSDATAIO_API_KEY;
    if (!key || key === "your-sportsdataio-api-key") {
      throw new Error("[SportsDataIO] Missing or default SPORTSDATAIO_API_KEY environment variable.");
    }
    this.apiKey = key;
  }

  private getEndpoint(league: string): EndpointConfig {
    const config = ENDPOINT_MAP[league.toUpperCase()];
    if (!config) {
      throw new Error(`[SportsDataIO] League '${league}' is not supported by SportsDataIO provider endpoints.`);
    }
    return config;
  }

  private async fetchFromApi<T = any>(league: string, path: string): Promise<T> {
    const config = this.getEndpoint(league);
    // Build query with API key parameter
    const url = `${config.baseUrl}${path}${path.includes("?") ? "&" : "?"}key=${this.apiKey}`;
    
    console.log(`[SportsDataIO] GET ${config.baseUrl}${path} (key hidden)`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`[SportsDataIO] Request failed with status ${response.status}: ${response.statusText}`);
    }

    return response.json() as Promise<T>;
  }

  async getSchedules(league: string, season: string): Promise<any[]> {
    const config = this.getEndpoint(league);
    const path = config.schedules(season);
    return this.fetchFromApi(league, path);
  }

  async getScores(league: string, date: string): Promise<any[]> {
    const config = this.getEndpoint(league);
    const path = config.scores(date);
    return this.fetchFromApi(league, path);
  }

  async getStandings(league: string, season: string): Promise<any[]> {
    const config = this.getEndpoint(league);
    const path = config.standings(season);
    return this.fetchFromApi(league, path);
  }

  async getTeamStats(league: string, season: string): Promise<any[]> {
    const config = this.getEndpoint(league);
    const path = config.teamStats(season);
    return this.fetchFromApi(league, path);
  }

  async getPlayerStats(league: string, season: string, playerId?: string): Promise<any[]> {
    const config = this.getEndpoint(league);
    const path = config.playerStats(season);
    const data = await this.fetchFromApi<any[]>(league, path);
    if (playerId) {
      return data.filter((p: any) => String(p.PlayerID) === String(playerId) || String(p.playerId) === String(playerId));
    }
    return data;
  }

  async getInjuries(league: string): Promise<any[]> {
    const config = this.getEndpoint(league);
    const path = config.injuries();
    return this.fetchFromApi(league, path);
  }

  async getOdds(league: string, date: string): Promise<any[]> {
    const config = this.getEndpoint(league);
    const path = config.odds(date);
    return this.fetchFromApi(league, path);
  }

  async getNews(league: string): Promise<any[]> {
    const config = this.getEndpoint(league);
    const path = config.news();
    return this.fetchFromApi(league, path);
  }
}

export default SportsDataIOProvider;
