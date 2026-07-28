import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import {
  queuedScriptLogIsSuperseded,
  scriptLogEpisodeId,
  type ScriptJobLogLike,
} from "@/lib/queue/scriptJobTracking";
import AutoRefresh from "./AutoRefresh";

export const dynamic = "force-dynamic";

function maskSecrets(obj: any): any {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    let masked = obj;
    if (masked.includes("Signature=") || masked.includes("AWSAccessKeyId=")) {
      masked = masked
        .replace(/Signature=[^&]*/g, "Signature=[MASKED]")
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
    return masked.replace(
      /(password|passwd|pwd|secret|api_key|apikey|token)=[^&;\s"']+/gi,
      "$1=[MASKED]"
    );
  }

  if (Array.isArray(obj)) return obj.map(maskSecrets);

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

      result[key] = isSensitive ? "[MASKED]" : maskSecrets(obj[key]);
    }
    return result;
  }

  return obj;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractRelatedLinks(log: { jobType: string; input: unknown; output: unknown }) {
  let scriptId: string | null = null;
  let episodeId: string | null = scriptLogEpisodeId({ input: log.input });

  const check = (value: unknown) => {
    const val = objectValue(value);
    if (!val) return;
    if (typeof val.scriptId === "string") scriptId = val.scriptId;
    if (typeof val.episodeId === "string") episodeId = val.episodeId;
    if (typeof val.id === "string") {
      if (log.jobType.includes("episode") || log.jobType.includes("content") || log.jobType.includes("rss")) {
        episodeId = val.id;
      } else if (log.jobType.includes("script") || log.jobType.includes("fact") || log.jobType.includes("audio")) {
        scriptId = val.id;
      }
    }
  };

  check(log.input);
  check(log.output);
  return { scriptId, episodeId };
}

function queueJobId(input: unknown): string | null {
  const obj = objectValue(input);
  return typeof obj?.queueJobId === "string" ? obj.queueJobId : null;
}

