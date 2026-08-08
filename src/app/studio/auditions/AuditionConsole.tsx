"use client";

// The blind listening room.
//
// Everything this component receives about a candidate under vote is opaque:
// a ballot id, a letter, and an audio URL. Provider, voice id and model are not
// in the props, are not in the actions it calls, and are not fetchable from
// here — the server projection drops them (see BALLOT_SELECT in
// src/lib/services/voiceAudition.ts). Identity only appears after the audition
// has been unblinded, which requires a winner to already be locked.

import React, { useMemo, useState } from "react";
import StudioPageHeader from "../StudioPageHeader";
import { useRouter } from "next/navigation";
import type {
  AuditionDimension,
  AuditionScores,
  BlindBallot,
  BlindTallyRow,
} from "@/lib/services/voiceAudition";
import {
  addCandidateAction,
  castVoteAction,
  createAuditionAction,
  openVotingAction,
  promoteWinnerAction,
  revealAuditionAction,
  rollbackPromotionAction,
  selectWinnerAction,
} from "./actions";

// Exhaustive by construction: adding a dimension to the service breaks this
// object until the UI is updated too.
const DIMENSION_COPY: Record<AuditionDimension, { label: string; low: string; high: string; help: string }> = {
  characterFit: {
    label: "Character fit",
    low: "Wrong person",
    high: "Is the character",
    help: "Could this be the host as written, or is it a competent stranger reading their lines?",
  },
  identityConsistency: {
    label: "Identity consistency",
    low: "Drifts",
    high: "Same person throughout",
    help: "Scene 8 against scene 1. Age, accent, weight and placement should not wander.",
  },
  listenerFatigue: {
    label: "Stamina (anti-fatigue)",
    low: "Tiring by minute three",
    high: "Could listen for an hour",
    help: "Rate what you felt at the END of the audition, not at the start.",
  },
  spontaneity: {
    label: "Spontaneity",
    low: "Reading aloud",
    high: "Thinking out loud",
    help: "Does the thought arrive as it is spoken, or does it arrive pre-packaged?",
  },
  intelligibility: {
    label: "Intelligibility",
    low: "Had to re-listen",
    high: "Effortless",
    help: "Names, numbers, and the fast angry passages in scene 6.",
  },
  emotionalRange: {
    label: "Emotional range",
    low: "One colour",
    high: "Cold to furious to quiet",
    help: "Compare scene 2, scene 6 and scene 7. Loud is not range.",
  },
  interruptionQuality: {
    label: "Interruption quality",
    low: "Politely queued",
    high: "Could not wait",
    help: "Scene 3 only. A calm cut-in is the clearest tell of synthetic conversation.",
  },
  pairChemistry: {
    label: "Pair chemistry",
    low: "Two monologues",
    high: "One conversation",
    help: "Same partner voice every time. Do they sound like they are in a room together?",
  },
};

const DIMENSIONS = Object.keys(DIMENSION_COPY) as AuditionDimension[];

const PROVIDERS = ["fish", "boson", "cartesia", "elevenlabs", "openai", "stub"] as const;

export interface HostOptionVM {
  id: string;
  name: string;
  hasVoice: boolean;
  ownedByMe: boolean;
}

export interface RevealedVM {
  ballotId: string;
  blindLabel: string;
  privateLabel: string | null;
  provider: string;
  voiceId: string;
  model: string | null;
  performanceScore: number | null;
  loudnessRangeLu: number | null;
  durationSec: number | null;
  isWinner: boolean;
}

export interface AuditionVM {
  id: string;
  title: string;
  notes: string | null;
  status: string;
  hostId: string | null;
  hostName: string;
  packVersion: string;
  policyVersion: number;
  createdAt: string;
  candidateCount: number;
  draftEntries: Array<{ label: string; rendered: boolean; problem: string | null }> | null;
  ballots: BlindBallot[];
  tally: BlindTallyRow[];
  myVotes: Record<string, { scores: AuditionScores; overall: number; notes: string | null }>;
  winnerBallotId: string | null;
  winnerSelectedAt: string | null;
  unblinded: boolean;
  revealed: RevealedVM[] | null;
}

