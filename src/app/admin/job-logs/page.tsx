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
        <h2 className="pageTitle">
          Pipeline Job Operations Logs
        </h2>
        <p className="pageDesc">
          View background execution logs, outputs, and details. API keys and RSS preview tokens are automatically masked.
        </p>
      </div>

      {/* Filter and Search Bar */}
      <div className="panel" style={{ padding: "1.25rem" }}>
        <form method="GET" style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", flex: "1 1 200px" }}>
            <label className="label">Search Error/Job</label>
            <input
              type="text"
              name="search"
              defaultValue={search}
              placeholder="e.g. timeout, database"
              className="input"
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "180px" }}>
            <label className="label">Job Type</label>
            <select
              name="jobType"
              defaultValue={filterJobType}
              className="select"
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
            <label className="label">Status</label>
            <select
              name="status"
              defaultValue={filterStatus}
              className="select"
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
              className="buttonPrimary"
              style={{ padding: "0.5rem 1.25rem" }}
            >
              Apply Filters
            </button>
            <Link
              href="/admin/job-logs"
              className="btnReset"
              style={{
                padding: "0.5rem 1.25rem",
                textDecoration: "none",
                fontSize: "0.85rem",
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
          <div className="emptyState" style={{ padding: "3rem" }}>
            <div className="emptyStateTitle">No Operations Logs Found</div>
            <div className="emptyStateDesc">Try clearing search inputs or adjusting filters.</div>
          </div>
        ) : (
          <table className="table" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
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
                  <tr key={log.id} style={{ borderBottom: "1px solid var(--border-color)", verticalAlign: "top" }}>
                    <td style={{ padding: "1rem" }}>
                      <strong style={{ color: "var(--text-primary)", fontSize: "0.9rem" }}>{log.jobType}</strong>
                      <br />
                      <code style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>{log.id}</code>
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
                      <span style={{ fontSize: "0.85rem", color: "var(--text-primary)" }}>
                        {new Date(log.createdAt).toLocaleString()}
                      </span>
                      <br />
                      <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                        Duration: {durationSeconds}s
                      </span>
                    </td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.85rem" }}>
                        {scriptId ? (
                          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                            <Link href={`/admin/scripts/${scriptId}`} style={{ color: "var(--accent-color)", textDecoration: "underline" }}>
                              Script
                            </Link>
                            <Link href={`/admin/audio-segments/${scriptId}`} style={{ color: "var(--text-secondary)", textDecoration: "underline" }}>
                              Speech Segments
                            </Link>
                            <Link href={`/admin/final-audio/${scriptId}`} style={{ color: "var(--success-color)", textDecoration: "underline" }}>
                              Final Audio
                            </Link>
                            <Link href={`/admin/content-assets/${scriptId}`} style={{ color: "var(--text-primary)", textDecoration: "underline" }}>
                              Content Assets
                            </Link>
                          </div>
                        ) : null}
                        {episodeId ? (
                          <Link href={`/admin/episodes/${episodeId}`} style={{ color: "var(--text-primary)", textDecoration: "underline" }}>
                             Episode Details
                          </Link>
                        ) : null}
                        {!scriptId && !episodeId ? (
                          <span style={{ color: "var(--text-secondary)" }}>No related record found.</span>
                        ) : null}
                      </div>
                    </td>
                    <td style={{ maxWidth: "300px" }}>
                      {maskedError ? (
                        <div className="alertCard alertDanger" style={{ marginBottom: "0.5rem", padding: "0.5rem" }}>
                          {maskedError}
                        </div>
                      ) : null}

                      {/* Expandable JSON payload details */}
                      <details style={{ marginTop: "0.25rem" }}>
                        <summary style={{ cursor: "pointer", color: "var(--accent-color)", fontSize: "0.8rem", fontWeight: "600" }}>
                          Toggle Details
                        </summary>
                        <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                          <div>
                            <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>Masked Input Payload</span>
                            <pre
                              style={{
                                backgroundColor: "var(--bg-secondary)",
                                padding: "0.5rem",
                                borderRadius: "4px",
                                overflowX: "auto",
                                fontSize: "0.75rem",
                                color: "var(--text-primary)",
                                border: "1px solid var(--border-color)",
                                margin: "0.25rem 0 0 0",
                              }}
                            >
                              {JSON.stringify(maskedInput, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>Masked Output Result</span>
                            <pre
                              style={{
                                backgroundColor: "var(--bg-secondary)",
                                padding: "0.5rem",
                                borderRadius: "4px",
                                overflowX: "auto",
                                fontSize: "0.75rem",
                                color: "var(--text-primary)",
                                border: "1px solid var(--border-color)",
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
