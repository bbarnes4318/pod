"use client";

// Business fact-check, made inspectable: the three verification layers as
// separate states, every detected claim with its outcome, and — when semantic
// verification is unavailable or inconclusive — the attributable human review
// that is the only manual way past it. A review never relabels a claim as
// verified; the claim list keeps its original statuses.

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { recordBusinessFactReviewAction } from "./actions";
import type { BusinessFactReview, BusinessVerification, ClaimOutcome, ClaimStatus } from "@/lib/business/businessVerification";

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
}

export default function BusinessFactCheckPanel({ episodeId, verification, review, claims, current }: BusinessFactCheckPanelProps) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (!verification) {
    return (
      <section className="studio-panel gate-panel gate-review" aria-label="Business fact-check">
        <div className="gate-head"><span className="gate-badge">Not fact-checked</span></div>
        <p className="gate-blurb">This business script hasn&apos;t been fact-checked. Voicing and publishing stay locked until it is.</p>
      </section>
    );
  }

  const tone = !current ? "gate-review" : verification.overall === "FACT_CHECK_PASSED" ? "gate-pass" : verification.overall === "FACT_CHECK_FAILED" ? "gate-hold" : "gate-review";
  const flagged = claims.filter((c) => c.status !== "SUPPORTED" && c.status !== "NOT_A_CLAIM");
  const shown = showAll ? claims : flagged;
  const canReview = current && verification.overall === "NEEDS_HUMAN_REVIEW";

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = (await recordBusinessFactReviewAction(episodeId, reason)) as { success: boolean; error?: string };
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
      {review && current && (
        <p className="gate-blurb">
          Reviewed by <strong>{review.actor}</strong> on {new Date(review.at).toLocaleString()}: &ldquo;{review.reason}&rdquo;.{" "}
          {review.unresolved.length} claim{review.unresolved.length === 1 ? " was" : "s were"} accepted without independent verification.
        </p>
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
            Independent verification couldn&apos;t confirm everything. You can record that <strong>you</strong> checked the
            {" "}{flagged.length} unverified claim{flagged.length === 1 ? "" : "s"} against the sources. Your name, your note and
            the exact claims are stored; they stay marked as not independently verified.
          </p>
          <label className="gate-release-note">
            <span>What did you check?</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="e.g. Checked lines 4, 12 and 30 against the cited NAIC report and the carrier's rate page" />
          </label>
          <div className="gate-release-buttons">
            <button type="button" className="btnPrimary" onClick={submit} disabled={busy || reason.trim().length < 10}>
              {busy ? "Recording…" : "Record my factual review"}
            </button>
          </div>
          {error && <p className="gate-release-err" role="alert">{error}</p>}
        </div>
      )}
    </section>
  );
}
