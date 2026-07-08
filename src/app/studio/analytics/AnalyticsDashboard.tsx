"use client";

// Analytics dashboard (Step 9b) — real, owner-scoped download/listen data.
// Every number here comes from the PlayEvent rows for the signed-in owner's
// episodes; an owner with no events sees zeros, never fabricated data. Charts
// are inline SVG (no chart dependency).

import React from "react";
import Link from "next/link";
import type { AnalyticsSummary } from "@/lib/services/analyticsService";

const RANGES = [7, 30, 90];

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function AnalyticsDashboard({ summary, days }: { summary: AnalyticsSummary; days: number }) {
  const hasData = summary.totalDownloads + summary.totalPlays > 0;
  const maxDaily = Math.max(1, ...summary.daily.map((d) => d.downloads + d.plays));
  const maxCountry = Math.max(1, ...summary.byCountry.map((c) => c.count));
  const maxApp = Math.max(1, ...summary.byApp.map((a) => a.count));

  return (
    <div className="fadeUp">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h1 className="pageTitle">Analytics</h1>
          <p className="pageSub" style={{ marginBottom: 0 }}>
            IAB-style download &amp; listen counts for your episodes — deduped per client per day. Your data only.
          </p>
        </div>
        <div className="anRange">
          {RANGES.map((r) => (
            <Link key={r} href={`/studio/analytics?days=${r}`} className={`anRangeBtn${r === days ? " on" : ""}`}>
              {r}d
            </Link>
          ))}
        </div>
      </div>

      {/* Stat cards */}
      <div className="anStats">
        <div className="anStat">
          <div className="anStatNum">{summary.totalDownloads.toLocaleString()}</div>
          <div className="anStatLabel">Downloads</div>
        </div>
        <div className="anStat">
          <div className="anStatNum">{summary.totalPlays.toLocaleString()}</div>
          <div className="anStatLabel">In-app plays</div>
        </div>
        <div className="anStat">
          <div className="anStatNum">{summary.episodeCount.toLocaleString()}</div>
          <div className="anStatLabel">Your episodes</div>
        </div>
      </div>

      {!hasData && (
        <div className="emptyNote" style={{ marginTop: "1.5rem" }}>
          No downloads or plays in the last {days} days yet. Real counts appear here as listeners fetch your feed, download, or press play — nothing is fabricated.
        </div>
      )}

      {/* Downloads/plays over time */}
      <div className="studioCard" style={{ marginTop: "1.5rem" }}>
        <div className="sectionTitle" style={{ marginBottom: "0.9rem" }}>Over time</div>
        <div className="anBars" role="img" aria-label="Downloads and plays per day">
          {summary.daily.map((d) => {
            const total = d.downloads + d.plays;
            const h = (total / maxDaily) * 100;
            const dlH = total > 0 ? (d.downloads / total) * h : 0;
            const plH = h - dlH;
            return (
              <div key={d.date} className="anBarCol" title={`${fmtDate(d.date)} · ${d.downloads} downloads · ${d.plays} plays`}>
                <div className="anBarStack">
                  <div className="anBarPlay" style={{ height: `${plH}%` }} />
                  <div className="anBarDl" style={{ height: `${dlH}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="anLegend">
          <span><i className="anDot anDotDl" /> Downloads</span>
          <span><i className="anDot anDotPlay" /> Plays</span>
          <span className="anAxis">{summary.daily.length ? `${fmtDate(summary.daily[0].date)} – ${fmtDate(summary.daily[summary.daily.length - 1].date)}` : ""}</span>
        </div>
      </div>

      <div className="grid2" style={{ marginTop: "1.5rem" }}>
        {/* By country */}
        <div className="studioCard">
          <div className="sectionTitle" style={{ marginBottom: "0.9rem" }}>By country</div>
          {summary.byCountry.length === 0 ? (
            <div className="anMuted">No geo data yet. Country is recorded only when the edge/proxy provides it — no IP lookups.</div>
          ) : (
            summary.byCountry.map((c) => (
              <div key={c.country} className="anRow">
                <span className="anRowLabel">{c.country === "Unknown" ? "Unknown" : c.country}</span>
                <div className="anRowTrack"><div className="anRowFill" style={{ width: `${(c.count / maxCountry) * 100}%` }} /></div>
                <span className="anRowNum">{c.count}</span>
              </div>
            ))
          )}
        </div>

        {/* By app/client */}
        <div className="studioCard">
          <div className="sectionTitle" style={{ marginBottom: "0.9rem" }}>By app / client</div>
          {summary.byApp.length === 0 ? (
            <div className="anMuted">No client data yet.</div>
          ) : (
            summary.byApp.map((a) => (
              <div key={a.app} className="anRow">
                <span className="anRowLabel">{a.app}</span>
                <div className="anRowTrack"><div className="anRowFill" style={{ width: `${(a.count / maxApp) * 100}%` }} /></div>
                <span className="anRowNum">{a.count}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* By episode */}
      <div className="studioCard" style={{ marginTop: "1.5rem" }}>
        <div className="sectionTitle" style={{ marginBottom: "0.9rem" }}>By episode</div>
        {summary.byEpisode.length === 0 ? (
          <div className="anMuted">No episode activity in this range.</div>
        ) : (
          <div className="anTable">
            <div className="anTHead">
              <span>Episode</span><span>Downloads</span><span>Plays</span>
            </div>
            {summary.byEpisode.map((e) => (
              <Link key={e.episodeId} href={`/studio/episodes/${e.episodeId}`} className="anTRow">
                <span className="anEpTitle">{e.title}</span>
                <span className="anTNum">{e.downloads.toLocaleString()}</span>
                <span className="anTNum">{e.plays.toLocaleString()}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <p className="anFoot">
        Privacy: no IP address or personal data is stored — only a salted, truncated client hash used to dedupe, a coarse app label from the user-agent, and a country code when the network provides one.
      </p>
    </div>
  );
}
