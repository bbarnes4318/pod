export interface SportsDataProvider {
  name: string;
  getSchedules(league: string, season: string): Promise<any[]>;
  getScores(league: string, date: string): Promise<any[]>;
  getStandings(league: string, season: string): Promise<any[]>;
  getTeamStats(league: string, season: string): Promise<any[]>;
  getPlayerStats(league: string, season: string, playerId?: string): Promise<any[]>;
  getInjuries(league: string): Promise<any[]>;
  getOdds(league: string, sport: string): Promise<any[]>;
  getNews(league: string): Promise<any[]>;
}
