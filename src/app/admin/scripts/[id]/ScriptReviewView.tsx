"use client";

import React, { useState } from "react";
import {
  saveScriptEdits,
  saveScriptAsNewVersion,
  validateScript,
  approveScript,
  rejectScript,
  markScriptNeedsRevision,
} from "../actions";
import { triggerFactCheck } from "../../fact-checks/actions";
import Link from "next/link";

interface EvidenceRef {
  type: string;
  id: string;
}

interface ScriptLine {
  lineIndex: number;
  speakerName: string;
  speakerHostId: string;
  text: string;
  tone: string;
  evidenceRefs: EvidenceRef[];
  isFactualClaim: boolean;
  needsHumanReview: boolean;
}

interface ScriptSegment {
  type: string;
  title: string;
  topicId?: string;
  lines: ScriptLine[];
}

interface ValidationSummary {
  factualLineCount: number;
  factualLineWithEvidenceCount: number;
  evidenceCoveragePercent: number;
  unsupportedClaimCount: number;
  unsafeClaimCount: number;
  needsHumanReviewCount: number;
  invalidEvidenceRefCount: number;
  invalidSpeakerCount: number;
  totalLineCount: number;
  hostLineShare: Record<string, number>;
  lastValidatedAt: string;
  validationPassed: boolean;
  reasons: string[];
}

interface EvidencePanelItem {
  type: string;
  id: string;
  topicTitle: string;
  detailText: string;
}

interface ScriptInfo {
  id: string;
  episodeId: string;
  version: number;
  content: any;
  plainText: string | null;
  status: string;
  createdAt: string;
}

interface ReviewProps {
  script: ScriptInfo;
  episode: { id: string; title: string; status: string };
  evidencePanelItems: EvidencePanelItem[];
  hostA: { id: string; name: string };
  hostB: { id: string; name: string };
  unsafeClaims: string[];
  latestFactCheck: any;
}

