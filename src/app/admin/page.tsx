import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { runProductionReadinessAudit } from "@/lib/services/finalQaService";

export const dynamic = "force-dynamic";

function maskSecrets(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    let masked = obj;
    if (masked.includes("Signature=") || masked.includes("AWSAccessKeyId=")) {
      masked = masked.replace(/Signature=[^&]*/g, "Signature=[MASKED]")
                     .replace(/AWSAccessKeyId=[^&]*/g, "AWSAccessKeyId=[MASKED]");
    }
    if (masked.includes("token=") || masked.includes("Token=")) {
      masked = masked.replace(/token=[^&]*/gi, "token=[MASKED]");
    }
    if (masked.includes("postgres://") || masked.includes("postgresql://")) {
      masked = masked.replace(/(postgres|postgresql):\/\/[^@\s]+/g, "$1://[MASKED]");
    }
    if (masked.includes("redis://")) {
      masked = masked.replace(/redis:\/\/[^@\s]+/g, "redis://[MASKED]");
    }
    if (masked.includes("Bearer ")) {
      masked = masked.replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [MASKED]");
    }
    masked = masked.replace(/(password|passwd|pwd|secret|api_key|apikey|token)=[^&;\s"']+/gi, "$1=[MASKED]");
    return masked;
  }
  return obj;
}

export default async function AdminDashboard() {
  const audit = await runProductionReadinessAudit();
  const warnings = audit.checks.filter((c) => c.status === "fail" || c.status === "warning");

  // Read active provider configuration from environment
  const config = {
    llm: process.env.LLM_PROVIDER || "stub",
    tts: process.env.TTS_PROVIDER || "stub",
    sports: process.env.SPORTS_PROVIDER || "stub",
    storage: process.env.STORAGE_PROVIDER || "stub",
  };

  // 1. Dynamic database queries for Pipeline Board & Cards
  const [
    newsCount,
    gameCount,
    oddsCount,
    injuryCount,
    totalTopics,
    pendingTopics,
    approvedTopics,
    totalBriefs,
    episodesDraftCount,
    scriptsDraftCount,
    scriptsApprovedCount,
    factCheckPassedCount,
    scriptsAudioReadyCount,
    episodesAudioReadyCount,
    episodesContentReadyCount,
    episodesPublishReadyCount,
    episodesPublishedCount,
    totalEpisodes,
    recentLogs,
  ] = await Promise.all([
    db.newsItem.count(),
    db.game.count(),
    db.oddsSnapshot.count(),
    db.injury.count(),
    db.topicCandidate.count(),
    db.topicCandidate.count({ where: { status: "pending" } }),
    db.topicCandidate.count({ where: { status: "approved" } }),
    db.researchBrief.count(),
    db.episode.count({ where: { status: { in: ["draft", "script_draft"] } } }),
    db.script.count({ where: { status: { in: ["draft", "generating"] } } }),
    db.script.count({ where: { status: { in: ["approved", "ready", "script_approved"] } } }),
    db.factCheckResult.count({ where: { status: "passed" } }),
    db.script.count({
      where: {
        audioSegments: {
          some: { status: "ready" },
          none: { status: { not: "ready" } },
        },
      },
    }),
    db.episode.count({ where: { status: "audio_ready" } }),
    db.episode.count({ where: { status: "content_ready" } }),
    db.episode.count({ where: { status: "publish_ready" } }),
    db.episode.count({ where: { status: "published" } }),
    db.episode.count(),
    db.jobLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const dataIngestedCount = newsCount + gameCount + oddsCount + injuryCount;

  // Pipeline board stages
  const stages = [
    { label: "Data Ingested", count: dataIngestedCount, link: "/admin/data-sources" },
    { label: "Topics Generated", count: totalTopics, link: "/admin/topics" },
    { label: "Briefs Generated", count: totalBriefs, link: "/admin/research-briefs" },
    { label: "Episodes Drafted", count: episodesDraftCount, link: "/admin/episodes" },
    { label: "Scripts Drafted", count: scriptsDraftCount, link: "/admin/scripts" },
    { label: "Scripts Approved", count: scriptsApprovedCount, link: "/admin/scripts" },
    { label: "Fact Checked", count: factCheckPassedCount, link: "/admin/fact-checks" },
    { label: "Audio Segments Ready", count: scriptsAudioReadyCount, link: "/admin/audio-segments" },
    { label: "Final Audio Ready", count: episodesAudioReadyCount, link: "/admin/final-audio" },
    { label: "Content Ready", count: episodesContentReadyCount, link: "/admin/content-assets" },
    { label: "Publish Ready", count: episodesPublishReadyCount, link: "/admin/rss" },
    { label: "Published", count: episodesPublishedCount, link: "/admin/rss" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      
      {/* Configuration & Diagnostic Warnings */}
      {warnings.length > 0 && (
        <div className="alertCard alertWarning" style={{ marginBottom: 0 }}>
          <strong style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: "700" }}>
            ⚠️ System Diagnostic Advisories ({warnings.length})
          </strong>
          <ul style={{ marginTop: "0.25rem", paddingLeft: "1.2rem", margin: "0.25rem 0 0 0", fontSize: "0.85rem" }}>
            {warnings.slice(0, 3).map((w, idx) => (
              <li key={idx} style={{ color: "var(--warning-color)" }}>
                <strong>{w.name}</strong>: {w.details || w.description}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}>
            <Link href="/admin/configuration" style={{ color: "var(--accent-color)", textDecoration: "underline", fontWeight: "600" }}>
              View full system diagnostic configuration
            </Link>
          </div>
        </div>
      )}

      {/* Overview Cards */}
      <div className="grid">
        <div className="card">
          <div className="cardTitle">Episodes</div>
          <div className="cardValue">{totalEpisodes}</div>
          <div className="cardSub">
            <span>{episodesPublishedCount} published • {episodesPublishReadyCount} publish_ready</span>
          </div>
        </div>
        <div className="card">
          <div className="cardTitle">Topic Candidates</div>
          <div className="cardValue">{totalTopics}</div>
          <div className="cardSub">
            <span>{approvedTopics} approved • {pendingTopics} pending evaluation</span>
          </div>
        </div>
        <div className="card">
          <div className="cardTitle">Research Briefs</div>
          <div className="cardValue">{totalBriefs}</div>
          <div className="cardSub">
            <span>Grounded factual dossiers for scripts</span>
          </div>
        </div>
        <div className="card">
          <div className="cardTitle">Approved Scripts</div>
          <div className="cardValue">{scriptsApprovedCount}</div>
          <div className="cardSub">
            <span>Passed fact checking & verification</span>
          </div>
        </div>
      </div>

      {/* Dynamic Pipeline Board */}
      <div className="panel">
        <div className="panelHeader">
          <h3 className="panelTitle">Pipeline Flow Board</h3>
        </div>
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

      {/* Main Layout Grid */}
      <div className="dashboardSection">
        
        {/* Left Side: Recent Active Operations */}
        <div className="panel" style={{ marginBottom: 0 }}>
          <div className="panelHeader">
            <h3 className="panelTitle">Active Pipeline Operations</h3>
            <Link href="/admin/job-logs" style={{ fontSize: "0.8rem", color: "var(--accent-color)", textDecoration: "underline" }}>
              View all logs
            </Link>
          </div>
          <div className="panelContent" style={{ padding: 0 }}>
            {recentLogs.length === 0 ? (
              <div className="emptyState" style={{ border: "none", borderRadius: 0 }}>
                <div className="emptyStateTitle">No recent operations found</div>
                <div className="emptyStateDesc">Ingest sports data to begin the pipeline process.</div>
              </div>
            ) : (
              <div className="tableContainer" style={{ border: "none", borderRadius: 0 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Job Type</th>
                      <th>Status</th>
                      <th>Executed At</th>
                      <th>Logs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentLogs.map((log) => (
                      <tr key={log.id}>
                        <td>
                          <strong style={{ color: "var(--text-primary)" }}>{log.jobType}</strong>
                          <br />
                          <code style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{log.id.slice(0, 8)}...</code>
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              log.status === "completed"
                                ? "badgeCompleted"
                                : log.status === "failed"
                                ? "badgeFailed"
                                : "badgeRunning"
                            }`}
                          >
                            {log.status}
                          </span>
                        </td>
                        <td>{new Date(log.createdAt).toLocaleTimeString()}</td>
                        <td>
                          {log.error ? (
                            <span style={{ color: "var(--error-color)", fontSize: "0.8rem" }}>{maskSecrets(log.error).slice(0, 45)}...</span>
                          ) : (
                            <span style={{ color: "var(--text-secondary)", fontSize: "0.8rem" }}>Clean run.</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right Side: Active Abstractions Config & Trigger Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          
          {/* Active Configuration Panel */}
          <div className="panel" style={{ marginBottom: 0 }}>
            <div className="panelHeader">
              <h3 className="panelTitle">Active Abstractions Configuration</h3>
            </div>
            <div className="panelContent">
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>LLM Engine:</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "var(--accent-color)", fontSize: "0.85rem" }}>{config.llm}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>TTS Engine:</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "var(--accent-color)", fontSize: "0.85rem" }}>{config.tts}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Sports Data Source:</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "var(--accent-color)", fontSize: "0.85rem" }}>{config.sports}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", paddingBottom: "0.15rem" }}>
                  <span style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>Storage Target:</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "var(--accent-color)", fontSize: "0.85rem" }}>{config.storage}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Pipeline Control Points Panel */}
          <div className="panel" style={{ marginBottom: 0 }}>
            <div className="panelHeader">
              <h3 className="panelTitle">Pipeline Control Points</h3>
            </div>
            <div className="panelContent" style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <p style={{ color: "var(--text-secondary)", fontSize: "0.8rem", margin: "0 0 0.5rem 0", lineHeight: 1.4 }}>
                Navigate to dedicated phase-specific admin consoles to trigger tasks and operations:
              </p>
              {[
                { label: "Data Ingest Management", href: "/admin/data-sources" },
                { label: "Sports Debate Topic Engine", href: "/admin/topics" },
                { label: "Debate Research Dossiers", href: "/admin/research-briefs" },
                { label: "LLM Script Review Console", href: "/admin/scripts" },
                { label: "Fact Checking Panel", href: "/admin/fact-checks" },
                { label: "Dialogue Voice Synthesis", href: "/admin/audio-segments" },
                { label: "Final Audio Stitching", href: "/admin/final-audio" },
                { label: "Content Assets Generator", href: "/admin/content-assets" },
                { label: "Podcast RSS Publishing", href: "/admin/rss" },
              ].map((item, idx) => (
                <Link
                  key={idx}
                  href={item.href}
                  className="editButton"
                  style={{
                    display: "block",
                    textAlign: "center",
                    textDecoration: "none",
                    fontSize: "0.8rem",
                    padding: "0.4rem",
                  }}
                >
                  {item.label} &rarr;
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
