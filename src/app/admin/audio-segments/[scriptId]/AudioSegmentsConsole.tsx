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
import TtsVoicePicker, { VoicePicks, buildVoiceOverrides } from "../../components/TtsVoicePicker";
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

interface ConsoleHost {
  id: string;
  slug: string;
  name: string;
}

interface ConsoleProps {
  script: ScriptInfo;
  initialSegments: any[];
  eligible: boolean;
  eligibilityReason?: string;
  eligibilityWarnings?: string[];
  hostAId: string;
  hostBId: string;
  hosts: ConsoleHost[];
  /** Episode.ttsVoiceOverrides — voice picks pinned on the episode. */
  episodeVoiceOverrides: Record<string, { provider: string; voiceId: string; voiceName?: string }> | null;
}

export default function AudioSegmentsConsole({
  script,
  initialSegments,
  eligible,
  eligibilityReason,
  eligibilityWarnings = [],
  hostAId,
  hostBId,
  hosts,
  episodeVoiceOverrides,
}: ConsoleProps) {
  const [segments, setSegments] = useState<any[]>(initialSegments);
  const [loading, setLoading] = useState(false);
  const [rangeStart, setRangeStart] = useState<number>(0);
  const [rangeEnd, setRangeEnd] = useState<number>(Math.max(0, script.totalLines - 1));
  const [selectedHostId, setSelectedHostId] = useState<string>("");
  const [providerOverride, setProviderOverride] = useState<string>("");
  const [saveToEpisode, setSaveToEpisode] = useState(true);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Engine the voice picks below apply to: explicit override first, then the
  // episode/env default the page resolved into script.provider.
  const effectiveProvider = providerOverride || script.provider;

  // Each host's voice prefilled from the picks already pinned on the episode
  // FOR the current engine.
  const pinnedPicksFor = (engine: string): VoicePicks => {
    const next: VoicePicks = {};
    for (const host of hosts) {
      const pinned = episodeVoiceOverrides?.[host.slug] || episodeVoiceOverrides?.[host.id];
      if (pinned && pinned.provider === engine && pinned.voiceId) {
        next[host.slug] = { voiceId: pinned.voiceId, voiceName: pinned.voiceName };
      }
    }
    return next;
  };
  const [voicePicks, setVoicePicks] = useState<VoicePicks>(() => pinnedPicksFor(effectiveProvider));
  // Reset the picks when the engine changes — voice ids don't cross engines.
  const [picksEngine, setPicksEngine] = useState(effectiveProvider);
  if (picksEngine !== effectiveProvider) {
    setPicksEngine(effectiveProvider);
    setVoicePicks(pinnedPicksFor(effectiveProvider));
  }

  const currentVoiceOverrides = () => buildVoiceOverrides(effectiveProvider, voicePicks);

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
    const res = await triggerTtsGeneration(script.id, force, providerOverride || undefined, currentVoiceOverrides(), saveToEpisode);
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
    const res = await triggerTtsRange(script.id, rangeStart, rangeEnd, providerOverride || undefined, currentVoiceOverrides(), saveToEpisode);
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
    const res = await triggerTtsForHost(script.id, selectedHostId, providerOverride || undefined, currentVoiceOverrides(), saveToEpisode);
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
    const res = await retryTtsSegment(script.id, lineIndex, providerOverride || undefined, currentVoiceOverrides(), saveToEpisode);
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
            Goto Episode Details
          </Link>
          <Link href={`/admin/scripts/${script.id}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
            Goto Script Console
          </Link>
        </div>
      </div>

      {/* Header */}
      <div className="scriptsHeader">
        <div>
          <h2 className="pageTitle">
            Audio Segment Console: Version {script.version}
          </h2>
          <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
            Episode: <strong style={{ color: "var(--text-primary)" }}>{script.episodeTitle}</strong>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", display: "block" }}>Eligibility</span>
            <span
              className={`badge ${!eligible ? "badgeFailed" : eligibilityWarnings.length > 0 ? "badgePending" : "badgeCompleted"}`}
              style={{ display: "inline-block", marginTop: "0.25rem" }}
            >
              {!eligible ? "Blocked" : eligibilityWarnings.length > 0 ? "Warnings" : "Eligible"}
            </span>
          </div>
        </div>
      </div>

      {/* Warnings & Messages */}
      {message && (
        <div className={`alertCard ${message.type === "success" ? "alertSuccess" : "alertDanger"}`} style={{ marginTop: "1rem" }}>
          {message.text}
        </div>
      )}

      {!eligible && eligibilityReason && (
        <div className="alertCard alertDanger" style={{ marginTop: "1rem" }}>
          <strong>TTS Generation Blocked:</strong> {eligibilityReason}
        </div>
      )}

      {eligible && eligibilityWarnings.length > 0 && (
        <div className="alertCard alertWarning" style={{ marginTop: "1rem" }}>
          <strong>Pipeline warnings (generation still allowed):</strong>
          <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.25rem" }}>
            {eligibilityWarnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
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
                    <th style={{ width: "60px", textAlign: "center" }}>Line</th>
                    <th style={{ width: "120px" }}>Speaker</th>
                    <th>Dialogue Text Preview</th>
                    <th style={{ width: "80px" }}>Tone</th>
                    <th style={{ width: "100px" }}>Status</th>
                    <th style={{ width: "80px", textAlign: "center" }}>Duration</th>
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
                          <span style={{ fontWeight: 700, color: line.speakerName === "Max Voltage" ? "var(--error-color)" : "var(--accent-color)" }}>
                            {line.speakerName}
                          </span>
                        </td>
                        <td style={{ fontSize: "0.85rem", color: "var(--text-primary)" }}>
                          {line.text}
                        </td>
                        <td style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontStyle: "italic" }}>
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
                          }`} style={{ fontSize: "0.7rem", padding: "0.15rem 0.4rem" }}>
                            {statusVal}
                          </span>
                          {seg?.provider && (
                            <div
                              style={{ fontSize: "0.65rem", color: "var(--text-secondary)", marginTop: "0.2rem" }}
                              title={seg.providerMetadata?.voiceId ? `Voice: ${seg.providerMetadata.voiceName || seg.providerMetadata.voiceId} (${seg.providerMetadata.voiceSource || "?"})` : undefined}
                            >
                              {seg.provider}
                              {seg.providerMetadata?.voiceName || seg.providerMetadata?.voiceId ? (
                                <> · {seg.providerMetadata.voiceName || `${String(seg.providerMetadata.voiceId).slice(0, 10)}…`}</>
                              ) : null}
                            </div>
                          )}
                        </td>
                        <td style={{ fontSize: "0.8rem", color: "var(--text-primary)", textAlign: "center" }}>
                          {seg?.durationMs ? `${(seg.durationMs / 1000).toFixed(1)}s` : "--"}
                        </td>
                        <td>
                          {isReady && seg?.audioUrl ? (
                            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
                              <audio src={seg.audioUrl} controls style={{ width: "140px", height: "24px" }} />
                              <a
                                href={seg.audioUrl}
                                download={`segment-${line.lineIndex}.mp3`}
                                style={{ fontSize: "0.7rem", color: "var(--accent-color)", textDecoration: "underline" }}
                              >
                                Download MP3
                              </a>
                            </div>
                          ) : (
                            <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontStyle: "italic" }}>No audio</span>
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
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem", color: "var(--text-primary)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Total Dialogue Lines:</span>
                <strong>{script.totalLines}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Ready Segments:</span>
                <strong style={{ color: readyCount === script.totalLines ? "var(--success-color)" : "var(--text-primary)" }}>
                  {readyCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Failed Segments:</span>
                <strong style={{ color: failedCount > 0 ? "var(--error-color)" : "var(--text-primary)" }}>
                  {failedCount}
                </strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Processing/Pending:</span>
                <strong style={{ color: processingCount + pendingCount > 0 ? "var(--warning-color)" : "var(--text-primary)" }}>
                  {processingCount + pendingCount}
                </strong>
              </div>
            </div>
          </div>

          {/* Action Triggers Console */}
          {eligible && (
            <>
              {/* Voice Engine + per-host Voice ID Selection */}
              <div className="controlsPanel">
                <div className="panelTitle">Voice Engine &amp; Voices</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                  <select
                    value={providerOverride}
                    onChange={(e) => setProviderOverride(e.target.value)}
                    className="select"
                  >
                    <option value="">{`Default (${script.provider} — episode/host/env)`}</option>
                    <option value="elevenlabs">ElevenLabs</option>
                    <option value="cartesia">Cartesia</option>
                    <option value="openai">OpenAI TTS</option>
                    <option value="boson">Boson AI</option>
                    <option value="fish">Fish Audio</option>
                    <option value="stub">Stub</option>
                  </select>

                  {effectiveProvider !== "stub" && hosts.length > 0 && (
                    <>
                      <div style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>
                        Voice IDs below apply to <strong>{effectiveProvider}</strong> runs only.
                      </div>
                      <TtsVoicePicker
                        provider={effectiveProvider}
                        hosts={hosts}
                        value={voicePicks}
                        onChange={setVoicePicks}
                        disabled={loading}
                      />
                      <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.75rem", color: "var(--text-primary)", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={saveToEpisode}
                          onChange={(e) => setSaveToEpisode(e.target.checked)}
                        />
                        Save to episode for future reruns
                      </label>
                    </>
                  )}
                </div>
              </div>

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

          {/* Final Audio panel */}
          <div className="controlsPanel">
            <div className="panelTitle">Final Audio Stitching</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", fontSize: "0.85rem", color: "var(--text-primary)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Stitching Status:</span>
                <span className={`badge ${readyCount === script.totalLines && script.totalLines > 0 ? "badgeCompleted" : "badgePending"}`}>
                  {readyCount === script.totalLines && script.totalLines > 0 ? "Ready to Stitch" : "Awaiting segments"}
                </span>
              </div>
              <div style={{ marginTop: "0.5rem" }}>
                <Link href={`/admin/final-audio/${script.id}`} className="buttonPrimary" style={{ display: "block", textAlign: "center", textDecoration: "none", fontSize: "0.8rem", padding: "0.4rem" }}>
                  Open Final Stitch Console
                </Link>
              </div>
            </div>
          </div>

          {/* safety guidelines info card */}
          <div className="controlsPanel">
            <div className="panelTitle">Audio Rules</div>
            <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--text-secondary)", lineHeight: 1.4 }}>
              TTS voice segments are built line-by-line using high-fidelity host parameters. Audio segments must only generate for approved and verified dialogue, ensuring zero hallucinations.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