function statusClass(status: string): string {
  if (status === "completed") return "badgeCompleted";
  if (status === "failed") return "badgeFailed";
  if (status === "completed_with_errors") return "badgeWarning";
  return "badgeRunning";
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
  const nowMs = Date.now();

  const [distinctTypes, rawLogs] = await Promise.all([
    db.jobLog.groupBy({ by: ["jobType"] }),
    db.jobLog.findMany({
      // Status is filtered in memory because queued-row suppression needs to see
      // the later running/completed row for the same episode.
      where: filterJobType ? { jobType: filterJobType } : {},
      orderBy: { createdAt: "desc" },
      take: 250,
    }),
  ]);

  const lifecycleLogs = rawLogs.filter(
    (log) => !queuedScriptLogIsSuperseded(log as ScriptJobLogLike, rawLogs as ScriptJobLogLike[])
  );

  const episodeIds = [
    ...new Set(
      lifecycleLogs
        .map((log) => extractRelatedLinks(log).episodeId)
        .filter((id): id is string => !!id)
    ),
  ];
  const episodeRows = episodeIds.length
    ? await db.episode.findMany({
        where: { id: { in: episodeIds } },
        select: { id: true, title: true },
      })
    : [];
  const episodeTitleById = new Map(episodeRows.map((episode) => [episode.id, episode.title]));

  const filteredLogs = lifecycleLogs.filter((log) => {
    if (filterStatus && log.status !== filterStatus) return false;
    if (!search.trim()) return true;

    const lowerSearch = search.toLowerCase();
    const { episodeId } = extractRelatedLinks(log);
    const episodeTitle = episodeId ? episodeTitleById.get(episodeId) ?? "" : "";
    return [
      log.jobType,
      log.status,
      log.error ?? "",
      episodeId ?? "",
      episodeTitle,
      JSON.stringify(log.input),
      JSON.stringify(log.output),
    ].some((value) => value.toLowerCase().includes(lowerSearch));
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <AutoRefresh />

      <div>
        <h2 className="pageTitle">Pipeline Job Operations Logs</h2>
        <p className="pageDesc">
          Waiting script requests appear immediately, with their episode title and queue identity. This page refreshes every four seconds.
        </p>
      </div>

      <div className="panel" style={{ padding: "1.25rem" }}>
        <form method="GET" style={{ display: "flex", flexWrap: "wrap", gap: "1rem", alignItems: "flex-end" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", flex: "1 1 240px" }}>
            <label className="label">Search job, episode, or error</label>
            <input
              type="text"
              name="search"
              defaultValue={search}
              placeholder="Episode title, episode ID, timeout..."
              className="input"
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "190px" }}>
            <label className="label">Job Type</label>
            <select name="jobType" defaultValue={filterJobType} className="select">
              <option value="">All Job Types</option>
              {distinctTypes.map((type) => (
                <option key={type.jobType} value={type.jobType}>
                  {type.jobType}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", width: "180px" }}>
            <label className="label">Status</label>
            <select name="status" defaultValue={filterStatus} className="select">
              <option value="">All Statuses</option>
              <option value="queued">queued</option>
              <option value="running">running</option>
              <option value="completed">completed</option>
              <option value="completed_with_errors">completed_with_errors</option>
              <option value="failed">failed</option>
            </select>
          </div>

          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="submit" className="buttonPrimary" style={{ padding: "0.5rem 1.25rem" }}>
              Apply Filters
            </button>
            <Link
              href="/admin/job-logs"
              className="btnReset"
              style={{ padding: "0.5rem 1.25rem", textDecoration: "none", fontSize: "0.85rem" }}
            >
              Clear
            </Link>
          </div>
        </form>
      </div>

      <div className="panel" style={{ padding: 0 }}>
        {filteredLogs.length === 0 ? (
          <div className="emptyState" style={{ padding: "3rem" }}>
            <div className="emptyStateTitle">No Operations Logs Found</div>
            <div className="emptyStateDesc">Try clearing the search or adjusting the filters.</div>
          </div>
        ) : (
          <div className="tableContainer" style={{ border: "none", borderRadius: 0 }}>
            <table className="table" style={{ borderCollapse: "collapse", width: "100%" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border-color)" }}>
                  <th style={{ padding: "1rem" }}>Job</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Episode / Records</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => {
                  const { scriptId, episodeId } = extractRelatedLinks(log);
                  const episodeTitle = episodeId ? episodeTitleById.get(episodeId) ?? "Untitled episode" : null;
                  const elapsedEnd =
                    log.status === "queued" || log.status === "running"
                      ? nowMs
                      : new Date(log.updatedAt).getTime();
                  const elapsedSeconds = Math.max(
                    0,
                    Math.round((elapsedEnd - new Date(log.createdAt).getTime()) / 1000)
                  );
                  const timingLabel =
                    log.status === "queued"
                      ? `Waiting ${elapsedSeconds}s`
                      : log.status === "running"
                        ? `Running ${elapsedSeconds}s`
                        : `Duration ${elapsedSeconds}s`;

                  const maskedInput = maskSecrets(log.input);
                  const maskedOutput = maskSecrets(log.output);
                  const maskedError = log.error ? maskSecrets(log.error) : null;
                  const bullJobId = queueJobId(log.input);

                  return (
                    <tr key={log.id} style={{ borderBottom: "1px solid var(--border-color)", verticalAlign: "top" }}>
                      <td style={{ padding: "1rem" }}>
                        <strong style={{ color: "var(--text-primary)", fontSize: "0.9rem" }}>{log.jobType}</strong>
                        <br />
                        <code style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>{log.id}</code>
                        {bullJobId ? (
                          <>
                            <br />
                            <code style={{ fontSize: "0.72rem", color: "var(--accent-color)" }}>
                              queue: {bullJobId}
                            </code>
                          </>
                        ) : null}
                      </td>
                      <td>
                        <span className={`badge ${statusClass(log.status)}`}>{log.status.toUpperCase()}</span>
                      </td>
                      <td>
                        <span style={{ fontSize: "0.85rem", color: "var(--text-primary)" }}>
                          {new Date(log.createdAt).toLocaleString()}
                        </span>
                        <br />
                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>{timingLabel}</span>
                      </td>
                      <td>
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}>
                          {episodeId ? (
                            <>
                              <strong>{episodeTitle}</strong>
                              <code style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>{episodeId}</code>
                              <Link href={`/admin/episodes/${episodeId}`} style={{ color: "var(--accent-color)", textDecoration: "underline" }}>
                                Episode Details
                              </Link>
                            </>
                          ) : null}
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
                            </div>
                          ) : null}
                          {!scriptId && !episodeId ? (
                            <span style={{ color: "var(--text-secondary)" }}>No related record found.</span>
                          ) : null}
                        </div>
                      </td>
                      <td style={{ maxWidth: "340px" }}>
                        {log.status === "queued" ? (
                          <div className="alertCard" style={{ marginBottom: "0.5rem", padding: "0.5rem" }}>
                            This exact episode is queued and has not been picked up by the worker yet.
                          </div>
                        ) : null}
                        {maskedError ? (
                          <div className="alertCard alertDanger" style={{ marginBottom: "0.5rem", padding: "0.5rem" }}>
                            {maskedError}
                          </div>
                        ) : null}

                        <details style={{ marginTop: "0.25rem" }}>
                          <summary style={{ cursor: "pointer", color: "var(--accent-color)", fontSize: "0.8rem", fontWeight: 600 }}>
                            Toggle Details
                          </summary>
                          <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                            <div>
                              <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>
                                Masked Input Payload
                              </span>
                              <pre style={{ backgroundColor: "var(--bg-secondary)", padding: "0.5rem", borderRadius: "4px", overflowX: "auto", fontSize: "0.75rem", border: "1px solid var(--border-color)", margin: "0.25rem 0 0" }}>
                                {JSON.stringify(maskedInput, null, 2)}
                              </pre>
                            </div>
                            <div>
                              <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>
                                Masked Output Result
                              </span>
                              <pre style={{ backgroundColor: "var(--bg-secondary)", padding: "0.5rem", borderRadius: "4px", overflowX: "auto", fontSize: "0.75rem", border: "1px solid var(--border-color)", margin: "0.25rem 0 0" }}>
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
          </div>
        )}
      </div>
    </div>
  );
}
