import React from "react";
import Link from "next/link";
import { fetchContentAssetDashboard } from "./actions";
import "../scripts/scripts.css";

export const dynamic = "force-dynamic";

interface SearchParams {
  episodeStatus?: string;
  contentStatus?: string;
  search?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

export default async function ContentAssetsDashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const searchFilter = params.search || "";
  const episodeStatusFilter = params.episodeStatus || "";
  const contentStatusFilter = params.contentStatus || "";

  const res = await fetchContentAssetDashboard({
    search: searchFilter,
    episodeStatus: episodeStatusFilter,
    contentStatus: contentStatusFilter,
  });

  const items = res.success && res.items ? res.items : [];

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="scriptsHeader" style={{ marginBottom: "1.5rem" }}>
        <div>
          <h2 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#ffffff", margin: 0 }}>Content Assets Console</h2>
          <p style={{ fontSize: "0.9rem", color: "#94a3b8", marginTop: "0.25rem", margin: 0 }}>
            Generate and manage listener-facing transcripts, show notes, chapters, and metadata files.
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
            defaultValue={searchFilter}
            className="input"
            placeholder="Search..."
          />
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Episode Status</label>
          <select name="episodeStatus" defaultValue={episodeStatusFilter} className="select">
            <option value="">All Statuses</option>
            <option value="audio_ready">Audio Ready</option>
            <option value="content_ready">Content Ready</option>
            <option value="content_generating">Generating Content</option>
            <option value="draft">Draft</option>
          </select>
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Content Asset Status</label>
          <select name="contentStatus" defaultValue={contentStatusFilter} className="select">
            <option value="">All Statuses</option>
            <option value="ready">Ready (Generated)</option>
            <option value="pending">Pending</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="submit" className="buttonPrimary" style={{ padding: "0.5rem 1rem" }}>
            Filter
          </button>
          <Link href="/admin/content-assets" className="btnReset" style={{ padding: "0.5rem 1rem", textDecoration: "none", fontSize: "0.85rem", display: "inline-flex", alignItems: "center" }}>
            Reset
          </Link>
        </div>
      </form>

      {/* Dashboard Table */}
      {items.length === 0 ? (
        <div className="panel" style={{ textAlign: "center", padding: "4rem" }}>
          <p style={{ color: "#64748b", fontSize: "1.1rem", margin: 0 }}>No eligible episodes or scripts found.</p>
        </div>
      ) : (
        <div className="tableContainer">
          <table className="table">
            <thead>
              <tr>
                <th>Episode Title</th>
                <th style={{ width: "90px" }}>Script</th>
                <th>Episode Status</th>
                <th>Final Audio</th>
                <th>Transcript</th>
                <th>Show Notes</th>
                <th>Duration</th>
                <th>Generated At</th>
                <th style={{ width: "120px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const hasAudio = !!item.audioUrl;
                const isContentReady = item.episodeStatus === "content_ready" && !!item.transcriptUrl && !!item.showNotesText;
                const isGenerating = item.episodeStatus === "content_generating";

                return (
                  <tr key={item.scriptId}>
                    <td>
                      <span style={{ fontWeight: 600, color: "#ffffff" }}>{item.episodeTitle}</span>
                    </td>
                    <td style={{ textAlign: "center", fontFamily: "var(--font-mono)" }}>
                      v{item.scriptVersion}
                    </td>
                    <td>
                      <span className={`badge ${
                        isContentReady
                          ? "badgeCompleted"
                          : isGenerating
                          ? "badgePending"
                          : "badgePending"
                      }`}>
                        {item.episodeStatus}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${hasAudio ? "badgeCompleted" : "badgeFailed"}`} style={{ fontSize: "0.75rem" }}>
                        {hasAudio ? "Ready" : "Missing"}
                      </span>
                    </td>
                    <td>
                      {item.transcriptUrl ? (
                        <span className="badge badgeCompleted" style={{ fontSize: "0.75rem" }}>Ready</span>
                      ) : (
                        <span className="badge badgePending" style={{ fontSize: "0.75rem" }}>Pending</span>
                      )}
                    </td>
                    <td>
                      {item.showNotesText ? (
                        <span className="badge badgeCompleted" style={{ fontSize: "0.75rem" }}>Ready</span>
                      ) : (
                        <span className="badge badgePending" style={{ fontSize: "0.75rem" }}>Pending</span>
                      )}
                    </td>
                    <td style={{ fontSize: "0.85rem", color: "#cbd5e1", fontFamily: "var(--font-mono)" }}>
                      {item.duration ? `${Math.floor(item.duration / 60)}m ${item.duration % 60}s` : "N/A"}
                    </td>
                    <td style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                      {item.generatedAt ? new Date(item.generatedAt).toLocaleString() : "—"}
                    </td>
                    <td>
                      <Link href={`/admin/content-assets/${item.scriptId}`} className="editButton" style={{ display: "inline-block", fontSize: "0.8rem", padding: "0.25rem 0.6rem", textDecoration: "none" }}>
                        Manage
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
