"use client";

// Reusable multi-topic picker for the rundown builder (Studio now; Admin later).
// Search + Sport/League/Status/Readiness filters, editorial topic cards with
// talkability, readiness, evidence/source counts, scoped usage, a clear
// unavailability reason (never hidden), a research-brief preview, and
// keyboard-accessible multi-select. Only ELIGIBLE topics can be added; an
// ineligible card explains why but cannot be selected.

import React, { useMemo, useState } from "react";
import type { StudioTopicVM, TopicReadiness } from "@/lib/services/studioTopicPool";

const READINESS_LABEL: Record<TopicReadiness, string> = {
  ready: "Ready",
  needs_research: "Needs research",
  not_approved: "Not approved",
  weak_evidence: "Weak evidence",
};
const READINESS_CLASS: Record<TopicReadiness, string> = {
  ready: "chipSuccess",
  needs_research: "chipAccent",
  not_approved: "",
  weak_evidence: "",
};

/** Short chip labels for the shared eligibility WARNING codes (non-blocking). */
const WARNING_LABEL: Record<string, string> = {
  below_automatic_threshold: "below auto threshold",
  filter_mismatch: "outside auto filters",
  recently_used: "recently used",
  already_selected: "in this rundown",
  research_queued: "research queued",
  research_in_progress: "researching",
  research_failed: "research failed",
};

export interface TopicRundownPickerProps {
  topics: StudioTopicVM[];
  selectedIds: string[];
  /** Toggle selection. The parent enforces max-count + mode rules and may reject. */
  onToggle: (id: string) => void;
  /** True in automatic mode — selection is disabled (the backend picks topics). */
  selectionDisabled?: boolean;
  /** Podcast is selected → usage labels say "this show". */
  podcastScoped?: boolean;
  /** Announce to screen readers (added/blocked). */
  announce?: (msg: string) => void;
}

