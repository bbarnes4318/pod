import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

function maskSecrets(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    let masked = obj;
    // Redact S3 / local URL secrets
    if (masked.includes("Signature=") || masked.includes("AWSAccessKeyId=")) {
      masked = masked.replace(/Signature=[^&]*/g, "Signature=[MASKED]")
                     .replace(/AWSAccessKeyId=[^&]*/g, "AWSAccessKeyId=[MASKED]");
    }
    if (masked.includes("token=") || masked.includes("Token=")) {
      masked = masked.replace(/token=[^&]*/gi, "token=[MASKED]");
    }
    // Mask DB URL, Redis URL, bearer keys, and cookies
    if (masked.includes("postgres://") || masked.includes("postgresql://")) {
      masked = masked.replace(/(postgres|postgresql):\/\/[^@\s]+/g, "$1://[MASKED]");
    }
    if (masked.includes("redis://")) {
      masked = masked.replace(/redis:\/\/[^@\s]+/g, "redis://[MASKED]");
    }
    if (masked.includes("Bearer ")) {
      masked = masked.replace(/Bearer\s+[a-zA-Z0-9_\-\.]+/gi, "Bearer [MASKED]");
    }
    // Mask database/redis connection strings or passwords in errors
    masked = masked.replace(/(password|passwd|pwd|secret|api_key|apikey|token)=[^&;\s"']+/gi, "$1=[MASKED]");
    return masked;
  }

  if (Array.isArray(obj)) {
    return obj.map(maskSecrets);
  }

  if (typeof obj === "object") {
    const result: any = {};
    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive =
        lowerKey.includes("apikey") ||
        lowerKey.includes("api_key") ||
        lowerKey.includes("token") ||
        lowerKey.includes("secret") ||
        lowerKey.includes("password") ||
        lowerKey.includes("authorization") ||
        lowerKey.includes("bearer") ||
        lowerKey.includes("cookie") ||
        (lowerKey.includes("url") && (lowerKey.includes("signed") || lowerKey.includes("private"))) ||
        lowerKey.includes("database") ||
        lowerKey.includes("redis");

      if (isSensitive) {
        result[key] = "[MASKED]";
      } else {
        result[key] = maskSecrets(obj[key]);
      }
    }
    return result;
  }

  return obj;
}

function extractRelatedLinks(log: any) {
  let scriptId: string | null = null;
  let episodeId: string | null = null;

  const check = (val: any) => {
    if (!val) return;
    if (typeof val === "object") {
      if (val.scriptId && typeof val.scriptId === "string") scriptId = val.scriptId;
      if (val.episodeId && typeof val.episodeId === "string") episodeId = val.episodeId;
      if (val.id && typeof val.id === "string") {
        if (log.jobType.includes("episode") || log.jobType.includes("content") || log.jobType.includes("rss")) {
          episodeId = val.id;
        } else if (log.jobType.includes("script") || log.jobType.includes("fact") || log.jobType.includes("audio")) {
          scriptId = val.id;
        }
      }
    }
  };

  try {
    check(log.input);
    check(log.output);
  } catch (e) {}

  return { scriptId, episodeId };
}

