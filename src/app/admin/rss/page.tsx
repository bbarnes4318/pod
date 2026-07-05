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
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="scriptsHeader" style={{ marginBottom: "1.5rem" }}>
        <div>
          <h2 className="pageTitle">RSS Feed &amp; Publishing Console</h2>
          <p className="pageDesc">
            Configure podcast feeds, run publication readiness gates, and manage RSS feed metadata.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "2.5fr 1.5fr", gap: "2rem", marginBottom: "2rem" }}>
        {/* Left side: Feeds and configuration */}
        <div className="panel" style={{ padding: "1.5rem" }}>
          <h3 className="panelTitle" style={{ marginTop: 0 }}>Feed Endpoints</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ padding: "1rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "4px" }}>
              <div style={{ fontWeight: 700, color: "var(--success-color)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>PUBLIC RSS FEED</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem", wordBreak: "break-all", color: "var(--text-primary)" }}>
                <a href={publicRssUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)", textDecoration: "underline" }}>
                  {publicRssUrl}
                </a>
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
                Only includes episodes with status <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>"published"</span> and a valid publication date.
              </div>
            </div>

            <div style={{ padding: "1rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "4px" }}>
              <div style={{ fontWeight: 700, color: "var(--warning-color)", fontSize: "0.85rem", marginBottom: "0.25rem" }}>PREVIEW RSS FEED</div>
              <div style={{ fontFamily: "monospace", fontSize: "0.85rem", wordBreak: "break-all", color: "var(--text-primary)" }}>
                <a href={previewRssUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)", textDecoration: "underline" }}>
                  {previewRssUrl}
                </a>
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
                Includes both <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>"published"</span> and <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>"publish_ready"</span> episodes. Requires token authentication.
              </div>
            </div>
          </div>
        </div>

        {/* Right side: Podcast configuration checklist */}
        <div className="panel" style={{ padding: "1.5rem" }}>
          <h3 className="panelTitle" style={{ marginTop: 0 }}>Podcast Metadata Configuration</h3>
          {configData.isValid ? (
            <div className="alertCard alertSuccess" style={{ marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span>All 9 required RSS metadata keys configured!</span>
              </div>
            </div>
          ) : (
            <div className="alertCard alertDanger" style={{ marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: 700 }}>
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
              <span style={{ color: "var(--text-secondary)" }}>Title:</span>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{configData.config.title || "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-secondary)" }}>Language:</span>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{configData.config.language || "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-secondary)" }}>Category:</span>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{configData.config.category || "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ color: "var(--text-secondary)" }}>Explicit:</span>
              <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{configData.config.explicit ? "YES" : "NO"}</span>
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
        <div className="emptyState">
          <div className="emptyStateTitle">No RSS episodes found.</div>
          <div className="emptyStateDesc">
            Only published episodes appear in the public RSS feed. Prepare content assets for an episode, then configure and publish it here.
          </div>
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
                      <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{ep.title}</div>
                      <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", marginTop: "0.15rem" }}>
                        Script ID: {script.id}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${
                        ep.status === "published" ? "badgeCompleted" :
                        ep.status === "publish_ready" ? "badgePending" : "refBadge"
                      }`}>
                        {ep.status.replace("_", " ").toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8rem", color: ep.rssGuid ? "var(--text-primary)" : "var(--text-secondary)", fontWeight: ep.rssGuid ? 600 : 400 }}>
                        {ep.rssGuid || "Not prepared"}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: "0.85rem", color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>
                        {ep.audioFileSizeBytes 
                          ? `${(ep.audioFileSizeBytes / (1024 * 1024)).toFixed(2)} MB`
                          : "—"}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: "0.85rem", color: "var(--text-primary)" }}>
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