export default function TopicRundownPicker({
  topics,
  selectedIds,
  onToggle,
  selectionDisabled,
  podcastScoped,
  announce,
}: TopicRundownPickerProps) {
  const [query, setQuery] = useState("");
  const [sport, setSport] = useState("");
  const [league, setLeague] = useState("");
  const [status, setStatus] = useState("");
  const [readiness, setReadiness] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sports = useMemo(() => [...new Set(topics.map((t) => t.sport).filter(Boolean))].sort(), [topics]);
  const leagues = useMemo(() => [...new Set(topics.map((t) => t.leagueId).filter(Boolean) as string[])].sort(), [topics]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return topics.filter((t) => {
      if (q && !(`${t.title} ${t.summary ?? ""}`.toLowerCase().includes(q))) return false;
      if (sport && t.sport !== sport) return false;
      if (league && t.leagueId !== league) return false;
      if (status && t.status !== status) return false;
      if (readiness && t.readiness !== readiness) return false;
      return true;
    });
  }, [topics, query, sport, league, status, readiness]);

  const selectedSet = new Set(selectedIds);

  const handleToggle = (t: StudioTopicVM) => {
    if (selectionDisabled) return;
    if (!t.eligible && !selectedSet.has(t.id)) {
      announce?.(`${t.title} can't be added: ${t.unavailableReason ?? "ineligible"}`);
      return;
    }
    onToggle(t.id);
  };

  return (
    <div>
      {/* -------- Filters (BOARD DISPLAY ONLY) -------- */}
      <p className="stageHint" style={{ margin: "0 0 0.4rem" }} data-testid="board-filter-note">
        These filter what you SEE on the board. In Automatic/Hybrid, backend selection is driven by <strong>Selection preferences</strong> above — not by this search.
      </p>
      <div className="rundownFilters">
        <input
          type="search"
          className="input"
          placeholder="Search takes by title or summary…"
          aria-label="Search topics by title or summary"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: "1 1 220px", minWidth: 200 }}
        />
        <select className="input" aria-label="Filter by sport" value={sport} onChange={(e) => setSport(e.target.value)}>
          <option value="">All sports</option>
          {sports.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {leagues.length > 0 && (
          <select className="input" aria-label="Filter by league" value={league} onChange={(e) => setLeague(e.target.value)}>
            <option value="">All leagues</option>
            {leagues.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
        <select className="input" aria-label="Filter by editorial status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="approved">Approved</option>
          <option value="pending">Pending</option>
        </select>
        <select className="input" aria-label="Filter by readiness" value={readiness} onChange={(e) => setReadiness(e.target.value)}>
          <option value="">Any readiness</option>
          <option value="ready">Ready</option>
          <option value="needs_research">Needs research</option>
          <option value="weak_evidence">Weak evidence</option>
          <option value="not_approved">Not approved</option>
        </select>
      </div>

      {selectionDisabled && (
        <p className="stageHint" role="note" style={{ marginBottom: "0.6rem" }}>
          Automatic mode — the studio picks the strongest eligible topics when you create the episode. The board below is a preview; selection is off.
        </p>
      )}

      {/* -------- Cards -------- */}
      {filtered.length === 0 ? (
        <div className="emptyNote">No takes match these filters.</div>
      ) : (
        <ul className="rundownPickerList" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {filtered.map((t) => {
            const selected = selectedSet.has(t.id);
            const canSelect = t.eligible || selected;
            const expanded = expandedId === t.id;
            return (
              <li key={t.id} className="studioCard" style={{ padding: "0.85rem 1rem", opacity: canSelect ? 1 : 0.72 }}>
                <div style={{ display: "flex", gap: "0.85rem", alignItems: "flex-start" }}>
                  <input
                    type="checkbox"
                    data-testid={`pick-${t.id}`}
                    checked={selected}
                    disabled={selectionDisabled || !canSelect}
                    onChange={() => handleToggle(t)}
                    aria-label={`Add ${t.title} to the rundown`}
                    style={{ marginTop: 4, width: 18, height: 18, flexShrink: 0 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="epMeta" style={{ marginBottom: "0.3rem", display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                      <span className="scoreBadge" title="Talkability">{t.talkability}</span>
                      <span className="chip">{t.sport}</span>
                      {t.leagueId && <span className="chip">{t.leagueId}</span>}
                      <span className={`chip ${READINESS_CLASS[t.readiness]}`}>{READINESS_LABEL[t.readiness]}</span>
                      <span className="chip" title="Debate score">Debate {Math.round(t.debateScore)}</span>
                      <span className="chip" title="Evidence items · brief sources">{t.evidenceCount} ev · {t.sourceCount} src</span>
                      {t.usedByYouCount > 0 && <span className="chip">Used by you {t.usedByYouCount}×</span>}
                      {podcastScoped && (t.usedByShowCount ?? 0) > 0 && (
                        <span className="chip">Used by this show {t.usedByShowCount}×</span>
                      )}
                      {podcastScoped && t.lastUsedByShow && (
                        <span className="chip" title="Last used by this show">Last used {relTime(t.lastUsedByShow)}</span>
                      )}
                    </div>
                    <div className="epTitle" style={{ fontSize: "1rem" }}>{t.title}</div>
                    {t.summary && (
                      <div style={{ fontSize: "0.82rem", color: "var(--text-secondary)", marginTop: "0.25rem", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                        {t.summary}
                      </div>
                    )}
                    {/* Blocking reason — the precise one from the shared contract,
                        never a generic "Unavailable". */}
                    {!t.eligible && t.unavailableReason && (
                      <p role="note" data-testid={`blocked-${t.id}`} data-code={t.eligibility.blockingReasons[0]?.code}
                        style={{ margin: "0.4rem 0 0", fontSize: "0.78rem", color: "var(--warning-color, #b45309)" }}>
                        ⚠ {t.unavailableReason}
                      </p>
                    )}
                    {/* Non-blocking warnings — notably "below the automatic
                        threshold", which explains why the auto-picker would skip
                        this topic WITHOUT preventing a manual pick. */}
                    {t.eligibility.warnings.length > 0 && (
                      <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
                        {t.eligibility.warnings.map((w, i) => (
                          <span key={i} className="chip" data-testid={`warn-${t.id}-${w.code}`} title={w.message}
                            style={{ color: "var(--warning-color, #b45309)" }}>
                            {WARNING_LABEL[w.code] ?? w.code.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>
                    )}
                    {t.brief && (
                      <button
                        type="button"
                        className="advLink"
                        aria-expanded={expanded}
                        onClick={() => setExpandedId(expanded ? null : t.id)}
                        style={{ marginTop: "0.4rem" }}
                      >
                        {expanded ? "Hide research" : "Review research"}
                      </button>
                    )}
                  </div>
                </div>
                {expanded && t.brief && <ResearchPreview brief={t.brief} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PreviewRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div style={{ marginTop: "0.5rem" }}>
      <span className="briefTag">{label}</span>
      <span style={{ fontSize: "0.84rem" }}>{value}</span>
    </div>
  );
}

function ResearchPreview({ brief }: { brief: NonNullable<StudioTopicVM["brief"]> }) {
  const Row = PreviewRow;
  return (
    <div className="briefBlock" style={{ marginTop: "0.7rem", borderTop: "1px solid var(--border-color, #333)", paddingTop: "0.7rem" }}>
      <Row label="Main angle" value={brief.mainAngle} />
      <Row label="Contrarian" value={brief.contrarianAngle} />
      <Row label="Why now" value={brief.whyMattersNow} />
      <Row label="Host A" value={brief.argumentForHostA} />
      <Row label="Host B" value={brief.argumentForHostB} />
      <Row label="Debate Q" value={brief.strongestDebateQuestion} />
      <Row label="Injury" value={brief.injuryContext} />
      <Row label="Odds" value={brief.oddsContext} />
      {brief.keyFacts.length > 0 && (
        <div style={{ marginTop: "0.5rem" }}>
          <span className="briefTag">Key facts</span>
          <ul className="briefPoints">{brief.keyFacts.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}
      {brief.stats.length > 0 && (
        <div style={{ marginTop: "0.5rem" }}>
          <span className="briefTag">Stats</span>
          <ul className="briefPoints">{brief.stats.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      {brief.talkingPoints.length > 0 && (
        <div style={{ marginTop: "0.5rem" }}>
          <span className="briefTag">Talking points</span>
          <ul className="briefPoints">{brief.talkingPoints.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {brief.sourceRefs.length > 0 && (
        <div style={{ marginTop: "0.5rem" }}>
          <span className="briefTag">Sources</span>
          <span style={{ fontSize: "0.78rem", color: "var(--text-secondary)" }}>{brief.sourceRefs.join(", ")}</span>
        </div>
      )}
      {brief.flaggedClaimCount > 0 && (
        <p role="note" style={{ marginTop: "0.5rem", fontSize: "0.78rem", color: "var(--warning-color, #b45309)" }}>
          ⚠ {brief.flaggedClaimCount} moderated/flagged claim{brief.flaggedClaimCount === 1 ? "" : "s"} withheld from this preview.
        </p>
      )}
    </div>
  );
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const days = Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}
