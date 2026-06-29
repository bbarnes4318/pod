import React from "react";
import Link from "next/link";
import { fetchRssDashboard, fetchPodcastConfigChecklist } from "./actions";
import "../scripts/scripts.css";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  search?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

export default async function RssDashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const searchFilter = params.search || "";
  const statusFilter = params.status || "";

  const [scripts, configData] = await Promise.all([
    fetchRssDashboard({
      search: searchFilter,
      status: statusFilter,
    }),
    fetchPodcastConfigChecklist(),
  ]);

  const previewToken = process.env.RSS_PREVIEW_TOKEN || "super-secret-preview-token";
  const publicRssUrl = configData.config.rssUrl || "/rss";
  const previewRssUrl = `${configData.config.rssUrl || "/rss"}/preview?token=${previewToken}`;

  return (
    <div className="formContainer" style={{ maxWidth: "100%", padding: "2rem" }}>
      {/* Header */}
      <div className="scriptsHeader" style={{ marginBottom: "1.5rem" }}>
        <div>
          <h2 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#ffffff", margin: 0 }}>RSS Feed &amp; Publishing Console</h2>
          <p style={{ fontSize: "0.9rem", color: "#94a3b8", marginTop: "0.25rem", margin: 0 }}>
            Configure podcast feeds, run publication readiness gates, and manage RSS feed metadata.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1.5fr", gap: "2rem", marginBottom: "2rem" }}>
        {/* Left side: Feeds and configuration */}
        <div className="panel" style={{ padding: "1.5rem" }}>
          <h3 className="panelTitle" style={{ marginTop: 0 }}>Feed Endpoints</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ padding: "1rem", backgroundColor: "#0c0f16", border: "1px solid #1a2233", borderRadius: "4px" }}>
              <div style={{ fontWeight: 600, color: "#10b981", fontSize: "0.9rem", marginBottom: "0.25rem" }}>PUBLIC RSS FEED</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem", wordBreak: "break-all", color: "#cbd5e1" }}>
                <a href={publicRssUrl} target="_blank" rel="noreferrer" style={{ color: "#38bdf8", textDecoration: "underline" }}>
                  {publicRssUrl}
                </a>
              </div>
              <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "0.5rem" }}>
                Only includes episodes with status <span style={{ color: "#e2e8f0" }}>"published"</span> and a valid publication date.
              </div>
            </div>

            <div style={{ padding: "1rem", backgroundColor: "#0c0f16", border: "1px solid #1a2233", borderRadius: "4px" }}>
              <div style={{ fontWeight: 600, color: "#f59e0b", fontSize: "0.9rem", marginBottom: "0.25rem" }}>PREVIEW RSS FEED</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem", wordBreak: "break-all", color: "#cbd5e1" }}>
                <a href={previewRssUrl} target="_blank" rel="noreferrer" style={{ color: "#38bdf8", textDecoration: "underline" }}>
                  {previewRssUrl}
                </a>
              </div>
              <div style={{ fontSize: "0.8rem", color: "#64748b", marginTop: "0.5rem" }}>
                Includes both <span style={{ color: "#e2e8f0" }}>"published"</span> and <span style={{ color: "#e2e8f0" }}>"publish_ready"</span> episodes. Requires token authentication.
              </div>
            </div>
          </div>
        </div>

        {/* Right side: Podcast configuration checklist */}
        <div className="panel" style={{ padding: "1.5rem" }}>
          <h3 className="panelTitle" style={{ marginTop: 0 }}>Podcast Metadata Configuration</h3>
          {configData.isValid ? (
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#10b981", fontSize: "0.9rem", padding: "0.75rem", backgroundColor: "rgba(16, 185, 129, 0.08)", border: "1px solid rgba(16, 185, 129, 0.2)", borderRadius: "4px", marginBottom: "1rem" }}>
              <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span>All 9 required RSS metadata keys configured!</span>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", color: "#ef4444", fontSize: "0.9rem", padding: "0.75rem", backgroundColor: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "4px", marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 600 }}>
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <span>Missing Required RSS Keys!</span>
              </div>
              <ul style={{ margin: "0.25rem 0 0 1.25rem", padding: 0, fontSize: "0.8rem", listStyleType: "disc" }}>
                {configData.missingKeys.map(k => (
                  <li key={k}>{k}</li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#64748b" }}>Title:</span>
              <span style={{ fontWeight: 500, color: "#ffffff" }}>{configData.config.title || "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#64748b" }}>Language:</span>
              <span style={{ fontWeight: 500, color: "#ffffff" }}>{configData.config.language || "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#64748b" }}>Category:</span>
              <span style={{ fontWeight: 500, color: "#ffffff" }}>{configData.config.category || "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "#64748b" }}>Explicit:</span>
              <span style={{ fontWeight: 500, color: "#ffffff" }}>{configData.config.explicit ? "YES" : "NO"}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Filters Form */}
      <form method="GET" className="panel" style={{ display: "grid", gridTemplateColumns: "2fr 1fr auto", gap: "1rem", alignItems: "end", padding: "1.25rem", marginBottom: "1.5rem" }}>
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
          <label className="label">RSS/Publishing Status</label>
          <select name="status" defaultValue={statusFilter} className="select">
            <option value="">All Statuses</option>
            <option value="content_ready">Content Ready</option>
            <option value="publish_ready">Publish Ready</option>
            <option value="published">Published</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="submit" className="buttonPrimary" style={{ padding: "0.5rem 1rem" }}>
            Filter
          </button>
          <Link href="/admin/rss" className="btnReset" style={{ padding: "0.5rem 1rem", textDecoration: "none", fontSize: "0.85rem", display: "inline-flex", alignItems: "center" }}>
            Reset
          </Link>
        </div>
      </form>

      {/* Table */}
      {scripts.length === 0 ? (
        <div className="panel" style={{ textAlign: "center", padding: "4rem" }}>
          <p style={{ color: "#94a3b8", fontSize: "1.1rem", fontWeight: "600", margin: 0 }}>No RSS episodes found.</p>
          <p style={{ color: "#64748b", fontSize: "0.9rem", marginTop: "0.5rem", margin: 0 }}>
            Only published episodes appear in the public RSS feed. Prepare content assets for an episode, then configure and publish it here.
          </p>
        </div>
      ) : (
        <div className="tableContainer">
          <table className="table">
            <thead>
              <tr>
                <th>Episode Title</th>
                <th>Status</th>
                <th>GUID</th>
                <th>File Size</th>
                <th>Published At</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {scripts.map((script) => {
                const ep = script.episode;

                return (
                  <tr key={script.id}>
                    <td>
                      <div style={{ fontWeight: 600, color: "#ffffff" }}>{ep.title}</div>
                      <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "0.15rem" }}>
                        Script ID: {script.id}
                      </div>
                    </td>
                    <td>
                      <span className={`statusTag`} style={{
                        display: "inline-block",
                        padding: "0.25rem 0.5rem",
                        borderRadius: "4px",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        backgroundColor:
                          ep.status === "published" ? "rgba(16, 185, 129, 0.15)" :
                          ep.status === "publish_ready" ? "rgba(56, 189, 248, 0.15)" : "rgba(148, 163, 184, 0.15)",
                        color:
                          ep.status === "published" ? "#10b981" :
                          ep.status === "publish_ready" ? "#38bdf8" : "#94a3b8",
                        border:
                          ep.status === "published" ? "1px solid rgba(16, 185, 129, 0.3)" :
                          ep.status === "publish_ready" ? "1px solid rgba(56, 189, 248, 0.3)" : "1px solid rgba(148, 163, 184, 0.3)",
                      }}>
                        {ep.status.replace("_", " ").toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontFamily: "monospace", fontSize: "0.8rem", color: ep.rssGuid ? "#cbd5e1" : "#64748b" }}>
                        {ep.rssGuid || "Not prepared"}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: "0.85rem", color: "#cbd5e1" }}>
                        {ep.audioFileSizeBytes 
                          ? `${(ep.audioFileSizeBytes / (1024 * 1024)).toFixed(2)} MB`
                          : "—"}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: "0.85rem", color: "#cbd5e1" }}>
                        {ep.publishedAt ? new Date(ep.publishedAt).toLocaleString() : "—"}
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        href={`/admin/rss/${script.id}`}
                        className="buttonPrimary"
                        style={{
                          padding: "0.35rem 0.75rem",
                          fontSize: "0.8rem",
                          textDecoration: "none",
                          display: "inline-block",
                        }}
                      >
                        Manage RSS
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
