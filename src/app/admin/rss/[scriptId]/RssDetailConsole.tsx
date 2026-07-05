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
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Navigation & Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <Link href="/admin/rss" style={{ color: "var(--accent-color)", textDecoration: "none", fontSize: "0.9rem", display: "inline-flex", alignItems: "center", gap: "0.25rem", marginBottom: "1rem" }}>
          &larr; Back to RSS Dashboard
        </Link>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h2 className="pageTitle">
              Manage Episode RSS
            </h2>
            <p className="pageDesc">
              {ep.title}
            </p>
          </div>
          <div>
            <button
              onClick={refreshStatus}
              disabled={isPending}
              className="btnReset"
              style={{ padding: "0.5rem 1rem", fontSize: "0.85rem", border: "1px solid var(--border-color)" }}
            >
              Refresh Status
            </button>
          </div>
        </div>
      </div>

      {/* Notifications */}
      {errorMsg && (
        <div className="alertCard alertDanger" style={{ marginBottom: "1.5rem" }}>
          <strong>Error:</strong> {errorMsg}
        </div>
      )}
      {successMsg && (
        <div className="alertCard alertSuccess" style={{ marginBottom: "1.5rem" }}>
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
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>Episode Status</div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--accent-color)", marginTop: "0.25rem" }}>
                  {ep.status.toUpperCase()}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>GUID</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.9rem", color: ep.rssGuid ? "var(--text-primary)" : "var(--text-secondary)", marginTop: "0.25rem", fontWeight: ep.rssGuid ? 600 : 400 }}>
                  {ep.rssGuid || "Not prepared yet"}
                </div>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>Audio URL</div>
                <div style={{ fontSize: "0.9rem", color: "var(--text-primary)", marginTop: "0.25rem", wordBreak: "break-all" }}>
                  {ep.audioUrl || "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>File Size</div>
                <div style={{ fontSize: "0.9rem", color: "var(--text-primary)", marginTop: "0.25rem" }}>
                  {ep.audioFileSizeBytes 
                    ? `${(ep.audioFileSizeBytes / (1024 * 1024)).toFixed(2)} MB (${ep.audioFileSizeBytes} bytes)`
                    : "Not resolved yet"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>MIME Type</div>
                <div style={{ fontSize: "0.9rem", color: "var(--text-primary)", marginTop: "0.25rem" }}>
                  {ep.audioMimeType || "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>Season / Episode</div>
                <div style={{ fontSize: "0.9rem", color: "var(--text-primary)", marginTop: "0.25rem" }}>
                  Season {ep.seasonNumber ?? "—"}, Episode {ep.episodeNumber ?? "—"}
                </div>
              </div>
              <div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>Explicit Content</div>
                <div style={{ fontSize: "0.9rem", color: "var(--text-primary)", marginTop: "0.25rem" }}>
                  {ep.explicit ? "YES (explicit)" : "NO (clean)"}
                </div>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)", textTransform: "uppercase" }}>RSS Summary</div>
                <div style={{ fontSize: "0.9rem", color: "var(--text-primary)", marginTop: "0.25rem", fontStyle: "italic", whiteSpace: "pre-wrap" }}>
                  {ep.rssSummary || ep.description || "No custom summary configured. Fallback description will be resolved from show notes."}
                </div>
              </div>
            </div>
          </div>

          {/* Validation Checklist */}
          <div className="panel" style={{ padding: "1.5rem" }}>
            <h3 className="panelTitle" style={{ marginTop: 0 }}>Publication Gate Checklist</h3>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {Object.entries(eligibility.checks).map(([key, val]) => {
                const checkDetails: Record<string, { blocker: string; link?: string; actionText?: string }> = {
                  scriptExists: { blocker: "Script record missing.", link: "/admin/scripts" },
                  scriptApproved: { blocker: "Script must be approved.", link: `/admin/scripts/${script.id}` },
                  episodeExists: { blocker: "Episode is not linked.", link: "/admin/episodes" },
                  episodeStatusValid: { blocker: "Episode status is not content_ready or publish_ready.", link: `/admin/content-assets/${script.id}` },
                  episodeTitleExists: { blocker: "Title is missing in episode details.", link: `/admin/episodes/${ep.id}` },
                  episodeAudioUrlExists: { blocker: "Stitched final audio URL is missing.", link: `/admin/final-audio/${script.id}` },
                  episodeDurationValid: { blocker: "Audio duration seconds is missing or 0.", link: `/admin/final-audio/${script.id}` },
                  episodeTranscriptUrlExists: { blocker: "Transcript asset is not generated.", link: `/admin/content-assets/${script.id}` },
                  episodeLongShowNotesExists: { blocker: "Show notes asset is not generated.", link: `/admin/content-assets/${script.id}` },
                  factCheckPassed: { blocker: "Latest fact check result status is not 'passed'.", link: `/admin/fact-checks` },
                  allAudioSegmentsReady: { blocker: "Some speech segments are pending or failed.", link: `/admin/audio-segments/${script.id}` },
                  audioFileSizeResolved: { blocker: "Audio file size cannot be verified from storage.", link: `/admin/final-audio/${script.id}` },
                  audioMimeTypeValid: { blocker: "Audio MIME type is invalid or missing.", link: `/admin/episodes/${ep.id}` },
                  podcastConfigValid: { blocker: "Public RSS feed env config incomplete.", link: "/admin/configuration" },
                  rssGuidValid: { blocker: "RSS GUID not generated.", actionText: "Click 'Prepare Episode' below to resolve." },
                  noPlaceholderMetadata: { blocker: "Placeholder brackets detected in title/show notes.", link: `/admin/episodes/${ep.id}` },
                };

                const info = checkDetails[key];

                return (
                  <div
                    key={key}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      padding: "0.75rem 1rem",
                      backgroundColor: val ? "rgba(16, 185, 129, 0.04)" : "rgba(239, 68, 68, 0.04)",
                      border: val ? "1px solid var(--success-border)" : "1px solid var(--error-border)",
                      borderRadius: "6px",
                      fontSize: "0.85rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontWeight: "600", color: val ? "var(--success-color)" : "var(--error-color)" }}>
                      <span>{val ? "✓" : "✗"}</span>
                      <span>{checkLabels[key] || key}</span>
                    </div>
                    {!val && info && (
                      <div style={{ marginTop: "0.25rem", color: "var(--text-secondary)", fontSize: "0.8rem", paddingLeft: "1.25rem" }}>
                        <span style={{ color: "var(--error-color)" }}>Blocker:</span> {info.blocker}{" "}
                        {info.link && (
                          <Link href={info.link} style={{ color: "var(--accent-color)", textDecoration: "underline", fontWeight: "600" }}>
                            Fix on target page →
                          </Link>
                        )}
                        {info.actionText && (
                          <span style={{ color: "var(--text-secondary)", fontWeight: "600" }}>{info.actionText}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
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
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "1.25rem" }}>
                <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--text-primary)", fontSize: "0.95rem" }}>1. Prepare Feed Metadata</h4>
                <p style={{ margin: "0 0 1rem 0", fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
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
              <div style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "1.25rem" }}>
                <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--text-primary)", fontSize: "0.95rem" }}>2. Go Live / Publish</h4>
                <p style={{ margin: "0 0 1rem 0", fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
                  Makes episode visible in the public RSS feed. Sets publication date.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem", color: "var(--text-primary)", marginBottom: "0.75rem", cursor: "pointer" }}>
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
                  style={{ width: "100%", padding: "0.6rem" }}
                >
                  {isPending ? "Processing..." : "Publish Episode"}
                </button>
                {!eligibility.eligible && (
                  <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.75rem", color: "var(--error-color)" }}>
                    * Gates are not fully passed. Check checklist on left.
                  </p>
                )}
              </div>

              {/* Unpublish Section */}
              <div>
                <h4 style={{ margin: "0 0 0.5rem 0", color: "var(--text-primary)", fontSize: "0.95rem" }}>3. Take Down / Unpublish</h4>
                <p style={{ margin: "0 0 1rem 0", fontSize: "0.8rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
                  Removes episode from the public RSS feed. Reverts status to publish ready.
                </p>
                <button
                  onClick={handleUnpublish}
                  disabled={isPending || ep.status !== "published"}
                  className="btnReset"
                  style={{ width: "100%", padding: "0.6rem", border: "1px solid var(--error-border)", color: "var(--error-color)", backgroundColor: "transparent" }}
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
                  <span style={{ color: "var(--text-secondary)" }}>Job Type:</span>
                  <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{latestJob.jobType}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Status:</span>
                  <span
                    style={{
                      fontWeight: 700,
                      color:
                        latestJob.status === "completed" ? "var(--success-color)" :
                        latestJob.status === "running" ? "var(--accent-color)" : "var(--error-color)",
                    }}
                  >
                    {latestJob.status.toUpperCase()}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-secondary)" }}>Timestamp:</span>
                  <span style={{ color: "var(--text-primary)" }}>{new Date(latestJob.createdAt).toLocaleString()}</span>
                </div>
                {latestJob.error && (
                  <div className="alertCard alertDanger" style={{ marginTop: "0.5rem" }}>
                    <strong>Error details:</strong> {latestJob.error}
                  </div>
                )}
                {latestJob.output && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <div style={{ color: "var(--text-secondary)", marginBottom: "0.25rem" }}>Logs:</div>
                    <pre style={{ margin: 0, padding: "0.5rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "4px", fontSize: "0.75rem", overflowX: "auto", color: "var(--text-primary)" }}>
                      {JSON.stringify(latestJob.output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)", fontStyle: "italic" }}>
                No publishing jobs recorded yet.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
