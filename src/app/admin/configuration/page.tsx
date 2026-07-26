import React from "react";
import { runProductionReadinessAudit } from "@/lib/services/finalQaService";
import { getOddsApiKeyStatus, getRssFeedStatus, getRedisStatus, getResearchProviderStatus, getBosonTtsStatus } from "@/lib/env";
import { resolveEpisodeCast } from "@/lib/services/hostCasting";
import { getLlmRoutingReadiness } from "@/lib/services/productionEnvService";

export const dynamic = "force-dynamic";

export default async function ConfigurationPage() {
  const audit = await runProductionReadinessAudit();

  // Seat labels come from the CURRENT roster, never from name literals. This
  // page used to print "Max Voltage Voice" and "Dr. Linebreak Voice" against a
  // pair that had been retired for two rosters. Wrapped because this is a
  // diagnostic page: a casting failure must not blank the whole readout.
  let castNames: string[] = [];
  try {
    const cast = await resolveEpisodeCast({ hostIds: [] });
    castNames = cast.members.map((m) => m.host.name);
  } catch {
    castNames = [];
  }
  const SEAT_LETTERS = ["A", "B", "C", "D"];
  const seatLabel = (i: number) =>
    castNames[i] ? `${castNames[i]} (seat ${SEAT_LETTERS[i]})` : `Seat ${SEAT_LETTERS[i]}`;

  const maskSecret = (envVar: string | undefined): string => {
    if (!envVar || envVar.trim() === "") return "MISSING";
    return "CONFIGURED";
  };

  const dbUrlStatus = maskSecret(process.env.DATABASE_URL);
  const redisUrlStatus = await getRedisStatus();
  const previewTokenStatus = maskSecret(process.env.RSS_PREVIEW_TOKEN);

  // How many environment variables this SERVER PROCESS can actually see. A
  // container that is receiving its configuration normally reports dozens. A
  // very low number means the variables are not reaching the process at all,
  // which is a different problem from any single key being unset — and it is
  // the distinction that a per-key MISSING/CONFIGURED readout cannot make.
  const visibleEnvCount = Object.keys(process.env).length;

  // Providers this project actually uses. Previously this list showed OpenAI
  // and Gemini — neither is used by the pipeline (Gemini has no adapter at
  // all) — while omitting Fish, the live voice engine, so an operator
  // checking the Fish key found nothing on the page to check.
  // Resolved LLM role map. Names and verdicts only — this helper never returns
  // a credential value, and the table below never renders one.
  const routing = getLlmRoutingReadiness();
  const routingStatusClass = (status: string) =>
    status === "ready"
      ? "badgeCompleted"
      : status === "degraded"
      ? "badgeRunning"
      : status === "unroutable"
      ? "badgeFailed"
      : "badge";

  const providerApis = [
    { name: "Anthropic API Key (ANTHROPIC_API_KEY) — legacy/paid LLM backup", value: maskSecret(process.env.ANTHROPIC_API_KEY) },
    { name: "NVIDIA NIM API Key (NVIDIA_API_KEY) — frontier development primaries", value: maskSecret(process.env.NVIDIA_API_KEY) },
    { name: "Z.ai API Key (ZAI_API_KEY) — independent free provider", value: maskSecret(process.env.ZAI_API_KEY) },
    { name: "Fish Audio API Key (FISH_API_KEY) — voice engine", value: maskSecret(process.env.FISH_API_KEY) },
    { name: "ElevenLabs API Key (fallback)", value: maskSecret(process.env.ELEVENLABS_API_KEY) },
    { name: "Cartesia API Key (fallback)", value: maskSecret(process.env.CARTESIA_API_KEY) },
    { name: "Boson API Key (fallback)", value: getBosonTtsStatus() },
    { name: "Research Provider (RESEARCH_PROVIDER)", value: getResearchProviderStatus() },
    { name: "Odds API Key (ODDS_API_KEY)", value: getOddsApiKeyStatus() },
    { name: "RSS Feed Ingest (NEWS_RSS_FEEDS)", value: getRssFeedStatus() },
    { name: "Env vars visible to this process", value: String(visibleEnvCount) },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <div className="pageHeader" style={{ marginBottom: 0 }}>
        <div>
          <h2 className="pageTitle">System Configuration</h2>
          <p className="pageDesc">
            Read-only environment status, service provider diagnostics, and production safety audits.
          </p>
        </div>
      </div>

      {/* LLM role routing — which model plays each production role */}
      <div className="panel">
        <div className="panelHeader" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <h3 className="panelTitle">LLM Role Routing</h3>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <span className="badge badgeCompleted" style={{ fontSize: "0.75rem" }}>
              profile: {routing.profile}
            </span>
            <span className={`badge ${routing.stage === "live" ? "badgeRunning" : "badgeCompleted"}`} style={{ fontSize: "0.75rem" }}>
              stage: {routing.stage}
            </span>
            <span className={`badge ${routing.paidFallbackAllowed ? "badgeRunning" : "badgeCompleted"}`} style={{ fontSize: "0.75rem" }}>
              paid fallback: {routing.paidFallbackAllowed ? "allowed" : "forbidden"}
            </span>
          </div>
        </div>
        <div className="panelContent" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", margin: 0 }}>
            {routing.profile === "legacy"
              ? "Legacy routing: every role uses the existing LLM_* / SCRIPT_LLM_* / VERIFY_* configuration, exactly as before this feature shipped."
              : "Each role resolves in order: role override → profile primary → secondary → tertiary → role-appropriate existing provider."}{" "}
            Set <code>LLM_ROUTING_PROFILE=legacy</code> and redeploy web + worker to roll back with one variable.
          </p>

          {routing.advisory && (
            <div
              style={{
                padding: "0.75rem 1rem",
                border: "1px solid var(--warning-color)",
                borderRadius: "6px",
                backgroundColor: "var(--bg-primary)",
                color: "var(--warning-color)",
                fontSize: "0.85rem",
              }}
            >
              <strong>Trial endpoint advisory: </strong>
              {routing.advisory}
            </div>
          )}

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8rem" }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-secondary)", textTransform: "uppercase", fontSize: "0.7rem" }}>
                  <th style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)" }}>Role</th>
                  <th style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)" }}>Primary</th>
                  <th style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)" }}>Secondary</th>
                  <th style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)" }}>Legacy backup</th>
                  <th style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {routing.roles.map((r) => (
                  <tr key={r.role}>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)", color: "var(--text-primary)" }}>
                      <div style={{ fontWeight: 600 }}>{r.label}</div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-secondary)" }}>{r.role}</div>
                      {r.override && (
                        <div style={{ fontSize: "0.7rem", color: "var(--accent-color)" }}>override: {r.override}</div>
                      )}
                    </td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)", fontFamily: "var(--font-mono)" }}>{r.primary}</td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)", fontFamily: "var(--font-mono)" }}>{r.secondary}</td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)", fontFamily: "var(--font-mono)" }}>{r.legacyBackup}</td>
                    <td style={{ padding: "0.5rem", borderBottom: "1px solid var(--border-color)" }}>
                      <span className={`badge ${routingStatusClass(r.status)}`} style={{ fontSize: "0.7rem" }}>
                        {r.status === "not-wired" ? "no LLM call yet" : r.status}
                      </span>
                      {r.notes.length > 0 && (
                        <div style={{ marginTop: "0.35rem", fontSize: "0.7rem", color: "var(--text-secondary)" }}>
                          {r.notes.join(" ")}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: "1.5rem", alignItems: "start" }}>
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

      {/* Active TTS Configuration */}
      <div className="panel">
        <div className="panelHeader">
          <h3 className="panelTitle">Active TTS Settings ({(process.env.TTS_PROVIDER || "stub").toUpperCase()})</h3>
        </div>
        <div className="panelContent" style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          {process.env.TTS_PROVIDER?.toLowerCase() === "boson" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1.5rem" }}>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Boson TTS Status</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>{getBosonTtsStatus()}</div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Model</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>{process.env.BOSON_TTS_MODEL || "higgs-tts-3"}</div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Voice</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>{process.env.BOSON_TTS_VOICE || "default"}</div>
              </div>
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Inline Tags</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>
                  {process.env.BOSON_TTS_ENABLE_TAGS === "true" ? "ENABLED" : "DISABLED"}
                </div>
              </div>
            </div>
          ) : process.env.TTS_PROVIDER?.toLowerCase() === "cartesia" ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1.5rem" }}>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Cartesia Status</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>
                  {process.env.CARTESIA_API_KEY ? "CONFIGURED" : "MISSING"}
                </div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Model ID</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>{process.env.CARTESIA_MODEL_ID || "sonic-2"}</div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>{seatLabel(0)} Voice</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>
                  {process.env.CARTESIA_HOST_A_VOICE_ID ||
                    process.env.CARTESIA_MAX_VOLTAGE_VOICE_ID ||
                    "Adrian (default fallback)"}
                </div>
              </div>
              <div>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>{seatLabel(1)} Voice</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>
                  {process.env.CARTESIA_HOST_B_VOICE_ID ||
                    process.env.CARTESIA_DR_LINEBREAK_VOICE_ID ||
                    "Aiden (default fallback)"}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1.5rem" }}>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>TTS Status</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>CONFIGURED</div>
              </div>
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "0.5rem" }}>
                <div style={{ color: "var(--text-secondary)", fontSize: "0.75rem", textTransform: "uppercase" }}>Global Provider</div>
                <div style={{ color: "var(--text-primary)", fontWeight: "600" }}>{process.env.TTS_PROVIDER || "stub"}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
