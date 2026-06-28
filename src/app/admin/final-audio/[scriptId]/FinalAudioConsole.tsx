"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { triggerFinalAudioStitch, fetchLatestAudioStitchJob, fetchFinalAudioDetail } from "../actions";
import { triggerContentAssetGeneration } from "../../content-assets/actions";
import "../../scripts/scripts.css";

interface DetailInfo {
  scriptId: string;
  episodeId: string;
  episodeTitle: string;
  episodeStatus: string;
  version: number;
  status: string;
  latestFactCheckStatus: string;
  finalAudioUrl: string | null;
  durationSeconds: number | null;
  totalLines: number;
  eligibility: {
    eligible: boolean;
    reason?: string;
    details?: {
      missing: number;
      failed: number;
      duplicate: number;
      totalLines: number;
      ready: number;
    };
  };
  latestJob: any | null;
  transcriptUrl?: string | null;
  longShowNotes?: string | null;
}

interface ConsoleProps {
  initialDetail: DetailInfo;
}

export default function FinalAudioConsole({ initialDetail }: ConsoleProps) {
  const [detail, setDetail] = useState<DetailInfo>(initialDetail);
  const [loading, setLoading] = useState(false);
  const [includeIntro, setIncludeIntro] = useState(false);
  const [includeOutro, setIncludeOutro] = useState(false);
  const [normalizeAudio, setNormalizeAudio] = useState(true);
  const [targetLufs, setTargetLufs] = useState(-16);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Poll for job log updates while the latest job is "running"
  useEffect(() => {
    const isRunning = detail.latestJob?.status === "running";
    if (!isRunning) return;

    const interval = setInterval(async () => {
      const res = await fetchFinalAudioDetail(detail.scriptId);
      if (res.success && res.detail) {
        setDetail(res.detail);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [detail.latestJob, detail.scriptId]);

  const refreshStatus = async () => {
    setLoading(true);
    const res = await fetchFinalAudioDetail(detail.scriptId);
    if (res.success && res.detail) {
      setDetail(res.detail);
    }
    setLoading(false);
  };

  const handleStitch = async (force: boolean) => {
    setLoading(true);
    setMessage(null);
    const res = await triggerFinalAudioStitch(detail.scriptId, {
      forceRegenerate: force,
      includeIntro,
      includeOutro,
      normalizeAudio,
      targetLufs,
    });

    if (res.success) {
      setMessage({ type: "success", text: "Final audio stitching job enqueued successfully." });
      // Reload details immediately
      await refreshStatus();
    } else {
      setMessage({ type: "error", text: res.error || "Failed to trigger final audio stitching." });
    }
    setLoading(false);
  };

  const isEligible = detail.eligibility.eligible;
  const isJobRunning = detail.latestJob?.status === "running";
  const hasAudio = !!detail.finalAudioUrl;

  const missingCount = detail.eligibility.details?.missing || 0;
  const failedCount = detail.eligibility.details?.failed || 0;
  const duplicateCount = detail.eligibility.details?.duplicate || 0;
  const readyCount = detail.eligibility.details?.ready || 0;

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Top Nav */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
          <Link href="/admin/final-audio" className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            ← Back to Dashboard
          </Link>
          <Link href={`/admin/episodes/${detail.episodeId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto Episode Details
          </Link>
          <Link href={`/admin/audio-segments/${detail.scriptId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto TTS Console
          </Link>
        </div>
      </div>

      {/* Header */}
      <div className="scriptsHeader">
        <div>
          <h2 style={{ fontSize: "1.5rem", color: "#ffffff", margin: 0 }}>
            Final Audio Stitching Console: Version {detail.version}
          </h2>
          <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Episode: <strong style={{ color: "#ffffff" }}>{detail.episodeTitle}</strong>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: "0.75rem", color: "#64748b", display: "block" }}>Stitching Gate</span>
            <span
              className={`badge ${isEligible ? "badgeCompleted" : "badgeFailed"}`}
              style={{ display: "inline-block", marginTop: "0.25rem" }}
            >
              {isEligible ? "Open" : "Locked"}
            </span>
          </div>
        </div>
      </div>

      {/* Warnings & Messages */}
      {message && (
        <div className={`messageBox ${message.type === "success" ? "successBox" : "errorBox"}`} style={{ marginTop: "1rem" }}>
          {message.text}
        </div>
      )}

      {!isEligible && detail.eligibility.reason && (
        <div className="messageBox errorBox" style={{ marginTop: "1rem" }}>
          <strong>Stitching Blocked:</strong> {detail.eligibility.reason}
        </div>
      )}

      {/* Grid Layout */}
      <div className="scriptReviewLayout" style={{ marginTop: "1.5rem" }}>
        {/* Left Side: Eligibility Checklist and Job log details */}
        <div>
          {/* Checklist */}
          <div className="editorPanel" style={{ padding: "1.25rem" }}>
            <div className="panelTitle">Eligibility Checklist</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "0.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", color: "#cbd5e1" }}>
                <span>1. Approved Script Version:</span>
                <span className={`badge ${detail.status === "approved" ? "badgeCompleted" : "badgeFailed"}`}>
                  {detail.status}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", color: "#cbd5e1" }}>
                <span>2. Episode Status:</span>
                <span className={`badge ${detail.episodeStatus === "audio_segments_ready" || detail.episodeStatus === "audio_ready" || detail.episodeStatus === "audio_stitching" ? "badgeCompleted" : "badgeFailed"}`}>
                  {detail.episodeStatus}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", color: "#cbd5e1" }}>
                <span>3. Fact Check:</span>
                <span className={`badge ${detail.latestFactCheckStatus === "passed" ? "badgeCompleted" : "badgeFailed"}`}>
                  {detail.latestFactCheckStatus}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.9rem", color: "#cbd5e1" }}>
                <span>4. Audio Segments Count:</span>
                <span className={`badge ${readyCount === detail.totalLines && detail.totalLines > 0 ? "badgeCompleted" : "badgeFailed"}`}>
                  {readyCount} / {detail.totalLines} Ready
                </span>
              </div>
            </div>
          </div>

          {/* Stitched Audio Player */}
          {hasAudio && (
            <div className="editorPanel" style={{ padding: "1.25rem", marginTop: "1.5rem" }}>
              <div className="panelTitle">Final Episode Audio</div>
              <div style={{ marginTop: "0.75rem" }}>
                <audio src={detail.finalAudioUrl!} controls style={{ width: "100%", marginBottom: "0.75rem" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", color: "#cbd5e1" }}>
                  <span>Duration:</span>
                  <strong>{detail.durationSeconds ? `${Math.floor(detail.durationSeconds / 60)}m ${detail.durationSeconds % 60}s` : "--"}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem", color: "#cbd5e1", marginTop: "0.5rem" }}>
                  <span>Storage URL:</span>
                  <a href={detail.finalAudioUrl!} target="_blank" style={{ color: "#38bdf8", textDecoration: "underline", wordBreak: "break-all" }}>
                    Download MP3
                  </a>
                </div>
              </div>
            </div>
          )}

          {/* Latest Job Log */}
          {detail.latestJob && (
            <div className="editorPanel" style={{ padding: "1.25rem", marginTop: "1.5rem" }}>
              <div className="panelTitle" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Latest Stitching Job Log</span>
                <span className={`badge ${
                  detail.latestJob.status === "completed"
                    ? "badgeCompleted"
                    : detail.latestJob.status === "failed"
                    ? "badgeFailed"
                    : "badgePending"
                }`}>
                  {detail.latestJob.status}
                </span>
              </div>
              <div style={{ marginTop: "0.75rem", fontSize: "0.85rem", color: "#cbd5e1", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Job ID:</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>{detail.latestJob.id}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Started:</span>
                  <span>{new Date(detail.latestJob.createdAt).toLocaleString()}</span>
                </div>
                {detail.latestJob.error && (
                  <div style={{ color: "#ef4444", border: "1px solid #ef4444", backgroundColor: "rgba(239, 68, 68, 0.1)", padding: "0.5rem", borderRadius: "4px", marginTop: "0.5rem" }}>
                    <strong>Error:</strong> {detail.latestJob.error}
                  </div>
                )}
                {detail.latestJob.output && (
                  <div style={{ borderTop: "1px solid #161f30", paddingTop: "0.5rem", marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Input Duration:</span>
                      <span>{(detail.latestJob.output.totalInputDurationMs / 1000).toFixed(1)}s</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Final Audio Size:</span>
                      <span>{(detail.latestJob.output.finalFileSizeBytes / (1024 * 1024)).toFixed(2)} MB</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>FFmpeg Command:</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "#94a3b8" }}>{detail.latestJob.output.ffmpegCommandSummary}</span>
                    </div>
                    {detail.latestJob.output.reasons && (
                      <div style={{ marginTop: "0.5rem", color: "#94a3b8", fontSize: "0.8rem" }}>
                        <strong>Outcome:</strong>
                        <ul style={{ margin: 0, paddingLeft: "1.25rem", marginTop: "0.25rem" }}>
                          {detail.latestJob.output.reasons.map((r: string, idx: number) => (
                            <li key={idx}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right Side: Options & Run Controls */}
        <div className="sideControls">
          <div className="controlsPanel">
            <div className="panelTitle">Stitching Options</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "0.5rem" }}>
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#cbd5e1", fontSize: "0.9rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={includeIntro}
                  onChange={(e) => setIncludeIntro(e.target.checked)}
                />
                Include Intro Clip
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#cbd5e1", fontSize: "0.9rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={includeOutro}
                  onChange={(e) => setIncludeOutro(e.target.checked)}
                />
                Include Outro Clip
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#cbd5e1", fontSize: "0.9rem", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={normalizeAudio}
                  onChange={(e) => setNormalizeAudio(e.target.checked)}
                />
                Normalize Loudness
              </label>
              {normalizeAudio && (
                <div className="formGroup" style={{ marginBottom: 0 }}>
                  <label className="label">Target LUFS</label>
                  <input
                    type="number"
                    value={targetLufs}
                    onChange={(e) => setTargetLufs(Number(e.target.value))}
                    className="input"
                    min={-24}
                    max={-10}
                  />
                </div>
              )}
            </div>
          </div>

          {/* Action Trigger Buttons */}
          {isEligible && (
            <div className="controlsPanel">
              <div className="panelTitle">Actions</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", marginTop: "0.5rem" }}>
                <button
                  onClick={() => handleStitch(false)}
                  disabled={loading || isJobRunning}
                  className="buttonPrimary"
                  style={{ width: "100%" }}
                >
                  {isJobRunning ? "Stitching..." : "Stitch Final Audio"}
                </button>
                {hasAudio && (
                  <button
                    onClick={() => handleStitch(true)}
                    disabled={loading || isJobRunning}
                    className="editButton"
                    style={{ width: "100%" }}
                  >
                    Force Restitch
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Content Assets Panel */}
          <div className="controlsPanel">
            <div className="panelTitle">Content Assets</div>
            <div style={{ fontSize: "0.85rem", color: "#cbd5e1", display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "0.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Transcript:</span>
                <span className={`badge ${detail.transcriptUrl ? "badgeCompleted" : "badgePending"}`} style={{ fontSize: "0.75rem" }}>
                  {detail.transcriptUrl ? "Ready" : "Pending"}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Show Notes:</span>
                <span className={`badge ${detail.longShowNotes ? "badgeCompleted" : "badgePending"}`} style={{ fontSize: "0.75rem" }}>
                  {detail.longShowNotes ? "Ready" : "Pending"}
                </span>
              </div>
              {hasAudio ? (
                <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <button
                    onClick={async () => {
                      setLoading(true);
                      setMessage(null);
                      const res = await triggerContentAssetGeneration(detail.scriptId, { forceRegenerate: true });
                      if (res.success) {
                        setMessage({ type: "success", text: "Content asset generation enqueued successfully." });
                        const fresh = await fetchFinalAudioDetail(detail.scriptId);
                        if (fresh.success && fresh.detail) {
                          setDetail(fresh.detail as any);
                        }
                      } else {
                        setMessage({ type: "error", text: res.error || "Failed to trigger content asset generation." });
                      }
                      setLoading(false);
                    }}
                    disabled={loading}
                    className="buttonPrimary"
                    style={{ width: "100%" }}
                  >
                    Generate Content Assets
                  </button>
                  <Link
                    href={`/admin/content-assets/${detail.scriptId}`}
                    className="editButton"
                    style={{ display: "block", textAlign: "center", textDecoration: "none", fontSize: "0.8rem", padding: "0.4rem" }}
                  >
                    View Content Assets Detail
                  </Link>
                </div>
              ) : (
                <div style={{ color: "#64748b", fontSize: "0.85rem", fontStyle: "italic", marginTop: "0.5rem" }}>
                  Content generation is available once final audio is ready.
                </div>
              )}
            </div>
          </div>

          {/* Segment Details counts */}
          <div className="controlsPanel">
            <div className="panelTitle">Segment Checklist details</div>
            <div style={{ fontSize: "0.85rem", color: "#cbd5e1", display: "flex", flexDirection: "column", gap: "0.4rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Ready Segments:</span>
                <strong style={{ color: "#10b981" }}>{readyCount}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Missing:</span>
                <strong style={{ color: missingCount > 0 ? "#ef4444" : "#cbd5e1" }}>{missingCount}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Failed:</span>
                <strong style={{ color: failedCount > 0 ? "#ef4444" : "#cbd5e1" }}>{failedCount}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Duplicates:</span>
                <strong style={{ color: duplicateCount > 0 ? "#ef4444" : "#cbd5e1" }}>{duplicateCount}</strong>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
