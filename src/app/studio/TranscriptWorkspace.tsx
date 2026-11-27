"use client";

// Step 4 — editable transcript + inline citation chips + fact-check panel with
// a publish HARD GATE. All data is real: citations resolve from the records a
// line's evidenceRefs point at; per-line status and the gate come from the
// latest FactCheckResult. Editing a line marks it dirty (→ unresolved until a
// re-check). The publish action is refused server-side while any claim is
// unresolved — this component only reflects that refusal.

import React, { useCallback, useEffect, useState } from "react";
import {
  getEpisodeTranscript,
  saveLineEdit,
  requestLineVariant,
  regenerateEpisodeScript,
  regenerateLineAudio,
  attemptPublish,
} from "../app/create/actions";
import type { TranscriptVM, TranscriptLineVM, Citation, FactStatus } from "@/lib/services/transcriptView";
import PanelSkeleton from "./PanelSkeleton";
import PassageReviser from "./episodes/[id]/PassageReviser";
import { QUALITY_CHANGED } from "./episodes/[id]/QualityInspector";
import { MAX_PASSAGE_LINES } from "@/lib/services/passageRevision";
import { PLAYER_SEEK, PLAYER_TIME } from "./episodes/[id]/playerBus";

/** Where each line sits in the finished audio, as a fraction of its length.
 *  Approximate (the same line timeline the mix view draws). */
export type LineTimes = Record<number, { start: number; end: number }>;

const FACT_META: Record<FactStatus, { label: string; cls: string; glyph: string }> = {
  verified: { label: "Verified", cls: "fact-ok", glyph: "✓" },
  unverified: { label: "Unverified", cls: "fact-warn", glyph: "!" },
  failed: { label: "Failed", cls: "fact-err", glyph: "✕" },
};

const TYPE_LABEL: Record<string, string> = {
  newsItem: "News",
  injury: "Injury",
  game: "Game",
  oddsSnapshot: "Odds",
  teamStat: "Team stat",
  playerStat: "Player stat",
  research: "Research",
};

