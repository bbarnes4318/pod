import React from "react";
import { db } from "@/lib/db";
import Link from "next/link";
import "./scripts.css";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  episodeStatus?: string;
  version?: string;
  search?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

export default async function ScriptsDashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const statusFilter = params.status || "";
  const episodeStatusFilter = params.episodeStatus || "";
  const versionFilter = params.version || "";
  const searchFilter = params.search || "";

  // Query scripts list matching filters
  const where: any = {};
  if (statusFilter) {
    where.status = statusFilter;
  }
  if (versionFilter) {
    where.version = Number(versionFilter);
  }
  if (episodeStatusFilter || searchFilter) {
    where.episode = {};
    if (episodeStatusFilter) {
      where.episode.status = episodeStatusFilter;
    }
    if (searchFilter) {
      where.episode.title = { contains: searchFilter, mode: "insensitive" };
    }
  }

  const scripts = await db.script.findMany({
    where,
    include: { episode: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="scriptsHeader">
        <div>
          <h2 style={{ fontSize: "1.5rem", fontWeight: 700, color: "#ffffff", margin: 0 }}>Script Review Console</h2>
          <p style={{ fontSize: "0.9rem", color: "#94a3b8", marginTop: "0.25rem", margin: 0 }}>
            Inspect, edit, validate, and approve generated AI podcast host debate scripts.
          </p>
        </div>
      </div>

      {/* Filter Widgets */}
      <form method="GET" className="panel" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 0.6fr auto", gap: "1rem", alignItems: "end", padding: "1.25rem", marginBottom: "1.5rem" }}>
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
          <label className="label">Script Status</label>
          <select name="status" defaultValue={statusFilter} className="select">
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="needs_revision">Needs Revision</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Episode Status</label>
          <select name="episodeStatus" defaultValue={episodeStatusFilter} className="select">
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="script_draft">Script Draft</option>
            <option value="script_approved">Script Approved</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Version</label>
          <input
            type="number"
            name="version"
            defaultValue={versionFilter}
            className="input"
            placeholder="e.g. 1"
          />
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="submit" className="buttonPrimary" style={{ padding: "0.5rem 1rem" }}>
            Filter
          </button>
          <Link href="/admin/scripts" className="btnReset" style={{ padding: "0.5rem 1rem", textDecoration: "none", fontSize: "0.85rem" }}>
            Reset
          </Link>
        </div>
      </form>

      {/* Directory Table */}
      {scripts.length === 0 ? (
        <div className="panel" style={{ textAlign: "center", padding: "4rem" }}>
          <p style={{ color: "#64748b", fontSize: "1.1rem", margin: 0 }}>No scripts found matching the filters.</p>
        </div>
      ) : (
        <div className="tableContainer">
          <table className="table">
            <thead>
              <tr>
                <th>Episode Title</th>
                <th style={{ width: "100px" }}>Version</th>
                <th style={{ width: "130px" }}>Script Status</th>
                <th style={{ width: "150px" }}>Episode Status</th>
                <th>Created At</th>
                <th>Safety Indicators</th>
                <th style={{ width: "120px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {scripts.map((s) => {
                const contentObj = typeof s.content === "object" && s.content !== null ? (s.content as any) : {};
                const safety = contentObj.safety || {};
                const isApproved = s.status === "approved";
                const isRejected = s.status === "rejected";
                const isNeedsRevision = s.status === "needs_revision";

                return (
                  <tr key={s.id}>
                    <td>
                      <span style={{ fontWeight: 600, color: "#ffffff" }}>{s.episode.title}</span>
                    </td>
                    <td style={{ textAlign: "center", fontFamily: "var(--font-mono)" }}>
                      v{s.version}
                    </td>
                    <td>
                      <span className={`badge ${
                        isApproved
                          ? "badgeCompleted"
                          : isRejected
                          ? "badgeFailed"
                          : isNeedsRevision
                          ? "badgeFailed"
                          : "badgePending"
                      }`}>
                        {s.status}
                      </span>
                    </td>
                    <td>
                      <span className="refBadge" style={{ fontSize: "0.75rem" }}>
                        {s.episode.status}
                      </span>
                    </td>
                    <td style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                      {s.createdAt.toLocaleString()}
                    </td>
                    <td style={{ fontSize: "0.8rem", color: "#94a3b8" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                        <span className="refBadge">Lines: {safety.totalLineCount || 0}</span>
                        <span className="refBadge">Coverage: {safety.evidenceCoveragePercent !== undefined ? `${safety.evidenceCoveragePercent}%` : "0%"}</span>
                        {safety.needsHumanReviewCount > 0 && (
                          <span style={{ color: "#ef4444", fontSize: "0.7rem", fontWeight: 700 }}>
                            ⚠️ {safety.needsHumanReviewCount} Review Flags
                          </span>
                        )}
                        {safety.reasons && safety.reasons.length > 0 && (
                          <span style={{ color: "#f59e0b", fontSize: "0.7rem" }}>
                            • {safety.reasons.length} Warnings
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <Link href={`/admin/scripts/${s.id}`} className="editButton" style={{ display: "inline-block", fontSize: "0.8rem", padding: "0.25rem 0.6rem", textDecoration: "none" }}>
                        Review
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
