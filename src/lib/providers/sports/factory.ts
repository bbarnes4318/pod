import { SportsDataProvider } from "./interface";
import { StubSportsDataProvider } from "./stub";
import { SportsDataIOProvider } from "./sportsdataio";
import { OddsApiProvider } from "./oddsapi";
import { RssNewsProvider } from "./rss";

export function getSportsDataProvider(type?: string): SportsDataProvider {
  const providerType = type || process.env.SPORTS_PROVIDER || "stub";

  switch (providerType.toLowerCase()) {
    case "sportsdataio":
      return new SportsDataIOProvider();
    case "oddsapi":
      return new OddsApiProvider();
    case "rss-news":
    case "rss":
      return new RssNewsProvider();
    case "stub":
    default:
      return new StubSportsDataProvider();
  }
}

export default getSportsDataProvider;
