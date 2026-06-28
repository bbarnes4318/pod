import React from "react";
import { fetchFinalAudioDashboard } from "./actions";
import Link from "next/link";
import "../scripts/scripts.css";

export const dynamic = "force-dynamic";

interface SearchParams {
  search?: string;
  episodeStatus?: string;
  finalAudioStatus?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

export default async function FinalAudioDashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const search = params.search || "";
  const episodeStatus = params.episodeStatus || "";
  const finalAudioStatus = params.finalAudioStatus || "";

  const res = await fetchFinalAudioDashboard({ search, episodeStatus, finalAudioStatus });
  const list = res.success && res.list ? res.list : [];

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="scriptsHeader">
        <div>
          <h2 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#ffffff", margin: 0 }}>Final Audio Stitching Panel</h2>
          <p style={{ fontSize: "0.9rem", color: "#94a3b8", marginTop: "0.25rem", margin: 0 }}>
            Assemble individual ready voice segments into complete dynamic MP3 episodes using standardized loudness parameters.
          </p>
        </div>
      </div>

      {/* Filters Form */}
      <form method="GET" className="panel" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr auto", gap: "1rem", alignItems: "end", padding: "1.25rem", marginBottom: "1.5rem" }}>
        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Search Episode Title</label>
          <input
            type="text"
            name="search"
            defaultValue={search}
            className="input"
            placeholder="Search..."
          />
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Episode Status</label>
          <select name="episodeStatus" defaultValue={episodeStatus} className="select">
            <option value="">All Statuses</option>
            <option value="audio_segments_ready">Audio Segments Ready</option>
            <option value="audio_ready">Audio Ready</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Final MP3 Status</label>
          <select name="finalAudioStatus" defaultValue={finalAudioStatus} className="select">
            <option value="">All States</option>
            <option value="ready">Ready (Has MP3)</option>
            <option value="pending">Pending (Needs Stitching)</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="submit" className="buttonPrimary" style={{ padding: "0.5rem 1.25rem" }}>
            Filter
          </button>
          <Link href="/admin/final-audio" className="btnReset" style={{ padding: "0.5rem 1.25rem", textDecoration: "none", fontSize: "0.85rem" }}>
            Reset
          </Link>
        </div>
      </form>

      {/* Table */}
      {list.length === 0 ? (
        <div className="panel" style={{ textAlign: "center", padding: "4rem" }}>
          <p style={{ color: "#64748b", fontSize: "1.1rem", margin: 0 }}>No approved script versions eligible for final audio compilation.</p>
        </div>
      ) : (
        <div className="tableContainer">
          <table className="table">
            <thead>
              <tr>
                <th>Episode Title</th>
                <th style={{ width: "80px" }}>Version</th>
                <th>Episode Status</th>
                <th>Fact Check</th>
                <th>Segments Readiness</th>
                <th>Final MP3 Status</th>
                <th>Duration</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((item) => {
                const fcPassed = item.factCheckStatus === "passed";
                const segsReady = item.readySegments === item.totalLines && item.totalLines > 0;
                const ready = !!item.finalAudioUrl;

                return (
                  <tr key={item.scriptId}>
                    <td>
                      <span style={{ fontWeight: 600, color: "#ffffff" }}>{item.episodeTitle}</span>
                    </td>
                    <td style={{ textAlign: "center", fontFamily: "var(--font-mono)" }}>
                      v{item.version}
                    </td>
                    <td>
                      <span className="refBadge" style={{ fontSize: "0.75rem" }}>{item.episodeStatus}</span>
                    </td>
                    <td>
                      <span className={`badge ${fcPassed ? "badgeCompleted" : "badgeFailed"}`}>
                        {item.factCheckStatus}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${segsReady ? "badgeCompleted" : "badgePending"}`}>
                        {item.readySegments} / {item.totalLines} Ready
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${ready ? "badgeCompleted" : "badgePending"}`}>
                        {ready ? "Ready" : "Pending"}
                      </span>
                    </td>
                    <td style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                      {item.durationSeconds ? `${Math.floor(item.durationSeconds / 60)}m ${item.durationSeconds % 60}s` : "--"}
                    </td>
                    <td>
                      <Link href={`/admin/final-audio/${item.scriptId}`} className="editButton" style={{ display: "inline-block", fontSize: "0.8rem", padding: "0.25rem 0.6rem", textDecoration: "none" }}>
                        Stitch Panel
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
