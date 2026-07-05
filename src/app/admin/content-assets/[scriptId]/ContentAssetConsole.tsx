"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { triggerContentAssetGeneration, fetchContentAssetDetail, fetchContentAssetEligibility } from "../actions";

interface ConsoleProps {
  initialDetail: any;
  initialEligibility: any;
}

export default function ContentAssetConsole({ initialDetail, initialEligibility }: ConsoleProps) {
  const [detail, setDetail] = useState(initialDetail);
  const [eligibility, setEligibility] = useState(initialEligibility);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const scriptId = detail.scriptId;
  const isJobRunning = detail.latestJob?.status === "running";
  const hasAudio = !!detail.audioUrl;
  const isContentReady = detail.episodeStatus === "content_ready";
  const isGenerating = detail.episodeStatus === "content_generating" || isJobRunning;

  // Poll job status if running
  useEffect(() => {
    if (!isGenerating) return;

    const interval = setInterval(async () => {
      const detailRes = await fetchContentAssetDetail(scriptId);
      if (detailRes.success && detailRes.detail) {
        setDetail(detailRes.detail);
      }
      const elRes = await fetchContentAssetEligibility(scriptId);
      if (elRes.success) {
        setEligibility(elRes);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [isGenerating, scriptId]);

  const refreshStatus = async () => {
    setLoading(true);
    const detailRes = await fetchContentAssetDetail(scriptId);
    if (detailRes.success && detailRes.detail) {
      setDetail(detailRes.detail);
    }
    const elRes = await fetchContentAssetEligibility(scriptId);
    if (elRes.success) {
      setEligibility(elRes);
    }
    setLoading(false);
  };

  const handleGenerate = async (force: boolean) => {
    setLoading(true);
    setMessage(null);
    const res = await triggerContentAssetGeneration(scriptId, {
      forceRegenerate: force,
    });

    if (res.success) {
      setMessage({
        type: "success",
        text: force
          ? "Force regeneration triggered successfully! Enqueued job in background."
          : "Content asset generation triggered successfully! Enqueued job in background.",
      });
      await refreshStatus();
    } else {
      setMessage({ type: "error", text: res.error || "Failed to trigger content asset generation." });
    }
    setLoading(false);
  };

  // Eligibility checklist labels
  const checklistLabels: Record<string, string> = {
    scriptExists: "Script exists in database",
    scriptApproved: "Script status is approved",
    scriptContentValid: "Script content is valid structured JSON",
    scriptPlainTextNotEmpty: "Script plainText transcript exists and is not empty",
    episodeExists: "Linked Episode exists",
    episodeAudioReady: "Episode status is audio_ready (or content_ready for regeneration)",
    episodeAudioUrlExists: "Episode final audioUrl exists",
    episodeDurationValid: "Episode durationSeconds exists or can be estimated",
    factCheckExists: "Fact check result exists for this script",
    factCheckPassed: "Fact check result status is passed",
    allDialogueLinesHaveAudioSegment: "Every dialogue line has a matching AudioSegment record",
    allAudioSegmentsReady: "Every matching AudioSegment is ready",
    allAudioSegmentsHaveUrl: "Every matching AudioSegment has an audio URL",
    noNeedsHumanReview: "No dialogue lines require human review",
    activeHostsExist: "Active host profiles exist for Max Voltage & Dr. Linebreak",
    speakerNamesValid: "Every line speaker is either Max Voltage or Dr. Linebreak",
    speakerHostIdsValid: "Every line speakerHostId matches correct active host profile",
    allTopicsHaveTopicCandidate: "Every linked topic has a TopicCandidate record",
    allTopicCandidatesHaveResearchBrief: "Every TopicCandidate has a ResearchBrief",
    allResearchBriefsValid: "Every ResearchBrief has non-empty facts and sourceIds",
  };

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Top navigation */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
          <Link href="/admin/content-assets" className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            ← Back to Dashboard
          </Link>
          <Link href={`/admin/episodes/${detail.episodeId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto Episode details
          </Link>
          <Link href={`/admin/scripts/${scriptId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto Script review
          </Link>
          <Link href={`/admin/rss/${scriptId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none", color: "var(--success-color)", border: "1px solid var(--success-border)" }}>
            Goto RSS publishing
          </Link>
        </div>
        <button onClick={refreshStatus} disabled={loading} className="btnReset" style={{ fontSize: "0.85rem" }}>
          {loading ? "Refreshing..." : "🔄 Refresh Status"}
        </button>
      </div>

      {/* Title block */}
      <div className="scriptsHeader" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h2 className="pageTitle">{detail.episodeTitle}</h2>
          <p className="pageDesc">
            Episode status: <strong style={{ color: "var(--text-primary)" }}>{detail.episodeStatus}</strong> | Script Version: v{detail.scriptVersion} (Status: {detail.scriptStatus})
          </p>
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          {isContentReady ? (
            <button
              onClick={() => handleGenerate(true)}
              disabled={loading || isGenerating || !eligibility?.eligible}
              className="editButton"
              style={{ padding: "0.5rem 1rem" }}
            >
              {isGenerating ? "Regenerating..." : "Force Regenerate"}
            </button>
          ) : (
            <button
              onClick={() => handleGenerate(false)}
              disabled={loading || isGenerating || !eligibility?.eligible}
              className="buttonPrimary"
              style={{ padding: "0.5rem 1rem" }}
            >
              {isGenerating ? "Generating..." : "Generate Transcript + Show Notes"}
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      {message && (
        <div className={`alertCard ${message.type === "success" ? "alertSuccess" : "alertDanger"}`} style={{ marginBottom: "1.5rem" }}>
          {message.text}
        </div>
      )}

      {/* Grid container */}
      <div className="scriptsGrid" style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: "1.5rem" }}>
        {/* Left Column: Asset URLs, Chapters, Previews */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          
          {/* Audio Player */}
          {hasAudio && (
            <div className="panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.75rem 0", color: "var(--text-primary)" }}>Final Episode Audio</h3>
              <audio src={detail.audioUrl} controls style={{ width: "100%" }} />
              {detail.durationSeconds && (
                <p style={{ margin: "0.5rem 0 0 0", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                  Calculated Duration: {Math.floor(detail.durationSeconds / 60)}m {detail.durationSeconds % 60}s ({detail.durationSeconds} seconds)
                </p>
              )}
            </div>
          )}

          {/* Generated URLs */}
          {isContentReady && (
            <div className="panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.75rem 0", color: "var(--text-primary)" }}>Generated Storage Assets</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-primary)" }}>Transcript Markdown:</span>
                  <a href={detail.transcriptUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)", textDecoration: "underline" }}>
                    {detail.transcriptUrl ? "View file" : "Not Set"}
                  </a>
                </div>
                {detail.metadataJson?.assets && (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--text-primary)" }}>Transcript JSON:</span>
                      <a href={detail.metadataJson.assets.transcriptJsonUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)", textDecoration: "underline" }}>
                        View file
                      </a>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--text-primary)" }}>Show Notes Markdown:</span>
                      <a href={detail.metadataJson.assets.showNotesMarkdownUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)", textDecoration: "underline" }}>
                        View file
                      </a>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--text-primary)" }}>Metadata JSON:</span>
                      <a href={detail.metadataJson.assets.metadataJsonUrl} target="_blank" rel="noreferrer" style={{ color: "var(--accent-color)", textDecoration: "underline" }}>
                        View file
                      </a>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Transcript Preview */}
          <div className="panel" style={{ padding: "1.25rem" }}>
            <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.75rem 0", color: "var(--text-primary)" }}>Transcript Preview</h3>
            {detail.transcriptMarkdown ? (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "0.8rem",
                  color: "var(--text-primary)",
                  backgroundColor: "var(--bg-secondary)",
                  border: "1px solid var(--border-color)",
                  padding: "0.75rem",
                  maxHeight: "350px",
                  overflowY: "auto",
                  lineHeight: 1.5,
                }}
              >
                {detail.transcriptMarkdown}
              </pre>
            ) : (
              <p style={{ color: "var(--text-secondary)", margin: 0, fontStyle: "italic" }}>
                No transcript generated yet. Complete the eligibility checklist and trigger asset generation.
              </p>
            )}
          </div>

          {/* Show Notes Preview */}
          <div className="panel" style={{ padding: "1.25rem" }}>
            <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.75rem 0", color: "var(--text-primary)" }}>Show Notes Preview</h3>
            {detail.showNotesMarkdown ? (
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "0.8rem",
                  color: "var(--text-primary)",
                  backgroundColor: "var(--bg-secondary)",
                  border: "1px solid var(--border-color)",
                  padding: "0.75rem",
                  maxHeight: "350px",
                  overflowY: "auto",
                  lineHeight: 1.5,
                }}
              >
                {detail.showNotesMarkdown}
              </pre>
            ) : (
              <p style={{ color: "var(--text-secondary)", margin: 0, fontStyle: "italic" }}>
                No show notes generated yet.
              </p>
            )}
          </div>

          {/* Chapters List */}
          {detail.metadataJson?.chapters && (
            <div className="panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.75rem 0", color: "var(--text-primary)" }}>Chapter Timeline</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {detail.metadataJson.chapters.map((ch: any, idx: number) => {
                  const formatTime = (sec: number) => {
                    const m = Math.floor(sec / 60);
                    const s = Math.floor(sec % 60);
                    return `${m}:${s.toString().padStart(2, '0')}`;
                  };
                  return (
                    <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.25rem" }}>
                      <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{ch.title}</span>
                      <span style={{ color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                        {formatTime(ch.startTimeSeconds)} — {formatTime(ch.endTimeSeconds)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Metadata JSON Preview */}
          {detail.metadataJson && (
            <div className="panel" style={{ padding: "1.25rem" }}>
              <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.75rem 0", color: "var(--text-primary)" }}>Metadata JSON</h3>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  fontFamily: "var(--font-mono), monospace",
                  fontSize: "0.75rem",
                  color: "var(--accent-color)",
                  backgroundColor: "var(--bg-secondary)",
                  border: "1px solid var(--border-color)",
                  padding: "0.75rem",
                  maxHeight: "300px",
                  overflowY: "auto",
                }}
              >
                {JSON.stringify(detail.metadataJson, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Right Column: Checklist & Job Log */}
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          
          {/* Eligibility Checklist */}
          <div className="panel" style={{ padding: "1.25rem" }}>
            <h3 style={{ fontSize: "1.1rem", margin: "0 0 1rem 0", color: "var(--text-primary)", display: "flex", justifyContent: "space-between" }}>
              <span>Eligibility Checklist</span>
              <span className={`badge ${eligibility?.eligible ? "badgeCompleted" : "badgeFailed"}`} style={{ fontSize: "0.75rem" }}>
                {eligibility?.eligible ? "Eligible" : "Ineligible"}
              </span>
            </h3>

            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
              {eligibility?.checks &&
                Object.keys(checklistLabels).map((key) => {
                  const passes = eligibility.checks[key] === true;
                  return (
                    <div
                      key={key}
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "0.5rem",
                        fontSize: "0.8rem",
                        color: passes ? "var(--text-primary)" : "var(--text-secondary)",
                      }}
                    >
                      <span style={{ color: passes ? "var(--success-color)" : "var(--error-color)", fontSize: "1rem", lineHeight: 1 }}>
                        {passes ? "✓" : "✗"}
                      </span>
                      <span>{checklistLabels[key] || key}</span>
                    </div>
                  );
                })}
            </div>

            {eligibility?.errorReasons && eligibility.errorReasons.length > 0 && (
              <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--border-color)" }}>
                <h4 style={{ fontSize: "0.85rem", color: "var(--error-color)", margin: "0 0 0.5rem 0" }}>Blockers:</h4>
                <ul style={{ margin: 0, paddingLeft: "1rem", fontSize: "0.75rem", color: "var(--error-color)" }}>
                  {eligibility.errorReasons.map((r: string, idx: number) => (
                    <li key={idx} style={{ marginBottom: "0.25rem" }}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Job Log Info */}
          <div className="panel" style={{ padding: "1.25rem" }}>
            <h3 style={{ fontSize: "1.1rem", margin: "0 0 0.75rem 0", color: "var(--text-primary)" }}>Latest Job Log</h3>
            {detail.latestJob ? (
              <div style={{ fontSize: "0.8rem", display: "flex", flexDirection: "column", gap: "0.5rem", color: "var(--text-primary)" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Job ID:</span>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{detail.latestJob.id}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Status:</span>
                  <span className={`badge ${
                    detail.latestJob.status === "completed"
                      ? "badgeCompleted"
                      : detail.latestJob.status === "failed"
                      ? "badgeFailed"
                      : detail.latestJob.status === "skipped"
                      ? "badgeFailed"
                      : "badgePending"
                  }`} style={{ fontSize: "0.75rem" }}>
                    {detail.latestJob.status}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Created At:</span>
                  <span>{new Date(detail.latestJob.createdAt).toLocaleString()}</span>
                </div>
                {detail.latestJob.error && (
                  <div className="alertCard alertDanger" style={{ marginTop: "0.5rem" }}>
                    <strong>Error:</strong> {detail.latestJob.error}
                  </div>
                )}
                {detail.latestJob.output && (
                  <div style={{ marginTop: "0.5rem" }}>
                    <span style={{ display: "block", marginBottom: "0.25rem", fontWeight: 600 }}>Job Output Details:</span>
                    <pre style={{ margin: 0, padding: "0.5rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", color: "var(--text-secondary)", fontSize: "0.75rem", overflowX: "auto" }}>
                      {JSON.stringify(detail.latestJob.output, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <p style={{ color: "var(--text-secondary)", margin: 0, fontStyle: "italic" }}>
                No generation jobs executed yet.
              </p>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
