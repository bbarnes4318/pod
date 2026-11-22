"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  answerAdaptiveQuestion, askAdaptiveQuestions, approveBusinessScript, cancelBusinessRun, decideOpportunity,
  generateBusinessEpisode, refineOpportunity, regenerateBusinessScript, startBusinessResearch, startDossier,
} from "../businessActions";

type Depth = "QUICK" | "STANDARD" | "DEEP";
type Res = { success: true } | { success: false; error: string };

/** Runs one server action, shows its error inline, refreshes on success. */
function useAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Res>, onOk?: () => void) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.success) return setError(res.error);
      onOk?.();
      router.refresh();
    });
  return { pending, error, run };
}

const ErrorLine = ({ error }: { error: string | null }) => (error ? <span role="alert" className="bizError">{error}</span> : null);

export function StartResearch({ podcastId, running }: { podcastId: string; running: boolean }) {
  const { pending, error, run } = useAction();
  const [depth, setDepth] = useState<Depth>("STANDARD");
  return (
    <span className="bizRow">
      <select className="input bizSelect" value={depth} onChange={(e) => setDepth(e.target.value as Depth)} aria-label="Research depth">
        <option value="QUICK">Quick scan</option>
        <option value="STANDARD">Standard</option>
        <option value="DEEP">Deep research</option>
      </select>
      <button className="btnPrimary" disabled={pending || running} data-testid="start-business-research" onClick={() => run(() => startBusinessResearch(podcastId, depth))}>
        {running ? "Research running…" : pending ? "Starting…" : "Research topics"}
      </button>
      <ErrorLine error={error} />
    </span>
  );
}

export function CancelRun({ podcastId, runId }: { podcastId: string; runId: string }) {
  const { pending, error, run } = useAction();
  return (
    <span className="bizRow">
      <button className="btnGhost" disabled={pending} onClick={() => run(() => cancelBusinessRun(podcastId, runId))}>Cancel</button>
      <ErrorLine error={error} />
    </span>
  );
}

export function AskQuestions({ podcastId }: { podcastId: string }) {
  const { pending, error, run } = useAction();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="bizRow">
      <button
        className="btnGhost"
        disabled={pending}
        onClick={() => run(async () => {
          const r = await askAdaptiveQuestions(podcastId);
          if (r.success) setNote(r.asked ? `${r.asked} new question${r.asked === 1 ? "" : "s"}` : r.note ?? "No questions needed.");
          return r;
        })}
      >
        {pending ? "Thinking…" : "Ask me a few questions"}
      </button>
      {note && <span className="bizNote" role="status">{note}</span>}
      <ErrorLine error={error} />
    </span>
  );
}

export function AdaptiveQuestion({ podcastId, id, question, why }: { podcastId: string; id: string; question: string; why?: string | null }) {
  const { pending, error, run } = useAction();
  const [answer, setAnswer] = useState("");
  return (
    <div className={pending ? "bizFinding isPending" : "bizFinding"}>
      <label className="bizStackTight">
        <span className="fieldLabel">{question}</span>
        {why && <span className="bizNote">{why}</span>}
        <textarea className="textarea bizAnswer" maxLength={4000} value={answer} onChange={(e) => setAnswer(e.target.value)} />
      </label>
      <span className="bizRow">
        <button className="btnPrimary" disabled={pending || !answer.trim()} onClick={() => run(() => answerAdaptiveQuestion(podcastId, id, answer))}>Save answer</button>
        <button className="btnGhost" disabled={pending} onClick={() => run(() => answerAdaptiveQuestion(podcastId, id, null))}>Skip</button>
        <ErrorLine error={error} />
      </span>
    </div>
  );
}

export function OpportunityActions({ podcastId, opportunityId, status, dossierStatus }: {
  podcastId: string; opportunityId: string; status: string; dossierStatus: string | null;
}) {
  const { pending, error, run } = useAction();
  const router = useRouter();
  const dossierBusy = dossierStatus === "RESEARCHING";
  return (
    <span className="bizFindingActions">
      {status !== "PRODUCED" && status !== "REJECTED" && (
        <button className="btnGhost" disabled={pending || dossierBusy} onClick={() => run(() => startDossier(podcastId, opportunityId))}>
          {dossierBusy ? "Researching…" : dossierStatus ? "Re-research dossier" : "Research dossier"}
        </button>
      )}
      {(status === "CANDIDATE" || status === "HELD") && (
        <button className="btnGhost" disabled={pending} onClick={() => run(() => decideOpportunity(podcastId, opportunityId, "approve"))}>Approve</button>
      )}
      {status === "APPROVED" && (
        <button
          className="btnPrimary"
          disabled={pending || dossierStatus !== "READY"}
          title={dossierStatus !== "READY" ? "The dossier must be READY first" : undefined}
          onClick={() => run(async () => {
            const r = await generateBusinessEpisode(podcastId, opportunityId);
            if (r.success) router.push(`/studio/shows/${podcastId}?tab=episodes`);
            return r;
          })}
        >
          Generate episode
        </button>
      )}
      {status !== "REJECTED" && status !== "PRODUCED" && (
        <button className="btnGhost" disabled={pending} onClick={() => run(() => decideOpportunity(podcastId, opportunityId, "reject"))}>Reject</button>
      )}
      {(status === "REJECTED" || status === "APPROVED") && (
        <button className="btnGhost" disabled={pending} onClick={() => run(() => decideOpportunity(podcastId, opportunityId, "reopen"))}>Reopen</button>
      )}
      <ErrorLine error={error} />
    </span>
  );
}

export function RefineOpportunity({ podcastId, opportunityId, title, coreQuestion, targetListener }: {
  podcastId: string; opportunityId: string; title: string; coreQuestion: string; targetListener: string;
}) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState({ title, coreQuestion, targetListener });
  const field = (k: keyof typeof v, label: string) => (
    <label>
      <span className="fieldLabel">{label}</span>
      <input className="input" maxLength={300} value={v[k]} onChange={(e) => setV((p) => ({ ...p, [k]: e.target.value }))} />
    </label>
  );
  return (
    <details className="bizDetails">
      <summary>Refine angle</summary>
      <div className="bizDetailsBody">
        {field("title", "Title")}
        {field("coreQuestion", "Core question")}
        {field("targetListener", "Target listener")}
        <span className="bizRow">
          <button className="btnPrimary" disabled={pending} onClick={() => run(() => refineOpportunity(podcastId, opportunityId, v))}>Save refinement</button>
          <span className="bizNote">Saving puts the topic back to review and its dossier on hold until re-researched.</span>
          <ErrorLine error={error} />
        </span>
      </div>
    </details>
  );
}

export function ScriptActions({ podcastId, episodeId, canApprove }: { podcastId: string; episodeId: string; canApprove: boolean }) {
  const { pending, error, run } = useAction();
  return (
    <span className="bizFindingActions">
      {canApprove && (
        <button className="btnPrimary" disabled={pending} onClick={() => run(() => approveBusinessScript(podcastId, episodeId))}>Approve script &amp; fact-check</button>
      )}
      <button className="btnGhost" disabled={pending} onClick={() => run(() => regenerateBusinessScript(podcastId, episodeId))}>Regenerate script</button>
      <ErrorLine error={error} />
    </span>
  );
}
