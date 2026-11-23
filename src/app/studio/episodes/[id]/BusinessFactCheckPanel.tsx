"use client";

// Business fact-check, made inspectable: the three verification layers as
// separate states, every detected claim with its outcome, and — when semantic
// verification is unavailable or inconclusive — the attributable human review
// that is the only manual way past it. A review never relabels a claim as
// verified; the claim list keeps its original statuses.

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { recordBusinessFactReviewAction, rerunBusinessFactCheckAction } from "./actions";
import { claimsNeedingReview, type BusinessFactReview, type BusinessVerification, type ClaimDecision, type ClaimOutcome, type ClaimStatus } from "@/lib/business/businessVerification";

const STATE_COPY: Record<string, string> = {
  DETERMINISTIC_CHECK_PASSED: "Deterministic checks passed",
  FACT_CHECK_FAILED: "Failed",
  SEMANTIC_VERIFICATION_PASSED: "Independent verification passed",
  SEMANTIC_VERIFICATION_UNAVAILABLE: "Independent verification unavailable",
  SEMANTIC_VERIFICATION_FAILED: "Independent verification found problems",
  FACT_CHECK_PASSED: "Fact-check passed",
  NEEDS_HUMAN_REVIEW: "Needs human review",
};

const CLAIM_COPY: Record<ClaimStatus, string> = {
  SUPPORTED: "Supported by its cited evidence (independently checked)",
  CITED_UNVERIFIED: "Cited, but not independently checked",
  INSUFFICIENT_EVIDENCE: "Cited evidence doesn't establish it",
  CONTRADICTED: "Contradicted by its evidence",
  UNSUPPORTED: "No evidence cited",
  NOT_A_CLAIM: "Not presented as fact",
};

export interface BusinessFactCheckPanelProps {
  episodeId: string;
  verification: BusinessVerification | null;
  review: BusinessFactReview | null;
  claims: ClaimOutcome[];
  /** False when the script text changed after the check. */
  current: boolean;
  /** True when the latest script is approved, so a fact-check can be (re)run. */
  canRun?: boolean;
}

