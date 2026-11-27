"use client";

// One talent, as a casting profile card: who they are, how they play, whether
// they can speak, and a real voice preview. Also the quickest path to a voice
// (Create voice opens the in-app designer inside the card).

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { TRAIT_LABELS, personalityRead } from "@/lib/hosts/castingFit";
import { PlayButton } from "../StudioAudio";
import { showHue, showInitials } from "../lib";
import { archiveHost, deleteHostSafely, saveDesignedHostVoice, setHostOnAir, unarchiveHost } from "./actions";
import VoiceDesigner, { type VoiceDesignSelection } from "./VoiceDesigner";
import { usageLabel, useEditHost, useHostPreview, voiceReady, voiceSourceLabel, type StudioHostVM } from "./talentModel";

export function OwnershipChip({ host }: { host: StudioHostVM }) {
  if (host.isShared) return <span className="chip" title="Shared house cast. Editing makes your own copy.">House cast</span>;
  return <span className="chip">{host.ownedByMe ? "Yours" : "Another account"}</span>;
}

export default function TalentCard({ host, accent, onEdit, onOpen }: {
  host: StudioHostVM;
  accent: string;
  /** Called with the id of the host to open. Omitted = this card's own host. */
  onEdit: (hostId?: string) => void;
  onOpen: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "archive" | "air" | "saveVoice">(null);
  const [designing, setDesigning] = useState(false);
  const [selection, setSelection] = useState<VoiceDesignSelection | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const preview = useHostPreview(host.id);
  const { editHost, cloning, error: editError } = useEditHost(host, onEdit);
  const error = actionError || preview.error || editError;

  const hasVoice = voiceReady(host.ttsVoiceId);
  const sourceLabel = voiceSourceLabel(host.voiceSource);

  const play = async () => {
    setActionError(null); setMessage(null);
    const ok = await preview.request({
      provider: host.ttsProvider,
      voiceId: host.ttsVoiceId,
      name: host.name,
      settings: host.settings,
      scenario: "hello",
    }, `${host.name} — voice preview`);
    if (ok) setMessage("Playing this host in normal conversation.");
  };

  const saveVoice = async () => {
    if (!selection) return;
    setBusy("saveVoice"); setActionError(null); setMessage(null);
    const result = await saveDesignedHostVoice(host.id, {
      title: `${host.name} — designed voice`,
      audioBase64: selection.audioBase64,
      previewText: selection.testLine,
      instruction: selection.description,
    });
    if (result.success) {
      setDesigning(false);
      setSelection(null);
      setMessage(host.isActive
        ? `${host.name} has a voice. Press Hear host to listen.`
        : `${host.name} has a voice. Press Hear host to listen, then Put on air when you're happy.`);
      router.refresh();
    } else setActionError(result.error);
    setBusy(null);
  };

  const toggleOnAir = async () => {
    setBusy("air"); setActionError(null); setMessage(null);
    const result = await setHostOnAir(host.id, !host.isActive);
    if (result.success) {
      setMessage(result.isActive ? `${host.name} is on air and can be cast in episodes.` : `${host.name} is benched and won't be cast.`);
      router.refresh();
    } else setActionError(result.error);
    setBusy(null);
  };

  const doArchive = async () => {
    setBusy("archive"); setActionError(null);
    const result = await archiveHost(host.id);
    if (!result.success) setActionError(result.error);
    else router.refresh();
    setBusy(null);
  };

  const openDesigner = () => { setDesigning(true); setActionError(null); setMessage(null); };

  return (
    <article className={`studioCard hostCard talentCard ${designing ? "hostCardDesigning" : ""}`} style={{ "--host-accent": accent } as React.CSSProperties}>
      <div className="talentCardHead">
        <span className="showArt" data-hue={showHue(host.id)} aria-hidden="true">{showInitials(host.name)}</span>
        <div className="talentCardWho">
          <h3 className="displayTitle talentCardName">{host.name}</h3>
          <div className="talentCardRole">{host.role}</div>
        </div>
        <div className="hostCardAside">
          <span className={`chip ${host.isActive && hasVoice ? "chipSuccess" : ""}`}>{host.isActive && hasVoice ? "On air" : "Benched"}</span>
          <OwnershipChip host={host} />
        </div>
      </div>

      <p className="talentRead">{personalityRead(host.settings)}</p>

      <div className="hostChipRow">
        <span className="chip">{TRAIT_LABELS.energy[host.settings.energy]}</span>
        <span className="chip">{TRAIT_LABELS.pace[host.settings.pace]}</span>
        <span className="chip">{TRAIT_LABELS.humor[host.settings.humor]}</span>
        <span className="chip">{TRAIT_LABELS.pressure[host.settings.pressure]}</span>
      </div>

      <p className="hostBelief" title={host.settings.belief}>{host.settings.belief}</p>

      <div className={`provRow ${hasVoice ? "" : "gate-err"}`}>
        <span className={`provBadge ${hasVoice ? "provOk" : "provRisk"}`}>
          {hasVoice ? "✓ Voice ready" : "Voice needed"}
        </span>
        {hasVoice && sourceLabel && <span className="provVoice">{sourceLabel}</span>}
        {hasVoice && !sourceLabel && <span className="provBadge provRisk">⚠ Provenance undocumented</span>}
        {!hasVoice && host.voiceBrief && <span className="provVoice">Voice brief ready</span>}
      </div>

      {(message || error) && <div className={`gateResult mt-3 mb-3 ${error ? "gate-err" : "gate-ok"}`} role="status">{error || message}</div>}

      {designing && (
        <div className="hostCardDesigner">
          <VoiceDesigner
            hostName={host.name}
            brief={host.voiceBrief}
            pace={host.settings.pace}
            onSelectionChange={setSelection}
            footer={
              <div className="voiceSaveBar">
                <span className="voiceSaveHint">
                  {selection ? `Take ${selection.take} selected. Saving creates a private voice in your Fish account.` : "Pick a take to keep."}
                </span>
                <button type="button" className="btnGhost" onClick={() => { setDesigning(false); setSelection(null); }} disabled={busy === "saveVoice"}>Cancel</button>
                <button type="button" className="btnPrimary" onClick={saveVoice} disabled={!selection || busy === "saveVoice"}>
                  {busy === "saveVoice" && <span className="btnSpin" aria-hidden="true" />}
                  {busy === "saveVoice" ? "Saving voice…" : `Save as ${host.name}'s voice`}
                </button>
              </div>
            }
          />
        </div>
      )}

      <div className="hostCardActions">
        {hasVoice ? (
          <>
            {/* Replays the last preview without another call to the voice engine. */}
            {preview.track && <PlayButton track={preview.track} className="playBtn playBtn--sm" />}
            <button type="button" className="btnGhost" onClick={play} disabled={preview.busy}>
              {preview.busy ? "Making preview…" : preview.track ? "New preview" : "▶ Hear host"}
            </button>
          </>
        ) : host.canEdit ? (
          !designing && (
            <button type="button" className="btnGhost hostVoiceCta" onClick={openDesigner}>
              Create voice
            </button>
          )
        ) : (
          <button type="button" className="btnGhost" disabled>▶ Hear host</button>
        )}
        {host.canEdit && hasVoice && (
          <button type="button" className={host.isActive ? "btnGhost" : "btnGhost hostVoiceCta"} onClick={toggleOnAir} disabled={busy === "air"}>
            {busy === "air" ? "Saving…" : host.isActive ? "Bench" : "Put on air"}
          </button>
        )}
        {host.canEdit && hasVoice && !designing && (
          <button type="button" className="btnGhost" onClick={openDesigner}>
            New voice
          </button>
        )}
        <button type="button" className="btnGhost" onClick={onOpen} aria-label={`Open ${host.name}'s profile`}>
          Profile
        </button>
        {/* Present on EVERY card, owned or shared — see useEditHost for why. */}
        <button type="button" className="btnGhost" onClick={editHost} disabled={cloning}>
          {cloning ? "Making your copy…" : "Edit host"}
        </button>
        {host.canEdit && (
          <button type="button" className="btnGhost u-mlAuto" onClick={doArchive} disabled={busy === "archive"}>
            Archive
          </button>
        )}
      </div>
      <div className="hostCardUsage">{usageLabel(host.episodeCount)}</div>
    </article>
  );
}

export function ArchivedCard({ host }: { host: StudioHostVM }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const referenced = host.episodeCount > 0 || host.segmentCount > 0;
  const restore = async () => { setBusy(true); const result = await unarchiveHost(host.id); if (!result.success) setError(result.error); else router.refresh(); setBusy(false); };
  const remove = async () => { setBusy(true); const result = await deleteHostSafely(host.id); if (!result.success) setError(result.error); else router.refresh(); setBusy(false); };
  return (
    <article className="studioCard hostCard hostCardArchived">
      <div className="talentCardHead">
        <span className="showArt" data-hue={showHue(host.id)} aria-hidden="true">{showInitials(host.name)}</span>
        <div className="talentCardWho">
          <h3 className="displayTitle talentCardName">{host.name}</h3>
          <div className="talentCardRole">{host.role}</div>
        </div>
        <div className="hostCardAside">
          <span className="chip">Archived</span>
          <OwnershipChip host={host} />
        </div>
      </div>
      <div className="hostCardUsage mt-3 mb-3">{usageLabel(host.episodeCount)}</div>
      {error && <div className="gateResult gate-err" role="status">{error}</div>}
      {host.canEdit ? (
        <div className="hostBtnRow">
          <button type="button" className="btnGhost" onClick={restore} disabled={busy}>Restore</button>
          {!referenced && <button type="button" className="btnGhost" onClick={remove} disabled={busy} data-danger="true">Delete</button>}
          {referenced && <span className="advNote">In use, so it can be restored but not deleted.</span>}
        </div>
      ) : <span className="advNote">Shared host — read only.</span>}
    </article>
  );
}
