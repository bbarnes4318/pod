"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  triggerTtsGeneration,
  triggerTtsRange,
  triggerTtsForHost,
  retryTtsSegment,
  fetchTtsSegments,
} from "../actions";
import "../../scripts/scripts.css";

interface ScriptInfo {
  id: string;
  episodeId: string;
  episodeTitle: string;
  episodeStatus: string;
  version: number;
  status: string;
  latestFactCheckStatus: string;
  totalLines: number;
  provider: string;
  lines: any[];
}

interface ConsoleProps {
  script: ScriptInfo;
  initialSegments: any[];
  eligible: boolean;
  eligibilityReason?: string;
  hostAId: string;
  hostBId: string;
}

export default function AudioSegmentsConsole({
  script,
  initialSegments,
  eligible,
  eligibilityReason,
  hostAId,
  hostBId,
}: ConsoleProps) {
  const [segments, setSegments] = useState<any[]>(initialSegments);
  const [loading, setLoading] = useState(false);
  const [rangeStart, setRangeStart] = useState<number>(0);
  const [rangeEnd, setRangeEnd] = useState<number>(Math.max(0, script.totalLines - 1));
  const [selectedHostId, setSelectedHostId] = useState<string>("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Poll segments status while there are pending or processing items
  useEffect(() => {
    const hasActive = segments.some((s) => s.status === "pending" || s.status === "processing");
    if (!hasActive) return;

    const interval = setInterval(async () => {
      const res = await fetchTtsSegments(script.id);
      if (res.success && res.segments) {
        setSegments(res.segments);
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [segments, script.id]);

  const refreshSegments = async () => {
    setLoading(true);
    const res = await fetchTtsSegments(script.id);
    if (res.success && res.segments) {
      setSegments(res.segments);
    }
    setLoading(false);
  };

  const handleFullTts = async (force: boolean) => {
    setLoading(true);
    setMessage(null);
    const res = await triggerTtsGeneration(script.id, force);
    if (res.success) {
      setMessage({ type: "success", text: "TTS generation enqueued successfully." });
      await refreshSegments();
    } else {
      setMessage({ type: "error", text: res.error || "Failed to trigger TTS generation." });
    }
    setLoading(false);
  };

  const handleRangeTts = async () => {
    setLoading(true);
    setMessage(null);
    const res = await triggerTtsRange(script.id, rangeStart, rangeEnd);
    if (res.success) {
      setMessage({ type: "success", text: `TTS range (${rangeStart} to ${rangeEnd}) generation enqueued.` });
      await refreshSegments();
    } else {
      setMessage({ type: "error", text: res.error || "Failed to trigger range TTS." });
    }
    setLoading(false);
  };

  const handleHostTts = async () => {
    if (!selectedHostId) return;
    setLoading(true);
    setMessage(null);
    const res = await triggerTtsForHost(script.id, selectedHostId);
    if (res.success) {
      setMessage({ type: "success", text: "TTS host-specific generation enqueued." });
      await refreshSegments();
    } else {
      setMessage({ type: "error", text: res.error || "Failed to trigger host TTS." });
    }
    setLoading(false);
  };

  const handleLineAction = async (lineIndex: number) => {
    setLoading(true);
    setMessage(null);
    const res = await retryTtsSegment(script.id, lineIndex);
    if (res.success) {
      setMessage({ type: "success", text: `TTS generation enqueued for line #${lineIndex + 1}.` });
      await refreshSegments();
    } else {
      setMessage({ type: "error", text: res.error || "Failed to queue segment generation." });
    }
    setLoading(false);
  };

  const readyCount = segments.filter((s) => s.status === "ready").length;
  const failedCount = segments.filter((s) => s.status === "failed").length;
  const pendingCount = segments.filter((s) => s.status === "pending").length;
  const processingCount = segments.filter((s) => s.status === "processing").length;

  return (
    <div className="formContainer" style={{ maxWidth: "100%" }}>
      {/* Top Nav */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", gap: "1rem" }}>
          <Link href="/admin/audio-segments" className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            ← Back to TTS Dashboard
          </Link>
          <Link href={`/admin/episodes/${script.episodeId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto Episode details
          </Link>
          <Link href={`/admin/scripts/${script.id}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto Script Console
          </Link>
        </div>
      </div>

      {/* Header */}
      <div className="scriptsHeader">
        <div>
          <h2 style={{ fontSize: "1.5rem", color: "#ffffff", margin: 0 }}>
            Audio Segment Console: Version {script.version}
          </h2>
          <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Episode: <strong style={{ color: "#ffffff" }}>{script.episodeTitle}</strong>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: "0.75rem", color: "#64748b", display: "block" }}>Eligibility</span>
            <span
              className={`badge ${eligible ? "badgeCompleted" : "badgeFailed"}`}
              style={{ display: "inline-block", marginTop: "0.25rem" }}
            >
              {eligible ? "Eligible" : "Blocked"}
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

      {!eligible && eligibilityReason && (
        <div className="messageBox errorBox" style={{ marginTop: "1rem" }}>
          <strong>TTS Generation Blocked:</strong> {eligibilityReason}
        </div>
      )}

      {/* Layout Split */}
      <div className="scriptReviewLayout" style={{ marginTop: "1.5rem" }}>
        {/* Left: Per line segments table */}
        <div>
          <div className="editorPanel">
            <div className="panelTitle" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Dialogue Lines Speech Progress</span>
              <button
                onClick={refreshSegments}
                disabled={loading}
                className="editButton"
                style={{ fontSize: "0.75rem", padding: "0.25rem 0.5rem" }}
              >
                Sync Status
              </button>
            </div>

            <div className="tableContainer" style={{ border: "none", marginTop: "0.5rem" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: "60px" }}>Line</th>
                    <th style={{ width: "120px" }}>Speaker</th>
                    <th>Dialogue Text Preview</th>
                    <th style={{ width: "80px" }}>Tone</th>
                    <th style={{ width: "100px" }}>Status</th>
                    <th style={{ width: "80px" }}>Duration</th>
                    <th style={{ width: "150px" }}>Audio</th>
                    <th style={{ width: "100px" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {script.lines.map((line, idx) => {
                    const seg = segments.find((s) => s.lineIndex === line.lineIndex);
                    const statusVal = seg ? seg.status : "missing";

                    const isReady = statusVal === "ready";
                    const isFailed = statusVal === "failed";
                    const isProcessing = statusVal === "processing";
                    const isPending = statusVal === "pending";

                    return (
                      <tr key={idx}>
                        <td style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
                          #{line.lineIndex + 1}
                        </td>
                        <td>
                          <span style={{ fontWeight: 600, color: line.speakerName === "Max Voltage" ? "#f43f5e" : "#38bdf8" }}>
                            {line.speakerName}
                          </span>
                        </td>
                        <td style={{ fontSize: "0.85rem", color: "#cbd5e1" }}>
                          {line.text}
                        </td>
                        <td style={{ fontSize: "0.75rem", color: "#94a3b8", fontStyle: "italic" }}>
                          {line.tone}
                        </td>
                        <td>
                          <span className={`badge ${
                            isReady
                              ? "badgeCompleted"
                              : isFailed
                              ? "badgeFailed"
                              : isProcessing || isPending
                              ? "badgePending"
                              : "refBadge"
                          }`} style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem" }}>
                            {statusVal}
                          </span>
                        </td>
                        <td style={{ fontSize: "0.8rem", color: "#cbd5e1", textAlign: "center" }}>
                          {seg?.durationMs ? `${(seg.durationMs / 1000).toFixed(1)}s` : "--"}
                        </td>
                        <td>
                          {isReady && seg?.audioUrl ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                              <audio src={seg.audioUrl} controls style={{ width: "140px", height: "24px" }} />
                              <a
                                href={seg.audioUrl}
                                download={`segment-${line.lineIndex}.mp3`}
                                style={{ fontSize: "0.7rem", color: "#38bdf8", textDecoration: "underline" }}
                              >
                                Download MP3
                              </a>
                            </div>
                          ) : (
                            <span style={{ fontSize: "0.75rem", color: "#64748b", fontStyle: "italic" }}>No audio</span>
                          )}
                        </td>
                        <td>
                          {eligible && (
                            <button
                              onClick={() => handleLineAction(line.lineIndex)}
                              disabled={loading || isProcessing}
                              className="editButton"
                              style={{ fontSize: "0.75rem", padding: "0.2rem 0.4rem" }}
                            >
                              {isReady ? "Regen" : isFailed ? "Retry" : "Generate"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right: Controls Panel */}
        <div className="sideControls">
          {/* Status Overview Card */}
          <div className="controlsPanel">
            <div className="panelTitle">Progress Summary</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem", color: "#cbd5e1" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Total Dialogue Lines:</span>
                <strong>{script.totalLines}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Ready Segments:</span>
                <strong style={{ color: readyCount === script.totalLines ? "#10b981" : "#ffffff" }}>
                  {readyCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Failed Segments:</span>
                <strong style={{ color: failedCount > 0 ? "#ef4444" : "#ffffff" }}>
                  {failedCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Processing/Pending:</span>
                <strong style={{ color: processingCount + pendingCount > 0 ? "#f59e0b" : "#ffffff" }}>
                  {processingCount + pendingCount}
                </strong>
              </div>
            </div>
          </div>

          {/* Action Triggers Console */}
          {eligible && (
            <>
              {/* Full Generation */}
              <div className="controlsPanel">
                <div className="panelTitle">Full TTS Assembly</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <button
                    onClick={() => handleFullTts(false)}
                    disabled={loading}
                    className="buttonPrimary"
                    style={{ width: "100%" }}
                  >
                    Synthesize Speech (New Only)
                  </button>
                  <button
                    onClick={() => handleFullTts(true)}
                    disabled={loading}
                    className="editButton"
                    style={{ width: "100%" }}
                  >
                    Force Regenerate All Lines
                  </button>
                </div>
              </div>

              {/* Host Specific */}
              <div className="controlsPanel">
                <div className="panelTitle">Host Speech Triggers</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <select
                    value={selectedHostId}
                    onChange={(e) => setSelectedHostId(e.target.value)}
                    className="select"
                  >
                    <option value="">Choose Host...</option>
                    <option value={hostAId}>Max Voltage</option>
                    <option value={hostBId}>Dr. Linebreak</option>
                  </select>
                  <button
                    onClick={handleHostTts}
                    disabled={loading || !selectedHostId}
                    className="editButton"
                    style={{ width: "100%" }}
                  >
                    Synthesize Selected Host
                  </button>
                </div>
              </div>

              {/* Range Generation */}
              <div className="controlsPanel">
                <div className="panelTitle">Range Triggers</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                    <div className="formGroup" style={{ marginBottom: 0 }}>
                      <label className="label" style={{ fontSize: "0.7rem" }}>Start Line</label>
                      <input
                        type="number"
                        value={rangeStart}
                        onChange={(e) => setRangeStart(Number(e.target.value))}
                        className="input"
                        min={0}
                        max={script.totalLines - 1}
                      />
                    </div>
                    <div className="formGroup" style={{ marginBottom: 0 }}>
                      <label className="label" style={{ fontSize: "0.7rem" }}>End Line</label>
                      <input
                        type="number"
                        value={rangeEnd}
                        onChange={(e) => setRangeEnd(Number(e.target.value))}
                        className="input"
                        min={0}
                        max={script.totalLines - 1}
                      />
                    </div>
                  </div>
                  <button
                    onClick={handleRangeTts}
                    disabled={loading || rangeStart > rangeEnd}
                    className="editButton"
                    style={{ width: "100%", marginTop: "0.25rem" }}
                  >
                    Synthesize Range
                  </button>
                </div>
              </div>
            </>
          )}

          {/* safety guidelines info card */}
          <div className="controlsPanel">
            <div className="panelTitle">Audio Rules</div>
            <p style={{ margin: 0, fontSize: "0.75rem", color: "#64748b", lineHeight: 1.5 }}>
              TTS voice segments are built line-by-line using high-fidelity host parameters. Audio segments must only generate for approved and verified dialogue, ensuring zero hallucinations.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
