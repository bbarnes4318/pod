import { SportsDataProvider } from "./interface";

/**
 * The stub provider is for architecture validation only. 
 * It must never be used to generate real topics, research briefs, scripts, or published episodes.
 */
export class StubSportsDataProvider implements SportsDataProvider {
  name = "stub-sports-data";

  async getSchedules(league: string, season: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getSchedules called for league: ${league}, season: ${season} - Returning stub empty array`);
    return [];
  }

  async getScores(league: string, date: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getScores called for league: ${league}, date: ${date} - Returning stub empty array`);
    return [];
  }

  async getStandings(league: string, season: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getStandings called for league: ${league}, season: ${season} - Returning stub empty array`);
    return [];
  }

  async getTeamStats(league: string, season: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getTeamStats called for league: ${league}, season: ${season} - Returning stub empty array`);
    return [];
  }

  async getPlayerStats(league: string, season: string, playerId?: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getPlayerStats called for league: ${league}, season: ${season}, playerId: ${playerId || "all"} - Returning stub empty array`);
    return [];
  }

  async getInjuries(league: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getInjuries called for league: ${league} - Returning stub empty array`);
    return [];
  }

  async getOdds(league: string, sport: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getOdds called for league: ${league}, sport: ${sport} - Returning stub empty array`);
    return [];
  }

  async getNews(league: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getNews called for league: ${league} - Returning stub empty array`);
    return [];
  }
}

export default StubSportsDataProvider;
