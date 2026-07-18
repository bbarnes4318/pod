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
  onChanged,
}: {
  episodeId: string;
  initialVm?: TranscriptVM;
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
    } catch {
      /* keep last snapshot */
    } finally {
      setLoading(false);
    }
  }, [episodeId, onChanged]);

  useEffect(() => {
    if (!initialVm) refresh();
  }, [initialVm, refresh]);

  if (loading && !vm) return <div className="stageHint">Loading transcript…</div>;
  if (!vm || !vm.ok) return <div className="emptyNote">{vm?.error || "No transcript available yet."}</div>;
  if (!vm.scriptId || vm.segments.length === 0) {
    return <div className="emptyNote">The script isn&apos;t written yet — it appears here once the debate is generated.</div>;
  }

  // Seat-indexed colours (Prompt 7): seats 0-3 -> the four host tokens.
  const SEAT_COLORS = ["var(--host-max)", "var(--host-doc)", "var(--host-3)", "var(--host-4)"];
  const colorFor = (speaker: string) => {
    const s = speaker.trim().toLowerCase();
    const seat = vm.cast.findIndex((h) => h.name.toLowerCase() === s);
    return seat >= 0 ? SEAT_COLORS[Math.min(seat, SEAT_COLORS.length - 1)] : "var(--text-muted)";
  };

  return (
    <div className="transcriptWorkspace">
      <TranscriptEditor vm={vm} episodeId={episodeId} colorFor={colorFor} canRevoice={canRevoice} onChanged={refresh} />
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
  onChanged,
}: {
  vm: TranscriptVM;
  episodeId: string;
  colorFor: (s: string) => string;
  canRevoice: boolean;
  onChanged: () => void;
}) {
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
        <div className="sectionTitle" style={{ margin: 0 }}>Transcript</div>
        <div className="transcriptLegend">
          <span><span className="legendSwatch" style={{ background: "var(--host-max)" }} />{vm.hostA.name}</span>
          <span><span className="legendSwatch" style={{ background: "var(--host-doc)" }} />{vm.hostB.name}</span>
        </div>
      </div>

      {note && <div className="createAlert" role="status" style={{ marginBottom: "0.9rem" }}>{note}</div>}

      <div className="transcriptScroller">
        {vm.segments.map((seg, si) => (
          <div key={si} className="transcriptSeg">
            <div className="chip chipAccent transcriptSegTag">{seg.title}</div>
            {seg.lines.map((line) => {
              const color = colorFor(line.speaker);
              const isEditing = editing === line.lineIndex;
              return (
                <div key={line.lineIndex} className={`tLine${line.dirty ? " tLine-dirty" : ""}`}>
                  <div className="tLineHead">
                    <span className="tSpeaker" style={{ color }}>{line.speaker}</span>
                    {line.factStatus && <FactPill status={line.factStatus} reason={line.factReason} />}
                    {line.dirty && <span className="chip tDirtyChip" title="Edited since the last fact check">Edited</span>}
                    {line.requestedTone && <span className="chip" title="Requested variant (applied on regeneration)">{line.requestedTone}</span>}
                  </div>

                  {isEditing ? (
                    <div className="tEditRow">
                      <textarea className="textarea tEditArea" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} />
                      <div className="tEditActions">
                        <button className="btnPrimary" onClick={() => saveEdit(line.lineIndex)} disabled={busyLine === line.lineIndex}>
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
                      <button className="tMini" onClick={() => variant(line.lineIndex, "regenerate")} disabled={busyLine === line.lineIndex}>
                        {canRevoice ? "↻ Re-voice line" : "↻ Regenerate"}
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
        <span className="stageHint" style={{ margin: 0 }}>
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
      <div className="sectionTitle" style={{ marginBottom: "0.8rem" }}>Fact check</div>

      <div className="factSummary">
        <span className={`factPill ${fcTone}`}>
          <span className="factGlyph" aria-hidden="true">{fcStatus === "passed" ? "✓" : fcStatus === "failed" ? "✕" : "!"}</span>
          {fcLabel}
        </span>
        {vm.factCheck.coveragePercent != null && (
          <span className="stageHint" style={{ margin: 0 }}>{vm.factCheck.coveragePercent}% evidence coverage</span>
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
            <p className="stageHint" style={{ margin: 0 }}>
              Review or regenerate the {vm.gate.unresolvedCount} flagged claim{vm.gate.unresolvedCount === 1 ? "" : "s"} above.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
