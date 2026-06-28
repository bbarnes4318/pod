import { SportsDataProvider } from "./interface";

export class StubSportsDataProvider implements SportsDataProvider {
  name = "stub-sports-data";

  async getSchedules(league: string, season: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getSchedules called for league: ${league}, season: ${season}`);
    return [{ id: "nba-game-1", status: "scheduled", homeTeam: "Boston Celtics", awayTeam: "Miami Heat" }];
  }

  async getScores(league: string, date: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getScores called for league: ${league}, date: ${date}`);
    return [{ id: "nba-game-1", status: "final", homeScore: 104, awayScore: 99 }];
  }

  async getStandings(league: string, season: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getStandings called for league: ${league}, season: ${season}`);
    return [{ team: "Boston Celtics", rank: 1, wins: 64, losses: 18 }];
  }

  async getTeamStats(league: string, season: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getTeamStats called for league: ${league}, season: ${season}`);
    return [{ team: "Boston Celtics", offensiveRating: 122.2, defensiveRating: 110.6 }];
  }

  async getPlayerStats(league: string, season: string, playerId?: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getPlayerStats called for league: ${league}, season: ${season}, playerId: ${playerId || "all"}`);
    return [{ playerId: "tatum-01", name: "Jayson Tatum", ppg: 26.9, rpg: 8.1, apg: 4.9 }];
  }

  async getInjuries(league: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getInjuries called for league: ${league}`);
    return [{ team: "Miami Heat", player: "Jimmy Butler", status: "Out", injury: "Knee" }];
  }

  async getOdds(league: string, sport: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getOdds called for league: ${league}, sport: ${sport}`);
    return [{ gameId: "nfl-game-1", homeOdds: 1.8, awayOdds: 2.1, spread: "-2.5" }];
  }

  async getNews(league: string): Promise<any[]> {
    console.log(`[StubSportsDataProvider] getNews called for league: ${league}`);
    return [{ title: "Celtics clinch championship", content: "Boston Celtics secure the title after an outstanding performance." }];
  }
}

export default StubSportsDataProvider;