export default function TranscriptWorkspace({
  episodeId,
  initialVm,
  showPublish = true,
  canRevoice = false,
  lineTimes,
  onChanged,
}: {
  episodeId: string;
  initialVm?: TranscriptVM;
  /** Present once the episode has finished audio: lines can be played from. */
  lineTimes?: LineTimes;
  showPublish?: boolean;
  /** When the episode is fully voiced, per-line actions re-synthesize that one
   *  line's audio + re-splice (Step 5) instead of just recording the intent. */
  canRevoice?: boolean;
  onChanged?: () => void;
}) {
  const [vm, setVm] = useState<TranscriptVM | null>(initialVm ?? null);
  const [loading, setLoading] = useState(!initialVm);

  const refresh = useCallback(async () => {
    try {
      const next = (await getEpisodeTranscript(episodeId)) as TranscriptVM;
      setVm(next);
      onChanged?.();
      // The quality report reads the same data; keep it in step.
      window.dispatchEvent(new Event(QUALITY_CHANGED));
    } catch {
      /* keep last snapshot */
    } finally {
      setLoading(false);
    }
  }, [episodeId, onChanged]);

  useEffect(() => {
    if (!initialVm) refresh();
  }, [initialVm, refresh]);

  if (loading && !vm) return <PanelSkeleton label="Loading the transcript" rows={6} />;
  if (!vm || !vm.ok) return <div className="emptyNote">{vm?.error || "No transcript available yet."}</div>;
  if (!vm.scriptId || vm.segments.length === 0) {
    return <div className="emptyNote">The script isn&apos;t written yet — it appears here once the debate is generated.</div>;
  }

  // Seat-indexed colours (Prompt 7): seats 0-3 -> the four host tokens.
  const SEAT_COLORS = ["var(--host-a)", "var(--host-b)", "var(--host-c)", "var(--host-d)"];
  const colorFor = (speaker: string) => {
    const s = speaker.trim().toLowerCase();
    const seat = vm.cast.findIndex((h) => h.name.toLowerCase() === s);
    return seat >= 0 ? SEAT_COLORS[Math.min(seat, SEAT_COLORS.length - 1)] : "var(--text-muted)";
  };

  return (
    <div className="transcriptWorkspace">
      <TranscriptEditor vm={vm} episodeId={episodeId} colorFor={colorFor} canRevoice={canRevoice} lineTimes={lineTimes} onChanged={refresh} />
      <FactCheckPanel vm={vm} episodeId={episodeId} showPublish={showPublish} onChanged={refresh} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Editable transcript                                                */
/* ------------------------------------------------------------------ */

function TranscriptEditor({
  vm,
  episodeId,
  colorFor,
  canRevoice,
  lineTimes,
  onChanged,
}: {
  vm: TranscriptVM;
  episodeId: string;
  colorFor: (s: string) => string;
  canRevoice: boolean;
  lineTimes?: LineTimes;
  onChanged: () => void;
}) {
  // ---- Passage selection (for AI revision) ----
  // A passage is consecutive lines. The first tick sets the anchor; ticking
  // another line extends the passage to it; ticking inside shrinks it.
  const order = React.useMemo(() => vm.segments.flatMap((s) => s.lines.map((l) => l.lineIndex)), [vm.segments]);
  const [sel, setSel] = useState<{ from: number; to: number } | null>(null); // positions in `order`
  const selected = (lineIndex: number) => {
    const at = order.indexOf(lineIndex);
    return !!sel && at >= sel.from && at <= sel.to;
  };
  const toggleSelect = (lineIndex: number) => {
    const at = order.indexOf(lineIndex);
    setSel((prev) => {
      if (!prev) return { from: at, to: at };
      if (at === prev.from && at === prev.to) return null;
      if (at >= prev.from && at <= prev.to) return { from: prev.from, to: Math.max(prev.from, at - 1) }; // shrink to just above
      const from = Math.min(prev.from, at);
      const to = Math.max(prev.to, at);
      return to - from + 1 > MAX_PASSAGE_LINES ? (at < prev.from ? { from: at, to: at + MAX_PASSAGE_LINES - 1 } : { from: at - MAX_PASSAGE_LINES + 1, to: at }) : { from, to };
    });
  };

  // ---- Follow the player ----
  // The player reports its position many times a second; state changes only
  // when the LINE being spoken changes, so the transcript is not re-rendered
  // on every frame.
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  useEffect(() => {
    if (!lineTimes) return;
    const spans = Object.entries(lineTimes).map(([k, t]) => ({ lineIndex: Number(k), ...t }));
    const onTime = (e: Event) => {
      const frac = (e as CustomEvent<number>).detail;
      const hit = spans.find((t) => frac >= t.start && frac < t.end);
      setPlayingIndex(hit ? hit.lineIndex : null);
    };
    window.addEventListener(PLAYER_TIME, onTime);
    return () => window.removeEventListener(PLAYER_TIME, onTime);
  }, [lineTimes]);
  const playingLine = (lineIndex: number) => playingIndex === lineIndex;

  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busyLine, setBusyLine] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const beginEdit = (line: TranscriptLineVM) => {
    setEditing(line.lineIndex);
    setDraft(line.text);
    setNote(null);
  };

  const saveEdit = async (lineIndex: number) => {
    setBusyLine(lineIndex);
    try {
      const res: any = await saveLineEdit(episodeId, lineIndex, draft);
      if (res?.success === false) {
        setNote(res.error || "Couldn't save that edit.");
        return;
      }
      setEditing(null);
      // Text edit → new line audio: if the episode is voiced, re-synthesize
      // ONLY this line and re-splice so the new words are actually heard.
      if (canRevoice) {
        const rv: any = await regenerateLineAudio(episodeId, lineIndex);
        setNote(
          rv?.success === false
            ? `Saved. ${rv.error}`
            : `Saved — re-voicing line #${lineIndex + 1} with the new text (one line of TTS, then a re-splice).`
        );
      }
      await onChanged();
    } finally {
      setBusyLine(null);
    }
  };

  const variant = async (lineIndex: number, v: "spicier" | "calmer" | "regenerate") => {
    setBusyLine(lineIndex);
    try {
      // When the episode is voiced, per-line actions actually re-voice that ONE
      // line + re-splice (Step 5). Otherwise they record the intent (Step 4).
      const res: any = canRevoice
        ? await regenerateLineAudio(episodeId, lineIndex, v === "regenerate" ? undefined : { tone: v })
        : await requestLineVariant(episodeId, lineIndex, v);
      if (res?.success === false) setNote(res.error || "Couldn't request that.");
      else {
        setNote(
          canRevoice
            ? `Re-voicing line #${lineIndex + 1} — only this line is re-synthesized, then the mix is re-spliced.`
            : null
        );
        await onChanged();
      }
    } finally {
      setBusyLine(null);
    }
  };

  const [regenBusy, setRegenBusy] = useState(false);
  const regen = async (tone?: "spicier" | "calmer" | "regenerate") => {
    setRegenBusy(true);
    try {
      const res: any = await regenerateEpisodeScript(episodeId, tone);
      setNote(res?.success === false ? res.error : "Rewriting the whole script — it'll refresh here shortly.");
      if (res?.success !== false) await onChanged();
    } finally {
      setRegenBusy(false);
    }
  };

  return (
    <div className="studioCard transcriptCard">
      <div className="transcriptHead">
        <div className="sectionTitle m-0">Transcript</div>
        <div className="transcriptLegend">
          <span><span className="legendSwatch" data-seat="a" />{vm.hostA.name}</span>
          <span><span className="legendSwatch" data-seat="b" />{vm.hostB.name}</span>
        </div>
      </div>

      {note && <div className="createAlert mb-4" role="status">{note}</div>}

      {sel ? (
        <PassageReviser
          key={`${sel.from}-${sel.to}`}
          episodeId={episodeId}
          startLineIndex={order[sel.from]}
          endLineIndex={order[sel.to]}
          lineCount={sel.to - sel.from + 1}
          voiced={canRevoice}
          onCancel={() => setSel(null)}
          onDone={async (message) => { setSel(null); setNote(message); await onChanged(); }}
        />
      ) : (
        <p className="stageHint mb-3">Tick lines to select a passage and have it revised to your instruction, or click any line to edit it by hand.</p>
      )}

      <div className="transcriptScroller">
        {vm.segments.map((seg, si) => (
          <div key={si} className="transcriptSeg">
            <div className="chip chipAccent transcriptSegTag">{seg.title}</div>
            {seg.lines.map((line) => {
              const color = colorFor(line.speaker);
              const isEditing = editing === line.lineIndex;
              return (
                <div
                  key={line.lineIndex}
                  id={`line-${line.lineIndex}`}
                  tabIndex={-1}
                  className={`tLine${line.dirty ? " tLine-dirty" : ""}${selected(line.lineIndex) ? " tLine-selected" : ""}${playingLine(line.lineIndex) ? " tLine-playing" : ""}`}
                >
                  <div className="tLineHead">
                    <input
                      type="checkbox"
                      className="tSelect"
                      checked={selected(line.lineIndex)}
                      onChange={() => toggleSelect(line.lineIndex)}
                      aria-label={`Select line ${line.lineIndex + 1} (${line.speaker}) for revision`}
                    />
                    {lineTimes?.[line.lineIndex] && (
                      <button
                        type="button"
                        className="tMini tPlayFrom"
                        aria-label={`Play from line ${line.lineIndex + 1}`}
                        title="Play from here (position is approximate)"
                        onClick={() => window.dispatchEvent(new CustomEvent(PLAYER_SEEK, { detail: lineTimes[line.lineIndex].start }))}
                      >
                        ▶
                      </button>
                    )}
                    <span className="tSpeaker" style={{ "--speaker-color": color } as React.CSSProperties}>{line.speaker}</span>
                    {line.factStatus && <FactPill status={line.factStatus} reason={line.factReason} />}
                    {line.dirty && <span className="chip tDirtyChip" title="Edited since the last fact check">Edited</span>}
                    {line.requestedTone && <span className="chip" title="Requested variant (applied on regeneration)">{line.requestedTone}</span>}
                  </div>

                  {isEditing ? (
                    <div className="tEditRow">
                      <textarea className="textarea tEditArea" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} />
                      <div className="tEditActions">
                        <button className="btnPrimary" onClick={() => saveEdit(line.lineIndex)} disabled={busyLine === line.lineIndex} aria-busy={busyLine === line.lineIndex}>
                          {busyLine === line.lineIndex && <span className="btnSpin" aria-hidden="true" />}
                          {busyLine === line.lineIndex ? "Saving…" : "Save"}
                        </button>
                        <button className="btnGhost" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="tText"
                      onClick={() => beginEdit(line)}
                      title="Click to edit this line"
                    >
                      {line.text}
                    </button>
                  )}

                  {line.citations.length > 0 && (
                    <div className="tCites">
                      {line.citations.map((c) => (
                        <CitationChip key={c.key} c={c} />
                      ))}
                    </div>
                  )}

                  {!isEditing && (
                    <div className="tLineActions">
                      <button className="tMini" onClick={() => variant(line.lineIndex, "spicier")} disabled={busyLine === line.lineIndex}>🌶 Spicier</button>
                      <button className="tMini" onClick={() => variant(line.lineIndex, "calmer")} disabled={busyLine === line.lineIndex}>🧊 Calmer</button>
                      <button
                        className="tMini"
                        onClick={() => variant(line.lineIndex, "regenerate")}
                        disabled={busyLine === line.lineIndex}
                        aria-busy={busyLine === line.lineIndex}
                        title={
                          canRevoice && (vm.ttsRenderMode === "scene" || vm.ttsRenderMode === "mixed_fallback")
                            ? "Scene-voiced episode: re-voicing regenerates this line's whole scene (with its surrounding conversation) so the performance stays continuous."
                            : undefined
                        }
                      >
                        {busyLine === line.lineIndex ? (
                          <><span className="btnSpin" aria-hidden="true" />Working…</>
                        ) : canRevoice ? (
                          vm.ttsRenderMode === "scene" || vm.ttsRenderMode === "mixed_fallback"
                            ? "↻ Re-voice scene"
                            : "↻ Re-voice line"
                        ) : (
                          "↻ Regenerate"
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="transcriptFoot">
        <span className="stageHint m-0">
          Per-line variants mark the line for the next rewrite. Regenerate rewrites the whole script now:
        </span>
        <div className="transcriptRegen">
          <button className="btnGhost" onClick={() => regen("spicier")} disabled={regenBusy}>Rewrite spicier</button>
          <button className="btnGhost" onClick={() => regen("calmer")} disabled={regenBusy}>Rewrite calmer</button>
          <button className="btnGhost" onClick={() => regen("regenerate")} disabled={regenBusy}>{regenBusy ? "Queuing…" : "Regenerate"}</button>
        </div>
      </div>
    </div>
  );
}

function CitationChip({ c }: { c: Citation }) {
  const label = TYPE_LABEL[c.type] || c.type;
  const inner = (
    <>
      <span className="citeType">{label}</span>
      <span className="citeName">{c.name}</span>
      {c.url && <span className="citeLink" aria-hidden="true">↗</span>}
    </>
  );
  if (c.url) {
    return (
      <a className="citeChip citeChip-link" href={c.url} target="_blank" rel="noopener noreferrer" title={`${label}: ${c.name} — open source`}>
        {inner}
      </a>
    );
  }
  return (
    <span className="citeChip" title={`${label}: ${c.name} (no external link)`}>
      {inner}
    </span>
  );
}

function FactPill({ status, reason }: { status: FactStatus; reason: string | null }) {
  const m = FACT_META[status];
  return (
    <span className={`factPill ${m.cls}`} title={reason || m.label}>
      <span className="factGlyph" aria-hidden="true">{m.glyph}</span>
      {m.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Fact-check panel + publish gate                                    */
/* ------------------------------------------------------------------ */

function FactCheckPanel({
  vm,
  episodeId,
  showPublish,
  onChanged,
}: {
  vm: TranscriptVM;
  episodeId: string;
  showPublish: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const counts = vm.claims.reduce(
    (acc, c) => {
      acc[c.status]++;
      return acc;
    },
    { verified: 0, unverified: 0, failed: 0 } as Record<FactStatus, number>
  );

  const publish = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res: any = await attemptPublish(episodeId);
      if (res?.success) {
        setResult({ ok: true, message: "Published to the feed." });
        await onChanged();
      } else {
        setResult({ ok: false, message: res?.error || "Publish was refused." });
      }
    } finally {
      setBusy(false);
    }
  };

  const fcStatus = vm.factCheck.status;
  const fcTone = fcStatus === "passed" ? "fact-ok" : fcStatus === "failed" ? "fact-err" : "fact-warn";
  const fcLabel = !vm.factCheck.present ? "Not fact-checked" : fcStatus === "passed" ? "Fact check passed" : fcStatus === "failed" ? "Fact check failed" : "Needs review";

  return (
    <div className="studioCard factPanel">
      <div className="sectionTitle mb-3">Fact check</div>

      <div className="factSummary">
        <span className={`factPill ${fcTone}`}>
          <span className="factGlyph" aria-hidden="true">{fcStatus === "passed" ? "✓" : fcStatus === "failed" ? "✕" : "!"}</span>
          {fcLabel}
        </span>
        {vm.factCheck.coveragePercent != null && (
          <span className="stageHint m-0">{vm.factCheck.coveragePercent}% evidence coverage</span>
        )}
      </div>

      <div className="factCounts">
        <span className="factCount fact-ok"><span className="factGlyph">✓</span>{counts.verified} verified</span>
        <span className="factCount fact-warn"><span className="factGlyph">!</span>{counts.unverified} unverified</span>
        <span className="factCount fact-err"><span className="factGlyph">✕</span>{counts.failed} failed</span>
      </div>

      {vm.claims.length === 0 ? (
        <div className="stageHint">No factual claims detected in this script.</div>
      ) : (
        <ul className="claimList">
          {vm.claims.map((c) => {
            const m = FACT_META[c.status];
            return (
              <li key={c.lineIndex} className={`claimRow ${m.cls}`}>
                <span className={`factPill ${m.cls}`} title={c.reason || m.label}>
                  <span className="factGlyph" aria-hidden="true">{m.glyph}</span>
                  {m.label}
                </span>
                <span className="claimText">{c.text}</span>
                {c.citationCount > 0 && <span className="claimCites">{c.citationCount} src</span>}
              </li>
            );
          })}
        </ul>
      )}

      {showPublish && (
        <div className="publishGate">
          {!vm.gate.canPublish && (
            <div className="gateReasons" role="status">
              <strong>Publish is blocked.</strong>{" "}
              {vm.gate.reasons.join(" ")}
            </div>
          )}
          <button className="btnPrimary" onClick={publish} disabled={busy} aria-disabled={busy}>
            {busy ? "Checking…" : "Publish to feed"}
          </button>
          {result && (
            <div className={`gateResult ${result.ok ? "gate-ok" : "gate-err"}`} role="alert">
              {result.message}
            </div>
          )}
          {vm.gate.unresolvedCount > 0 && (
            <p className="stageHint m-0">
              Review or regenerate the {vm.gate.unresolvedCount} flagged claim{vm.gate.unresolvedCount === 1 ? "" : "s"} above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
