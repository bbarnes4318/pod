"use client";

// Revise a selected passage with the writing model: instruction → preview →
// accept, try again, or discard. Nothing is saved until Accept, and Accept
// writes through the same path as a hand edit (see applyPassageRevision), so
// the changed lines need a fact re-check and any recording of them is stale.

import React, { useState } from "react";
import { proposePassageRevision, applyPassageRevision } from "../../../app/create/actions";
import type { RevisionPreviewLine } from "@/lib/services/passageRevision";
import { QUALITY_CHANGED } from "./QualityInspector";

const PRESETS = [
  { label: "Tighter", text: "Tighten it. Cut filler and repetition; keep every point." },
  { label: "Sharper disagreement", text: "Make the disagreement sharper and more direct, without adding any new facts." },
  { label: "Plainer", text: "Use plainer, more conversational language." },
  { label: "Smoother hand-offs", text: "Make the hand-offs between the hosts flow more naturally." },
];

export default function PassageReviser({
  episodeId, startLineIndex, endLineIndex, lineCount, voiced, onDone, onCancel,
}: {
  episodeId: string;
  startLineIndex: number;
  endLineIndex: number;
  lineCount: number;
  /** The episode has recorded audio, so accepted changes make lines stale. */
  voiced: boolean;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<"propose" | "apply" | null>(null);
  const [preview, setPreview] = useState<RevisionPreviewLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const propose = async () => {
    setBusy("propose");
    setError(null);
    try {
      const res = await proposePassageRevision(episodeId, startLineIndex, endLineIndex, instruction);
      if (!res.ok) { setError(res.error); return; }
      setPreview(res.lines);
    } catch {
      setError("The rewrite could not be requested. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  };

  const accept = async () => {
    if (!preview) return;
    const edits = preview.filter((l) => l.changed).map((l) => ({ lineIndex: l.lineIndex, before: l.before, after: l.after }));
    setBusy("apply");
    setError(null);
    try {
      const res: any = await applyPassageRevision(episodeId, edits);
      if (res?.success === false) { setError(res.error); return; }
      window.dispatchEvent(new Event(QUALITY_CHANGED));
      const stale = (res.staleAudioLines ?? []).length;
      onDone(
        `${res.changed} line${res.changed === 1 ? "" : "s"} revised. ${res.changed === 1 ? "It needs" : "They need"} a fact re-check before release.` +
          (stale ? ` ${stale} recorded line${stale === 1 ? " no longer matches" : "s no longer match"} the script: re-voice from the quality check on Overview.` : "")
      );
    } catch {
      setError("The revision could not be saved. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  };

  const changed = preview?.filter((l) => l.changed) ?? [];
  const newFigures = changed.flatMap((l) => l.newFigures);
  const factual = changed.filter((l) => l.factual).length;

  return (
    <div className="reviser" role="region" aria-label="Revise the selected passage" data-testid="passage-reviser">
      <div className="reviserHead">
        <strong>Revise {lineCount} selected line{lineCount === 1 ? "" : "s"}</strong>
        <button type="button" className="advLink" onClick={onCancel}>Clear selection</button>
      </div>

      {!preview ? (
        <>
          <label className="fieldLabel" htmlFor="reviseInstruction">What should change?</label>
          <textarea id="reviseInstruction" className="textarea u-full" rows={2} maxLength={400} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="e.g. Cut this in half and land on the question" />
          <div className="reviserPresets">
            {PRESETS.map((p) => (
              <button key={p.label} type="button" className="chip" onClick={() => setInstruction(p.text)}>{p.label}</button>
            ))}
          </div>
          <div className="reviserBar">
            <button type="button" className="btnPrimary" onClick={propose} disabled={busy !== null || !instruction.trim()} aria-busy={busy === "propose"}>
              {busy === "propose" ? "Writing…" : "Show me a revision"}
            </button>
            <span className="stageHint m-0">One call to the writing model. Nothing is saved until you accept.</span>
          </div>
        </>
      ) : (
        <>
          {changed.length === 0 ? (
            <p className="stageHint">The model returned the passage unchanged. Try a more specific instruction.</p>
          ) : (
            <ol className="reviserDiff">
              {preview.map((l) => (
                <li key={l.lineIndex} className={l.changed ? "reviserLine changed" : "reviserLine"}>
                  <div className="reviserSpeaker">{l.speaker} · line {l.lineIndex + 1}{l.changed ? "" : " · unchanged"}</div>
                  {l.changed ? (
                    <>
                      <p className="reviserBefore"><span className="srOnly">Before: </span>{l.before}</p>
                      <p className="reviserAfter"><span className="srOnly">After: </span>{l.after}</p>
                    </>
                  ) : (
                    <p className="reviserSame">{l.before}</p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {newFigures.length > 0 && (
            <p className="noteWarn" role="alert">
              This revision contains figures that were not in the original passage: {[...new Set(newFigures)].join(", ")}. Check them against your sources before accepting.
            </p>
          )}
          {changed.length > 0 && (
            <p className="stageHint">
              Accepting changes {changed.length} line{changed.length === 1 ? "" : "s"}
              {factual ? `, ${factual} of them carrying a factual claim` : ""}. Changed lines are marked for a fact re-check
              {voiced ? ", and their recordings will need re-voicing" : ""}.
            </p>
          )}
          <div className="reviserBar">
            <button type="button" className="btnPrimary" onClick={accept} disabled={busy !== null || changed.length === 0} aria-busy={busy === "apply"}>
              {busy === "apply" ? "Saving…" : "Accept revision"}
            </button>
            <button type="button" className="btnGhost" onClick={propose} disabled={busy !== null}>{busy === "propose" ? "Writing…" : "Try again"}</button>
            <button type="button" className="btnGhost" onClick={() => setPreview(null)} disabled={busy !== null}>Change the instruction</button>
          </div>
        </>
      )}
      {error && <p className="gateResult gate-err" role="alert">{error}</p>}
    </div>
  );
}
