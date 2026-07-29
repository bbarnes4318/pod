"use client";

import type { AnalyticsSummary } from "@/lib/services/analyticsService";
import { AppPage, PageHeader, ButtonLink, MetricGrid, Metric, Section, SectionHeader, Card, DataTable, RowTitle, TableRowActions, EmptyState } from "@/components/studio";

const RANGES = [7, 30, 90];
function fmtDate(iso: string): string { return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

export default function AnalyticsDashboard({ summary, days }: { summary: AnalyticsSummary; days: number }) {
  const hasData = summary.totalDownloads + summary.totalPlays > 0;
  const maxDaily = Math.max(1, ...summary.daily.map(day => day.downloads + day.plays));
  const maxCountry = Math.max(1, ...summary.byCountry.map(country => country.count));
  const maxApp = Math.max(1, ...summary.byApp.map(app => app.count));
  const average = summary.episodeCount > 0 ? summary.totalPlays / summary.episodeCount : null;

  return <AppPage>
    <PageHeader title="Analytics" description="Owner-scoped downloads and in-app plays, deduplicated by client and day." actions={<div className="analyticsRange">{RANGES.map(range => <ButtonLink key={range} href={`/studio/analytics?days=${range}`} variant={range === days ? "secondary" : "ghost"} size="compact">{range} days</ButtonLink>)}</div>} />
    <MetricGrid><Metric label="Downloads" value={summary.totalDownloads.toLocaleString()} hint={`Last ${days} days`} /><Metric label="In-app plays" value={summary.totalPlays.toLocaleString()} hint={`Last ${days} days`} /><Metric label="Episodes" value={summary.episodeCount.toLocaleString()} hint="Included in this account" /><Metric label="Average plays" value={average === null ? "—" : average.toFixed(1)} hint="Per episode" /></MetricGrid>
    <Section><SectionHeader title="Activity over time" description={summary.daily.length ? `${fmtDate(summary.daily[0].date)} – ${fmtDate(summary.daily[summary.daily.length - 1].date)}` : `Last ${days} days`} />
      <Card className="analyticsChartCard">{hasData ? <div className="analyticsChart" role="img" aria-label="Downloads and plays per day"><div className="analyticsYAxis"><span>{maxDaily}</span><span>{Math.round(maxDaily / 2)}</span><span>0</span></div><div className="analyticsBars">{summary.daily.map(day => { const total = day.downloads + day.plays; const totalHeight = (total / maxDaily) * 100; const playHeight = total > 0 ? (day.plays / total) * totalHeight : 0; const downloadHeight = totalHeight - playHeight; return <div key={day.date} className="analyticsBarColumn" title={`${fmtDate(day.date)}: ${day.downloads} downloads, ${day.plays} plays`}><div className="analyticsBarStack"><div className="analyticsBarPlay" style={{ height: `${playHeight}%` }} /><div className="analyticsBarDownload" style={{ height: `${downloadHeight}%` }} /></div></div>; })}</div></div> : <EmptyState title="No activity in this range" description="The chart will populate when listeners fetch the feed, download an episode, or press play. No sample analytics are manufactured." />}
      <div className="analyticsLegend"><span><i className="analyticsLegendDownload" />Downloads</span><span><i className="analyticsLegendPlay" />In-app plays</span></div></Card>
    </Section>
    <div className="analyticsBreakdowns"><Section><SectionHeader title="Countries" /><Card>{summary.byCountry.length === 0 ? <p className="analyticsMuted">No country data is available for this range.</p> : summary.byCountry.map(country => <div key={country.country} className="analyticsBreakdownRow"><span>{country.country}</span><div className="analyticsTrack"><div style={{ width: `${(country.count / maxCountry) * 100}%` }} /></div><strong>{country.count}</strong></div>)}</Card></Section><Section><SectionHeader title="Apps and clients" /><Card>{summary.byApp.length === 0 ? <p className="analyticsMuted">No client data is available for this range.</p> : summary.byApp.map(app => <div key={app.app} className="analyticsBreakdownRow"><span>{app.app}</span><div className="analyticsTrack"><div style={{ width: `${(app.count / maxApp) * 100}%` }} /></div><strong>{app.count}</strong></div>)}</Card></Section></div>
    <Section><SectionHeader title="Episode performance" />{summary.byEpisode.length === 0 ? <EmptyState title="No episode activity" description="Episodes with plays or downloads in this range will appear here." /> : <DataTable label="Episode analytics"><thead><tr><th>Episode</th><th>Downloads</th><th>Plays</th><th>Total</th><th><span className="srOnly">Action</span></th></tr></thead><tbody>{summary.byEpisode.map(episode => <tr key={episode.episodeId}><td><RowTitle title={episode.title} /></td><td>{episode.downloads.toLocaleString()}</td><td>{episode.plays.toLocaleString()}</td><td>{(episode.downloads + episode.plays).toLocaleString()}</td><td><TableRowActions><ButtonLink href={`/studio/episodes/${episode.episodeId}`} variant="ghost" size="compact">Open</ButtonLink></TableRowActions></td></tr>)}</tbody></DataTable>}</Section>
  </AppPage>;
}
