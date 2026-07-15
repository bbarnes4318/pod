"use client";

// The selected-topic rundown tray: ordered, numbered, lead-story badge,
// keyboard move up/down (never DnD-only), native drag-and-drop, remove, per-item
// readiness / recently-used warnings, and honest episode estimates.

import React, { useRef } from "react";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";
import type { RundownEstimate } from "@/lib/services/episodeEstimate";

export interface RundownTrayProps {
  items: StudioTopicVM[]; // in rundown order
  leadTopicId: string | null;
  maxTopics: number;
  mode: "manual" | "automatic" | "hybrid";
  targetTopicCount: number;
  estimate: RundownEstimate;
  onReorder: (from: number, to: number) => void;
  onRemove: (id: string) => void;
  onSetLead: (id: string) => void;
}

export default function RundownTray({
  items,
  leadTopicId,
  maxTopics,
  mode,
  targetTopicCount,
  estimate,
  onReorder,
  onRemove,
  onSetLead,
}: RundownTrayProps) {
  const dragFrom = useRef<number | null>(null);
  const autoSlots = mode === "hybrid" ? Math.max(0, targetTopicCount - items.length) : mode === "automatic" ? targetTopicCount : 0;
  const effectiveLead = leadTopicId && items.some((t) => t.id === leadTopicId) ? leadTopicId : items[0]?.id ?? null;

  return (
    <div className="studioCard" aria-label="Selected rundown">
      <div className="sectionHead" style={{ marginTop: 0, display: "flex", alignItems: "baseline", gap: "0.6rem" }}>
        <h2 className="sectionTitle" style={{ margin: 0 }}>Rundown</h2>
        <span className="stageHint">
          {items.length}/{maxTopics} selected
          {mode !== "manual" && autoSlots > 0 && ` · ${autoSlots} auto slot${autoSlots === 1 ? "" : "s"}`}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="emptyNote">
          {mode === "automatic"
            ? "Automatic mode fills the rundown for you when you create the episode."
            : "No topics yet — add takes from the board on the left."}
        </div>
      ) : (
        <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          {items.map((t, i) => {
            const isLead = t.id === effectiveLead;
            return (
              <li
                key={t.id}
                className="studioCard"
                draggable
                onDragStart={() => { dragFrom.current = i; }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (dragFrom.current !== null && dragFrom.current !== i) onReorder(dragFrom.current, i); dragFrom.current = null; }}
                style={{ padding: "0.6rem 0.75rem", display: "flex", gap: "0.6rem", alignItems: "center", cursor: "grab" }}
              >
                <span aria-hidden="true" style={{ color: "var(--text-muted)", cursor: "grab" }} title="Drag to reorder">⠿</span>
                <span className="scoreBadge" aria-hidden="true" style={{ width: 26, textAlign: "center", flexShrink: 0 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
                    {isLead && <span className="chip chipAccent" title="Lead story">★ Lead</span>}
                    <span className="epTitle" style={{ fontSize: "0.92rem" }}>{t.title}</span>
                  </div>
                  <div className="epMeta" style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.2rem" }}>
                    <span className="chip">{t.sport}</span>
                    {t.readiness !== "ready" && <span className="chip" style={{ color: "var(--warning-color, #b45309)" }}>⚠ {t.readiness.replace("_", " ")}</span>}
                    {t.usedByShowRecent && <span className="chip" style={{ color: "var(--warning-color, #b45309)" }}>⚠ recently used by this show</span>}
                  </div>
                </div>
                <div className="trayControls" style={{ display: "flex", gap: "0.25rem", flexShrink: 0 }}>
                  <button type="button" className="btnGhost" aria-label={`Move ${t.title} up`} disabled={i === 0} onClick={() => onReorder(i, i - 1)} style={{ padding: "0.2rem 0.45rem" }}>↑</button>
                  <button type="button" className="btnGhost" aria-label={`Move ${t.title} down`} disabled={i === items.length - 1} onClick={() => onReorder(i, i + 1)} style={{ padding: "0.2rem 0.45rem" }}>↓</button>
                  {!isLead && <button type="button" className="btnGhost" aria-label={`Make ${t.title} the lead story`} onClick={() => onSetLead(t.id)} style={{ padding: "0.2rem 0.45rem" }}>★</button>}
                  <button type="button" className="btnGhost" aria-label={`Remove ${t.title} from the rundown`} onClick={() => onRemove(t.id)} style={{ padding: "0.2rem 0.45rem" }}>✕</button>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {/* -------- Estimates (honest) -------- */}
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
