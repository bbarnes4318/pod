"use client";

// One talent's full profile, in sections: identity, personality, performance,
// voice, then the two advisory panels. Read-only; "Edit host" opens the
// five-step workflow (forking a house-cast host into the viewer's roster first).

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { TRAIT_LABELS, personalityRead, personalityRecommendations } from "@/lib/hosts/castingFit";
import { PlayButton } from "../StudioAudio";
import { Icon } from "../StudioIcons";
import { showHue, showInitials } from "../lib";
import { archiveHost, setHostOnAir, unarchiveHost } from "./actions";
import type { PreviewScenario } from "./constants";
import { OwnershipChip } from "./TalentCard";
import { CastingPartners, Recommendations } from "./TalentInsights";
import {
  previewLines,
  providerLabel,
  scenarioLabels,
  usageLabel,
  useEditHost,
  useHostPreview,
  voiceReady,
  voiceSourceLabel,
  type StudioHostVM,
} from "./talentModel";

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="talentFact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Lines({ lines, empty }: { lines: string[]; empty: string }) {
  if (lines.length === 0) return <span className="talentMuted">{empty}</span>;
  return <ul className="talentLines">{lines.map((line) => <li key={line}>{line}</li>)}</ul>;
}

export default function TalentProfile({ host, others, onBack, onEdit, onOpen }: {
  host: StudioHostVM;
  others: StudioHostVM[];
  onBack: () => void;
  /** Called with the id of the host to open in the workflow. Omitted = this host. */
  onEdit: (hostId?: string) => void;
  onOpen: (hostId: string) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<PreviewScenario>("hello");
  const preview = useHostPreview(`profile:${host.id}`);
  const { editHost, cloning, error: editError } = useEditHost(host, onEdit);
  const error = actionError || preview.error || editError;

  const s = host.settings;
  const hasVoice = voiceReady(host.ttsVoiceId);
  const sourceLabel = voiceSourceLabel(host.voiceSource);
  const onAir = host.isActive && hasVoice && !host.isArchived;

  const run = async (action: () => Promise<{ success: true } | { success: false; error: string }>, done: string) => {
    setBusy(true); setActionError(null); setMessage(null);
    const result = await action();
    if (result.success) { setMessage(done); router.refresh(); } else setActionError(result.error);
    setBusy(false);
  };

  const play = (next: PreviewScenario) => {
    setScenario(next);
    setMessage(null); setActionError(null);
    void preview.request(
      { provider: host.ttsProvider, voiceId: host.ttsVoiceId, name: host.name, settings: s, scenario: next, line: previewLines[next] },
      `${host.name} — ${scenarioLabels[next].toLowerCase()}`,
    );
  };

  return (
    <div className="talentProfile">
      <button type="button" className="btnGhost btnSm talentBack" onClick={onBack}>
        {Icon.chevronLeft} Talent library
      </button>

      <header className="studioCard talentMast">
        <span className="showArt showArt--lg" data-hue={showHue(host.id)} aria-hidden="true">{showInitials(host.name)}</span>
        <div className="talentMastWho">
          <h2 className="talentMastName">{host.name}</h2>
          <p className="talentCardRole">{host.role}</p>
          <div className="talentMastChips">
            <span className={`chip ${onAir ? "chipSuccess" : ""}`}>{host.isArchived ? "Archived" : onAir ? "On air" : "Benched"}</span>
            <OwnershipChip host={host} />
            <span className={`provBadge ${hasVoice ? "provOk" : "provRisk"}`}>{hasVoice ? "✓ Voice ready" : "Voice needed"}</span>
            {hasVoice && !sourceLabel && <span className="provBadge provRisk">⚠ Provenance undocumented</span>}
          </div>
          <p className="talentRead">{personalityRead(s)}</p>
        </div>
        <div className="talentMastActions">
          <button type="button" className="btnGhost hostVoiceCta" onClick={editHost} disabled={cloning}>
            {cloning ? "Making your copy…" : "Edit host"}
          </button>
          {host.canEdit && hasVoice && !host.isArchived && (
            <button type="button" className="btnGhost" disabled={busy} onClick={() => run(
              () => setHostOnAir(host.id, !host.isActive),
              host.isActive ? `${host.name} is benched and won't be cast.` : `${host.name} is on air and can be cast in episodes.`,
            )}>
              {host.isActive ? "Bench" : "Put on air"}
            </button>
          )}
          {host.canEdit && (host.isArchived ? (
            <button type="button" className="btnGhost" disabled={busy} onClick={() => run(() => unarchiveHost(host.id), `${host.name} is restored.`)}>Restore</button>
          ) : (
            <button type="button" className="btnGhost" disabled={busy} onClick={() => run(() => archiveHost(host.id), `${host.name} is archived.`)}>Archive</button>
          ))}
        </div>
        {host.isShared && !host.canEdit && (
          <p className="advNote talentMastNote">
            House cast is shared and read-only. Edit host makes your own copy and opens that; this one stays as it is.
          </p>
        )}
        {(message || error) && <div className={`gateResult talentMastNote ${error ? "gate-err" : "gate-ok"}`} role="status">{error || message}</div>}
      </header>

      <div className="talentSections">
        <section className="studioCard" aria-labelledby="talent-identity">
          <h3 className="sectionTitle" id="talent-identity">Identity</h3>
          <dl className="talentFacts">
            <Fact label="Role">{host.role}</Fact>
            <Fact label="Believes">{s.belief}</Fact>
            <Fact label="Casting priority">{s.castPriority} of 10 <span className="talentMuted">(higher takes the lead chair)</span></Fact>
            <Fact label="Roster">{host.isShared ? "House cast (shared, read-only)" : host.ownedByMe ? "Your talent" : "Another account's talent"}</Fact>
            <Fact label="Work">{usageLabel(host.episodeCount)}</Fact>
          </dl>
        </section>

        <section className="studioCard" aria-labelledby="talent-personality">
          <h3 className="sectionTitle" id="talent-personality">Personality</h3>
          <dl className="talentFacts">
            <Fact label="Humor">{TRAIT_LABELS.humor[s.humor]}</Fact>
            <Fact label="Interrupts">{TRAIT_LABELS.interruptions[s.interruptions]}</Fact>
            <Fact label="Concedes">{TRAIT_LABELS.concessions[s.concessions]}</Fact>
            <Fact label="Finish">{TRAIT_LABELS.finish[s.finish]}</Fact>
            <Fact label="They often"><Lines lines={s.argumentPatterns} empty="No habits written." /></Fact>
            <Fact label="Never say"><Lines lines={s.bannedPhrases} empty="Nothing ruled out." /></Fact>
            <Fact label="Favorite phrases"><Lines lines={s.catchphrases} empty="None (fine for most hosts)." /></Fact>
            {s.extraInstructions.trim() && <Fact label="Extra notes">{s.extraInstructions}</Fact>}
          </dl>
        </section>

        <section className="studioCard" aria-labelledby="talent-performance">
          <h3 className="sectionTitle" id="talent-performance">Performance</h3>
          <dl className="talentFacts">
            <Fact label="Energy">{TRAIT_LABELS.energy[s.energy]}</Fact>
            <Fact label="Pace">{TRAIT_LABELS.pace[s.pace]}</Fact>
            <Fact label="Pauses">{TRAIT_LABELS.pauses[s.pauses]}</Fact>
            <Fact label="Under pressure">{TRAIT_LABELS.pressure[s.pressure]}</Fact>
            <Fact label="Never sound like"><Lines lines={s.prohibitedTraits} empty="No delivery guard." /></Fact>
          </dl>
        </section>

        <section className="studioCard" aria-labelledby="talent-voice">
          <h3 className="sectionTitle" id="talent-voice">Voice</h3>
          <dl className="talentFacts">
            <Fact label="Status">{hasVoice ? "Voice ready" : host.voiceBrief ? "No voice yet. A voice brief is written and ready to design from." : "No voice yet."}</Fact>
            {hasVoice && <Fact label="Voice engine">{providerLabel(host.ttsProvider)}</Fact>}
            {hasVoice && (
              <Fact label="Provenance">
                {sourceLabel || <span className="provBadge provRisk">⚠ Undocumented: nothing records who owns or licensed this voice</span>}
              </Fact>
            )}
            {hasVoice && host.voiceProvenanceNote && <Fact label="Record">{host.voiceProvenanceNote}</Fact>}
          </dl>
          {hasVoice ? (
            <div className="talentPreviewBox mt-4" role="group" aria-label="Voice preview">
              <div className="hostChoiceTitle">Hear {host.name}</div>
              <div className="hostChoiceHelp">Each button makes one new preview with the voice engine, using this host&apos;s performance settings.</div>
              <div className="hostBtnRow">
                {preview.track && <PlayButton track={preview.track} className="playBtn playBtn--sm" />}
                {(["hello", "disagree", "pressure"] as PreviewScenario[]).map((value) => (
                  <button key={value} type="button" className="btnGhost" disabled={preview.busy} onClick={() => play(value)}>
                    {preview.busy && scenario === value ? "Making preview…" : `▶ ${scenarioLabels[value]}`}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <p className="advNote mt-4">
              Voices are made here in the Studio. Press Edit host and open the Voice step to design, clone or attach one.
            </p>
          )}
        </section>
      </div>

      <div className="talentSections">
        <section className="studioCard"><Recommendations recommendations={personalityRecommendations(s)} /></section>
        <section className="studioCard"><CastingPartners host={host} others={others} onOpen={onOpen} /></section>
      </div>
    </div>
  );
}
