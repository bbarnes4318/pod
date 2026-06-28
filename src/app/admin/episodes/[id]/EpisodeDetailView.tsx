"use client";

import React, { useState } from "react";
import { updateEpisodeMetadata, triggerScriptGeneration, fetchEpisodeScripts } from "../actions";
import Link from "next/link";

interface TopicEvidenceRef {
  type: string;
  id: string;
}

interface FactItem {
  text: string;
  confidence: string;
  evidenceRefs: TopicEvidenceRef[];
}

interface StatItem {
  text: string;
  evidenceRefs: TopicEvidenceRef[];
}

interface DialogueItem {
  host: string;
  claim: string;
  evidenceRefs: TopicEvidenceRef[];
}

interface UnsafeClaimItem {
  claim: string;
  reason: string;
}

interface ResearchBrief {
  facts: any; // FactItem[]
  stats: any; // StatItem[]
  injuryContext: string | null;
  oddsContext: string | null;
  argumentForHostA: string;
  argumentForHostB: string;
  counterArguments: any; // DialogueItem[]
  unsafeClaims: any; // UnsafeClaimItem[]
  sourceIds: any; // TopicEvidenceRef[]
}

interface TopicInfo {
  id: string;
  title: string;
  sport: string;
  leagueId: string | null;
  summary: string | null;
  debateScore: number;
  evidenceIds: any; // TopicEvidenceRef[]
  brief: ResearchBrief | null;
}

interface EpisodeInfo {
  id: string;
  title: string;
  slug: string;
  status: string;
  description: string | null;
  audioUrl: string | null;
  transcriptUrl: string | null;
  longShowNotes: string | null;
  durationSeconds: number | null;
  createdAt: string;
  topics: TopicInfo[];
}

interface ScriptInfo {
  id: string;
  version: number;
  status: string;
  plainText: string | null;
  createdAt: string;
  audioSegments?: {
    totalLines: number;
    readyCount: number;
    failedCount: number;
  };
}

interface FactCheckInfo {
  id: string;
  scriptId: string;
  status: string;
  checkedAt: string;
}

interface DetailProps {
  episode: EpisodeInfo;
  initialScripts: ScriptInfo[];
  initialFactChecks: FactCheckInfo[];
}

