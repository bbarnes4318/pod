"use client";

// The control that clears an editorial hold. It shows the operator exactly what
// they are signing off — the current reason list — because the release is
// recorded against those specific strings.

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { releaseScriptFromEditorialHold, revokeScriptEditorialRelease } from "./actions";

export interface ReleaseFromHoldProps {
  episodeId: string;
  decision: string;
  reasons: string[];
  /** Present when a release has already been recorded. */
  releasedBy?: string | null;
}

export default function ReleaseFromHold({ episodeId, decision, reasons, releasedBy }: ReleaseFromHoldProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onRelease = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await releaseScriptFromEditorialHold(episodeId, {
        expectedDecision: decision as never,
        note,
        resumeVoices: true,
      })) as { success?: boolean; error?: string; warning?: string; resumed?: boolean };
      if (res?.success === false) {
        setError(res.error || "Couldn't record the release.");
        return;
      }
      setDone(
        res?.warning
          ? `Released — but voicing didn't start: ${res.warning}`
          : res?.resumed
            ? "Released. Recording voices now."
            : "Released."
      );
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't record the release.");
    } finally {
      setBusy(false);
    }
  };

  const onRevoke = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await revokeScriptEditorialRelease(episodeId)) as { success?: boolean; error?: string };
      if (res?.success === false) {
        setError(res.error || "Couldn't revoke the release.");
        return;
      }
      setDone(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  if (releasedBy) {
    return (
      <div className="gate-release-actions">
        <button type="button" className="btnGhost" onClick={onRevoke} disabled={busy}>
          {busy ? "Working…" : "Revoke release"}
        </button>
        <p className="gate-release-hint">Revoking puts this script back under the gate.</p>
      </div>
    );
  }

  return (
    <div className="gate-release-actions">
      {done && <p className="gate-release-ok" role="status">{done}</p>}
      {!open && !done && (
        <button type="button" className="btnPrimary" onClick={() => setOpen(true)}>
          Release for production anyway
        </button>
      )}

      {open && (
        <div className="gate-release-confirm">
          <p>
            You are recording that you have read and accepted{" "}
            <strong>
              {reasons.length} problem{reasons.length === 1 ? "" : "s"}
            </strong>{" "}
            with this script, and that it should be voiced regardless. Your name and these reasons are stored on the
            episode.
          </p>
          <label className="gate-release-note">
            <span>Why (optional)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="e.g. shipping for a timing test; alternation reads fine out loud"
            />
          </label>
          <div className="gate-release-buttons">
            <button type="button" className="btnPrimary" onClick={onRelease} disabled={busy}>
              {busy ? "Releasing…" : "Confirm release and record voices"}
            </button>
            <button type="button" className="btnGhost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="gate-release-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
