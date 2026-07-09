import { SportsDataProvider } from "./interface";
import { StubSportsDataProvider } from "./stub";
import { SportsDataIOProvider } from "./sportsdataio";
import { OddsApiProvider } from "./oddsapi";
import { RssNewsProvider } from "./rss";

/** Every SPORTS_PROVIDER value that maps to a real, implemented adapter.
 *  "stub" is intentionally NOT here — it is a valid explicit dev/validation
 *  choice, but it is not a real provider and is rejected in production. */
export const IMPLEMENTED_SPORTS_PROVIDERS = ["sportsdataio", "oddsapi", "rss-news", "rss"] as const;

/**
 * Resolve a sports data provider.
 *
 * Fails LOUDLY on an unknown value instead of silently defaulting to the stub:
 * a typo or an unimplemented provider (e.g. "api-sports", which has no adapter)
 * used to fall through to `stub` and quietly ingest nothing. Now it throws so
 * misconfiguration surfaces immediately (at the ingest job and at boot).
 * `stub` is still returned for the explicit "stub" value only.
 */
export function getSportsDataProvider(type?: string): SportsDataProvider {
  const providerType = (type || process.env.SPORTS_PROVIDER || "stub").trim().toLowerCase();

  switch (providerType) {
    case "sportsdataio":
      return new SportsDataIOProvider();
    case "oddsapi":
      return new OddsApiProvider();
    case "rss-news":
    case "rss":
      return new RssNewsProvider();
    case "stub":
      return new StubSportsDataProvider();
    default:
      throw new Error(
        `Unknown SPORTS_PROVIDER '${providerType}'. Implemented providers: ${IMPLEMENTED_SPORTS_PROVIDERS.join(
          ", "
        )} (or 'stub' for local validation only). If you meant a real feed, use 'sportsdataio'.`
      );
  }
}

/** True when the resolved provider is the no-op stub — check the INSTANCE, not
 *  the env string, so an unimplemented value can't sneak past a guard. */
export function isStubSportsProvider(provider: SportsDataProvider): boolean {
  return provider.isStub === true || provider.name === "stub-sports-data";
}

export default getSportsDataProvider;
