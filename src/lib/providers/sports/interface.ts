export interface SportsDataProvider {
  name: string;
  /** True only for the no-op StubSportsDataProvider. Lets guards detect a stub
   *  by instance instead of string-matching the SPORTS_PROVIDER env value (so an
   *  unimplemented value like "api-sports" that resolves to a stub is caught). */
  isStub?: boolean;
  getSchedules(league: string, season: string): Promise<any[]>;
  getScores(league: string, date: string): Promise<any[]>;
  getStandings(league: string, season: string): Promise<any[]>;
  getTeamStats(league: string, season: string): Promise<any[]>;
  getPlayerStats(league: string, season: string, playerId?: string): Promise<any[]>;
  getInjuries(league: string): Promise<any[]>;
  getOdds(league: string, sport: string): Promise<any[]>;
  getNews(league: string): Promise<any[]>;
}
