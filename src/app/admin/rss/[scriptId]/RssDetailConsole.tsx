"use client";

import React, { useState, useTransition } from "react";
import Link from "next/link";
import {
  prepareEpisodeForRssAction,
  publishEpisodeAction,
  unpublishEpisodeAction,
  fetchRssEligibility,
  fetchLatestRssJob,
} from "../actions";

interface RssDetailConsoleProps {
  script: any;
  initialEligibility: any;
  initialJob: any;
  previewToken: string;
}

export default function RssDetailConsole({
  script,
  initialEligibility,
  initialJob,
  previewToken,
}: RssDetailConsoleProps) {
  const [eligibility, setEligibility] = useState(initialEligibility);
  const [latestJob, setLatestJob] = useState<any>(initialJob);
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [forceRepublish, setForceRepublish] = useState(false);

  const ep = script.episode;
  const publicRssUrl = process.env.NEXT_PUBLIC_PODCAST_RSS_URL || "/rss";
  const previewRssUrl = `${publicRssUrl}/preview?token=${previewToken}`;

  const refreshStatus = async () => {
    try {
      const [newElig, newJob] = await Promise.all([
        fetchRssEligibility(script.id),
        fetchLatestRssJob(script.id),
      ]);
      setEligibility(newElig);
      setLatestJob(newJob);
    } catch (e: any) {
      console.error("Refresh failed:", e);
    }
  };

  const handlePrepare = () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    startTransition(async () => {
      try {
        const res = await prepareEpisodeForRssAction(script.id);
        setSuccessMsg("Episode prepared for RSS successfully! Status set to PUBLISH READY.");
        await refreshStatus();
      } catch (e: any) {
        setErrorMsg(e.message || "Preparation failed.");
        await refreshStatus();
      }
    });
  };

  const handlePublish = () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    startTransition(async () => {
      try {
        const res = await publishEpisodeAction(script.id, forceRepublish);
        setSuccessMsg(`Episode published successfully! Status set to PUBLISHED.${forceRepublish ? " Publication date updated." : ""}`);
        await refreshStatus();
      } catch (e: any) {
        setErrorMsg(e.message || "Publishing failed.");
        await refreshStatus();
      }
    });
  };

  const handleUnpublish = () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    startTransition(async () => {
      try {
        const res = await unpublishEpisodeAction(script.id);
        setSuccessMsg("Episode unpublished successfully! Status reverted to PUBLISH READY.");
        await refreshStatus();
      } catch (e: any) {
        setErrorMsg(e.message || "Unpublishing failed.");
        await refreshStatus();
      }
    });
  };

  // Human readable check names
  const checkLabels: Record<string, string> = {
    scriptExists: "Script exists in database",
    scriptApproved: "Script status is 'approved'",
    episodeExists: "Episode is linked to script",
    episodeStatusValid: "Episode status is eligible",
    episodeTitleExists: "Episode title exists",
    episodeAudioUrlExists: "Final audio URL exists",
    episodeDurationValid: "Audio duration exists",
    episodeTranscriptUrlExists: "Transcript URL exists",
    episodeLongShowNotesExists: "Show notes content exists",
    factCheckPassed: "Latest fact check has passed",
    allAudioSegmentsReady: "All audio segments are 'ready'",
    audioFileSizeResolved: "Audio file size is resolved (> 0)",
    audioMimeTypeValid: "Audio MIME type is valid",
    podcastConfigValid: "Required podcast settings exist",
    rssGuidValid: "Podcast RSS GUID is generated",
    noPlaceholderMetadata: "No placeholder text detected",
  };

  return (
    <div style={{ padding: "2rem" }}>
      {/* Navigation & Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <Link href="/admin/rss" style={{ color: "#38bdf8", textDecoration: "none", fontSize: "0.9rem", display: "inline-flex", alignItems: "center", gap: "0.25rem", marginBottom: "1rem" }}>
          &larr; Back to RSS Dashboard
        </Link>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 style={{ fontSize: "1.75rem", fontWeight: 800, color: "#ffffff", margin: 0 }}>
              Manage Episode RSS
            </h2>
            <p style={{ fontSize: "0.9rem", color: "#94a3b8", marginTop: "0.25rem", margin: 0 }}>
              {ep.title}
            </p>
          </div>
          <div>
            <button
              onClick={refreshStatus}
              disabled={isPending}
              className="btnReset"
              style={{ padding: "0.5rem 1rem", fontSize: "0.85rem", border: "1px solid #1a2233" }}
            >
              Refresh Status
            </button>
          </div>
        </div>
      </div>

      {/* Notifications */}
      {errorMsg && (
        <div style={{ padding: "1rem", backgroundColor: "rgba(239, 68, 68, 0.1)", border: "1px solid rgba(239, 68, 68, 0.3)", borderRadius: "6px", color: "#ef4444", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
          <strong>Error:</strong> {errorMsg}
        </div>
      )}
      {successMsg && (
        <div style={{ padding: "1rem", backgroundColor: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: "6px", color: "#10b981", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
          <strong>Success:</strong> {successMsg}
        </div>
      )}

      {/* Grid Layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1.8fr 1.2fr", gap: "2rem" }}>
        {/* Left Column: Metadata & Checklist */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* Metadata Card */}
          <div className="panel" style={{ padding: "1.5rem" }}>
            <h3 className="panelTitle" style={{ marginTop: 0 }}>Episode Assets &amp; Fields</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem" }}>
              <div>
                <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>Episode Status</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "#38bdf8", marginTop: "0.25rem" }}>
                  {ep.status.toUpperCase()}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>GUID</div>
                <div style={{ fontFamily: "monospace", fontSize: "0.9rem", color: ep.rssGuid ? "#ffffff" : "#64748b", marginTop: "0.25rem" }}>
                  {ep.rssGuid || "Not prepared yet"}
                </div>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>Audio URL</div>
                <div style={{ fontSize: "0.9rem", color: "#cbd5e1", marginTop: "0.25rem", wordBreak: "break-all" }}>
                  {ep.audioUrl || "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>File Size</div>
                <div style={{ fontSize: "0.9rem", color: "#cbd5e1", marginTop: "0.25rem" }}>
                  {ep.audioFileSizeBytes 
                    ? `${(ep.audioFileSizeBytes / (1024 * 1024)).toFixed(2)} MB (${ep.audioFileSizeBytes} bytes)`
                    : "Not resolved yet"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>MIME Type</div>
                <div style={{ fontSize: "0.9rem", color: "#cbd5e1", marginTop: "0.25rem" }}>
                  {ep.audioMimeType || "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>Season / Episode</div>
                <div style={{ fontSize: "0.9rem", color: "#cbd5e1", marginTop: "0.25rem" }}>
                  Season {ep.seasonNumber ?? "—"}, Episode {ep.episodeNumber ?? "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>Explicit Content</div>
                <div style={{ fontSize: "0.9rem", color: "#cbd5e1", marginTop: "0.25rem" }}>
                  {ep.explicit ? "YES (explicit)" : "NO (clean)"}
                </div>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <div style={{ fontSize: "0.75rem", color: "#64748b", textTransform: "uppercase" }}>RSS Summary</div>
                <div style={{ fontSize: "0.9rem", color: "#cbd5e1", marginTop: "0.25rem", fontStyle: "italic", whiteSpace: "pre-wrap" }}>
                  {ep.rssSummary || ep.description || "No custom summary configured. Fallback description will be resolved from show notes."}
                </div>
              </div>
            </div>
          </div>

          {/* Validation Checklist */}
          <div className="panel" style={{ padding: "1.5rem" }}>
            <h3 className="panelTitle" style={{ marginTop: 0 }}>Publication Gate Checklist</h3>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
              {Object.entries(eligibility.checks).map(([key, val]) => (
                <div
                  key={key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                    padding: "0.6rem 0.75rem",
                    backgroundColor: val ? "rgba(16, 185, 129, 0.04)" : "rgba(239, 68, 68, 0.04)",
                    border: val ? "1px solid rgba(16, 185, 129, 0.15)" : "1px solid rgba(239, 68, 68, 0.15)",
                    borderRadius: "4px",
                    fontSize: "0.8rem",
                    color: val ? "#10b981" : "#ef4444",
                  }}
                >
                  {val ? (
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                  )}
                  <span>{checkLabels[key] || key}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right Column: Controls & Log */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* Controls Panel */}
          <div className="panel" style={{ padding: "1.5rem" }}>
            <h3 className="panelTitle" style={{ marginTop: 0 }}>Publishing Controls</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
              {/* Prepare Section */}
              <div style={{ borderBottom: "1px solid #161f30", paddingBottom: "1.25rem" }}>
                <h4 style={{ margin: "0 0 0.5rem 0", color: "#ffffff", fontSize: "0.95rem" }}>1. Prepare Feed Metadata</h4>
                <p style={{ margin: "0 0 1rem 0", fontSize: "0.8rem", color: "#94a3b8", lineHeight: 1.4 }}>
                  Resolves target file size, locks stable RSS GUID, and sets status to publish ready.
                </p>
                <button
                  onClick={handlePrepare}
                  disabled={isPending || (ep.status !== "content_ready" && ep.status !== "publish_ready" && ep.status !== "published")}
                  className="buttonPrimary"
                  style={{ width: "100%", padding: "0.6rem" }}
                >
                  {isPending ? "Processing..." : "Prepare Episode"}
                </button>
              </div>

              {/* Publish Section */}
              <div style={{ borderBottom: "1px solid #161f30", paddingBottom: "1.25rem" }}>
                <h4 style={{ margin: "0 0 0.5rem 0", color: "#ffffff", fontSize: "0.95rem" }}>2. Go Live / Publish</h4>
                <p style={{ margin: "0 0 1rem 0", fontSize: "0.8rem", color: "#94a3b8", lineHeight: 1.4 }}>
                  Makes episode visible in the public RSS feed. Sets publication date.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "#cbd5e1", marginBottom: "0.75rem", cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={forceRepublish}
                    onChange={(e) => setForceRepublish(e.target.checked)}
                    style={{ cursor: "pointer" }}
                  />
                  <span>Force republish (overwrites published date)</span>
                </label>
                <button
                  onClick={handlePublish}
                  disabled={isPending || !eligibility.eligible || (ep.status !== "publish_ready" && ep.status !== "published")}
                  className="buttonPrimary"
                  style={{ width: "100%", padding: "0.6rem", backgroundColor: eligibility.eligible ? "#10b981" : "#1e293b", borderColor: eligibility.eligible ? "#10b981" : "#2d3748" }}
                >
                  {isPending ? "Processing..." : "Publish Episode"}
                </button>
                {!eligibility.eligible && (
                  <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.75rem", color: "#ef4444" }}>
                    * Gates are not fully passed. Check checklist on left.
                  </p>
                )}
              </div>

              {/* Unpublish Section */}
              <div>
                <h4 style={{ margin: "0 0 0.5rem 0", color: "#ffffff", fontSize: "0.95rem" }}>3. Take Down / Unpublish</h4>
                <p style={{ margin: "0 0 1rem 0", fontSize: "0.8rem", color: "#94a3b8", lineHeight: 1.4 }}>
                  Removes episode from the public RSS feed. Reverts status to publish ready.
                </p>
                <button
                  onClick={handleUnpublish}
                  disabled={isPending || ep.status !== "published"}
                  className="btnReset"
                  style={{ width: "100%", padding: "0.6rem", border: "1px solid rgba(239, 68, 68, 0.4)", color: "#ef4444", backgroundColor: "rgba(239, 68, 68, 0.05)" }}
                >
                  {isPending ? "Processing..." : "Unpublish Episode"}
                </button>
              </div>
            </div>
          </div>

          {/* Job Log Panel */}
          <div className="panel" style={{ padding: "1.5rem" }}>
            <h3 className="panelTitle" style={{ marginTop: 0 }}>Latest Job Status</h3>
            {latestJob ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", fontSize: "0.8rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Job Type:</span>
                  <span style={{ fontWeight: 600, color: "#ffffff" }}>{latestJob.jobType}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Status:</span>
                  <span
                    style={{
                      fontWeight: 600,
                      color:
                        latestJob.status === "completed" ? "#10b981" :
                        latestJob.status === "running" ? "#38bdf8" : "#ef4444",
                    }}
                  >
                    {latestJob.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#64748b" }}>Timestamp:</span>
                  <span>{new Date(latestJob.createdAt).toLocaleString()}</span>
                </div>
                {latestJob.error && (
                  <div style={{ marginTop: "0.5rem", padding: "0.5rem", backgroundColor: "rgba(239, 68, 68, 0.08)", border: "1px solid rgba(239, 68, 68, 0.2)", borderRadius: "4px", color: "#ef4444" }}>
                    <strong>Error details:</strong> {latestJob.error}
                  </div>
                )}
                {latestJob.output && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <div style={{ color: "#64748b", marginBottom: "0.25rem" }}>Logs:</div>
                    <pre style={{ margin: 0, padding: "0.5rem", backgroundColor: "#0c0f16", border: "1px solid #1a2233", borderRadius: "4px", fontSize: "0.75rem", overflowX: "auto", color: "#cbd5e1" }}>
                      {JSON.stringify(latestJob.output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: "0.8rem", color: "#64748b", fontStyle: "italic" }}>
                No publishing jobs recorded yet.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
