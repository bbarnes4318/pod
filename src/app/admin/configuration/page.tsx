import React from "react";
import { runProductionReadinessAudit } from "@/lib/services/finalQaService";
import { getOddsApiKeyStatus, getRssFeedStatus } from "@/lib/env";

export const dynamic = "force-dynamic";

export default async function ConfigurationPage() {
  const audit = await runProductionReadinessAudit();

  const maskSecret = (envVar: string | undefined): string => {
    if (!envVar || envVar.trim() === "") return "MISSING";
    return "CONFIGURED";
  };

  const dbUrlStatus = maskSecret(process.env.DATABASE_URL);
  const redisUrlStatus = maskSecret(process.env.REDIS_URL);
  const previewTokenStatus = maskSecret(process.env.RSS_PREVIEW_TOKEN);

  const providerApis = [
    { name: "OpenAI API Key (if used)", value: maskSecret(process.env.OPENAI_API_KEY) },
    { name: "Anthropic API Key (if used)", value: maskSecret(process.env.ANTHROPIC_API_KEY) },
    { name: "Gemini API Key (if used)", value: maskSecret(process.env.GEMINI_API_KEY) },
    { name: "ElevenLabs API Key (if used)", value: maskSecret(process.env.ELEVENLABS_API_KEY) },
    { name: "Odds API Key (ODDS_API_KEY)", value: getOddsApiKeyStatus() },
    { name: "RSS Feed Ingest (NEWS_RSS_FEEDS)", value: getRssFeedStatus() },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <div>
        <h2 style={{ fontSize: "1.25rem", fontWeight: "700", color: "var(--text-primary)", marginBottom: "0.25rem" }}>
          System Configuration
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", margin: 0 }}>
          Read-only environment status, service provider diagnostics, and production safety audits.
        </p>
      </div>

      {/* Live Audit Report */}
      <div className="panel">
        <div className="panelHeader" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 className="panelTitle">Production Readiness Audit</h3>
          <span
            className={`badge ${audit.passed ? "badgeCompleted" : "badgeFailed"}`}
            style={{ fontSize: "0.8rem", padding: "0.25rem 0.75rem" }}
          >
            {audit.passed ? "AUDIT PASSED" : "AUDIT WARNINGS"}
          </span>
        </div>
        <div className="panelContent" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0 }}>
            Last Run: <code style={{ color: "var(--accent-color)" }}>{audit.timestamp}</code>
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {audit.checks.map((check, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: "1rem",
                  backgroundColor: "var(--bg-secondary)",
                  border: "1px solid var(--border-color)",
                  borderRadius: "6px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: "0.95rem" }}>{check.name}</strong>
                  <span
                    className={`badge ${
                      check.status === "pass"
                        ? "badgeCompleted"
                        : check.status === "warning"
                        ? "badgeRunning"
                        : "badgeFailed"
                    }`}
                    style={{ fontSize: "0.75rem" }}
                  >
                    {check.value || check.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.85rem" }}>{check.description}</div>
                {check.details && (
                  <div
                    style={{
                      marginTop: "0.5rem",
                      fontSize: "0.8rem",
                      fontFamily: "var(--font-mono)",
                      color: check.status === "fail" ? "var(--error-color)" : "var(--warning-color)",
                      backgroundColor: "var(--bg-primary)",
                      padding: "0.5rem",
                      borderRadius: "4px",
                      wordBreak: "break-all",
                    }}
                  >
                    {check.details}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
        {/* Environment Vars checklist */}
        <div className="panel">
          <div className="panelHeader">
            <h3 className="panelTitle">Environment & Credentials Diagnostic</h3>
          </div>
          <div className="panelContent" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Variable Name</th>
                  <th style={{ textAlign: "right" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>DATABASE_URL</code></td>
                  <td style={{ textAlign: "right" }}>
                    <span className={`badge ${dbUrlStatus === "CONFIGURED" ? "badgeCompleted" : "badgeFailed"}`}>
                      {dbUrlStatus}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td><code>REDIS_URL</code></td>
                  <td style={{ textAlign: "right" }}>
                    <span className={`badge ${redisUrlStatus === "CONFIGURED" ? "badgeCompleted" : "badgeFailed"}`}>
                      {redisUrlStatus}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td><code>RSS_PREVIEW_TOKEN</code></td>
                  <td style={{ textAlign: "right" }}>
                    <span className={`badge ${previewTokenStatus === "CONFIGURED" ? "badgeCompleted" : "badgeRunning"}`}>
                      {previewTokenStatus}
                    </span>
                  </td>
                </tr>
                {providerApis.map((api, idx) => (
                  <tr key={idx}>
                    <td><code>{api.name}</code></td>
                    <td style={{ textAlign: "right" }}>
                      <span className={`badge ${api.value === "CONFIGURED" ? "badgeCompleted" : "badgeRunning"}`}>
                        {api.value}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Podcast Public Settings & URLs */}
        <div className="panel">
          <div className="panelHeader">
            <h3 className="panelTitle">Podcast Metadata & Public Links</h3>
          </div>
          <div className="panelContent" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Title</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>{process.env.PODCAST_TITLE || "Not Configured"}</div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Author</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>{process.env.PODCAST_AUTHOR || "Not Configured"}</div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Owner Email</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>{process.env.PODCAST_OWNER_EMAIL || "Not Configured"}</div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Site URL</div>
                <div style={{ color: "var(--accent-color)", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                  {process.env.PODCAST_SITE_URL || "Not Configured"}
                </div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>RSS Feed URL</div>
                <div style={{ color: "var(--accent-color)", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                  {process.env.PODCAST_RSS_URL || "Not Configured"}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Image Cover URL</div>
                <div style={{ color: "var(--accent-color)", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                  {process.env.PODCAST_IMAGE_URL || "Not Configured"}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