export default async function JobLogsPage(props: {
  searchParams: Promise<{
    jobType?: string;
    status?: string;
    search?: string;
  }>;
}) {
  const searchParams = await props.searchParams;
  const filterJobType = searchParams.jobType || "";
  const filterStatus = searchParams.status || "";
  const search = searchParams.search || "";

  // Query distinct job types for filters
  const distinctTypes = await db.jobLog.groupBy({
    by: ["jobType"],
  });

  // Construct database filters
  const dbWhere: any = {};
  if (filterJobType) {
    dbWhere.jobType = filterJobType;
  }
  if (filterStatus) {
    dbWhere.status = filterStatus;
  }

  // Fetch recent job logs (bounded to 250 rows)
  const logs = await db.jobLog.findMany({
    where: dbWhere,
    orderBy: { createdAt: "desc" },
    take: 250,
  });

  // Filter in memory for full payload search (jobType, error, input, output)
  const filteredLogs = logs.filter((log) => {
    if (!search.trim()) return true;
    const lowerSearch = search.toLowerCase();

    const matchesJobType = log.jobType?.toLowerCase().includes(lowerSearch);
    const matchesError = log.error?.toLowerCase().includes(lowerSearch);

    let matchesInput = false;
    try {
      matchesInput = JSON.stringify(log.input).toLowerCase().includes(lowerSearch);
    } catch (e) {}

    let matchesOutput = false;
    try {
      matchesOutput = JSON.stringify(log.output).toLowerCase().includes(lowerSearch);
    } catch (e) {}

    return matchesJobType || matchesError || matchesInput || matchesOutput;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <div>
        <h2 style={{ fontSize: "1.5rem", fontWeight: "700", color: "#ffffff", marginBottom: "0.25rem" }}>
          Pipeline Job Operations Logs
        </h2>
        <p style={{ color: "#64748b", fontSize: "0.9rem" }}>
          View background execution logs, outputs, and details. API keys and RSS preview tokens are automatically masked.
        </p>
      </div>

      {/* Filter and Search Bar */}
      <div className="panel" style={{ padding: "1.25rem" }}>
        <form method="GET" style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", flex: "1 1 200px" }}>
            <label style={{ fontSize: "0.8rem", fontWeight: "600", color: "#94a3b8" }}>Search Error/Job</label>
            <input
              type="text"
              name="search"
              defaultValue={search}
              placeholder="e.g. timeout, database"
              style={{
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid #1a2233",
                backgroundColor: "#080b10",
                color: "#ffffff",
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "180px" }}>
            <label style={{ fontSize: "0.8rem", fontWeight: "600", color: "#94a3b8" }}>Job Type</label>
            <select
              name="jobType"
              defaultValue={filterJobType}
              style={{
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid #1a2233",
                backgroundColor: "#080b10",
                color: "#ffffff",
              }}
            >
              <option value="">All Job Types</option>
              {distinctTypes.map((t) => (
                <option key={t.jobType} value={t.jobType}>
                  {t.jobType}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "150px" }}>
            <label style={{ fontSize: "0.8rem", fontWeight: "600", color: "#94a3b8" }}>Status</label>
            <select
              name="status"
              defaultValue={filterStatus}
              style={{
                padding: "0.5rem",
                borderRadius: "4px",
                border: "1px solid #1a2233",
                backgroundColor: "#080b10",
                color: "#ffffff",
              }}
            >
              <option value="">All Statuses</option>
              <option value="completed">completed</option>
              <option value="failed">failed</option>
              <option value="running">running</option>
            </select>
          </div>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="submit"
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: "4px",
                backgroundColor: "#1e3a8a",
                color: "#ffffff",
                border: "none",
                fontWeight: "600",
                cursor: "pointer",
              }}
            >
              Apply Filters
            </button>
            <Link
              href="/admin/job-logs"
              style={{
                padding: "0.5rem 1.25rem",
                borderRadius: "4px",
                backgroundColor: "#1e293b",
                color: "#94a3b8",
                border: "1px solid #334155",
                fontWeight: "600",
                textDecoration: "none",
                fontSize: "0.9rem",
              }}
            >
              Clear
            </Link>
          </div>
        </form>
      </div>

      {/* Logs Table */}
      <div className="panel" style={{ padding: 0 }}>
        {filteredLogs.length === 0 ? (
          <div style={{ padding: "3rem", textAlign: "center", color: "#64748b" }}>
            <p style={{ fontSize: "1rem", fontWeight: "600", marginBottom: "0.5rem" }}>No Operations Logs Found</p>
            <p style={{ fontSize: "0.85rem" }}>Try clearing search inputs or adjusting filters.</p>
          </div>
        ) : (
          <table className="table" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #1a2233" }}>
                <th style={{ padding: "1rem" }}>Job Type</th>
                <th>Status</th>
                <th>Time / Duration</th>
                <th>Related Records</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {filteredLogs.map((log) => {
                const { scriptId, episodeId } = extractRelatedLinks(log);
                const durationSeconds = Math.max(
                  0,
                  Math.round((new Date(log.updatedAt).getTime() - new Date(log.createdAt).getTime()) / 1000)
                );

                const maskedInput = maskSecrets(log.input);
                const maskedOutput = maskSecrets(log.output);
                const maskedError = log.error ? maskSecrets(log.error) : null;

                return (
                  <tr key={log.id} style={{ borderBottom: "1px solid #1a2233", verticalAlign: "top" }}>
                    <td style={{ padding: "1rem" }}>
                      <strong style={{ color: "#ffffff", fontSize: "0.9rem" }}>{log.jobType}</strong>
                      <br />
                      <code style={{ fontSize: "0.75rem", color: "#64748b" }}>{log.id}</code>
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
                        {log.status.toUpperCase()}
                      </span>
                    </td>
                    <td>
                      <span style={{ fontSize: "0.85rem", color: "#ffffff" }}>
                        {new Date(log.createdAt).toLocaleString()}
                      </span>
                      <br />
                      <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                        Duration: {durationSeconds}s
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
                        {scriptId ? (
                          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                            <Link href={`/admin/scripts/${scriptId}`} style={{ color: "#38bdf8", textDecoration: "underline" }}>
                              Script
                            </Link>
                            <Link href={`/admin/audio-segments/${scriptId}`} style={{ color: "#a5b4fc", textDecoration: "underline" }}>
                              Speech Segments
                            </Link>
                            <Link href={`/admin/final-audio/${scriptId}`} style={{ color: "#86efac", textDecoration: "underline" }}>
                              Final Audio
                            </Link>
                            <Link href={`/admin/content-assets/${scriptId}`} style={{ color: "#cbd5e1", textDecoration: "underline" }}>
                              Content Assets
                            </Link>
                          </div>
                        ) : null}
                        {episodeId ? (
                          <Link href={`/admin/episodes/${episodeId}`} style={{ color: "#e2e8f0", textDecoration: "underline" }}>
                             Episode Details
                          </Link>
                        ) : null}
                        {!scriptId && !episodeId ? (
                          <span style={{ color: "#64748b" }}>No related record found.</span>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ maxWidth: "300px" }}>
                      {maskedError ? (
                        <div
                          style={{
                            fontSize: "0.8rem",
                            color: "#fda4af",
                            backgroundColor: "rgba(244, 63, 94, 0.1)",
                            padding: "0.5rem",
                            borderRadius: "4px",
                            border: "1px solid rgba(244, 63, 94, 0.2)",
                            marginBottom: "0.5rem",
                            wordBreak: "break-all",
                          }}
                        >
                          {maskedError}
                        </div>
                      ) : null}

                      {/* Expandable JSON payload details */}
                      <details style={{ marginTop: "0.25rem" }}>
                        <summary style={{ cursor: "pointer", color: "#38bdf8", fontSize: "0.8rem", fontWeight: "600" }}>
                          Toggle Details
                        </summary>
                        <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                          <div>
                            <span style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>Masked Input Payload</span>
                            <pre
                              style={{
                                backgroundColor: "#080b10",
                                padding: "0.5rem",
                                borderRadius: "4px",
                                overflowX: "auto",
                                fontSize: "0.75rem",
                                color: "#94a3b8",
                                border: "1px solid #1a2233",
                                margin: "0.25rem 0 0 0",
                              }}
                            >
                              {JSON.stringify(maskedInput, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <span style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>Masked Output Result</span>
                            <pre
                              style={{
                                backgroundColor: "#080b10",
                                padding: "0.5rem",
                                borderRadius: "4px",
                                overflowX: "auto",
                                fontSize: "0.75rem",
                                color: "#94a3b8",
                                border: "1px solid #1a2233",
                                margin: "0.25rem 0 0 0",
                              }}
                            >
                              {JSON.stringify(maskedOutput, null, 2)}
                            </pre>
                          </div>
                        </div>
                      </details>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
