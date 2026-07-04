import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { runProductionReadinessAudit } from "@/lib/services/finalQaService";

export const dynamic = "force-dynamic";

// Operator home: pipeline throughput, diagnostics, and provider wiring.
// The user-facing product surface lives at /studio.
export default async function SystemOverview() {
  const [audit, counts, recentLogs] = await Promise.all([
    runProductionReadinessAudit().catch(() => null),
    Promise.all([
      db.newsItem.count(),
      db.game.count(),
      db.oddsSnapshot.count(),
      db.injury.count(),
      db.topicCandidate.count(),
      db.researchBrief.count(),
      db.episode.count({ where: { status: { in: ["draft", "script_draft"] } } }),
      db.script.count({ where: { status: { in: ["draft", "generating"] } } }),
      db.script.count({ where: { status: { in: ["approved", "ready", "script_approved"] } } }),
      db.factCheckResult.count({ where: { status: "passed" } }),
      db.episode.count({ where: { status: "audio_ready" } }),
      db.episode.count({ where: { status: "content_ready" } }),
      db.episode.count({ where: { status: "publish_ready" } }),
      db.episode.count({ where: { status: "published" } }),
    ]),
    db.jobLog.findMany({ orderBy: { createdAt: "desc" }, take: 8 }),
  ]);

  const [
    newsCount, gameCount, oddsCount, injuryCount,
    totalTopics, totalBriefs, episodesDraftCount, scriptsDraftCount,
    scriptsApprovedCount, factCheckPassedCount, episodesAudioReadyCount,
    episodesContentReadyCount, episodesPublishReadyCount, episodesPublishedCount,
  ] = counts;

  const stages = [
    { label: "Data Ingested", count: newsCount + gameCount + oddsCount + injuryCount, link: "/admin/data-sources" },
    { label: "Topics Generated", count: totalTopics, link: "/admin/topics" },
    { label: "Briefs Generated", count: totalBriefs, link: "/admin/research-briefs" },
    { label: "Episodes Drafted", count: episodesDraftCount, link: "/admin/episodes" },
    { label: "Scripts Drafted", count: scriptsDraftCount, link: "/admin/scripts" },
    { label: "Scripts Approved", count: scriptsApprovedCount, link: "/admin/scripts" },
    { label: "Fact Checked", count: factCheckPassedCount, link: "/admin/fact-checks" },
    { label: "Audio Ready", count: episodesAudioReadyCount, link: "/admin/final-audio" },
    { label: "Content Ready", count: episodesContentReadyCount, link: "/admin/content-assets" },
    { label: "Publish Ready", count: episodesPublishReadyCount, link: "/admin/rss" },
    { label: "Published", count: episodesPublishedCount, link: "/admin/rss" },
  ];

  const config = {
    "LLM Engine": process.env.LLM_PROVIDER || "stub",
    "Script LLM": process.env.SCRIPT_LLM_PROVIDER
      ? `${process.env.SCRIPT_LLM_PROVIDER} / ${process.env.SCRIPT_LLM_MODEL || "default"}`
      : "(inherits LLM engine)",
    "TTS Engine": process.env.TTS_PROVIDER || "stub",
    "Sports Data": process.env.SPORTS_PROVIDER || "stub",
    "Storage": process.env.STORAGE_PROVIDER || "stub",
    "Research": process.env.RESEARCH_PROVIDER || "stub",
  };

  const failures = audit?.checks.filter((c) => c.status === "fail") ?? [];
  const warnings = audit?.checks.filter((c) => c.status === "warning") ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: "1.6rem", textTransform: "uppercase" }}>System Overview</h2>
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            Pipeline throughput, diagnostics, and provider wiring. Making episodes? Head to the studio.
          </p>
        </div>
        <Link href="/studio" className="buttonPrimary" style={{ textDecoration: "none" }}>
          Open Studio →
        </Link>
      </div>

      {/* Diagnostics */}
      {audit && (failures.length > 0 || warnings.length > 0) && (
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panelHeader">
            <h3 className="panelTitle">Diagnostics ({failures.length} failing · {warnings.length} warnings)</h3>
            <Link href="/admin/configuration" style={{ fontSize: "0.8rem", color: "var(--accent-color)" }}>Full configuration →</Link>
          </div>
          <div className="panelContent" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {[...failures, ...warnings].slice(0, 6).map((c, i) => (
              <div key={i} style={{ display: "flex", gap: "0.75rem", alignItems: "baseline", fontSize: "0.85rem" }}>
                <span className={`badge ${c.status === "fail" ? "badgeFailed" : "badgeWarning"}`}>{c.status}</span>
                <strong>{c.name}</strong>
                <span style={{ color: "var(--text-secondary)" }}>{c.details || c.description}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pipeline throughput */}
      <div className="panel" style={{ marginBottom: 0 }}>
        <div className="panelHeader"><h3 className="panelTitle">Pipeline Flow</h3></div>
        <div className="panelContent" style={{ padding: "1.25rem" }}>
          <div className="pipelineFlowGrid">
            {stages.map((stage, idx) => (
              <Link key={idx} href={stage.link} className="pipelineFlowCard">
                <span className="pipelineFlowLabel">{stage.label}</span>
                <span className="pipelineFlowCount">{stage.count}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>

      <div className="dashboardSection">
        {/* Recent operations */}
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panelHeader">
            <h3 className="panelTitle">Recent Operations</h3>
            <Link href="/admin/job-logs" style={{ fontSize: "0.8rem", color: "var(--accent-color)" }}>All logs →</Link>
          </div>
          <div className="panelContent" style={{ padding: 0 }}>
            {recentLogs.length === 0 ? (
              <div className="emptyState" style={{ border: "none", borderRadius: 0 }}>
                <div className="emptyStateTitle">No operations yet</div>
              </div>
            ) : (
              <div className="tableContainer" style={{ border: "none", borderRadius: 0 }}>
                <table className="table">
                  <thead>
                    <tr><th>Job</th><th>Status</th><th>When</th></tr>
                  </thead>
                  <tbody>
                    {recentLogs.map((log) => (
                      <tr key={log.id}>
                        <td><strong>{log.jobType}</strong></td>
                        <td>
                          <span className={`badge ${log.status === "completed" ? "badgeCompleted" : log.status === "failed" ? "badgeFailed" : "badgeRunning"}`}>
                            {log.status}
                          </span>
                        </td>
                        <td style={{ color: "var(--text-secondary)" }}>{new Date(log.createdAt).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Provider wiring */}
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panelHeader"><h3 className="panelTitle">Provider Wiring</h3></div>
          <div className="panelContent">
            <div style={{ display: "flex", flexDirection: "column", gap: "0.7rem" }}>
              {Object.entries(config).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>{k}</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "var(--accent-color)", fontSize: "0.85rem" }}>{v}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
