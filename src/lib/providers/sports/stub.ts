import { SportsDataProvider, SportsGame, TalkingPointSuggestion } from "./interface";

export class StubSportsDataProvider implements SportsDataProvider {
  name = "stub-sports-data";

  async getLiveGames(): Promise<SportsGame[]> {
    console.log("[StubSportsDataProvider] getLiveGames called");
    return [
      {
        id: "nba-1",
        homeTeam: "Boston Celtics",
        awayTeam: "Miami Heat",
        homeScore: 104,
        awayScore: 99,
        status: "final",
        startTime: new Date().toISOString(),
      },
      {
        id: "nfl-1",
        homeTeam: "Kansas City Chiefs",
        awayTeam: "San Francisco 49ers",
        status: "scheduled",
        startTime: new Date().toISOString(),
      }
    ];
  }

  async getTalkingPoints(): Promise<TalkingPointSuggestion[]> {
    console.log("[StubSportsDataProvider] getTalkingPoints called");
    return [
      {
        title: "Celtics clinch Game 7 vs Heat",
        description: "Boston wins a tense defensive battle. Narratives are focused on Tatum's clutch shots under pressure, while efficiency models point to Boston's shot quality variance.",
        category: "NBA",
      },
      {
        title: "Chiefs vs 49ers Odds Volatility",
        description: "Odds fluctuate. Dr. Linebreak argues the 49ers are mathematically undervalued by 2.3%, whereas Max Voltage points to Patrick Mahomes' record in legacy-defining moments.",
        category: "NFL",
      }
    ];
  }
}

export default StubSportsDataProvider;