export default function BusinessFactCheckPanel({ episodeId, verification, review, claims, current, canRun = false }: BusinessFactCheckPanelProps) {
  const router = useRouter();
  const [rerunning, setRerunning] = useState(false);
  const [rerunMsg, setRerunMsg] = useState<string | null>(null);
  const rerun = async () => {
    setRerunning(true);
    setRerunMsg(null);
    const res = (await rerunBusinessFactCheckAction(episodeId)) as { success: boolean; error?: string };
    setRerunMsg(res.success ? "Fact-check queued — this page updates when it finishes." : res.error || "Couldn't queue the fact-check.");
    setRerunning(false);
    if (res.success) router.refresh();
  };
  const rerunButton = (label: string, primary: boolean) =>
    canRun ? (
      <div className="gate-actions">
        <button type="button" className={primary ? "btnPrimary" : "btnGhost"} onClick={rerun} disabled={rerunning}>
          {rerunning ? "Queuing…" : label}
        </button>
        {rerunMsg && <span className="epNoteSmall" role="status">{rerunMsg}</span>}
      </div>
    ) : null;
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [decisions, setDecisions] = useState<Record<string, { decision: ClaimDecision | ""; note: string }>>({});
  const keyOf = (c: { lineIndex: number; text: string }) => `${c.lineIndex}|${c.text}`;
  const setDecision = (k: string, patch: Partial<{ decision: ClaimDecision | ""; note: string }>) =>
    setDecisions((d) => ({ ...d, [k]: { ...(d[k] ?? { decision: "", note: "" }), ...patch } }));

  if (!verification) {
    return (
      <section className="studio-panel gate-panel gate-review" aria-label="Business fact-check">
        <div className="gate-head"><span className="gate-badge">Not fact-checked</span></div>
        <p className="gate-blurb">This business script hasn&apos;t been fact-checked. Voicing and publishing stay locked until it is.</p>
        {rerunButton("Run fact-check", true)}
      </section>
    );
  }

  const tone = !current ? "gate-review" : verification.overall === "FACT_CHECK_PASSED" ? "gate-pass" : verification.overall === "FACT_CHECK_FAILED" ? "gate-hold" : "gate-review";
  const flagged = claimsNeedingReview(claims);
  const allDecided = flagged.every((c) => decisions[keyOf(c)]?.decision && (decisions[keyOf(c)]?.note.trim().length ?? 0) >= 15);
  const shown = showAll ? claims : flagged;
  const canReview = current && verification.overall === "NEEDS_HUMAN_REVIEW";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const dispositions = flagged.map((c) => ({ lineIndex: c.lineIndex, text: c.text, decision: decisions[keyOf(c)]?.decision, note: decisions[keyOf(c)]?.note ?? "" }));
      const res = (await recordBusinessFactReviewAction(episodeId, reason, dispositions)) as { success: boolean; error?: string };
      if (!res.success) setError(res.error || "Couldn't record the review.");
      else router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`studio-panel gate-panel ${tone}`} aria-label="Business fact-check">
      <div className="gate-head">
        <span className="gate-badge">
          {!current ? "Script changed since check" : STATE_COPY[verification.overall]}
          {current && verification.basis === "HUMAN_REVIEW" ? " (human review)" : ""}
        </span>
      </div>
      <dl className="gate-provenance">
        <dt>Deterministic</dt>
        <dd className={verification.deterministic === "FACT_CHECK_FAILED" ? "gate-warn" : undefined}>{STATE_COPY[verification.deterministic]}</dd>
        <dt>Independent</dt>
        <dd className={verification.semantic === "SEMANTIC_VERIFICATION_PASSED" ? undefined : "gate-warn"}>
          {STATE_COPY[verification.semantic]}{verification.judge ? ` · ${verification.judge}` : ""}
        </dd>
        <dt>Checked</dt>
        <dd>{new Date(verification.checkedAt).toLocaleString()}</dd>
      </dl>
      {!current && <p className="gate-blurb">The text was edited after this check. Re-run the fact-check before voicing.</p>}
      {!current ? rerunButton("Re-run fact-check", true) : verification.overall !== "FACT_CHECK_PASSED" ? rerunButton("Re-run fact-check", false) : null}
      {review && current && (
        <p className="gate-blurb">
          Reviewed by <strong>{review.actor}</strong> on {new Date(review.at).toLocaleString()}: &ldquo;{review.reason}&rdquo;.{" "}
          {review.unresolved.length} claim{review.unresolved.length === 1 ? " was" : "s were"} decided by the reviewer, not independently verified.
        </p>
      )}
      {review && current && review.unresolved.length > 0 && (
        <ul className="gate-reasons">
          {review.unresolved.map((u, i) => (
            <li key={i}>
              <strong>Line {u.lineIndex}</strong> · was {CLAIM_COPY[u.status]} · {u.decision === "VERIFIED_BY_REVIEWER" ? "checked by the reviewer" : "judged not a factual claim"}
              <br />
              <span className="epNoteSmall">&ldquo;{u.text}&rdquo; — {u.note}</span>
            </li>
          ))}
        </ul>
      )}
      {verification.reasons.length > 0 && verification.overall !== "FACT_CHECK_PASSED" && (
        <ul className="gate-reasons">
          {verification.reasons.slice(0, 6).map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}

      {claims.length > 0 && (
        <details className="epOpsDetails mt-3" open={flagged.length > 0 && flagged.length <= 12}>
          <summary>
            {claims.length} claim{claims.length === 1 ? "" : "s"} detected · {flagged.length} not independently verified
          </summary>
          <ul className="gate-reasons mt-3">
            {shown.map((c, i) => (
              <li key={i}>
                <strong>Line {c.lineIndex}</strong> · {CLAIM_COPY[c.status]}
                {c.detectedBy.includes("writer_label") ? "" : " · found by the checker, not labelled by the writer"}
                <br />
                <span className="epNoteSmall">&ldquo;{c.text}&rdquo;{c.note ? ` — ${c.note}` : ""}</span>
                {(c.evidence ?? []).map((e) => (
                  <span key={e.factId} className="epNoteSmall">
                    <br />Cited {e.factId}: {e.claim} · source says &ldquo;{e.quote}&rdquo; ·{" "}
                    <a href={e.url} target="_blank" rel="noopener noreferrer">open source</a>
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {claims.length !== flagged.length && (
            <button type="button" className="btnGhost mt-3" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show only unverified claims" : "Show all claims"}
            </button>
          )}
        </details>
      )}

      {canReview && (
        <div className="gate-release-confirm mt-3">
          <p>
            Independent verification couldn&apos;t confirm everything. Decide each of the {flagged.length} unverified
            claim{flagged.length === 1 ? "" : "s"} below. Wrong or unsupported? Fix the line in the Transcript tab, then press
            Re-run fact-check above. Your name, decisions and notes are stored; the claims stay marked as not
            independently verified.
          </p>
          <ol className="gate-reasons">
            {flagged.map((c) => {
              const k = keyOf(c);
              const d = decisions[k];
              return (
                <li key={k}>
                  <strong>Line {c.lineIndex}</strong> · {CLAIM_COPY[c.status]}
                  <br />
                  <span className="epNoteSmall">&ldquo;{c.text}&rdquo;</span>
                  {(c.evidence ?? []).map((e) => (
                    <span key={e.factId} className="epNoteSmall">
                      <br />Cited {e.factId}: source says &ldquo;{e.quote}&rdquo; ·{" "}
                      <a href={e.url} target="_blank" rel="noopener noreferrer">open source</a>
                    </span>
                  ))}
                  <label className="gate-release-note">
                    <span>Your decision</span>
                    <select value={d?.decision ?? ""} onChange={(e) => setDecision(k, { decision: e.target.value as ClaimDecision | "" })}>
                      <option value="">Choose…</option>
                      <option value="VERIFIED_BY_REVIEWER">I checked it against a source and it is accurate</option>
                      <option value="NOT_A_FACTUAL_CLAIM">It is opinion or framing, not a statement of fact</option>
                    </select>
                  </label>
                  <label className="gate-release-note">
                    <span>{d?.decision === "NOT_A_FACTUAL_CLAIM" ? "Why it isn't a factual claim" : `What you checked${c.factIds.length ? "" : " (include the source URL)"}`}</span>
                    <textarea value={d?.note ?? ""} onChange={(e) => setDecision(k, { note: e.target.value })} rows={2} />
                  </label>
                </li>
              );
            })}
          </ol>
          <label className="gate-release-note">
            <span>Summary of your review</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="e.g. Checked lines 4, 12 and 30 against the cited NAIC report and the carrier's rate page" />
          </label>
          <div className="gate-release-buttons">
            <button type="button" className="btnPrimary" onClick={submit} disabled={busy || reason.trim().length < 10 || !allDecided}>
              {busy ? "Recording…" : "Record my factual review"}
            </button>
          </div>
          {error && <p className="gate-release-err" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