/**
 * The voice change log as the browser is allowed to see it: who changed which
 * host, when, why, and whether it can still be undone. No provider, voice id or
 * model — this object is serialized into the page HTML, and the identity of an
 * engine is not something a page needs in order to offer an undo button.
 */
export interface PromotionVM {
  id: string;
  kind: string;
  status: string;
  hostId: string;
  hostName: string;
  auditionId: string | null;
  actorLabel: string;
  reason: string | null;
  createdAt: string;
  rolledBackAt: string | null;
  revertsPromotionId: string | null;
  canRollback: boolean;
}

export interface PackVM {
  version: string;
  sceneCount: number;
  scenes: Array<{ id: string; title: string; listenFor: string }>;
  totalWords: number;
  estimatedMinutes: number;
}

function shortVoice(voiceId: string | null): string {
  if (!voiceId) return "—";
  return voiceId.length > 12 ? `${voiceId.slice(0, 8)}…${voiceId.slice(-4)}` : voiceId;
}

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

export default function AuditionConsole({
  hosts,
  auditions,
  promotions,
  pack,
  signedIn,
}: {
  hosts: HostOptionVM[];
  auditions: AuditionVM[];
  promotions: PromotionVM[];
  pack: PackVM;
  signedIn: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [showPack, setShowPack] = useState(false);

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Voice auditions"
        subtitle="Several minutes of the same material, listened to blind, scored over length."
        actions={
          <button type="button" className="btnPrimary" onClick={() => setCreating((value) => !value)} disabled={!signedIn}>
            {creating ? "Close" : "New audition"}
          </button>
        }
      />

      <details className="studioNoteDisclosure">
        <summary>How promotion works</summary>
        <p>
        <strong>Nothing is promoted automatically.</strong> Voting picks a winner; changing the voice a
        show actually uses is a separate, deliberate action that records who did it and what it replaced,
        so it can be rolled back.
        </p>
      </details>

      <button type="button" className="advLink" style={{ marginTop: "0.8rem" }} onClick={() => setShowPack((value) => !value)}>
        {showPack ? "Hide" : "What do they perform?"} ({pack.sceneCount} scenes · {pack.totalWords} words · ~{pack.estimatedMinutes} min · {pack.version})
      </button>
      {showPack && (
        <ol className="advNote" style={{ marginTop: "0.6rem", maxWidth: 860, paddingLeft: "1.4rem" }}>
          {pack.scenes.map((scene) => (
            <li key={scene.id} style={{ marginBottom: "0.35rem" }}>
              <strong>{scene.title}</strong> — {scene.listenFor}
            </li>
          ))}
        </ol>
      )}

      {creating && <NewAudition hosts={hosts} onDone={() => setCreating(false)} />}

      {auditions.length === 0 && (
        <div className="emptyNote" style={{ marginTop: "1.5rem" }}>
          No auditions yet. Start one, enter two or more voices, then listen without knowing which is which.
        </div>
      )}

      {auditions.map((audition) => (
        <AuditionCard key={audition.id} audition={audition} hosts={hosts} />
      ))}

      <PromotionHistory promotions={promotions} />
    </div>
  );
}

