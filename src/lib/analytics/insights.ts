// Analytics classification and takeaways. Pure: no database, no clock of its
// own, no Node imports (the Studio dashboard is a client component).
//
// Two jobs:
//   1. Say whether a number is a MEASURED zero or simply MISSING. "0" for an
//      episode that was never published, or that was published before this
//      account had any tracking, is not a measurement and must not look like one.
//   2. Turn stored counts into takeaways. Every takeaway states the numbers it
//      was computed from, and below a minimum sample it says "not enough data"
//      instead of a conclusion. The thresholds are heuristics, exported in
//      RULES so the screen can print them.
//
// "Events" throughout = downloads + plays, already IAB-deduped per client per
// UTC day by the PlayEvent unique key.

export const RULES = {
  /** Episodes with tracking data needed before an episode is compared to the median. */
  minEpisodesForMedian: 4,
  /** Events in the period, across those episodes, needed for the same comparison. */
  minEventsForMedian: 30,
  /** An episode published fewer days ago than this is "too new", not "under". */
  minDaysLiveToCompare: 7,
  /** Over = at least this multiple of the median AND at least minAbsoluteGap above it. */
  overFactor: 1.5,
  /** Under = at most this multiple of the median AND at least minAbsoluteGap below it. */
  underFactor: 0.5,
  minAbsoluteGap: 5,
  /** A show needs this many tracked episodes to be compared. */
  minEpisodesPerShow: 2,
  /** Events needed before a source split or a trend is stated. */
  minEventsForMix: 20,
  minEventsForTrend: 20,
} as const;

export type EpisodeDataState =
  | "measured" //            events in this period
  | "zero_in_range" //       has events at some point, none in this period: a measured zero
  | "not_published" //       never published, never tracked: no data can exist
  | "before_tracking" //     published before this account's first recorded event, none recorded since
  | "no_events_ever"; //     published, nothing ever recorded: no tracking data yet

export interface EpisodeStat {
  episodeId: string;
  title: string;
  showId: string | null;
  showName: string | null;
  published: boolean;
  /** ISO timestamp, or null. */
  publishedAt: string | null;
  /** Downloads and plays in the selected period. */
  downloads: number;
  plays: number;
  /** Every event ever recorded for this episode, any period. */
  lifetimeEvents: number;
}

export type PeriodState = "no_episodes" | "nothing_published" | "no_data" | "measured_zero" | "measured";

export interface Insight {
  id: "episodes" | "shows" | "sources" | "trend";
  title: string;
  /** "finding" states a conclusion; "insufficient" says why there is none. */
  kind: "finding" | "insufficient";
  /** One sentence each. For a finding, every line carries its own numbers. */
  lines: string[];
  /** The rule that was applied, in words. */
  basis: string;
  /** Episodes named by a finding, so the screen can link them. */
  episodeIds?: string[];
}

const rangeEvents = (e: EpisodeStat) => e.downloads + e.plays;

/** `trackingSince` = ISO timestamp of the account's first recorded event, or null. */
export function classifyEpisode(e: EpisodeStat, trackingSince: string | null): EpisodeDataState {
  if (rangeEvents(e) > 0) return "measured";
  if (e.lifetimeEvents > 0) return "zero_in_range";
  if (!e.published) return "not_published";
  if (trackingSince && e.publishedAt && e.publishedAt < trackingSince) return "before_tracking";
  return "no_events_ever";
}

export const STATE_LABEL: Record<EpisodeDataState, string> = {
  measured: "Measured",
  zero_in_range: "0 in this period (measured)",
  not_published: "Not published, so nothing to measure",
  before_tracking: "Published before tracking began; nothing recorded since",
  no_events_ever: "No tracking data yet",
};

