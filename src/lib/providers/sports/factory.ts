import { SportsDataProvider } from "./interface";
import { StubSportsDataProvider } from "./stub";

export function getSportsDataProvider(): SportsDataProvider {
  const providerType = process.env.SPORTS_PROVIDER?.toLowerCase() || "stub";

  switch (providerType) {
    case "sportsdataio":
      console.log("[SportsFactory] SportsDataIO requested (not fully implemented in architectural stub phase). Falling back to Stub.");
      return new StubSportsDataProvider();
    case "oddsapi":
      console.log("[SportsFactory] The Odds API requested (not fully implemented in architectural stub phase). Falling back to Stub.");
      return new StubSportsDataProvider();
    case "stub":
    default:
      return new StubSportsDataProvider();
  }
}

export default getSportsDataProvider;