function NewAudition({ hosts, onDone }: { hosts: HostOptionVM[]; onDone: () => void }) {
  const router = useRouter();
  const editable = hosts.filter((host) => host.ownedByMe);
  const [title, setTitle] = useState("");
  const [hostId, setHostId] = useState(editable[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await createAuditionAction({ title, hostId, notes });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    onDone();
    router.refresh();
  };

  return (
    <section className="advPanel" style={{ marginTop: "1.2rem" }}>
      <div className="advPanelHead">
        <h3>New audition</h3>
      </div>
      <div className="grid2">
        <label className="advField">
          <span className="fieldLabel">Name it</span>
          <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Zabala recast — season 3" />
        </label>
        <label className="advField">
          <span className="fieldLabel">Casting for</span>
          <select className="select" value={hostId} onChange={(event) => setHostId(event.target.value)}>
            {editable.length === 0 && <option value="">No editable hosts</option>}
            {editable.map((host) => (
              <option key={host.id} value={host.id}>{host.name}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="advField" style={{ marginTop: "0.6rem" }}>
        <span className="fieldLabel">Why you are running it</span>
        <textarea className="textarea" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>
      {error && <p className="prodNote prodNote--error">{error}</p>}
      <div className="stageActions" style={{ marginTop: "0.8rem" }}>
        <button type="button" className="btnPrimary" onClick={submit} disabled={busy || !title.trim() || !hostId}>
          {busy ? "Creating…" : "Create audition"}
        </button>
        <button type="button" className="btnGhost" onClick={onDone}>Cancel</button>
      </div>
    </section>
  );
}

function AuditionCard({ audition, hosts }: { audition: AuditionVM; hosts: HostOptionVM[] }) {
  const isDraft = audition.status === "draft";
  const isVoting = audition.status === "voting";

  return (
    <section className="advPanel" style={{ marginTop: "1.4rem" }}>
      <div className="advPanelHead">
        <div>
          <h3>{audition.title}</h3>
          <p className="advCardSub">
            Casting {audition.hostName} · {audition.status} · pack {audition.packVersion} · policy v{audition.policyVersion} · {when(audition.createdAt)}
          </p>
        </div>
        <span className="stepPill">{audition.candidateCount} voice{audition.candidateCount === 1 ? "" : "s"}</span>
      </div>
      {audition.notes && <p className="advCardSub">{audition.notes}</p>}

      {isDraft && <DraftStage audition={audition} hosts={hosts} />}
      {!isDraft && <ListeningStage audition={audition} />}
      {!isDraft && !isVoting && <DecisionStage audition={audition} />}
      {audition.revealed && <RevealTable rows={audition.revealed} />}
    </section>
  );
}

function DraftStage({ audition, hosts }: { audition: AuditionVM; hosts: HostOptionVM[] }) {
  const router = useRouter();
  const voiced = hosts.filter((host) => host.hasVoice);
  const [provider, setProvider] = useState<string>("fish");
  const [voiceId, setVoiceId] = useState("");
  const [model, setModel] = useState("");
  const [label, setLabel] = useState("");
  const [partnerHostId, setPartnerHostId] = useState(
    voiced.find((host) => host.id !== audition.hostId)?.id ?? voiced[0]?.id ?? ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const result = await addCandidateAction({
      auditionId: audition.id,
      provider,
      voiceId,
      model,
      privateLabel: label,
      partnerHostId,
    });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setVoiceId("");
    setLabel("");
    setNote(
      result.rendered
        ? `Rendered the full ${audition.packVersion} pack (${result.durationSec ?? "?"}s).`
        : `That voice did not render: ${result.problem}`
    );
    router.refresh();
  };

  const open = async () => {
    setBusy(true);
    setError(null);
    const result = await openVotingAction(audition.id);
    setBusy(false);
    if (!result.success) setError(result.error);
    else router.refresh();
  };

  return (
    <div>
      <p className="advCardSub">
        Enter every voice you want to compare, then open blind voting. Once voting is open the field is
        locked and the running order is reshuffled, so entry order gives nothing away.
      </p>

      {audition.draftEntries && audition.draftEntries.length > 0 && (
        <ul className="claimList">
          {audition.draftEntries.map((entry, index) => (
            <li key={index} className="claimRow">
              <span className="claimText">{entry.label}</span>
              <span className={entry.rendered ? "fact-ok" : "fact-err"}>
                {entry.rendered ? "rendered" : entry.problem || "not rendered"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="grid3" style={{ marginTop: "0.8rem" }}>
        <label className="advField">
          <span className="fieldLabel">Engine</span>
          <select className="select" value={provider} onChange={(event) => setProvider(event.target.value)}>
            {PROVIDERS.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label className="advField">
          <span className="fieldLabel">Voice id</span>
          <input className="input" value={voiceId} onChange={(event) => setVoiceId(event.target.value)} placeholder="32-character reference id" />
        </label>
        <label className="advField">
          <span className="fieldLabel">Model (optional)</span>
          <input className="input" value={model} onChange={(event) => setModel(event.target.value)} placeholder="s2.1-pro" />
        </label>
      </div>
      <div className="grid2">
        <label className="advField">
          <span className="fieldLabel">Your private note</span>
          <input className="input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="incumbent / redesign / cheaper option" />
        </label>
        <label className="advField">
          <span className="fieldLabel">Scene partner (same for all)</span>
          <select className="select" value={partnerHostId} onChange={(event) => setPartnerHostId(event.target.value)}>
            {voiced.length === 0 && <option value="">No host has a voice yet</option>}
            {voiced.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
          </select>
        </label>
      </div>

      {error && <p className="prodNote prodNote--error">{error}</p>}
      {note && <p className="prodNote">{note}</p>}

      <div className="stageActions" style={{ marginTop: "0.8rem" }}>
        <button type="button" className="btnGhost" onClick={add} disabled={busy || !voiceId.trim() || !partnerHostId}>
          {busy ? "Recording the audition…" : "Add voice and record the pack"}
        </button>
        <button type="button" className="btnPrimary" onClick={open} disabled={busy || audition.candidateCount < 2}>
          Open blind voting
        </button>
      </div>
      <p className="stageHint">
        Recording one candidate is a full multi-minute render, so this takes a while per voice.
      </p>
    </div>
  );
}

function ListeningStage({ audition }: { audition: AuditionVM }) {
  const tallyByBallot = useMemo(
    () => new Map(audition.tally.map((row) => [row.ballotId, row])),
    [audition.tally]
  );
  const votingOpen = audition.status === "voting";

  return (
    <div style={{ marginTop: "1rem" }}>
      {!audition.unblinded && (
        <p className="advNote">
          You are listening blind. Which engine, voice and model produced each recording is not sent to
          this page, and cannot be requested from it, until a winner is locked in.
        </p>
      )}
      {audition.ballots.map((ballot) => (
        <BallotRow
          key={ballot.ballotId}
          auditionId={audition.id}
          ballot={ballot}
          tally={tallyByBallot.get(ballot.ballotId) ?? null}
          existing={audition.myVotes[ballot.ballotId] ?? null}
          isWinner={audition.winnerBallotId === ballot.ballotId}
          votingOpen={votingOpen}
        />
      ))}
    </div>
  );
}

function BallotRow({
  auditionId,
  ballot,
  tally,
  existing,
  isWinner,
  votingOpen,
}: {
  auditionId: string;
  ballot: BlindBallot;
  tally: BlindTallyRow | null;
  existing: { scores: AuditionScores; overall: number; notes: string | null } | null;
  isWinner: boolean;
  votingOpen: boolean;
}) {
  const router = useRouter();
  const [scores, setScores] = useState<AuditionScores>(
    existing?.scores ??
      (DIMENSIONS.reduce((accumulator, dimension) => {
        accumulator[dimension] = 3;
        return accumulator;
      }, {} as AuditionScores))
  );
  const [overall, setOverall] = useState(existing?.overall ?? 3);
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(!!existing);

  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await castVoteAction({ auditionId, ballotId: ballot.ballotId, scores, overall, notes });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setSaved(true);
    router.refresh();
  };

  const choose = async () => {
    setBusy(true);
    setError(null);
    const result = await selectWinnerAction({ auditionId, ballotId: ballot.ballotId });
    setBusy(false);
    if (!result.success) setError(result.error);
    else router.refresh();
  };

  return (
    <div className="advCard" style={{ marginTop: "0.9rem" }}>
      <div className="advCardHead">
        <h4>
          {ballot.blindLabel}
          {isWinner && <span className="stepPill" style={{ marginLeft: "0.5rem" }}>winner</span>}
        </h4>
        <span className="advCardSub">
          {ballot.durationSec ? `${Math.floor(ballot.durationSec / 60)}m ${ballot.durationSec % 60}s` : "no audio"}
          {tally?.voteCount ? ` · ${tally.voteCount} vote${tally.voteCount === 1 ? "" : "s"}` : " · no votes yet"}
          {tally?.overallMean !== null && tally?.overallMean !== undefined ? ` · overall ${tally.overallMean.toFixed(1)}/5` : ""}
        </span>
      </div>

      {ballot.ready && ballot.audioUrl ? (
        <audio controls preload="none" src={ballot.audioUrl} style={{ width: "100%", marginTop: "0.4rem" }} />
      ) : (
        <p className="prodNote prodNote--warn">This candidate did not record: {ballot.problem || "no audio"}</p>
      )}

      {votingOpen && ballot.ready && (
        <>
          <div className="grid2" style={{ marginTop: "0.7rem" }}>
            {DIMENSIONS.map((dimension) => (
              <label key={dimension} className="advField" title={DIMENSION_COPY[dimension].help}>
                <span className="fieldLabel">
                  {DIMENSION_COPY[dimension].label} — {scores[dimension]}/5
                </span>
                <input
                  type="range"
                  min={1}
                  max={5}
                  step={1}
                  value={scores[dimension]}
                  onChange={(event) =>
                    setScores((current) => ({ ...current, [dimension]: Number(event.target.value) }))
                  }
                />
                <span className="advCardSub">
                  1 = {DIMENSION_COPY[dimension].low} · 5 = {DIMENSION_COPY[dimension].high}
                </span>
              </label>
            ))}
          </div>

          <label className="advField" style={{ marginTop: "0.5rem" }}>
            <span className="fieldLabel">Overall — {overall}/5</span>
            <input type="range" min={1} max={5} step={1} value={overall} onChange={(event) => setOverall(Number(event.target.value))} />
          </label>
          <label className="advField">
            <span className="fieldLabel">Notes</span>
            <textarea className="textarea" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>

          {error && <p className="prodNote prodNote--error">{error}</p>}
          <div className="stageActions" style={{ marginTop: "0.6rem" }}>
            <button type="button" className="btnGhost" onClick={save} disabled={busy}>
              {busy ? "Saving…" : saved ? "Update my scores" : "Save my scores"}
            </button>
            <button type="button" className="btnGhost" onClick={choose} disabled={busy}>
              Choose {ballot.blindLabel} as the winner
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function DecisionStage({ audition }: { audition: AuditionVM }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");

  const winner = audition.ballots.find((ballot) => ballot.ballotId === audition.winnerBallotId);

  const reveal = async () => {
    setBusy(true);
    setError(null);
    const result = await revealAuditionAction(audition.id);
    setBusy(false);
    if (!result.success) setError(result.error);
    else router.refresh();
  };

  const promote = async () => {
    setBusy(true);
    setError(null);
    const result = await promoteWinnerAction({
      auditionId: audition.id,
      acknowledgedBallotId: confirm.trim(),
      reason,
    });
    setBusy(false);
    if (!result.success) setError(result.error);
    else {
      setConfirm("");
      router.refresh();
    }
  };

  if (!audition.winnerBallotId) return null;

  return (
    <div className="advCard" style={{ marginTop: "1rem" }}>
      <div className="advCardHead">
        <h4>Decision</h4>
        <span className="advCardSub">
          {winner?.blindLabel ?? "A ballot"} won{audition.winnerSelectedAt ? ` on ${when(audition.winnerSelectedAt)}` : ""}
        </span>
      </div>

      {audition.status === "promoted" ? (
        <p className="prodNote">
          This voice is live on {audition.hostName}. Roll it back from the history below if it does not survive contact with listeners.
        </p>
      ) : (
        <>
          <p className="advCardSub">
            Choosing a winner changed nothing. {audition.hostName} is still using the voice it was using
            before. Promote deliberately, and only after you have unblinded and looked at what you picked.
          </p>
          {!audition.unblinded && (
            <div className="stageActions">
              <button type="button" className="btnGhost" onClick={reveal} disabled={busy}>
                {busy ? "Unblinding…" : "Unblind this audition"}
              </button>
            </div>
          )}
          {audition.unblinded && (
            <>
              <label className="advField" style={{ marginTop: "0.6rem" }}>
                <span className="fieldLabel">
                  Confirm by pasting the winning ballot id ({winner?.ballotId ? `${winner.ballotId.slice(0, 8)}…` : "see the reveal table"})
                </span>
                <input className="input" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder={winner?.ballotId ?? ""} />
              </label>
              <label className="advField">
                <span className="fieldLabel">Why you are changing the voice</span>
                <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} />
              </label>
              <div className="stageActions" style={{ marginTop: "0.5rem" }}>
                <button type="button" className="btnPrimary" onClick={promote} disabled={busy || !confirm.trim()}>
                  {busy ? "Promoting…" : `Promote onto ${audition.hostName}`}
                </button>
              </div>
            </>
          )}
        </>
      )}
      {error && <p className="prodNote prodNote--error">{error}</p>}
    </div>
  );
}

function RevealTable({ rows }: { rows: RevealedVM[] }) {
  return (
    <div className="advCard" style={{ marginTop: "1rem" }}>
      <div className="advCardHead">
        <h4>Unblinded</h4>
      </div>
      <table className="anTable">
        <thead>
          <tr className="anTHead">
            <th>Ballot</th>
            <th>Your note</th>
            <th>Engine</th>
            <th>Voice</th>
            <th>Model</th>
            <th className="anTNum">QA</th>
            <th className="anTNum">LRA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ballotId} className="anTRow">
              <td>{row.blindLabel}{row.isWinner ? " ★" : ""}</td>
              <td>{row.privateLabel || "—"}</td>
              <td>{row.provider}</td>
              <td><code title={row.voiceId}>{shortVoice(row.voiceId)}</code></td>
              <td>{row.model || "—"}</td>
              <td className="anTNum">{row.performanceScore ?? "—"}</td>
              <td className="anTNum">{row.loudnessRangeLu?.toFixed(1) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="advCardSub">
        These acoustic numbers are advisory. They never chose anything — the votes above did.
      </p>
    </div>
  );
}

function PromotionHistory({ promotions }: { promotions: PromotionVM[] }) {
  return (
    <section className="advPanel" style={{ marginTop: "2rem" }}>
      <div className="advPanelHead">
        <h3>Voice change history</h3>
      </div>
      {promotions.length === 0 ? (
        <div className="emptyNote">No production voice has ever been changed through an audition.</div>
      ) : (
        promotions.map((promotion) => <PromotionRow key={promotion.id} promotion={promotion} />)
      )}
    </section>
  );
}

function PromotionRow({ promotion }: { promotion: PromotionVM }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const undo = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    const result = await rollbackPromotionAction({ promotionId: promotion.id, reason });
    setBusy(false);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setNote(
      result.alreadyRolledBack
        ? "This promotion had already been rolled back. Nothing changed."
        : `${result.hostName} is back on its previous voice.`
    );
    router.refresh();
  };

  return (
    <div className="advCard" style={{ marginTop: "0.7rem" }}>
      <div className="advCardHead">
        <h4>
          {promotion.kind === "rollback" ? "Rolled back" : "Promoted"} — {promotion.hostName}
        </h4>
        <span className="advCardSub">
          {when(promotion.createdAt)} · by {promotion.actorLabel} · {promotion.status}
        </span>
      </div>
      <p className="advCardSub">
        {promotion.kind === "rollback"
          ? "Restored the voice this host used before the promotion above."
          : "Replaced this host's production voice with the winning audition entry."}
        {promotion.reason ? ` — ${promotion.reason}` : ""}
      </p>
      {promotion.rolledBackAt && (
        <p className="advCardSub">Reverted on {when(promotion.rolledBackAt)}.</p>
      )}
      {promotion.canRollback && (
        <div className="stageActions">
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why roll this back?" />
          <button type="button" className="btnGhost" onClick={undo} disabled={busy}>
            {busy ? "Restoring…" : "Roll back to the previous voice"}
          </button>
        </div>
      )}
      {error && <p className="prodNote prodNote--error">{error}</p>}
      {note && <p className="prodNote">{note}</p>}
    </div>
  );
}
