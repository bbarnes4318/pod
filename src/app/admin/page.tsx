import React from "react";
import JobTrigger from "./JobTrigger";

export default async function AdminDashboard() {
  // Read active provider configuration from environment
  const config = {
    llm: process.env.LLM_PROVIDER || "stub",
    tts: process.env.TTS_PROVIDER || "stub",
    sports: process.env.SPORTS_PROVIDER || "stub",
    storage: process.env.STORAGE_PROVIDER || "stub",
  };

  // Mock data representing a clean state of generated episodes & jobs
  const mockMetrics = [
    { title: "Total Episodes", value: "0", sub: "Drafts or published", trend: "0%" },
    { title: "Scored Topics", value: "0", sub: "Pending debate evaluation", trend: "0%" },
    { title: "Average Debate Score", value: "--", sub: "Target range: 80-100", trend: "" },
    { title: "Active Workers", value: "1", sub: "Standalone listener active", trend: "Online" },
  ];

  const mockJobs = [
    { id: "job-001", name: "generate-podcast", episode: "ep-stub-1", stage: "fetch-sports", status: "completed", date: "2 minutes ago" },
    { id: "job-002", name: "generate-podcast", episode: "ep-stub-2", stage: "generate-script", status: "failed", date: "10 minutes ago" },
    { id: "job-003", name: "generate-podcast", episode: "ep-stub-3", stage: "generate-audio", status: "running", date: "Just now" },
  ];

  return (
    <div>
      {/* Stub Provider Warning Guard */}
      {config.sports === "stub" && (
        <div
          style={{
            marginBottom: "1.5rem",
            padding: "1rem 1.5rem",
            backgroundColor: "rgba(245, 158, 11, 0.1)",
            border: "1px solid rgba(245, 158, 11, 0.3)",
            borderRadius: "6px",
            color: "#f59e0b",
            fontSize: "0.95rem",
            lineHeight: "1.5",
          }}
        >
          <strong>⚠️ Demo Mode (Stub Sports Provider Active)</strong>
          <p style={{ marginTop: "0.25rem", color: "#94a3b8" }}>
            The stub sports provider is for architecture validation only. It must never be used to generate real topics, research briefs, scripts, or published episodes. Claiming that any simulated sports fact is real is strictly prohibited in stub/architecture validation mode.
          </p>
        </div>
      )}

      {/* Metrics Row */}
      <div className="grid">
        {mockMetrics.map((m, idx) => (
          <div className="card" key={idx}>
            <div className="cardTitle">{m.title}</div>
            <div className="cardValue">{m.value}</div>
            <div className="cardSub">
              {m.trend && <span className={m.trend === "Online" || m.trend !== "0%" ? "trendPositive" : ""}>{m.trend} </span>}
              <span>{m.sub}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Main Layout Grid */}
      <div className="dashboardSection">
        {/* Left Side: Pipeline Jobs List */}
        <div className="panel">
          <div className="panelHeader">
            <h3 className="panelTitle">Active Pipeline Operations</h3>
          </div>
          <div className="panelContent" style={{ padding: 0 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Task Name</th>
                  <th>Episode</th>
                  <th>Current Stage</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {mockJobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <code style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "#38bdf8" }}>{j.id}</code>
                    </td>
                    <td>{j.name}</td>
                    <td>{j.episode}</td>
                    <td>
                      <code style={{ fontSize: "0.85rem", color: "#94a3b8" }}>{j.stage}</code>
                    </td>
                    <td>
                      <span
                        className={`badge ${
                          j.status === "running"
                            ? "badgeRunning"
                            : j.status === "completed"
                            ? "badgeCompleted"
                            : "badgeFailed"
                        }`}
                      >
                        {j.status}
                      </span>
                    </td>
                    <td>{j.date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Side: Active Providers Config & Trigger Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* Active Configuration Panel */}
          <div className="panel">
            <div className="panelHeader">
              <h3 className="panelTitle">Active Abstractions Configuration</h3>
            </div>
            <div className="panelContent">
              <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #1a2233", paddingBottom: "0.5rem" }}>
                  <span style={{ color: "#64748b", fontSize: "0.9rem" }}>LLM Engine:</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "#38bdf8" }}>{config.llm}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #1a2233", paddingBottom: "0.5rem" }}>
                  <span style={{ color: "#64748b", fontSize: "0.9rem" }}>TTS Engine:</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "#38bdf8" }}>{config.tts}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px solid #1a2233", paddingBottom: "0.5rem" }}>
                  <span style={{ color: "#64748b", fontSize: "0.9rem" }}>Sports Data Source:</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "#38bdf8" }}>{config.sports}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", paddingBottom: "0.25rem" }}>
                  <span style={{ color: "#64748b", fontSize: "0.9rem" }}>Storage Target:</span>
                  <strong style={{ fontFamily: "var(--font-mono)", color: "#38bdf8" }}>{config.storage}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Trigger Job Client Action Panel */}
          <JobTrigger />
        </div>
      </div>
    </div>
  );
}
