import React from "react";
import { currentUser } from "@/lib/currentUser";
import { getOwnerAnalytics } from "@/lib/services/analyticsService";
import { buildInsights } from "@/lib/analytics/insights";
import AnalyticsDashboard from "./AnalyticsDashboard";
import "../library.css";

export const dynamic = "force-dynamic";

const ALLOWED_DAYS = [7, 30, 90];

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { days: daysRaw } = await searchParams;
  const user = await currentUser(); // the /studio layout already gates sign-in

  const days = ALLOWED_DAYS.includes(Number(daysRaw)) ? Number(daysRaw) : 30;

  // Owner-scoped SERVER-SIDE: getOwnerAnalytics only ever reads events for
  // episodes this user owns. A signed-out request (shouldn't happen behind the
  // layout gate) sees nothing.
  const summary = user
    ? await getOwnerAnalytics(user.id, { days })
    : { totalDownloads: 0, totalPlays: 0, episodeCount: 0, daily: [], byEpisode: [], byCountry: [], byApp: [], rangeDays: days, bySource: [], episodes: [], trackingSince: null, lifetimeEvents: 0 };

  // Takeaways are computed here, from the same rows the dashboard shows.
  const insights = buildInsights({
    episodes: summary.episodes,
    bySource: summary.bySource,
    daily: summary.daily,
    trackingSince: summary.trackingSince,
    rangeDays: days,
    now: new Date().toISOString(),
  });

  return <AnalyticsDashboard summary={summary} days={days} insights={insights} />;
}
