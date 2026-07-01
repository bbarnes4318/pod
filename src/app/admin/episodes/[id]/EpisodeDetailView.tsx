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
          <h3 style={{ fontSize: "1rem", color: "var(--text-primary)", marginBottom: "1rem", marginTop: 0 }}>Edit Episode Metadata</h3>
          
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
            <div className="alertCard alertDanger" style={{ fontSize: "0.85rem", marginBottom: "1rem" }}>{errorMsg}</div>
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
        <h3 style={{ color: "var(--text-primary)", fontSize: "1.1rem", fontWeight: 700, marginBottom: "1.5rem" }}>Debate Lineup</h3>
        
        {episode.topics.map((topic, idx) => {
          const brief = topic.brief;

          return (
            <div key={topic.id} className="detailTopicCard">
              <div className="detailTopicHeader">
                <div>
                  <span style={{ color: "var(--accent-color)", fontWeight: 700, marginRight: "0.75rem" }}>Topic #{idx + 1}</span>
                  <span className="detailTopicTitle">{topic.title}</span>
                </div>
                <span className="refBadge" style={{ fontSize: "0.75rem", color: "var(--accent-color)" }}>
                  Debate Score: {Math.round(topic.debateScore)}
                </span>
              </div>

              <div className="detailTopicBody">
                {topic.summary && (
                  <div>
                    <span className="sectionGroupLabel">Brief Summary</span>
                    <p style={{ fontSize: "0.9rem", color: "var(--text-primary)", lineHeight: 1.5, margin: 0 }}>
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
                          <li key={fIdx} style={{ fontSize: "0.85rem", color: "var(--text-primary)" }}>
                            <span>{fact.text}</span>
                            <span style={{ fontSize: "0.65rem", textTransform: "uppercase", fontWeight: 700, padding: "0.05rem 0.25rem", borderRadius: "4px", marginLeft: "0.5rem", backgroundColor: "var(--bg-tertiary)", color: "var(--text-secondary)", border: "1px solid var(--border-color)" }}>
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
                          <li key={sIdx} style={{ fontSize: "0.85rem", color: "var(--text-primary)" }}>
                            {stat.text}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Injury Context */}
                    {brief.injuryContext && (
                      <div>
                        <span className="sectionGroupLabel">Injury Context</span>
                        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.5, margin: 0, backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", padding: "0.75rem", borderRadius: "6px" }}>
                          {brief.injuryContext}
                        </p>
                      </div>
                    )}

                    {/* Odds Context */}
                    {brief.oddsContext && (
                      <div>
                        <span className="sectionGroupLabel">Odds Context</span>
                        <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.5, margin: 0, backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", padding: "0.75rem", borderRadius: "6px" }}>
                          {brief.oddsContext}
                        </p>
                      </div>
                    )}

                    {/* Host arguments */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.5rem", marginTop: "0.5rem" }}>
                      <div style={{ backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderLeft: "4px solid var(--error-color)", padding: "1rem", borderRadius: "6px" }}>
                        <span style={{ color: "var(--error-color)", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", display: "block", marginBottom: "0.5rem" }}>
                          Max Voltage Debate Stance
                        </span>
                        <p style={{ fontSize: "0.85rem", color: "var(--text-primary)", lineHeight: 1.5, margin: 0 }}>
                          {brief.argumentForHostA}
                        </p>
                      </div>

                      <div style={{ backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderLeft: "4px solid var(--accent-color)", padding: "1rem", borderRadius: "6px" }}>
                        <span style={{ color: "var(--accent-color)", fontSize: "0.75rem", fontWeight: 700, textTransform: "uppercase", display: "block", marginBottom: "0.5rem" }}>
                          Dr. Linebreak Debate Stance
                        </span>
                        <p style={{ fontSize: "0.85rem", color: "var(--text-primary)", lineHeight: 1.5, margin: 0 }}>
                          {brief.argumentForHostB}
                        </p>
                      </div>
                    </div>

                    {/* Dialogue counter arguments */}
                    <div>
                      <span className="sectionGroupLabel">Host Counterpoints</span>
                      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        {getArray(brief.counterArguments).map((item: DialogueItem, caIdx) => (
                          <div key={caIdx} style={{ fontSize: "0.85rem", padding: "0.6rem 0.85rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "6px", display: "flex", gap: "0.5rem" }}>
                            <span style={{ fontWeight: 700, color: item.host === "Dr. Linebreak" ? "var(--accent-color)" : "var(--error-color)" }}>
                              {item.host}:
                            </span>
                            <span style={{ color: "var(--text-primary)" }}>{item.claim}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Unsafe claims */}
                    {getArray(brief.unsafeClaims).length > 0 && (
                      <div>
                        <span className="sectionGroupLabel" style={{ color: "var(--error-color)" }}>Unsafe / Unverified Claims</span>
                        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                          {getArray(brief.unsafeClaims).map((claim: UnsafeClaimItem, ucIdx) => (
                            <div key={ucIdx} className="unsafeClaimItem">
                              <p style={{ fontSize: "0.85rem", color: "var(--text-primary)", margin: 0 }}>"{claim.claim}"</p>
                              <span style={{ fontSize: "0.75rem", color: "var(--error-color)", fontWeight: 600 }}>Reason: {claim.reason}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Source counts */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--border-color)", paddingTop: "1rem", marginTop: "0.5rem" }}>
                      <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                        Topic ID: <span style={{ fontFamily: "var(--font-mono)" }}>{topic.id}</span>
                      </span>
                      <span className="refBadge" style={{ fontSize: "0.7rem" }}>
                        {getArray(brief.sourceIds).length} Fact Sources
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="alertCard alertWarning" style={{ margin: 0 }}>
                    ⚠️ No Research Brief exists for this topic candidate. Wait for brief generation before launching script generation.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Script Console */}
      <div className="panel" style={{ padding: "1.5rem", marginTop: "2rem" }}>
        <div className="panelHeader" style={{ borderBottom: "none", paddingBottom: 0 }}>
          <h3 className="panelTitle" style={{ fontSize: "1.1rem" }}>Dialogue Script Console</h3>
        </div>
        <div className="panelContent">
          <p style={{ color: "var(--text-secondary)", fontSize: "0.85rem", maxWidth: "700px", marginBottom: "1.5rem", lineHeight: 1.4 }}>
            Generate the spoken dialogue script for the hosts. The debate is composed entirely from grounded research briefs, matching the host personalities.
          </p>

          {/* Script Selection Dropdown */}
          {scripts.length > 0 && (
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "1rem", marginBottom: "1.5rem" }}>
              <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>Script Versions:</span>
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

            const isApproved = activeScript.status === "approved" || activeScript.status === "ready" || activeScript.status === "script_approved";

            return (
              <div style={{ border: "1px solid var(--border-color)", borderRadius: "8px", backgroundColor: "var(--bg-primary)", padding: "1.25rem", marginBottom: "1.5rem" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid var(--border-color)", paddingBottom: "0.75rem", marginBottom: "0.75rem" }}>
                  <div>
                    <span style={{ fontWeight: 700, color: "var(--text-primary)", marginRight: "0.75rem", fontSize: "0.95rem" }}>Version {activeScript.version}</span>
                    <span className={`badge ${isApproved ? "badgeCompleted" : activeScript.status === "rejected" ? "badgeFailed" : "badgePending"}`}>
                      {activeScript.status}
                    </span>
                  </div>
                  <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                    Created {new Date(activeScript.createdAt).toLocaleString()}
                  </span>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", alignItems: "center", marginBottom: "1rem" }}>
                  <div style={{ display: "flex", gap: "1rem", justifyContent: "center" }}>
                    {isApproved ? (
                      <div style={{ color: "var(--success-color)", fontWeight: 700, fontSize: "0.85rem" }}>
                        ✓ Script Approved (Episode Status: script_approved)
                      </div>
                    ) : (
                      <Link
                        href={`/admin/scripts/${activeScript.id}`}
                        className="buttonPrimary"
                        style={{ fontSize: "0.8rem", padding: "0.4rem 0.85rem", textDecoration: "none" }}
                      >
                        Review & Edit Script
                      </Link>
                    )}

                    {/* Direct link for approved script inspect reviews */}
                    {isApproved && (
                      <Link
                        href={`/admin/scripts/${activeScript.id}`}
                        className="editButton"
                        style={{ fontSize: "0.8rem", padding: "0.4rem 0.85rem", textDecoration: "none" }}
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
                      <div style={{ display: "flex", width: "100%", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0.75rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "6px", marginTop: "0.25rem" }}>
                        <span style={{ fontSize: "0.8rem", color: "var(--text-primary)" }}>Fact Check Audit:</span>
                        <span className={`badge ${badgeClass}`} style={{ fontSize: "0.7rem" }}>
                          {label}
                        </span>
                        <Link
                          href={`/admin/fact-checks/${latestFactCheck.id}`}
                          style={{ fontSize: "0.75rem", color: "var(--accent-color)", textDecoration: "underline", fontWeight: 600 }}
                        >
                          [View Audit Report]
                        </Link>
                      </div>
                    );
                  })()}

                  {/* TTS Audio segment readiness status */}
                  {activeScript.audioSegments && (
                    <div style={{ display: "flex", width: "100%", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0.75rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "6px", marginTop: "0.25rem" }}>
                      <span style={{ fontSize: "0.8rem", color: "var(--text-primary)" }}>Audio Segment Readiness:</span>
                      <span className="badge" style={{ fontSize: "0.7rem", backgroundColor: activeScript.audioSegments.readyCount === activeScript.audioSegments.totalLines ? "var(--success-muted)" : "var(--warning-muted)", color: activeScript.audioSegments.readyCount === activeScript.audioSegments.totalLines ? "var(--success-color)" : "var(--warning-color)", border: activeScript.audioSegments.readyCount === activeScript.audioSegments.totalLines ? "1px solid var(--success-border)" : "1px solid var(--warning-border)" }}>
                        Ready: {activeScript.audioSegments.readyCount} / {activeScript.audioSegments.totalLines} lines
                      </span>
                      {activeScript.audioSegments.failedCount > 0 && (
                        <span className="badge badgeFailed" style={{ fontSize: "0.7rem" }}>
                          Failed: {activeScript.audioSegments.failedCount} lines
                        </span>
                      )}
                      <Link
                        href={`/admin/audio-segments/${activeScript.id}`}
                        style={{ fontSize: "0.75rem", color: "var(--accent-color)", textDecoration: "underline", fontWeight: 600 }}
                      >
                        [View TTS Console]
                      </Link>
                    </div>
                  )}

                  {/* Final Audio readiness badge and player */}
                  <div style={{ display: "flex", width: "100%", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0.75rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "6px", marginTop: "0.25rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                      <span style={{ fontSize: "0.8rem", color: "var(--text-primary)" }}>Final Stitch Status:</span>
                      <span className={`badge ${episode.status === "audio_ready" || episode.status === "published" || episode.status === "publish_ready" ? "badgeCompleted" : "badgePending"}`} style={{ fontSize: "0.7rem" }}>
                        {episode.status === "audio_ready" ? "Audio Ready" : episode.status}
                      </span>
                      {episode.status === "audio_ready" && episode.durationSeconds && (
                        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)" }}>
                          Duration: {Math.floor(episode.durationSeconds / 60)}m {episode.durationSeconds % 60}s
                        </span>
                      )}
                      <Link
                        href={`/admin/final-audio/${activeScript.id}`}
                        style={{ fontSize: "0.75rem", color: "var(--accent-color)", textDecoration: "underline", fontWeight: 600 }}
                      >
                        [Open Stitch Console]
                      </Link>
                    </div>
                    {episode.audioUrl && (
                      <div style={{ marginTop: "0.5rem", borderTop: "1px solid var(--border-color)", paddingTop: "0.5rem" }}>
                        <audio src={episode.audioUrl} controls style={{ width: "100%", height: "36px" }} />
                      </div>
                    )}
                  </div>

                  {/* Content Assets status and links */}
                  <div style={{ display: "flex", width: "100%", flexDirection: "column", gap: "0.5rem", padding: "0.5rem 0.75rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "6px", marginTop: "0.25rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
                      <span style={{ fontSize: "0.8rem", color: "var(--text-primary)" }}>Transcript:</span>
                      <span className={`badge ${episode.transcriptUrl ? "badgeCompleted" : "badgePending"}`} style={{ fontSize: "0.7rem" }}>
                        {episode.transcriptUrl ? "Ready" : "Pending"}
                      </span>
                      <span style={{ fontSize: "0.8rem", color: "var(--text-primary)", marginLeft: "1rem" }}>Show Notes:</span>
                      <span className={`badge ${episode.longShowNotes ? "badgeCompleted" : "badgePending"}`} style={{ fontSize: "0.7rem" }}>
                        {episode.longShowNotes ? "Ready" : "Pending"}
                      </span>
                      {episode.transcriptUrl && (
                        <a
                          href={episode.transcriptUrl}
                          target="_blank"
                          rel="noreferrer"
                          style={{ fontSize: "0.75rem", color: "var(--accent-color)", textDecoration: "underline", fontWeight: 600, marginLeft: "1rem" }}
                        >
                          [Open Transcript]
                        </a>
                      )}
                      {(episode.status === "audio_ready" || episode.status === "content_ready" || episode.status === "publish_ready" || episode.status === "published") && (
                        <Link
                          href={`/admin/content-assets/${activeScript.id}`}
                          style={{ fontSize: "0.75rem", color: "var(--accent-color)", textDecoration: "underline", fontWeight: 600, marginLeft: "auto" }}
                        >
                          [View Content Assets Detail]
                        </Link>
                      )}
                    </div>
                    {episode.longShowNotes && (
                      <div style={{ marginTop: "0.5rem", borderTop: "1px solid var(--border-color)", paddingTop: "0.5rem" }}>
                        <details>
                          <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent-color)", fontSize: "0.8rem" }}>
                            View Show Notes Preview
                          </summary>
                          <pre style={{ margin: "0.5rem 0 0 0", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono), monospace", fontSize: "0.75rem", color: "var(--text-primary)", lineHeight: 1.5, maxHeight: "200px", overflowY: "auto", padding: "0.5rem", backgroundColor: "var(--bg-primary)", border: "1px solid var(--border-color)", borderRadius: "4px" }}>
                            {episode.longShowNotes}
                          </pre>
                        </details>
                      </div>
                    )}
                  </div>

                  {/* RSS Feed & Publishing Prep status */}
                  {(episode.status === "content_ready" || episode.status === "publish_ready" || episode.status === "published") && (
                    <div style={{ display: "flex", width: "100%", alignItems: "center", gap: "0.75rem", padding: "0.5rem 0.75rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "6px", marginTop: "0.25rem" }}>
                      <span style={{ fontSize: "0.8rem", color: "var(--text-primary)" }}>RSS Feed Status:</span>
                      <span className={`badge ${episode.status === "published" ? "badgeCompleted" : episode.status === "publish_ready" ? "badgeRunning" : "badgeWarning"}`} style={{ fontSize: "0.7rem" }}>
                        {episode.status}
                      </span>
                      <Link
                        href={`/admin/rss/${activeScript.id}`}
                        style={{ fontSize: "0.75rem", color: "var(--accent-color)", textDecoration: "underline", fontWeight: 600, marginLeft: "auto" }}
                      >
                        [Open RSS Console]
                      </Link>
                    </div>
                  )}
                </div>

                {activeScript.plainText ? (
                  <details style={{ textAlign: "left", marginTop: "1rem" }}>
                    <summary style={{ cursor: "pointer", fontWeight: 600, color: "var(--accent-color)", fontSize: "0.8rem", marginBottom: "0.5rem" }}>
                      View Script Transcript Preview
                    </summary>
                    <div style={{ marginTop: "0.5rem", borderTop: "1px solid var(--border-color)", paddingTop: "0.75rem" }}>
                      <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "var(--font-mono), monospace", fontSize: "0.75rem", color: "var(--text-primary)", lineHeight: 1.5, maxHeight: "300px", overflowY: "auto", padding: "0.5rem", backgroundColor: "var(--bg-secondary)", border: "1px solid var(--border-color)", borderRadius: "4px" }}>
                        {activeScript.plainText}
                      </pre>
                    </div>
                  </details>
                ) : (
                  <div style={{ color: "var(--text-secondary)", fontSize: "0.8rem", fontStyle: "italic", marginTop: "1rem" }}>
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
              className={`alertCard ${scriptMsg.type === "success" ? "alertSuccess" : "alertDanger"}`}
              style={{ marginTop: "1.25rem", marginBottom: 0 }}
            >
              {scriptMsg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
