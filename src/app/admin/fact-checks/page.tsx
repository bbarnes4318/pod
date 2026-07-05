import React from "react";
import { db } from "@/lib/db";
import Link from "next/link";
import "../scripts/scripts.css";

export const dynamic = "force-dynamic";

interface SearchParams {
  status?: string;
  episodeStatus?: string;
  version?: string;
  provider?: string;
  search?: string;
}

interface PageProps {
  searchParams: Promise<SearchParams>;
}

export default async function FactChecksDashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const statusFilter = params.status || "";
  const episodeStatusFilter = params.episodeStatus || "";
  const versionFilter = params.version || "";
  const providerFilter = params.provider || "";
  const searchFilter = params.search || "";

  const where: any = {};
  if (statusFilter) {
    where.status = statusFilter;
  }
  if (providerFilter) {
    where.provider = providerFilter;
  }
  if (versionFilter) {
    where.script = {
      version: Number(versionFilter),
    };
  }
  if (episodeStatusFilter || searchFilter) {
    if (!where.script) where.script = {};
    where.script.episode = {};
    if (episodeStatusFilter) {
      where.script.episode.status = episodeStatusFilter;
    }
    if (searchFilter) {
      where.script.episode.title = { contains: searchFilter, mode: "insensitive" };
    }
  }

  const factChecks = await db.factCheckResult.findMany({
    where,
    include: {
      script: {
        include: {
          episode: true,
        },
      },
    },
    orderBy: { checkedAt: "desc" },
  });

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Header */}
      <div className="scriptsHeader">
        <div>
          <h2 className="pageTitle">Fact Checking Safety Gate</h2>
          <p className="pageDesc">
            Audit trace reports comparing host statements against stored evidence records.
          </p>
        </div>
      </div>

      {/* Filters Form */}
      <form method="GET" className="panel" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr 0.6fr auto", gap: "1rem", alignItems: "end", padding: "1.25rem", marginBottom: "1.5rem" }}>
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
          <label className="label">Check Status</label>
          <select name="status" defaultValue={statusFilter} className="select">
            <option value="">All Statuses</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
            <option value="needs_review">Needs Review</option>
          </select>
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Episode Status</label>
          <select name="episodeStatus" defaultValue={episodeStatusFilter} className="select">
            <option value="">All Statuses</option>
            <option value="script_approved">Script Approved</option>
            <option value="fact_checked">Fact Checked</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Provider</label>
          <select name="provider" defaultValue={providerFilter} className="select">
            <option value="">All Providers</option>
            <option value="deterministic">deterministic</option>
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </div>

        <div className="formGroup" style={{ marginBottom: 0 }}>
          <label className="label">Version</label>
          <input
            type="number"
            name="version"
            defaultValue={versionFilter}
            className="input"
            placeholder="v..."
          />
        </div>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="submit" className="buttonPrimary" style={{ padding: "0.5rem 1rem" }}>
            Filter
          </button>
          <Link href="/admin/fact-checks" className="btnReset" style={{ padding: "0.5rem 1rem", textDecoration: "none", fontSize: "0.85rem" }}>
            Reset
          </Link>
        </div>
      </form>

      {/* Table */}
      {factChecks.length === 0 ? (
        <div className="emptyState">
          <div className="emptyStateTitle">No fact check runs found matching the filters.</div>
        </div>
      ) : (
        <div className="tableContainer">
          <table className="table">
            <thead>
              <tr>
                <th>Episode Title</th>
                <th style={{ width: "80px", textAlign: "center" }}>Version</th>
                <th style={{ width: "120px" }}>Fact Check</th>
                <th style={{ width: "120px" }}>Script Status</th>
                <th style={{ width: "120px" }}>Episode Status</th>
                <th>Provider</th>
                <th>Run At</th>
                <th>Coverage & Issues</th>
                <th style={{ width: "100px" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {factChecks.map((f) => {
                const summary = typeof f.summary === "object" && f.summary !== null ? (f.summary as any) : {};
                const coverage = typeof f.evidenceCoverage === "object" && f.evidenceCoverage !== null ? (f.evidenceCoverage as any) : {};
                
                const isPassed = f.status === "passed";
                const isFailed = f.status === "failed";
                const isReview = f.status === "needs_review";

                const issueCount = (summary.totalErrors || 0) + (summary.totalWarnings || 0);

                return (
                  <tr key={f.id}>
                    <td>
                      <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{f.script.episode.title}</span>
                    </td>
                    <td style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                      v{f.script.version}
                    </td>
                    <td>
                      <span className={`badge ${
                        isPassed
                          ? "badgeCompleted"
                          : isFailed
                          ? "badgeFailed"
                          : "badgePending"
                      }`}>
                        {f.status}
                      </span>
                    </td>
                    <td>
                      <span className="refBadge" style={{ fontSize: "0.75rem" }}>{f.script.status}</span>
                    </td>
                    <td>
                      <span className="refBadge" style={{ fontSize: "0.75rem" }}>{f.script.episode.status}</span>
                    </td>
                    <td style={{ fontSize: "0.8rem", color: "var(--text-primary)" }}>
                      {f.provider}
                    </td>
                    <td style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                      {new Date(f.checkedAt).toLocaleString()}
                    </td>
                    <td style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
                        <span className="refBadge">Coverage: {coverage.evidenceCoveragePercent !== undefined ? `${coverage.evidenceCoveragePercent}%` : "0%"}</span>
                        {issueCount > 0 && (
                          <span style={{ color: isFailed ? "var(--error-color)" : "var(--warning-color)", fontSize: "0.7rem", fontWeight: 700 }}>
                            ⚠️ {issueCount} Issue(s)
                          </span>
                        )}
                        {coverage.unsupportedClaimCount > 0 && (
                          <span style={{ color: "var(--error-color)", fontSize: "0.7rem" }}>
                            {coverage.unsupportedClaimCount} Unsupported
                          </span>
                        )}
                        {coverage.unsafeClaimCount > 0 && (
                          <span style={{ color: "var(--error-color)", fontSize: "0.7rem" }}>
                            {coverage.unsafeClaimCount} Unsafe
                          </span>
                        )}
                      </div>
                    </td>
                    <td>
                      <Link href={`/admin/fact-checks/${f.id}`} className="editButton" style={{ display: "inline-block", fontSize: "0.8rem", padding: "0.25rem 0.6rem", textDecoration: "none" }}>
                        Details
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