export default function EpisodeDetailView({ episode, initialScripts, initialFactChecks }: DetailProps) {
  const [scripts, setScripts] = useState<ScriptInfo[]>(initialScripts);
  const [factChecks, setFactChecks] = useState<FactCheckInfo[]>(initialFactChecks);
  const [selectedScriptId, setSelectedScriptId] = useState<string | null>(
    initialScripts.length > 0 ? initialScripts[0].id : null
  );

  const [isEditing, setIsEditing] = useState(false);
  const [title, setTitle] = useState(episode.title);
  const [description, setDescription] = useState(episode.description || "");

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [generating, setGenerating] = useState(false);
  const [scriptMsg, setScriptMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Polls script records for 30s to update status
  const startPolling = () => {
    let count = 0;
    const interval = setInterval(async () => {
      count++;
      const res = await fetchEpisodeScripts(episode.id);
      if (res.success && res.scripts) {
        setScripts(res.scripts);
        // Find if a draft or completed script is ready
        const anyActive = res.scripts.length > 0;
        if (anyActive) {
          // If we had a running script, select it
          const first = res.scripts[0];
          setSelectedScriptId(first.id);
        }
      }
      if (count >= 15) {
        clearInterval(interval);
        setGenerating(false);
      }
    }, 2000);
  };

  const handleGenerateScriptClick = async (forceRegenerate?: boolean) => {
    setGenerating(true);
    setScriptMsg(null);
    
    const res = await triggerScriptGeneration(episode.id, forceRegenerate);
    if (res.success) {
      setScriptMsg({
        type: "success",
        text: "Script generation job triggered! Assembly is processing in the background...",
      });
      startPolling();
    } else {
      setScriptMsg({
        type: "error",
        text: res.error || "Failed to trigger script generation.",
      });
      setGenerating(false);
    }
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setErrorMsg("Title cannot be empty.");
      return;
    }

    setLoading(true);
    setErrorMsg(null);

    const res = await updateEpisodeMetadata(episode.id, title, description);
    if (res.success) {
      setIsEditing(false);
      window.location.reload();
    } else {
      setErrorMsg(res.error || "Failed to update metadata.");
    }
    setLoading(false);
  };

  const getArray = (val: any): any[] => {
    if (Array.isArray(val)) return val;
    return [];
  };

  return (
    <div>
      {/* Back button */}
      <div style={{ marginBottom: "1.5rem" }}>
        <Link href="/admin/episodes" className="btnReset" style={{ fontSize: "0.85rem", textDecoration: "none" }}>
          ← Back to Episode Manager
        </Link>
      </div>

      {/* Episode Header */}
      <div className="detailHeader">
        <div className="detailTitleBlock">
          <h2 className="detailTitle">{episode.title}</h2>
          <div className="detailMeta">
            <span className="badge badgePending">{episode.status}</span>
            <span>Created {new Date(episode.createdAt).toLocaleDateString()}</span>
            <span>•</span>
            <span>{episode.topics.length} Debate Topics</span>
          </div>
          {episode.description && (
            <p className="detailDescription">{episode.description}</p>
          )}
        </div>

        <div>
          {episode.status === "draft" && (
            <button
              onClick={() => setIsEditing(!isEditing)}
              className="buttonPrimary"
              style={{ fontSize: "0.85rem", padding: "0.5rem 1rem" }}
            >
              {isEditing ? "Cancel Edit" : "Edit Details"}
            </button>
          )}
        </div>
      </div>

      {/* Edit Form */}
      {isEditing && (
        <form onSubmit={handleEditSubmit} className="metadataEditForm">
          <h3 style={{ fontSize: "1rem", color: "#ffffff", marginBottom: "1rem", marginTop: 0 }}>Edit Episode Metadata</h3>
          
          <div className="formGroup">
            <label className="label" htmlFor="editTitle">Episode Title</label>
            <input
              id="editTitle"
              type="text"
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="formGroup">
            <label className="label" htmlFor="editDesc">Description</label>
            <textarea
              id="editDesc"
              className="textarea"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={loading}
            />
          </div>

          {errorMsg && (
            <div style={{ color: "#ef4444", fontSize: "0.85rem", marginBottom: "1rem" }}>{errorMsg}</div>
          )}

          <div style={{ display: "flex", gap: "0.75rem" }}>
            <button type="submit" className="buttonPrimary" disabled={loading}>
              {loading ? "Saving..." : "Save Changes"}
            </button>
            <button type="button" onClick={() => setIsEditing(false)} className="btnReset" disabled={loading}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* 1. Draft warning banner */}
      <div className="draftWarning">
        <strong>ℹ️ Script Review & Approval Workflow</strong>
        <span>Script review and approval console is fully built. You can review, edit, validate, and approve the generated draft script before proceeding to production.</span>
      </div>

      {/* 2. List of topics */}
      <div style={{ marginBottom: "3rem" }}>
        <h3 style={{ color: "#ffffff", fontSize: "1.25rem", marginBottom: "1.5rem" }}>Debate Lineup</h3>
        
        {episode.topics.map((topic, idx) => {
          const evidenceList = getArray(topic.evidenceIds);
          const brief = topic.brief;

          return (
            <div key={topic.id} className="detailTopicCard">
              <div className="detailTopicHeader">
                <div>
                  <span style={{ color: "#38bdf8", fontWeight: 700, marginRight: "0.75rem" }}>Topic #{idx + 1}</span>
                  <span className="detailTopicTitle">{topic.title}</span>
                </div>
                <span className="refBadge" style={{ fontSize: "0.75rem", color: "#38bdf8" }}>
                  Debate Score: {Math.round(topic.debateScore)}
                </span>
              </div>

              <div className="detailTopicBody">
                {topic.summary && (
                  <div>
                    <span className="sectionGroupLabel">Brief Summary</span>
                    <p style={{ fontSize: "0.95rem", color: "#cbd5e1", lineHeight: 1.6, margin: 0 }}>
                      {topic.summary}
                    </p>
                  </div>
                )}

                {brief ? (
                  <>
                    {/* Facts bullet list */}
                    <div>
                      <span className="sectionGroupLabel">Key Facts</span>
                      <ul style={{ listStyleType: "square", paddingLeft: "1.25rem", margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        {getArray(brief.facts).map((fact: FactItem, fIdx) => (
                          <li key={fIdx} style={{ fontSize: "0.9rem", color: "#e2e8f0" }}>
                            <span>{fact.text}</span>
                            <span style={{ fontSize: "0.65rem", textTransform: "uppercase", fontWeight: 700, padding: "0.05rem 0.25rem", borderRadius: "3px", marginLeft: "0.5rem", backgroundColor: "#1e293b", color: "#cbd5e1" }}>
                              {fact.confidence}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Stats bullet list */}
                    <div>
                      <span className="sectionGroupLabel">Statistics</span>
                      <ul style={{ listStyleType: "circle", paddingLeft: "1.25rem", margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        {getArray(brief.stats).map((stat: StatItem, sIdx) => (
                          <li key={sIdx} style={{ fontSize: "0.9rem", color: "#e2e8f0" }}>
                            {stat.text}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Injury Context */}
                    {brief.injuryContext && (
                      <div>
                        <span className="sectionGroupLabel">Injury Context</span>
                        <p style={{ fontSize: "0.9rem", color: "#94a3b8", lineHeight: 1.5, margin: 0, backgroundColor: "#080b10", padding: "0.75rem", borderRadius: "4px" }}>
                          {brief.injuryContext}
                        </p>
                      </div>
                    )}

                    {/* Odds Context */}
                    {brief.oddsContext && (
                      <div>
                        <span className="sectionGroupLabel">Odds Context</span>
                        <p style={{ fontSize: "0.9rem", color: "#94a3b8", lineHeight: 1.5, margin: 0, backgroundColor: "#080b10", padding: "0.75rem", borderRadius: "4px" }}>
                          {brief.oddsContext}
                        </p>
                      </div>
                    )}

                    {/* Host arguments */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginTop: "0.5rem" }}>
                      <div style={{ backgroundColor: "#080b10", borderLeft: "3px solid #ef4444", padding: "1rem", borderRadius: "4px" }}>
                        <span style={{ color: "#ef4444", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", display: "block", marginBottom: "0.5rem" }}>
                          Max Voltage Debate Stance
                        </span>
                        <p style={{ fontSize: "0.85rem", color: "#e2e8f0", lineHeight: 1.6, margin: 0 }}>
                          {brief.argumentForHostA}
                        </p>
                      </div>

                      <div style={{ backgroundColor: "#080b10", borderLeft: "3px solid #38bdf8", padding: "1rem", borderRadius: "4px" }}>
                        <span style={{ color: "#38bdf8", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", display: "block", marginBottom: "0.5rem" }}>
                          Dr. Linebreak Debate Stance
                        </span>
                        <p style={{ fontSize: "0.85rem", color: "#e2e8f0", lineHeight: 1.6, margin: 0 }}>
                          {brief.argumentForHostB}
                        </p>
                      </div>
                    </div>

                    {/* Dialogue counter arguments */}
                    <div>
                      <span className="sectionGroupLabel">Host Counterpoints</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        {getArray(brief.counterArguments).map((item: DialogueItem, caIdx) => (
                          <div key={caIdx} style={{ fontSize: "0.85rem", padding: "0.5rem 0.75rem", backgroundColor: "#080b10", border: "1px solid #161f30", borderRadius: "4px", display: "flex", gap: "0.5rem" }}>
                            <span style={{ fontWeight: 700, color: item.host === "Dr. Linebreak" ? "#38bdf8" : "#ef4444" }}>
                              {item.host}:
                            </span>
                            <span style={{ color: "#cbd5e1" }}>{item.claim}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Unsafe claims */}
                    {getArray(brief.unsafeClaims).length > 0 && (
                      <div>
                        <span className="sectionGroupLabel" style={{ color: "#ef4444" }}>Unsafe / Unverified Claims</span>
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                          {getArray(brief.unsafeClaims).map((claim: UnsafeClaimItem, ucIdx) => (
                            <div key={ucIdx} style={{ padding: "0.75rem", backgroundColor: "rgba(239, 68, 68, 0.04)", border: "1px solid rgba(239, 68, 68, 0.15)", borderRadius: "4px" }}>
                              <p style={{ fontSize: "0.85rem", color: "#cbd5e1", margin: 0 }}>"{claim.claim}"</p>
                              <span style={{ fontSize: "0.75rem", color: "#ef4444", fontWeight: 600 }}>Reason: {claim.reason}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Source counts */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #161f30", paddingTop: "1rem", marginTop: "0.5rem" }}>
                      <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
                        Topic ID: <span style={{ fontFamily: "var(--font-mono)" }}>{topic.id}</span>
                      </span>
                      <span className="refBadge" style={{ fontSize: "0.7rem" }}>
                        {getArray(brief.sourceIds).length} Fact Sources
                      </span>
                    </div>
                  </>
                ) : (
                  <div style={{ padding: "1rem", backgroundColor: "rgba(245, 158, 11, 0.08)", border: "1px solid rgba(245, 158, 11, 0.25)", color: "#f59e0b", fontSize: "0.85rem", borderRadius: "4px" }}>
                    ⚠️ No Research Brief exists for this topic candidate. Wait for brief generation before launching script generation.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Script Console */}
      <div className="panel" style={{ padding: "2rem", marginTop: "2rem" }}>
        <h3 style={{ color: "#ffffff", fontSize: "1.25rem", marginBottom: "0.5rem", marginTop: 0 }}>Dialogue Script Console</h3>
        <p style={{ color: "#64748b", fontSize: "0.9rem", maxWidth: "700px", margin: "0 auto 1.5rem" }}>
          Generate the spoken dialogue script for the hosts. The debate is composed entirely from grounded research briefs, matching the host personalities.
        </p>

        {/* Script Selection Dropdown */}
        {scripts.length > 0 && (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
            <span style={{ fontSize: "0.85rem", color: "#94a3b8" }}>Script Versions:</span>
            <select
              value={selectedScriptId || ""}
              onChange={(e) => setSelectedScriptId(e.target.value)}
              className="select"
              style={{ width: "auto", minWidth: "150px", padding: "0.35rem 0.5rem" }}
            >
              {scripts.map((s) => (
                <option key={s.id} value={s.id}>
                  Version {s.version} ({s.status})
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Selected Script Detail Preview */}
        {(() => {
          const activeScript = scripts.find((s) => s.id === selectedScriptId) || (scripts.length > 0 ? scripts[0] : null);
          if (!activeScript) return null;

          const isApproved = activeScript.status === "approved";

          return (
            <div style={{ border: "1px solid #161f30", borderRadius: "6px", backgroundColor: "#080b10", padding: "1.25rem", marginBottom: "1.5rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #161f30", paddingBottom: "0.75rem", marginBottom: "0.75rem" }}>
                <div>
                  <span style={{ fontWeight: 700, color: "#ffffff", marginRight: "0.75rem" }}>Version {activeScript.version}</span>
                  <span className={`badge ${activeScript.status === "approved" ? "badgeCompleted" : activeScript.status === "rejected" ? "badgeFailed" : "badgePending"}`}>
                    {activeScript.status}
                  </span>
                </div>
                <span style={{ fontSize: "0.75rem", color: "#64748b" }}>
                  Created {new Date(activeScript.createdAt).toLocaleString()}
                </span>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", alignItems: "center", marginBottom: "1rem" }}>
                <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
                  {isApproved ? (
                    <div style={{ color: "#10b981", fontWeight: 700, fontSize: "0.90rem" }}>
                      ✓ Script Approved (Episode Status: script_approved)
                    </div>
                  ) : (
                    <Link
                      href={`/admin/scripts/${activeScript.id}`}
                      className="buttonPrimary"
                      style={{ fontSize: "0.85rem", padding: "0.35rem 0.85rem", textDecoration: "none" }}
                    >
                      Review & Edit Script
                    </Link>
                  )}

                  {/* Direct link for approved script inspect reviews */}
                  {isApproved && (
                    <Link
                      href={`/admin/scripts/${activeScript.id}`}
                      className="editButton"
                      style={{ fontSize: "0.85rem", padding: "0.35rem 0.85rem", textDecoration: "none" }}
                    >
                      Inspect Approved Script Console
                    </Link>
                  )}
                </div>

                {/* Fact Check status badge and details link */}
                {(() => {
                  const latestFactCheck = factChecks.find((f) => f.scriptId === activeScript.id);
                  if (!latestFactCheck) return null;

                  const fcStatus = latestFactCheck.status;
                  const label =
                    fcStatus === "passed"
                      ? "Fact Check Passed"
                      : fcStatus === "failed"
                      ? "Fact Check Failed — script needs revision"
                      : "Fact Check Needs Review";

                  const badgeClass =
                    fcStatus === "passed"
                      ? "badgeCompleted"
                      : fcStatus === "failed"
                      ? "badgeFailed"
                      : "badgePending";

                  return (
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0.75rem", backgroundColor: "#0c0f16", border: "1px solid #161f30", borderRadius: "4px", marginTop: "0.25rem" }}>
                      <span style={{ fontSize: "0.8rem", color: "#cbd5e1" }}>Fact Check Audit:</span>
                      <span className={`badge ${badgeClass}`} style={{ fontSize: "0.75rem" }}>
                        {label}
                      </span>
                      <Link
                        href={`/admin/fact-checks/${latestFactCheck.id}`}
                        style={{ fontSize: "0.75rem", color: "#38bdf8", textDecoration: "underline", fontWeight: 600 }}
                      >
                        [View Audit Report]
                      </Link>
                    </div>
                  );
                })()}

                {/* TTS Audio segment readiness status */}
                {activeScript.audioSegments && (
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0.75rem", backgroundColor: "#0c0f16", border: "1px solid #161f30", borderRadius: "4px", marginTop: "0.25rem" }}>
                    <span style={{ fontSize: "0.8rem", color: "#cbd5e1" }}>Audio Segment Readiness:</span>
                    <span className="badge badgePending" style={{ fontSize: "0.75rem", backgroundColor: activeScript.audioSegments.readyCount === activeScript.audioSegments.totalLines ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)", color: activeScript.audioSegments.readyCount === activeScript.audioSegments.totalLines ? "#10b981" : "#f59e0b" }}>
                      Ready: {activeScript.audioSegments.readyCount} / {activeScript.audioSegments.totalLines} lines
                    </span>
                    {activeScript.audioSegments.failedCount > 0 && (
                      <span className="badge badgeFailed" style={{ fontSize: "0.75rem" }}>
                        Failed: {activeScript.audioSegments.failedCount} lines
                      </span>
                    )}
                    <Link
                      href={`/admin/audio-segments/${activeScript.id}`}
                      style={{ fontSize: "0.75rem", color: "#38bdf8", textDecoration: "underline", fontWeight: 600 }}
                    >
                      [View TTS Console]
                    </Link>
                  </div>
                )}

                {/* Final Audio readiness badge and player */}
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0.75rem", backgroundColor: "#0c0f16", border: "1px solid #161f30", borderRadius: "4px", marginTop: "0.25rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                    <span style={{ fontSize: "0.8rem", color: "#cbd5e1" }}>Final Stitch Status:</span>
                    <span className={`badge ${episode.status === "audio_ready" ? "badgeCompleted" : "badgePending"}`} style={{ fontSize: "0.75rem" }}>
                      {episode.status === "audio_ready" ? "Audio Ready" : episode.status}
                    </span>
                    {episode.status === "audio_ready" && episode.durationSeconds && (
                      <span style={{ fontSize: "0.80rem", color: "#94a3b8", fontFamily: "var(--font-mono)" }}>
                        Duration: {Math.floor(episode.durationSeconds / 60)}m {episode.durationSeconds % 60}s
                      </span>
                    )}
                    <Link
                      href={`/admin/final-audio/${activeScript.id}`}
                      style={{ fontSize: "0.75rem", color: "#38bdf8", textDecoration: "underline", fontWeight: 600 }}
                    >
                      [Open Stitch Console]
                    </Link>
                  </div>
                  {episode.status === "audio_ready" && episode.audioUrl && (
                    <div style={{ marginTop: "0.5rem", borderTop: "1px solid #161f30", paddingTop: "0.5rem" }}>
                      <audio src={episode.audioUrl} controls style={{ width: "100%" }} />
                    </div>
                  )}
                </div>

                {/* Content Assets status and links */}
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0.75rem", backgroundColor: "#0c0f16", border: "1px solid #161f30", borderRadius: "4px", marginTop: "0.25rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.8rem", color: "#cbd5e1" }}>Transcript:</span>
                    <span className={`badge ${episode.transcriptUrl ? "badgeCompleted" : "badgePending"}`} style={{ fontSize: "0.75rem" }}>
                      {episode.transcriptUrl ? "Ready" : "Pending"}
                    </span>
                    <span style={{ fontSize: "0.8rem", color: "#cbd5e1", marginLeft: "1rem" }}>Show Notes:</span>
                    <span className={`badge ${episode.longShowNotes ? "badgeCompleted" : "badgePending"}`} style={{ fontSize: "0.75rem" }}>
                      {episode.longShowNotes ? "Ready" : "Pending"}
                    </span>
                    {episode.transcriptUrl && (
                      <a
                        href={episode.transcriptUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: "0.75rem", color: "#38bdf8", textDecoration: "underline", fontWeight: 600, marginLeft: "1rem" }}
                      >
                        [Open Transcript]
                      </a>
                    )}
                    {(episode.status === "audio_ready" || episode.status === "content_ready") && (
                      <Link
                        href={`/admin/content-assets/${activeScript.id}`}
                        style={{ fontSize: "0.75rem", color: "#38bdf8", textDecoration: "underline", fontWeight: 600, marginLeft: "auto" }}
                      >
                        [View Content Assets Detail]
                      </Link>
                    )}
                  </div>
                  {episode.longShowNotes && (
                    <div style={{ marginTop: "0.5rem", borderTop: "1px solid #161f30", paddingTop: "0.5rem" }}>
                      <details>
                        <summary style={{ cursor: "pointer", fontWeight: 600, color: "#38bdf8", fontSize: "0.85rem" }}>
                          View Show Notes Preview
                        </summary>
                        <pre style={{ margin: "0.5rem 0 0 0", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono), monospace", fontSize: "0.8rem", color: "#cbd5e1", lineHeight: 1.5, maxHeight: "200px", overflowY: "auto", padding: "0.5rem" }}>
                          {episode.longShowNotes}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              </div>

              {activeScript.plainText ? (
                <details open style={{ textAlign: "left" }}>
                  <summary style={{ cursor: "pointer", fontWeight: 600, color: "#38bdf8", fontSize: "0.85rem", marginBottom: "0.5rem" }}>
                    View Script Transcript Preview
                  </summary>
                  <div style={{ marginTop: "0.5rem", borderTop: "1px solid #161f30", paddingTop: "0.75rem" }}>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono), monospace", fontSize: "0.8rem", color: "#cbd5e1", lineHeight: 1.5, maxHeight: "300px", overflowY: "auto", padding: "0.5rem" }}>
                      {activeScript.plainText}
                    </pre>
                  </div>
                </details>
              ) : (
                <div style={{ color: "#64748b", fontSize: "0.85rem", fontStyle: "italic" }}>
                  Transcript content is currently empty or generating.
                </div>
              )}
            </div>
          );
        })()}

        {/* Generate / Force Regenerate Action buttons */}
        <div style={{ display: "flex", justifyContent: "center", gap: "1rem" }}>
          {generating ? (
            <button className="buttonPrimary" disabled style={{ opacity: 0.7, cursor: "not-allowed" }}>
              ⏳ Generating script...
            </button>
          ) : scripts.length === 0 ? (
            <button
              onClick={() => handleGenerateScriptClick(false)}
              className="buttonPrimary"
            >
              Generate Script
            </button>
          ) : (
            <button
              onClick={() => handleGenerateScriptClick(true)}
              className="editButton"
            >
              Force Regenerate Script (v{scripts.length + 1})
            </button>
          )}
        </div>

        {scriptMsg && (
          <div
            style={{
              marginTop: "1.25rem",
              padding: "0.75rem",
              borderRadius: "4px",
              fontSize: "0.85rem",
              fontWeight: 500,
              backgroundColor: scriptMsg.type === "success" ? "rgba(16, 185, 129, 0.1)" : "rgba(239, 68, 68, 0.1)",
              border: `1px solid ${scriptMsg.type === "success" ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)"}`,
              color: scriptMsg.type === "success" ? "#10b981" : "#ef4444",
              display: "inline-block",
            }}
          >
            {scriptMsg.text}
          </div>
        )}
      </div>
    </div>
  );
}
