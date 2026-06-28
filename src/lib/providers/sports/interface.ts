export interface SportsGame {
  id: string;
  homeTeam: string;
  awayTeam: string;
  homeScore?: number;
  awayScore?: number;
  status: "scheduled" | "live" | "final";
  startTime: string;
}

export interface TalkingPointSuggestion {
  title: string;
  description: string;
  sourceUrl?: string;
  category: string;
}

export interface SportsDataProvider {
  name: string;
  getLiveGames(): Promise<SportsGame[]>;
  getTalkingPoints(): Promise<TalkingPointSuggestion[]>;
}