export function classifyPeriod(input: { episodeCount: number; publishedCount: number; lifetimeEvents: number; rangeEvents: number }): PeriodState {
  if (input.rangeEvents > 0) return "measured";
  if (input.lifetimeEvents > 0) return "measured_zero";
  if (input.episodeCount === 0) return "no_episodes";
  if (input.publishedCount === 0) return "nothing_published";
  return "no_data";
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;
const times = (value: number, base: number) => `${(value / base).toFixed(1)}×`;
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export const SOURCE_LABEL: Record<string, string> = {
  rss: "Podcast apps (RSS feed)",
  direct: "Direct download",
  player: "In-app player",
};

export interface InsightInput {
  episodes: EpisodeStat[];
  bySource: { source: string; count: number }[];
  /** Oldest first, one entry per UTC day in the period. */
  daily: { date: string; downloads: number; plays: number }[];
  trackingSince: string | null;
  rangeDays: number;
  /** ISO timestamp for "now" (passed in so the function stays pure). */
  now: string;
}

export function buildInsights(input: InsightInput): Insight[] {
  const { episodes, bySource, daily, trackingSince, rangeDays } = input;
  const nowMs = new Date(input.now).getTime();
  const out: Insight[] = [];

  // The comparison set: episodes this account has tracking data for.
  const tracked = episodes.filter((e) => e.lifetimeEvents > 0);
  const trackedTotal = tracked.reduce((n, e) => n + rangeEvents(e), 0);
  const med = median(tracked.map(rangeEvents));
  const enoughForMedian = tracked.length >= RULES.minEpisodesForMedian && trackedTotal >= RULES.minEventsForMedian && med !== null && med > 0;
  const medianBasis =
    `Compared with your own median episode over the last ${rangeDays} days. Needs at least ${RULES.minEpisodesForMedian} episodes with tracking data and ` +
    `${RULES.minEventsForMedian} downloads and plays between them. "Above" means ${RULES.overFactor}× the median or more, "below" means ${RULES.underFactor}× or less, ` +
    `and at least ${RULES.minAbsoluteGap} away from it. Episodes published in the last ${RULES.minDaysLiveToCompare} days are left out. A rule of thumb, not a statistical test.`;

  // 1. Episodes against the account's own median.
  if (!enoughForMedian) {
    out.push({
      id: "episodes",
      title: "Episodes against your median",
      kind: "insufficient",
      lines: [
        `Not enough data: ${plural(tracked.length, "episode")} with tracking data, and ${trackedTotal.toLocaleString()} downloads and plays between them in this period.`,
      ],
      basis: medianBasis,
    });
  } else {
    const m = med as number;
    const liveLongEnough = (e: EpisodeStat) =>
      !e.publishedAt || nowMs - new Date(e.publishedAt).getTime() >= RULES.minDaysLiveToCompare * 86_400_000;
    const comparable = tracked.filter(liveLongEnough);
    const over = comparable
      .filter((e) => rangeEvents(e) >= m * RULES.overFactor && rangeEvents(e) - m >= RULES.minAbsoluteGap)
      .sort((a, b) => rangeEvents(b) - rangeEvents(a))
      .slice(0, 3);
    const under = comparable
      .filter((e) => rangeEvents(e) <= m * RULES.underFactor && m - rangeEvents(e) >= RULES.minAbsoluteGap)
      .sort((a, b) => rangeEvents(a) - rangeEvents(b))
      .slice(0, 3);
    const lines = [
      ...over.map((e) => `Above: "${e.title}" had ${rangeEvents(e).toLocaleString()} downloads and plays, ${times(rangeEvents(e), m)} your median of ${m.toLocaleString()}.`),
      ...under.map((e) => `Below: "${e.title}" had ${rangeEvents(e).toLocaleString()}, against your median of ${m.toLocaleString()}.`),
    ];
    out.push({
      id: "episodes",
      title: "Episodes against your median",
      kind: "finding",
      lines: lines.length
        ? lines
        : [`No episode stands out: all ${comparable.length} compared episodes are within range of your median of ${m.toLocaleString()} downloads and plays.`],
      basis: medianBasis,
      episodeIds: [...over, ...under].map((e) => e.episodeId),
    });
  }

  // 2. Shows: average per tracked episode, against the same account median.
  const byShow = new Map<string, { name: string; episodes: number; events: number }>();
  for (const e of tracked) {
    if (!e.showId) continue;
    const row = byShow.get(e.showId) ?? { name: e.showName ?? "Untitled show", episodes: 0, events: 0 };
    row.episodes += 1;
    row.events += rangeEvents(e);
    byShow.set(e.showId, row);
  }
  const shows = [...byShow.values()].filter((s) => s.episodes >= RULES.minEpisodesPerShow);
  const showBasis =
    `A show's average downloads and plays per episode, against your median episode. Needs the same sample as above, at least two shows, ` +
    `and ${RULES.minEpisodesPerShow} tracked episodes per show.`;
  if (!enoughForMedian || shows.length < 2) {
    out.push({
      id: "shows",
      title: "Shows compared",
      kind: "insufficient",
      lines: [`Not enough data: ${plural(shows.length, "show")} with at least ${RULES.minEpisodesPerShow} tracked episodes.`],
      basis: showBasis,
    });
  } else {
    const m = med as number;
    out.push({
      id: "shows",
      title: "Shows compared",
      kind: "finding",
      lines: shows
        .sort((a, b) => b.events / b.episodes - a.events / a.episodes)
        .map((s) => {
          const avg = s.events / s.episodes;
          return `${s.name}: ${avg.toFixed(1)} per episode across ${plural(s.episodes, "episode")} (${s.events.toLocaleString()} total), ${times(avg, m)} your median episode of ${m.toLocaleString()}.`;
        }),
      basis: showBasis,
    });
  }

  // 3. Where listens come from.
  const sourceTotal = bySource.reduce((n, s) => n + s.count, 0);
  const sourceBasis = `Share of downloads and plays by how the audio was requested. Needs at least ${RULES.minEventsForMix} in the period.`;
  if (sourceTotal < RULES.minEventsForMix) {
    out.push({
      id: "sources",
      title: "Where listens come from",
      kind: "insufficient",
      lines: [`Not enough data: ${plural(sourceTotal, "event")} in this period.`],
      basis: sourceBasis,
    });
  } else {
    out.push({
      id: "sources",
      title: "Where listens come from",
      kind: "finding",
      lines: [...bySource]
        .sort((a, b) => b.count - a.count)
        .map((s) => `${SOURCE_LABEL[s.source] ?? s.source}: ${pct(s.count, sourceTotal)} (${s.count.toLocaleString()} of ${sourceTotal.toLocaleString()}).`),
      basis: sourceBasis,
    });
  }

  // 4. Recency: the second half of the period against the first.
  const half = Math.floor(daily.length / 2);
  const firstHalf = daily.slice(daily.length - half * 2, daily.length - half);
  const secondHalf = daily.slice(daily.length - half);
  const sum = (days: typeof daily) => days.reduce((n, d) => n + d.downloads + d.plays, 0);
  const a = sum(firstHalf);
  const b = sum(secondHalf);
  const trendBasis =
    `The most recent ${half} days against the ${half} days before them. Needs at least ${RULES.minEventsForTrend} downloads and plays across both, ` +
    `and tracking data covering the whole period.`;
  const trackingDay = trackingSince ? trackingSince.slice(0, 10) : null;
  const firstHalfTracked = !!trackingDay && firstHalf.length > 0 && trackingDay <= firstHalf[0].date;
  if (half === 0 || !firstHalfTracked) {
    out.push({
      id: "trend",
      title: "Recent direction",
      kind: "insufficient",
      lines: [
        trackingDay
          ? `Not enough data: tracking for this account begins ${trackingDay}, partway through or after the earlier half of this period, so the two halves cannot be compared.`
          : "Not enough data: nothing has been recorded for this account yet.",
      ],
      basis: trendBasis,
    });
  } else if (a + b < RULES.minEventsForTrend) {
    out.push({
      id: "trend",
      title: "Recent direction",
      kind: "insufficient",
      lines: [`Not enough data: ${plural(a + b, "event")} across both halves of this period.`],
      basis: trendBasis,
    });
  } else {
    const change = a === 0 ? null : Math.round(((b - a) / a) * 100);
    out.push({
      id: "trend",
      title: "Recent direction",
      kind: "finding",
      lines: [
        `Last ${half} days: ${b.toLocaleString()} downloads and plays. The ${half} days before: ${a.toLocaleString()}` +
          (change === null ? "." : ` (${change > 0 ? "+" : ""}${change}%).`),
      ],
      basis: trendBasis,
    });
  }

  return out;
}
