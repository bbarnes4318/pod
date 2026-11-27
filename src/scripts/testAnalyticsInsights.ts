// Analytics insights: missing data is never reported as zero, and no takeaway
// is stated below its minimum sample.  Run: npx tsx src/scripts/testAnalyticsInsights.ts

import assert from "node:assert/strict";
import { buildInsights, classifyEpisode, classifyPeriod, median, RULES, type EpisodeStat } from "../lib/analytics/insights";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${(err as Error).message}`);
    failed++;
  }
}

const ep = (over: Partial<EpisodeStat>): EpisodeStat => ({
  episodeId: "e", title: "Episode", showId: "s1", showName: "Show One", published: true,
  publishedAt: "2026-01-01T00:00:00.000Z", downloads: 0, plays: 0, lifetimeEvents: 0, ...over,
});
const NOW = "2026-06-30T00:00:00.000Z";
const TRACKING = "2026-03-01T00:00:00.000Z";
const days = (perDay: number[]) =>
  perDay.map((n, i) => ({ date: new Date(Date.parse("2026-06-01T00:00:00Z") + i * 86_400_000).toISOString().slice(0, 10), downloads: n, plays: 0 }));
const find = (insights: ReturnType<typeof buildInsights>, id: string) => insights.find((i) => i.id === id)!;

console.log("Analytics insights\n");

check("an episode's zero is only 'measured' when it has ever been tracked", () => {
  assert.equal(classifyEpisode(ep({ downloads: 3, lifetimeEvents: 9 }), TRACKING), "measured");
  assert.equal(classifyEpisode(ep({ lifetimeEvents: 9 }), TRACKING), "zero_in_range");
  assert.equal(classifyEpisode(ep({ published: false, publishedAt: null }), TRACKING), "not_published");
  assert.equal(classifyEpisode(ep({ publishedAt: "2026-01-01T00:00:00.000Z" }), TRACKING), "before_tracking");
  assert.equal(classifyEpisode(ep({ publishedAt: "2026-04-01T00:00:00.000Z" }), TRACKING), "no_events_ever");
  assert.equal(classifyEpisode(ep({}), null), "no_events_ever", "no tracking at all is not 'before tracking'");
});

check("a period with no events is 'no data' unless the account has ever recorded one", () => {
  assert.equal(classifyPeriod({ episodeCount: 0, publishedCount: 0, lifetimeEvents: 0, rangeEvents: 0 }), "no_episodes");
  assert.equal(classifyPeriod({ episodeCount: 3, publishedCount: 0, lifetimeEvents: 0, rangeEvents: 0 }), "nothing_published");
  assert.equal(classifyPeriod({ episodeCount: 3, publishedCount: 2, lifetimeEvents: 0, rangeEvents: 0 }), "no_data");
  assert.equal(classifyPeriod({ episodeCount: 3, publishedCount: 2, lifetimeEvents: 40, rangeEvents: 0 }), "measured_zero");
  assert.equal(classifyPeriod({ episodeCount: 3, publishedCount: 2, lifetimeEvents: 40, rangeEvents: 5 }), "measured");
});

check("median", () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 2, 8, 6]), 5);
});

check("below the minimum sample every takeaway says 'not enough data'", () => {
  const insights = buildInsights({
    episodes: [ep({ episodeId: "a", downloads: 50, lifetimeEvents: 50 }), ep({ episodeId: "b", downloads: 1, lifetimeEvents: 1 })],
    bySource: [{ source: "rss", count: RULES.minEventsForMix - 1 }],
    daily: days([1, 1, 1, 1]),
    trackingSince: TRACKING, rangeDays: 30, now: NOW,
  });
  assert.equal(insights.length, 4);
  for (const i of insights) {
    assert.equal(i.kind, "insufficient", `${i.id} drew a conclusion from too little data`);
    assert.match(i.lines[0], /^Not enough data/);
  }
});

check("over- and under-performers are named with the numbers behind them", () => {
  const episodes = [
    ep({ episodeId: "hit", title: "Hit", downloads: 40, lifetimeEvents: 40 }),
    ep({ episodeId: "mid1", downloads: 10, lifetimeEvents: 10 }),
    ep({ episodeId: "mid2", downloads: 10, lifetimeEvents: 10 }),
    ep({ episodeId: "mid3", downloads: 12, lifetimeEvents: 12 }),
    ep({ episodeId: "miss", title: "Miss", downloads: 2, lifetimeEvents: 30 }),
    // Published 2 days before NOW: too new to be called an under-performer.
    ep({ episodeId: "new", title: "Fresh", downloads: 1, lifetimeEvents: 1, publishedAt: "2026-06-28T00:00:00.000Z" }),
    // Never tracked: must not drag the median down as a zero.
    ep({ episodeId: "untracked", title: "Untracked" }),
  ];
  const i = find(buildInsights({ episodes, bySource: [], daily: [], trackingSince: TRACKING, rangeDays: 30, now: NOW }), "episodes");
  assert.equal(i.kind, "finding");
  assert.deepEqual(i.episodeIds, ["hit", "miss"]);
  assert.match(i.lines[0], /"Hit" had 40 .* 4\.0× your median of 10/);
  assert.match(i.lines[1], /"Miss" had 2, against your median of 10/);
  assert.ok(!i.lines.join(" ").includes("Fresh"), "an episode live under a week was compared");
  assert.ok(!i.lines.join(" ").includes("Untracked"), "an episode with no tracking data was compared");
});

check("source mix and trend state their counts; a half without tracking is not compared", () => {
  const base = { episodes: [], rangeDays: 4, now: NOW };
  const mix = find(buildInsights({ ...base, bySource: [{ source: "player", count: 10 }, { source: "rss", count: 30 }], daily: [], trackingSince: TRACKING }), "sources");
  assert.equal(mix.kind, "finding");
  assert.match(mix.lines[0], /RSS feed\): 75% \(30 of 40\)/);

  const trend = find(buildInsights({ ...base, bySource: [], daily: days([5, 5, 10, 10]), trackingSince: TRACKING }), "trend");
  assert.equal(trend.kind, "finding");
  assert.match(trend.lines[0], /Last 2 days: 20 .* before: 10 \(\+100%\)/);

  // Tracking began on the third day: the first half is missing, not zero.
  const partial = find(buildInsights({ ...base, bySource: [], daily: days([0, 0, 10, 10]), trackingSince: "2026-06-03T00:00:00.000Z" }), "trend");
  assert.equal(partial.kind, "insufficient");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
