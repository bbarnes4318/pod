"use client";

// Analytics dashboard — real, owner-scoped download/listen data.
// Every number comes from the PlayEvent rows for the signed-in owner's
// episodes. Two rules hold on every panel:
//   · missing data never renders as "0". An episode that was never published,
//     or a day before tracking began, says so in words.
//   · a takeaway carries the numbers it was computed from, or says there are
//     not enough yet (rules in src/lib/analytics/insights.ts).
// Charts are CSS bars (no chart dependency).

import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import type { AnalyticsSummary } from "@/lib/services/analyticsService";
import { classifyEpisode, classifyPeriod, STATE_LABEL, SOURCE_LABEL, type EpisodeDataState, type Insight } from "@/lib/analytics/insights";

const RANGES = [7, 30, 90];
const MAX_EPISODE_ROWS = 50;

function fmtDate(iso: string): string {
  const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

const STATE_ORDER: EpisodeDataState[] = ["measured", "zero_in_range", "no_events_ever", "before_tracking", "not_published"];

export default function AnalyticsDashboard({ summary, days, insights }: { summary: AnalyticsSummary; days: number; insights: Insight[] }) {
  const rangeEvents = summary.totalDownloads + summary.totalPlays;
  const publishedCount = summary.episodes.filter((e) => e.published).length;
  const period = classifyPeriod({ episodeCount: summary.episodeCount, publishedCount, lifetimeEvents: summary.lifetimeEvents, rangeEvents });
  const measured = period === "measured" || period === "measured_zero";
  const trackingDay = summary.trackingSince ? summary.trackingSince.slice(0, 10) : null;
  const isTracked = (date: string) => !!trackingDay && date >= trackingDay;
  const untrackedDays = summary.daily.filter((d) => !isTracked(d.date)).length;

  const maxDaily = Math.max(1, ...summary.daily.map((d) => d.downloads + d.plays));
  const maxCountry = Math.max(1, ...summary.byCountry.map((c) => c.count));
  const maxApp = Math.max(1, ...summary.byApp.map((a) => a.count));
  const maxSource = Math.max(1, ...summary.bySource.map((s) => s.count));

  const rows = summary.episodes
    .map((e) => ({ ...e, state: classifyEpisode(e, summary.trackingSince), events: e.downloads + e.plays }))
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || b.events - a.events || b.lifetimeEvents - a.lifetimeEvents);
  const listed = rows.filter((r) => r.state !== "not_published");
  const unpublished = rows.length - listed.length;
  const withData = rows.filter((r) => r.lifetimeEvents > 0).length;
  const flagged = new Set(insights.flatMap((i) => i.episodeIds ?? []));

  // Words for a period with nothing to show. Each is a different fact.
  const periodNote: Record<typeof period, string | null> = {
    measured: null,
    measured_zero: `Measured: no downloads or plays in the last ${days} days. Tracking is working (it has recorded ${summary.lifetimeEvents.toLocaleString()} for your episodes before this period), so this is a real zero.`,
    no_data: "No tracking data yet. You have published episodes, but no download or play has ever been recorded for them, so there is nothing to measure. This is not a count of zero listeners.",
    nothing_published: "No tracking data yet: none of your episodes has been published, so there is nothing to measure.",
    no_episodes: "No tracking data yet: you have no episodes.",
  };

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Analytics"
        subtitle="Download and listen counts for your episodes, deduped per client per day."
        actions={
          <div className="anRange">
            {RANGES.map((r) => (
              <Link key={r} href={`/studio/analytics?days=${r}`} className={`anRangeBtn${r === days ? " on" : ""}`} aria-current={r === days ? "true" : undefined}>
                {r}d
              </Link>
            ))}
          </div>
        }
      />

      {periodNote[period] && (
        <div className="anState" data-state={period} role="status">{periodNote[period]}</div>
      )}

      {/* Stat cards: a dash, not a zero, when nothing was ever measured. */}
      <div className="anStats">
        <div className="anStat">
          <div className="anStatNum">{measured ? summary.totalDownloads.toLocaleString() : "—"}</div>
          <div className="anStatLabel">Downloads{measured ? "" : " (no data)"}</div>
        </div>
        <div className="anStat">
          <div className="anStatNum">{measured ? summary.totalPlays.toLocaleString() : "—"}</div>
          <div className="anStatLabel">In-app plays{measured ? "" : " (no data)"}</div>
        </div>
        <div className="anStat">
          <div className="anStatNum">{withData.toLocaleString()} <span className="anStatOf">of {publishedCount.toLocaleString()}</span></div>
          <div className="anStatLabel">Episodes with tracking data, of those published</div>
        </div>
      </div>
      {trackingDay && (
        <p className="anMuted mt-3">Tracking data for your episodes begins {fmtDate(trackingDay)}. Anything before that was not recorded and is shown as missing, not as zero.</p>
      )}

      {/* Takeaways */}
      <section className="mt-6" aria-labelledby="an-takeaways">
        <div className="sectionHead"><h2 className="sectionTitle" id="an-takeaways">What the numbers say</h2></div>
        <div className="anInsights">
          {insights.map((i) => (
            <article key={i.id} className="anInsight" data-kind={i.kind}>
              <h3 className="anInsightTitle">{i.title}</h3>
              <span className="anInsightKind">{i.kind === "finding" ? "From your data" : "Not enough data"}</span>
              <ul className="anInsightLines">
                {i.lines.map((line, n) => <li key={n}>{line}</li>)}
              </ul>
              <details className="anInsightBasis">
                <summary>How this is worked out</summary>
                <p>{i.basis}</p>
              </details>
            </article>
          ))}
        </div>
      </section>

      {/* Downloads/plays over time */}
      <div className="studioCard mt-6">
        <div className="sectionTitle mb-4">Over time</div>
        {period === "measured" || untrackedDays < summary.daily.length ? (
          <>
            <div className="anBars" role="img" aria-label={`Downloads and plays per day, last ${days} days. ${rangeEvents.toLocaleString()} in total${untrackedDays ? `; the first ${untrackedDays} days have no tracking data` : ""}.`}>
              {summary.daily.map((d) => {
                const tracked = isTracked(d.date);
                const total = d.downloads + d.plays;
                const h = (total / maxDaily) * 100;
                const dlH = total > 0 ? (d.downloads / total) * h : 0;
                const plH = h - dlH;
                return (
                  <div
                    key={d.date}
                    className="anBarCol"
                    data-untracked={tracked ? undefined : "true"}
                    title={tracked ? `${fmtDate(d.date)} · ${d.downloads} downloads · ${d.plays} plays` : `${fmtDate(d.date)} · no tracking data`}
                  >
                    <div className="anBarStack">
                      <div className="anBarPlay" style={{ "--bar-h": `${plH}%` } as React.CSSProperties} />
                      <div className="anBarDl" style={{ "--bar-h": `${dlH}%` } as React.CSSProperties} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="anLegend">
              <span><i className="anDot anDotDl" /> Downloads</span>
              <span><i className="anDot anDotPlay" /> Plays</span>
              {untrackedDays > 0 && <span><i className="anDot anDotNone" /> No tracking data</span>}
              <span className="anAxis">{summary.daily.length ? `${fmtDate(summary.daily[0].date)} – ${fmtDate(summary.daily[summary.daily.length - 1].date)}` : ""}</span>
            </div>
          </>
        ) : (
          <div className="anMuted">No tracking data for any day in this period, so there is no chart to draw.</div>
        )}
      </div>

      <div className="grid2 mt-6">
        <div className="studioCard">
          <div className="sectionTitle mb-4">By source</div>
          {summary.bySource.length === 0 ? (
            <div className="anMuted">{measured ? "Nothing recorded in this period." : "No tracking data yet."}</div>
          ) : (
            summary.bySource.map((s) => (
              <div key={s.source} className="anRow">
                <span className="anRowLabel anRowLabel--wide">{SOURCE_LABEL[s.source] ?? s.source}</span>
                <div className="anRowTrack"><div className="anRowFill" style={{ "--bar-w": `${(s.count / maxSource) * 100}%` } as React.CSSProperties} /></div>
                <span className="anRowNum">{s.count}</span>
              </div>
            ))
          )}
        </div>

        <div className="studioCard">
          <div className="sectionTitle mb-4">By app / client</div>
          {summary.byApp.length === 0 ? (
            <div className="anMuted">{measured ? "Nothing recorded in this period." : "No tracking data yet."}</div>
          ) : (
            summary.byApp.map((a) => (
              <div key={a.app} className="anRow">
                <span className="anRowLabel">{a.app}</span>
                <div className="anRowTrack"><div className="anRowFill" style={{ "--bar-w": `${(a.count / maxApp) * 100}%` } as React.CSSProperties} /></div>
                <span className="anRowNum">{a.count}</span>
              </div>
            ))
          )}
        </div>

        <div className="studioCard">
          <div className="sectionTitle mb-4">By country</div>
          {summary.byCountry.length === 0 ? (
            <div className="anMuted">{measured ? "Nothing recorded in this period." : "No tracking data yet."}</div>
          ) : (
            <>
              {summary.byCountry.map((c) => (
                <div key={c.country} className="anRow">
                  <span className="anRowLabel">{c.country === "Unknown" ? "Not provided" : c.country}</span>
                  <div className="anRowTrack"><div className="anRowFill" style={{ "--bar-w": `${(c.count / maxCountry) * 100}%` } as React.CSSProperties} /></div>
                  <span className="anRowNum">{c.count}</span>
                </div>
              ))}
              <p className="anMuted mt-3">Country is recorded only when the network supplies it. &quot;Not provided&quot; is missing data, not a place.</p>
            </>
          )}
        </div>
      </div>

      {/* By episode: every published or tracked episode, with its data state. */}
      <div className="studioCard mt-6">
        <div className="sectionTitle mb-4">By episode</div>
        {listed.length === 0 ? (
          <div className="anMuted">{summary.episodeCount === 0 ? "You have no episodes." : "None of your episodes has been published or tracked, so there is nothing to list."}</div>
        ) : (
          <ul className="anEpList">
            {listed.slice(0, MAX_EPISODE_ROWS).map((e) => (
              <li key={e.episodeId} className="anEp" data-state={e.state} data-flagged={flagged.has(e.episodeId) ? "true" : undefined}>
                <div className="anEpWhat">
                  <Link href={`/studio/episodes/${e.episodeId}`} className="anEpName">{e.title}</Link>
                  <span className="anEpShow">
                    {e.showName ?? "Standalone episode"}
                    {e.publishedAt ? ` · published ${fmtDate(e.publishedAt)}` : ""}
                    {flagged.has(e.episodeId) ? " · named in a takeaway above" : ""}
                  </span>
                </div>
                {e.state === "measured" ? (
                  <dl className="anEpNums">
                    <div><dt>Downloads</dt><dd>{e.downloads.toLocaleString()}</dd></div>
                    <div><dt>Plays</dt><dd>{e.plays.toLocaleString()}</dd></div>
                  </dl>
                ) : (
                  <span className="anEpState">{STATE_LABEL[e.state]}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {(listed.length > MAX_EPISODE_ROWS || unpublished > 0) && (
          <p className="anMuted mt-3">
            {listed.length > MAX_EPISODE_ROWS ? `Showing the first ${MAX_EPISODE_ROWS} of ${listed.length.toLocaleString()} episodes. ` : ""}
            {unpublished > 0 ? `${unpublished.toLocaleString()} unpublished episode${unpublished === 1 ? " is" : "s are"} not listed: nothing to measure.` : ""}
          </p>
        )}
      </div>

      <p className="anFoot">
        Privacy: no IP address or personal data is stored — only a salted, truncated client hash used to dedupe, a coarse app label from the user-agent, and a country code when the network provides one.
      </p>
    </div>
  );
}
