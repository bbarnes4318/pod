"use client";

// The selected-topic rundown tray: ordered, numbered, lead-story badge,
// keyboard move up/down (never DnD-only), native drag-and-drop, remove,
// per-topic EXPANSION (summary + research + usage warnings with proper
// aria-expanded/aria-controls), and honest episode estimates.

import React, { useRef, useState } from "react";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";
import type { RundownEstimate } from "@/lib/services/episodeEstimate";

export interface RundownTrayProps {
  items: StudioTopicVM[]; // in rundown order
  leadTopicId: string | null;
  maxTopics: number;
  mode: "manual" | "automatic" | "hybrid";
  targetTopicCount: number;
  estimate: RundownEstimate;
  podcastScoped?: boolean;
  onReorder: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  onSetLead: (id: string) => void;
}

export default function RundownTray({
  items, leadTopicId, maxTopics, mode, targetTopicCount, estimate, podcastScoped, onReorder, onRemove, onSetLead,
}: RundownTrayProps) {
  const dragFrom = useRef<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const autoSlots = mode === "hybrid" ? Math.max(0, targetTopicCount - items.length) : mode === "automatic" ? targetTopicCount : 0;
  const effectiveLead = leadTopicId && items.some((t) => t.id === leadTopicId) ? leadTopicId : items[0]?.id ?? null;

  return (
    <div className="studioCard" aria-label="Selected rundown">
      <div className="sectionHead" style={{ marginTop: 0, display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
        <h2 className="sectionTitle" style={{ margin: 0 }}>Rundown</h2>
        <span className="stageHint" data-testid="tray-count">
          {items.length}/{maxTopics} selected{mode !== "manual" && autoSlots > 0 && ` · ${autoSlots} auto slot${autoSlots === 1 ? "" : "s"}`}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="emptyNote">
          {mode === "automatic" ? "Automatic mode fills the rundown for you when you create the episode." : "No topics yet — add takes from the board on the left."}
        </div>
      ) : (
        <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {items.map((t, i) => {
            const isLead = t.id === effectiveLead;
            const expanded = expandedId === t.id;
            const panelId = `tray-panel-${t.id}`;
            return (
              <li key={t.id} data-testid={`tray-${t.id}`} className="studioCard" draggable
                onDragStart={() => { dragFrom.current = i; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (dragFrom.current !== null && dragFrom.current !== i) onReorder(dragFrom.current, i); dragFrom.current = null; }}
                style={{ padding: "0.55rem 0.7rem" }}>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <span aria-hidden="true" style={{ color: "var(--text-muted)", cursor: "grab" }} title="Drag to reorder">⠿</span>
                  <span className="scoreBadge" aria-hidden="true" style={{ width: 26, textAlign: "center", flexShrink: 0 }}>{i + 1}</span>
                  <button type="button" aria-expanded={expanded} aria-controls={panelId} data-testid={`tray-expand-${t.id}`}
                    onClick={() => setExpandedId(expanded ? null : t.id)}
                    style={{ all: "unset", cursor: "pointer", flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                      {isLead && <span className="chip chipAccent" title="Lead story">★ Lead</span>}
                      <span className="epTitle" style={{ fontSize: "0.9rem" }}>{t.title}</span>
                      <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>{expanded ? "▾" : "▸"}</span>
                    </div>
                    <div className="epMeta" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.2rem" }}>
                      <span className="chip">{t.sport}</span>
                      {t.readiness !== "ready" && <span className="chip" style={{ color: "var(--warning-color, #b45309)" }}>⚠ {t.readiness.replace("_", " ")}</span>}
                      {t.usedByShowRecent && <span className="chip" style={{ color: "var(--warning-color, #b45309)" }}>⚠ recently used by this show</span>}
                    </div>
                  </button>
                  <div className="trayControls">
                    <button type="button" className="btnGhost" aria-label={`Move ${t.title} up`} data-testid={`tray-up-${t.id}`} disabled={i === 0} onClick={() => onReorder(i, i - 1)} style={{ padding: "0.2rem 0.45rem" }}>↑</button>
                    <button type="button" className="btnGhost" aria-label={`Move ${t.title} down`} data-testid={`tray-down-${t.id}`} disabled={i === items.length - 1} onClick={() => onReorder(i, i + 1)} style={{ padding: "0.2rem 0.45rem" }}>↓</button>
                    {!isLead && <button type="button" className="btnGhost" aria-label={`Make ${t.title} the lead story`} data-testid={`tray-lead-${t.id}`} onClick={() => onSetLead(t.id)} style={{ padding: "0.2rem 0.45rem" }}>★</button>}
                    <button type="button" className="btnGhost" aria-label={`Remove ${t.title} from the rundown`} data-testid={`tray-remove-${t.id}`} onClick={() => onRemove(t.id)} style={{ padding: "0.2rem 0.45rem" }}>✕</button>
                  </div>
                </div>
                {expanded && (
                  <div id={panelId} role="region" aria-label={`${t.title} details`} data-testid={`tray-detail-${t.id}`} className="briefBlock" style={{ marginTop: "0.5rem", borderTop: "1px solid var(--border-color, #333)", paddingTop: "0.5rem" }}>
                    {t.summary && <p style={{ fontSize: "0.82rem", margin: "0 0 0.4rem" }}>{t.summary}</p>}
                    <div className="briefMeta" style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", marginBottom: "0.4rem" }}>
                      <span className="chip">Readiness: {t.readiness.replace("_", " ")}</span>
                      {t.usedByYouCount > 0 && <span className="chip">Used by you {t.usedByYouCount}×</span>}
                      {podcastScoped && (t.usedByShowCount ?? 0) > 0 && <span className="chip">Used by this show {t.usedByShowCount}×</span>}
                    </div>
                    {t.usedByShowRecent && <p role="note" style={{ color: "var(--warning-color, #b45309)", fontSize: "0.8rem", margin: "0 0 0.4rem" }}>⚠ Recently used by this show.</p>}
                    {t.brief && (
                      <>
                        {t.brief.mainAngle && <TrayRow label="Main angle" value={t.brief.mainAngle} />}
                        {t.brief.contrarianAngle && <TrayRow label="Contrarian" value={t.brief.contrarianAngle} />}
                        {t.brief.argumentForHostA && <TrayRow label="Host A" value={t.brief.argumentForHostA} />}
                        {t.brief.argumentForHostB && <TrayRow label="Host B" value={t.brief.argumentForHostB} />}
                        {t.brief.strongestDebateQuestion && <TrayRow label="Debate Q" value={t.brief.strongestDebateQuestion} />}
                        {t.brief.keyFacts.length > 0 && (
                          <div style={{ marginTop: "0.35rem" }}>
                            <span className="briefTag">Key facts</span>
                            <ul className="briefPoints">{t.brief.keyFacts.slice(0, 5).map((f, k) => <li key={k}>{f}</li>)}</ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <div className="briefMeta" style={{ marginTop: "0.8rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <span className="chip" title="Estimate">~{estimate.estimatedDurationMinutes} min</span>
        <span className="chip" title="Estimate">~{estimate.estimatedWords.toLocaleString()} words</span>
        <span className="chip" title="Estimate">~{estimate.estimatedTtsCharacters.toLocaleString()} TTS chars</span>
        {estimate.estimatedCostUsd !== null
          ? <span className="chip" title="Estimate — assumes a configured rate">~${estimate.estimatedCostUsd.toFixed(2)}</span>
          : <span className="chip" title={estimate.costBasis}>cost: provider-dependent</span>}
      </div>
      <p className="stageHint" style={{ marginTop: "0.4rem", fontSize: "0.75rem" }}>{estimate.costBasis}</p>
    </div>
  );
}

function TrayRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginTop: "0.35rem" }}>
      <span className="briefTag">{label}</span>
      <span style={{ fontSize: "0.82rem" }}>{value}</span>
    </div>
  );
}