export default function ScriptReviewView({
  script,
  episode,
  evidencePanelItems,
  hostA,
  hostB,
  unsafeClaims,
  latestFactCheck: initialFactCheck,
}: ReviewProps) {
  const [segments, setSegments] = useState<ScriptSegment[]>(script.content.segments || []);
  const [status, setStatus] = useState(script.status);
  const [validationSummary, setValidationSummary] = useState<ValidationSummary | null>(
    script.content.safety || null
  );

  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [factCheck, setFactCheck] = useState(initialFactCheck);
  const [factChecking, setFactChecking] = useState(false);

  const handleRunFactCheck = async (force: boolean) => {
    setFactChecking(true);
    setMessage(null);
    const res = await triggerFactCheck(script.id, force);
    if (res.success) {
      setMessage({
        type: "success",
        text: `Fact check job has been enqueued. Processing in background... Please refresh or check the Fact Checks tab shortly.`,
      });
      // Optionally poll or just alert
    } else {
      setMessage({
        type: "error",
        text: res.error || "Failed to trigger fact check.",
      });
    }
    setFactChecking(false);
  };

  const isLocked = status === "approved" || status === "rejected";

  // Re-generate lineIndices within segment lines
  const rebuildLineIndices = (segs: ScriptSegment[]): ScriptSegment[] => {
    let globalIndex = 0;
    return segs.map((s) => ({
      ...s,
      lines: s.lines.map((l) => {
        const lineIdx = globalIndex++;
        return { ...l, lineIndex: lineIdx };
      }),
    }));
  };

  // Line edits
  const handleLineTextChange = (sIdx: number, lIdx: number, val: string) => {
    setSegments((prev) => {
      const next = [...prev];
      next[sIdx].lines[lIdx].text = val;
      return next;
    });
  };

  const handleSpeakerChange = (sIdx: number, lIdx: number, speaker: string) => {
    setSegments((prev) => {
      const next = [...prev];
      const line = next[sIdx].lines[lIdx];
      line.speakerName = speaker;
      line.speakerHostId = speaker === "Max Voltage" ? hostA.id : hostB.id;
      return next;
    });
  };

  const handleToneChange = (sIdx: number, lIdx: number, tone: string) => {
    setSegments((prev) => {
      const next = [...prev];
      next[sIdx].lines[lIdx].tone = tone;
      return next;
    });
  };

  const handleCheckboxChange = (sIdx: number, lIdx: number, field: "isFactualClaim" | "needsHumanReview") => {
    setSegments((prev) => {
      const next = [...prev];
      const line = next[sIdx].lines[lIdx];
      line[field] = !line[field];
      return next;
    });
  };

  // Reordering lines within a segment
  const handleMoveLine = (sIdx: number, lIdx: number, direction: "up" | "down") => {
    setSegments((prev) => {
      const next = [...prev];
      const lines = [...next[sIdx].lines];
      const targetIdx = direction === "up" ? lIdx - 1 : lIdx + 1;
      if (targetIdx < 0 || targetIdx >= lines.length) return prev;

      // Swap lines
      const temp = lines[lIdx];
      lines[lIdx] = lines[targetIdx];
      lines[targetIdx] = temp;

      next[sIdx].lines = lines;
      return rebuildLineIndices(next);
    });
  };

  const handleDeleteLine = (sIdx: number, lIdx: number) => {
    if (!confirm("Are you sure you want to delete this dialogue line?")) return;
    setSegments((prev) => {
      const next = [...prev];
      next[sIdx].lines = next[sIdx].lines.filter((_, idx) => idx !== lIdx);
      return rebuildLineIndices(next);
    });
  };

  const handleAddLine = (sIdx: number) => {
    setSegments((prev) => {
      const next = [...prev];
      const newLine: ScriptLine = {
        lineIndex: 0,
        speakerName: "Max Voltage",
        speakerHostId: hostA.id,
        text: "",
        tone: "heated",
        evidenceRefs: [],
        isFactualClaim: false,
        needsHumanReview: false,
      };
      next[sIdx].lines.push(newLine);
      return rebuildLineIndices(next);
    });
  };

  // Evidence refs modifiers
  const handleRemoveRef = (sIdx: number, lIdx: number, rIdx: number) => {
    setSegments((prev) => {
      const next = [...prev];
      next[sIdx].lines[lIdx].evidenceRefs = next[sIdx].lines[lIdx].evidenceRefs.filter((_, idx) => idx !== rIdx);
      return next;
    });
  };

  const handleAddRef = (sIdx: number, lIdx: number, refType: string, refId: string) => {
    if (!refType || !refId.trim()) return;
    setSegments((prev) => {
      const next = [...prev];
      const line = next[sIdx].lines[lIdx];
      const exists = line.evidenceRefs.some((r) => r.type === refType && r.id === refId.trim());
      if (!exists) {
        line.evidenceRefs.push({ type: refType, id: refId.trim() });
      }
      return next;
    });
  };

  // Compile active content payload
  const getPayload = () => {
    return {
      episodeTitle: script.content.episodeTitle || episode.title,
      version: script.version,
      estimatedDurationMinutes: script.content.estimatedDurationMinutes || 12,
      segments,
      safety: validationSummary || {},
    };
  };

  // Actions
  const handleValidateOnly = async () => {
    setSubmitting(true);
    setMessage(null);
    const res = await validateScript(script.id, getPayload());
    if (res.success && res.validationSummary) {
      setValidationSummary(res.validationSummary);
      if (res.validationSummary.validationPassed) {
        setMessage({ type: "success", text: "Basic validation passed! Script is eligible for approval checks." });
      } else {
        setMessage({ type: "error", text: `Validation failed with ${res.validationSummary.reasons.length} warning(s).` });
      }
    } else {
      setMessage({ type: "error", text: res.error || "Failed to validate script." });
    }
    setSubmitting(false);
  };

  const handleSave = async () => {
    setSubmitting(true);
    setMessage(null);
    const res = await saveScriptEdits(script.id, getPayload());
    if (res.success && res.validationSummary) {
      setValidationSummary(res.validationSummary);
      if (!res.validationSummary.validationPassed) {
        setStatus("needs_revision");
        setMessage({
          type: "error",
          text: "Edits saved, but script failed validation and is marked as 'needs_revision'.",
        });
      } else {
        setMessage({ type: "success", text: "Edits saved successfully." });
      }
    } else {
      setMessage({ type: "error", text: res.error || "Failed to save script changes." });
    }
    setSubmitting(false);
  };

  const handleSaveAsNew = async () => {
    if (!confirm("Save this current editor state as a new Script version? The current version will remain locked.")) return;
    setSubmitting(true);
    setMessage(null);
    const res = await saveScriptAsNewVersion(script.id, getPayload());
    if (res.success && res.newScriptId) {
      setMessage({ type: "success", text: `Saved as a new script version! Redirecting...` });
      setTimeout(() => {
        window.location.href = `/admin/scripts/${res.newScriptId}`;
      }, 1500);
    } else {
      setMessage({ type: "error", text: res.error || "Failed to save as new version." });
      setSubmitting(false);
    }
  };

  const handleApprove = async () => {
    if (!confirm("Approve this script? Once approved, the script is locked and the episode becomes ready for production.")) return;
    setSubmitting(true);
    setMessage(null);
    const res = await approveScript(script.id);
    if (res.success) {
      setStatus("approved");
      setMessage({ type: "success", text: "Script approved! Episode marked as 'script_approved'." });
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      setMessage({ type: "error", text: res.error || "Failed to approve script." });
    }
    setSubmitting(false);
  };

  const handleReject = async () => {
    const reason = prompt("Enter a brief rejection reason:");
    if (reason === null) return; // Cancelled
    setSubmitting(true);
    setMessage(null);
    const res = await rejectScript(script.id, reason || "Admin rejected");
    if (res.success) {
      setStatus("rejected");
      setMessage({ type: "success", text: "Script rejected." });
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      setMessage({ type: "error", text: res.error || "Failed to reject script." });
    }
    setSubmitting(false);
  };

  const handleNeedsRevision = async () => {
    const reason = prompt("Enter a brief revision note:");
    if (reason === null) return; // Cancelled
    setSubmitting(true);
    setMessage(null);
    const res = await markScriptNeedsRevision(script.id, reason || "Admin flagged needs revision");
    if (res.success) {
      setStatus("needs_revision");
      setMessage({ type: "success", text: "Script marked as needs revision." });
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      setMessage({ type: "error", text: res.error || "Failed to flag needs revision." });
    }
    setSubmitting(false);
  };

  return (
    <div>
      {/* Top bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <Link href={`/admin/episodes/${script.episodeId}`} className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
          ← Back to Episode Details
        </Link>
        <div style={{ color: "#94a3b8", fontSize: "0.85rem" }}>
          Episode: <strong style={{ color: "#ffffff" }}>{episode.title}</strong> (Status: {episode.status})
        </div>
      </div>

      <div className="scriptsHeader">
        <div>
          <h2 style={{ fontSize: "1.50rem", color: "#ffffff", margin: 0 }}>
            Script Review: Version {script.version}
          </h2>
          <span style={{ fontSize: "0.85rem", color: "#64748b" }}>
            ID: <span style={{ fontFamily: "var(--font-mono)" }}>{script.id}</span>
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <span className={`badge ${status === "approved" ? "badgeCompleted" : status === "rejected" ? "badgeFailed" : "badgePending"}`}>
            {status}
          </span>
        </div>
      </div>

      {message && (
        <div
          style={{
            marginBottom: "1.5rem",
            padding: "0.75rem 1rem",
            borderRadius: "4px",
            fontSize: "0.85rem",
            fontWeight: 500,
            backgroundColor: message.type === "success" ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
            border: `1px solid ${message.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
            color: message.type === "success" ? "#10b981" : "#ef4444",
          }}
        >
          {message.text}
        </div>
      )}

      {/* Split layout */}
      <div className="scriptReviewLayout">
        
        {/* Left column: Line Editor */}
        <div className="editorPanel">
          <div className="panelTitle">Dialogue Lines Editor</div>

          {isLocked && (
            <div style={{ padding: "0.75rem", backgroundColor: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", color: "#f59e0b", fontSize: "0.85rem", borderRadius: "4px", marginBottom: "1.5rem" }}>
              🔒 This script is {status} and locked. Direct edits are disabled. To make adjustments, click "Save as New Version" on the right.
            </div>
          )}

          {segments.map((segment, sIdx) => (
            <div key={sIdx} className="segmentBlock">
              <div className="segmentHeader">
                <span className="segmentTitle">{segment.type} Segment</span>
                <span className="segmentMeta">
                  {segment.title} • {segment.lines.length} Line(s)
                </span>
              </div>

              {segment.lines.map((line, lIdx) => {
                const [refType, setRefType] = useState("game");
                const [refId, setRefId] = useState("");

                return (
                  <div key={lIdx} className="lineItem">
                    <div className="lineHeader">
                      <span style={{ fontSize: "0.75rem", fontWeight: 700, color: "#64748b", fontFamily: "var(--font-mono)" }}>
                        #{line.lineIndex + 1}
                      </span>

                      {/* Speaker selector */}
                      <select
                        value={line.speakerName}
                        onChange={(e) => handleSpeakerChange(sIdx, lIdx, e.target.value)}
                        disabled={isLocked || submitting}
                        className="speakerSelector"
                      >
                        <option value="Max Voltage">Max Voltage</option>
                        <option value="Dr. Linebreak">Dr. Linebreak</option>
                      </select>

                      {/* Tone selector */}
                      <select
                        value={line.tone}
                        onChange={(e) => handleToneChange(sIdx, lIdx, e.target.value)}
                        disabled={isLocked || submitting}
                        className="toneSelector"
                      >
                        <option value="heated">heated</option>
                        <option value="sarcastic">sarcastic</option>
                        <option value="analytical">analytical</option>
                        <option value="dismissive">dismissive</option>
                        <option value="setup">setup</option>
                        <option value="transition">transition</option>
                      </select>

                      {/* Checkboxes */}
                      <label className="checkboxLabel">
                        <input
                          type="checkbox"
                          checked={line.isFactualClaim}
                          onChange={() => handleCheckboxChange(sIdx, lIdx, "isFactualClaim")}
                          disabled={isLocked || submitting}
                        />
                        Factual?
                      </label>

                      <label className="checkboxLabel" style={{ color: line.needsHumanReview ? "#ef4444" : "#94a3b8" }}>
                        <input
                          type="checkbox"
                          checked={line.needsHumanReview}
                          onChange={() => handleCheckboxChange(sIdx, lIdx, "needsHumanReview")}
                          disabled={isLocked || submitting}
                        />
                        Review Flag
                      </label>

                      {/* Reorder/Delete Buttons */}
                      <div style={{ marginLeft: "auto", display: "flex", gap: "0.35rem" }}>
                        <button
                          type="button"
                          onClick={() => handleMoveLine(sIdx, lIdx, "up")}
                          disabled={isLocked || lIdx === 0}
                          className="btnReset"
                          style={{ padding: "0.1rem 0.35rem", fontSize: "0.75rem" }}
                          title="Move Line Up"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          onClick={() => handleMoveLine(sIdx, lIdx, "down")}
                          disabled={isLocked || lIdx === segment.lines.length - 1}
                          className="btnReset"
                          style={{ padding: "0.1rem 0.35rem", fontSize: "0.75rem" }}
                          title="Move Line Down"
                        >
                          ▼
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteLine(sIdx, lIdx)}
                          disabled={isLocked}
                          className="removeRefBtn"
                          style={{ fontSize: "0.8rem", marginLeft: "0.5rem" }}
                          title="Delete Line"
                        >
                          ✕
                        </button>
                      </div>
                    </div>

                    {/* Dialogue Line Text */}
                    <textarea
                      value={line.text}
                      onChange={(e) => handleLineTextChange(sIdx, lIdx, e.target.value)}
                      disabled={isLocked || submitting}
                      className="textarea"
                      rows={2}
                      style={{ fontSize: "0.9rem", width: "100%" }}
                      placeholder="Spoken host dialogue..."
                    />

                    {/* Factual claim evidenceRefs list */}
                    <div className="evidenceInputGroup">
                      <span className="sectionGroupLabel" style={{ fontSize: "0.7rem", marginBottom: "0.35rem" }}>
                        Evidence References
                      </span>

                      <div style={{ marginBottom: "0.5rem" }}>
                        {line.evidenceRefs.map((ref, rIdx) => (
                          <span key={rIdx} className="evidenceTag">
                            {ref.type}:{ref.id}
                            {!isLocked && (
                              <button
                                type="button"
                                onClick={() => handleRemoveRef(sIdx, lIdx, rIdx)}
                                className="removeRefBtn"
                                style={{ marginLeft: "0.25rem" }}
                              >
                                ✕
                              </button>
                            )}
                          </span>
                        ))}

                        {line.evidenceRefs.length === 0 && (
                          <span style={{ fontSize: "0.75rem", color: "#64748b", fontStyle: "italic" }}>
                            No evidence references.
                          </span>
                        )}
                      </div>

                      {/* Add evidenceRef helper form */}
                      {!isLocked && (
                        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                          <select
                            value={refType}
                            onChange={(e) => setRefType(e.target.value)}
                            className="select"
                            style={{ width: "auto", fontSize: "0.75rem", padding: "0.15rem 0.35rem" }}
                          >
                            <option value="game">game</option>
                            <option value="newsItem">newsItem</option>
                            <option value="injury">injury</option>
                            <option value="oddsSnapshot">oddsSnapshot</option>
                            <option value="teamStat">teamStat</option>
                            <option value="playerStat">playerStat</option>
                          </select>
                          <input
                            type="text"
                            value={refId}
                            onChange={(e) => setRefId(e.target.value)}
                            placeholder="Evidence ID"
                            className="input"
                            style={{ flexGrow: 1, fontSize: "0.75rem", padding: "0.15rem 0.35rem" }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              handleAddRef(sIdx, lIdx, refType, refId);
                              setRefId("");
                            }}
                            className="editButton"
                            style={{ fontSize: "0.75rem", padding: "0.15rem 0.5rem" }}
                          >
                            + Ref
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {!isLocked && (
                <button
                  type="button"
                  onClick={() => handleAddLine(sIdx)}
                  className="editButton"
                  style={{ fontSize: "0.8rem", width: "100%", padding: "0.4rem" }}
                >
                  + Add dialogue line to segment
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Right column: Controls & Validation & Evidence */}
        <div className="sideControls">
          
          {/* Action buttons panel */}
          <div className="controlsPanel">
            <div className="panelTitle">Approval & Saves Console</div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {!isLocked && (
                <>
                  <button
                    onClick={handleSave}
                    disabled={submitting}
                    className="buttonPrimary"
                    style={{ width: "100%" }}
                  >
                    Save Changes
                  </button>

                  <button
                    onClick={handleValidateOnly}
                    disabled={submitting}
                    className="editButton"
                    style={{ width: "100%" }}
                  >
                    Validate Script
                  </button>

                  <button
                    onClick={handleApprove}
                    disabled={submitting}
                    className="buttonPrimary"
                    style={{ width: "100%", backgroundColor: "#10b981", borderColor: "#059669" }}
                  >
                    Approve Script
                  </button>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                    <button
                      onClick={handleNeedsRevision}
                      disabled={submitting}
                      className="editButton"
                      style={{ width: "100%", fontSize: "0.8rem" }}
                    >
                      Needs Revision
                    </button>
                    <button
                      onClick={handleReject}
                      disabled={submitting}
                      className="btnReject"
                      style={{ width: "100%", fontSize: "0.8rem" }}
                    >
                      Reject Script
                    </button>
                  </div>
                </>
              )}

              <button
                onClick={handleSaveAsNew}
                disabled={submitting}
                className="editButton"
                style={{ width: "100%" }}
              >
                Save as New Version (v{script.version + 1})
              </button>
            </div>
          </div>

          {/* Fact Check Safety Gate Console */}
          <div className="controlsPanel">
            <div className="panelTitle">Fact Check Safety Gate</div>
            
            {status === "approved" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                {factCheck ? (
                  <div style={{ backgroundColor: "#080b10", border: "1px solid #161f30", borderRadius: "4px", padding: "0.75rem", fontSize: "0.85rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                      <span>Latest Check Result:</span>
                      <span className={`badge ${factCheck.status === "passed" ? "badgeCompleted" : factCheck.status === "failed" ? "badgeFailed" : "badgePending"}`}>
                        {factCheck.status}
                      </span>
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.5rem" }}>
                      Checked: {new Date(factCheck.checkedAt).toLocaleString()}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", color: "#cbd5e1", fontSize: "0.8rem", borderTop: "1px solid #161f30", paddingTop: "0.5rem" }}>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Coverage:</span>
                        <strong>{factCheck.evidenceCoverage?.evidenceCoveragePercent || 0}%</strong>
                      </div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <span>Issues Found:</span>
                        <strong style={{ color: (factCheck.summary?.totalErrors || 0) > 0 ? "#ef4444" : "#10b981" }}>
                          {(factCheck.summary?.totalErrors || 0) + (factCheck.summary?.totalWarnings || 0)}
                        </strong>
                      </div>
                    </div>
                    <div style={{ marginTop: "0.75rem" }}>
                      <Link
                        href={`/admin/fact-checks/${factCheck.id}`}
                        className="editButton"
                        style={{ display: "block", textAlign: "center", textDecoration: "none", fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
                      >
                        View Fact Check Audit Details
                      </Link>
                    </div>
                  </div>
                ) : (
                  <div style={{ color: "#64748b", fontSize: "0.85rem", fontStyle: "italic", marginBottom: "0.5rem" }}>
                    No fact check audits have been run for this approved script version yet.
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
                  <button
                    onClick={() => handleRunFactCheck(false)}
                    disabled={factChecking}
                    className="buttonPrimary"
                    style={{ fontSize: "0.8rem", padding: "0.4rem" }}
                  >
                    Run Fact Check
                  </button>
                  <button
                    onClick={() => handleRunFactCheck(true)}
                    disabled={factChecking}
                    className="editButton"
                    style={{ fontSize: "0.8rem", padding: "0.4rem" }}
                  >
                    Force Recheck
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ color: "#64748b", fontSize: "0.85rem", fontStyle: "italic" }}>
                Fact checking is only available for approved scripts. Approve this script draft first to unlock.
              </div>
            )}
          </div>

          {/* Validation Summary */}
          <div className="controlsPanel">
            <div className="panelTitle">Validation Report</div>
            
            {validationSummary ? (
              <div>
                <div
                  className={`validationItem ${
                    validationSummary.validationPassed ? "validationSuccess" : "validationFailed"
                  }`}
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontWeight: 700 }}
                >
                  <span>Validation Status:</span>
                  <span>{validationSummary.validationPassed ? "PASSED" : "FAILED"}</span>
                </div>

                <div style={{ fontSize: "0.85rem", color: "#cbd5e1", display: "flex", flexDirection: "column", gap: "0.4rem", marginTop: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Total lines count:</span>
                    <strong style={{ color: "#ffffff" }}>{validationSummary.totalLineCount}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Factual claims:</span>
                    <strong style={{ color: "#ffffff" }}>{validationSummary.factualLineCount}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Evidence coverage:</span>
                    <strong style={{ color: validationSummary.evidenceCoveragePercent >= 90 ? "#10b981" : "#ef4444" }}>
                      {validationSummary.evidenceCoveragePercent}%
                    </strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Review flags count:</span>
                    <strong style={{ color: validationSummary.needsHumanReviewCount > 0 ? "#ef4444" : "#ffffff" }}>
                      {validationSummary.needsHumanReviewCount}
                    </strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Prohibited claims:</span>
                    <strong style={{ color: validationSummary.unsupportedClaimCount > 0 ? "#ef4444" : "#ffffff" }}>
                      {validationSummary.unsupportedClaimCount}
                    </strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Unsafe claims:</span>
                    <strong style={{ color: validationSummary.unsafeClaimCount > 0 ? "#ef4444" : "#ffffff" }}>
                      {validationSummary.unsafeClaimCount}
                    </strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Invalid evidence refs:</span>
                    <strong style={{ color: validationSummary.invalidEvidenceRefCount > 0 ? "#ef4444" : "#ffffff" }}>
                      {validationSummary.invalidEvidenceRefCount}
                    </strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Invalid speaker names:</span>
                    <strong style={{ color: validationSummary.invalidSpeakerCount > 0 ? "#ef4444" : "#ffffff" }}>
                      {validationSummary.invalidSpeakerCount}
                    </strong>
                  </div>
                  
                  <div style={{ borderTop: "1px solid #161f30", paddingTop: "0.5rem", marginTop: "0.5rem" }}>
                    <span className="sectionGroupLabel" style={{ fontSize: "0.7rem" }}>Host Line Share</span>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem", marginTop: "0.25rem" }}>
                      <span>Max Voltage:</span>
                      <strong style={{ color: (validationSummary.hostLineShare?.["Max Voltage"] || 0) >= 25 ? "#10b981" : "#ef4444" }}>
                        {validationSummary.hostLineShare?.["Max Voltage"] || 0}%
                      </strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.8rem" }}>
                      <span>Dr. Linebreak:</span>
                      <strong style={{ color: (validationSummary.hostLineShare?.["Dr. Linebreak"] || 0) >= 25 ? "#10b981" : "#ef4444" }}>
                        {validationSummary.hostLineShare?.["Dr. Linebreak"] || 0}%
                      </strong>
                    </div>
                  </div>

                  <span style={{ fontSize: "0.7rem", color: "#64748b", marginTop: "0.5rem" }}>
                    Last Checked: {new Date(validationSummary.lastValidatedAt).toLocaleTimeString()}
                  </span>
                </div>

                {/* Validation Warnings List */}
                {validationSummary.reasons && validationSummary.reasons.length > 0 && (
                  <div style={{ marginTop: "1rem", borderTop: "1px solid #161f30", paddingTop: "0.75rem" }}>
                    <span className="sectionGroupLabel" style={{ color: "#f59e0b", fontSize: "0.7rem", marginBottom: "0.5rem", display: "block" }}>
                      Warnings & Failures ({validationSummary.reasons.length})
                    </span>
                    <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", maxHeight: "150px", overflowY: "auto", fontSize: "0.75rem", color: "#94a3b8" }}>
                      {validationSummary.reasons.map((r, rIdx) => (
                        <div key={rIdx} style={{ backgroundColor: "#0c0f16", borderLeft: "2px solid #ef4444", padding: "0.25rem 0.5rem" }}>
                          {r}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div style={{ color: "#64748b", fontSize: "0.85rem", fontStyle: "italic" }}>
                Script has not been validated yet. Click "Validate Script" to scan.
              </div>
            )}
          </div>

          {/* Evidence panel helper list */}
          <div className="controlsPanel">
            <div className="panelTitle">Allowed Evidence Refs</div>
            
            <div className="evidenceList">
              {evidencePanelItems.map((item, idx) => (
                <div key={idx} className="evidenceItemCard">
                  <div className="evidenceCardHeader">
                    <span style={{ color: "#38bdf8", fontWeight: 700 }}>{item.type}</span>
                    <span
                      className="copyCodeBlock"
                      title="Click to copy formatted reference object"
                      onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify({ type: item.type, id: item.id }));
                        alert(`Copied reference object code to clipboard: {"type":"${item.type}","id":"${item.id}"}`);
                      }}
                    >
                      {item.id.substring(0, 8)}...
                    </span>
                  </div>
                  <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: "0.25rem", fontStyle: "italic" }}>
                    Topic: {item.topicTitle}
                  </div>
                  {item.detailText && (
                    <p style={{ margin: 0, fontSize: "0.75rem", color: "#cbd5e1", lineHeight: 1.4 }}>
                      {item.detailText}
                    </p>
                  )}
                </div>
              ))}

              {evidencePanelItems.length === 0 && (
                <div style={{ color: "#64748b", fontSize: "0.85rem", fontStyle: "italic" }}>
                  No allowed evidence source refs available for this episode.
                </div>
              )}
            </div>
          </div>

          {/* Unsafe Claims warning box */}
          {unsafeClaims.length > 0 && (
            <div className="controlsPanel" style={{ border: "1px solid rgba(239, 68, 68, 0.25)" }}>
              <div className="panelTitle" style={{ color: "#ef4444" }}>Unsafe Claims Warnings</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {unsafeClaims.map((claim, idx) => (
                  <div key={idx} style={{ padding: "0.5rem", backgroundColor: "rgba(239, 68, 68, 0.04)", border: "1px solid rgba(239, 68, 68, 0.15)", borderRadius: "4px", fontSize: "0.75rem", color: "#cbd5e1" }}>
                    "{claim}"
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}
