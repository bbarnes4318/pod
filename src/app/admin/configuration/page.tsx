import React from "react";
import { runProductionReadinessAudit } from "@/lib/services/finalQaService";

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
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: "700", color: "#ffffff", marginBottom: "0.25rem" }}>
          System Configuration
        </h2>
        <p style={{ color: "#64748b", fontSize: "0.9rem" }}>
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
          <p style={{ fontSize: "0.85rem", color: "#94a3b8" }}>
            Last Run: <code style={{ color: "#38bdf8" }}>{audit.timestamp}</code>
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            {audit.checks.map((check, idx) => (
              <div
                key={idx}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  padding: "1rem",
                  backgroundColor: "#080b10",
                  border: "1px solid #1a2233",
                  borderRadius: "6px",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.25rem" }}>
                  <strong style={{ color: "#ffffff", fontSize: "0.95rem" }}>{check.name}</strong>
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
                <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>{check.description}</div>
                {check.details && (
                  <div
                    style={{
                      marginTop: "0.5rem",
                      fontSize: "0.8rem",
                      fontFamily: "var(--font-mono)",
                      color: check.status === "fail" ? "#fecdd3" : "#fef08a",
                      backgroundColor: "rgba(15, 23, 42, 0.6)",
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
              <div style={{ borderBottom: "1px solid #1a2233", paddingBottom: "0.5rem" }}>
                <div style={{ color: "#64748b", fontSize: "0.75rem", textTransform: "uppercase" }}>Title</div>
                <div style={{ color: "#ffffff", fontWeight: "600" }}>{process.env.PODCAST_TITLE || "Not Configured"}</div>
              </div>
              <div style={{ borderBottom: "1px solid #1a2233", paddingBottom: "0.5rem" }}>
                <div style={{ color: "#64748b", fontSize: "0.75rem", textTransform: "uppercase" }}>Author</div>
                <div style={{ color: "#ffffff", fontWeight: "600" }}>{process.env.PODCAST_AUTHOR || "Not Configured"}</div>
              </div>
              <div style={{ borderBottom: "1px solid #1a2233", paddingBottom: "0.5rem" }}>
                <div style={{ color: "#64748b", fontSize: "0.75rem", textTransform: "uppercase" }}>Owner Email</div>
                <div style={{ color: "#ffffff", fontWeight: "600" }}>{process.env.PODCAST_OWNER_EMAIL || "Not Configured"}</div>
              </div>
              <div style={{ borderBottom: "1px solid #1a2233", paddingBottom: "0.5rem" }}>
                <div style={{ color: "#64748b", fontSize: "0.75rem", textTransform: "uppercase" }}>Site URL</div>
                <div style={{ color: "#38bdf8", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                  {process.env.PODCAST_SITE_URL || "Not Configured"}
                </div>
              </div>
              <div style={{ borderBottom: "1px solid #1a2233", paddingBottom: "0.5rem" }}>
                <div style={{ color: "#64748b", fontSize: "0.75rem", textTransform: "uppercase" }}>RSS Feed URL</div>
                <div style={{ color: "#38bdf8", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
                  {process.env.PODCAST_RSS_URL || "Not Configured"}
                </div>
              </div>
              <div>
                <div style={{ color: "#64748b", fontSize: "0.75rem", textTransform: "uppercase" }}>Image Cover URL</div>
                <div style={{ color: "#38bdf8", fontFamily: "var(--font-mono)", fontSize: "0.85rem" }}>
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
