"use client";

// Talent Studio: the casting library, and the switch between its three views.
//   library  — every talent as a casting card (TalentCard)
//   profile  — one talent in full, with recommendations (TalentProfile)
//   workflow — create or edit in five steps (TalentWizard)

import Link from "next/link";
import React, { useMemo, useState } from "react";
import StudioPageHeader from "../StudioPageHeader";
import { Icon } from "../StudioIcons";
import TalentCard, { ArchivedCard } from "./TalentCard";
import TalentProfile from "./TalentProfile";
import TalentWizard from "./TalentWizard";
import { voiceReady, type StudioHostVM } from "./talentModel";
import "./talent.css";
import { ChemistryAudition } from "./ChemistryAudition";

export type { StudioHostVM } from "./talentModel";

type View =
  | { kind: "library" }
  | { kind: "chemistry" }
  | { kind: "profile"; id: string }
  | { kind: "edit"; id: string }
  | { kind: "create" };

export default function CharacterStudio({ hosts }: { hosts: StudioHostVM[] }) {
  const active = useMemo(() => hosts.filter((host) => !host.isArchived), [hosts]);
  const archived = useMemo(() => hosts.filter((host) => host.isArchived), [hosts]);
  const [view, setView] = useState<View>({ kind: "library" });
  const [showArchived, setShowArchived] = useState(false);
  const [filter, setFilter] = useState<"all" | "needsVoice" | "onAir">("all");
  const needsVoice = active.filter((host) => !voiceReady(host.ttsVoiceId));
  const onAir = active.filter((host) => host.isActive && voiceReady(host.ttsVoiceId));
  const shown = filter === "needsVoice" ? needsVoice : filter === "onAir" ? onAir : active;

  const library = () => setView({ kind: "library" });
  const selected = view.kind === "profile" || view.kind === "edit" ? hosts.find((host) => host.id === view.id) ?? null : null;

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Talent"
        subtitle="Your hosts: who they are, how they behave, and how they sound."
        actions={
          <>
            <Link href="/studio/auditions" className="btnGhost">Audition voices</Link>
            <button type="button" className="btnGhost" data-testid="open-chemistry" onClick={() => setView(view.kind === "chemistry" ? { kind: "library" } : { kind: "chemistry" })}>{view.kind === "chemistry" ? "Close audition" : "Chemistry audition"}</button>
            <button type="button" className="btnPrimary" onClick={() => setView(view.kind === "create" ? { kind: "library" } : { kind: "create" })}>
              {view.kind === "create" ? "Close" : "Create a host"}
            </button>
          </>
        }
      />

      {view.kind === "chemistry" && <ChemistryAudition hosts={active} onClose={library} />}

      {view.kind === "create" && (
        <TalentWizard mode="create" host={null} onClose={(savedId) => setView(savedId ? { kind: "profile", id: savedId } : { kind: "library" })} />
      )}

      {view.kind === "edit" && selected && (
        // Keyed by host so opening a different host never shows the last draft.
        <TalentWizard key={selected.id} mode="edit" host={selected} onClose={() => setView({ kind: "profile", id: selected.id })} />
      )}

      {view.kind === "profile" && selected && (
        <TalentProfile
          key={selected.id}
          host={selected}
          others={active.filter((host) => host.id !== selected.id)}
          onBack={library}
          onEdit={(hostId) => setView({ kind: "edit", id: hostId ?? selected.id })}
          onOpen={(hostId) => setView({ kind: "profile", id: hostId })}
        />
      )}

      {/* A freshly made copy or a just-created host is not in the list until
          the server refresh lands; a deleted one never comes back. */}
      {(view.kind === "edit" || view.kind === "profile") && !selected && (
        <div className="emptyState" role="status">
          <div className="emptyStateTitle">Opening this host…</div>
          <div className="emptyStateBody">If it does not appear, it may have been removed.</div>
          <button type="button" className="btnGhost" onClick={library}>Back to the talent library</button>
        </div>
      )}

      {/* The library stays mounted (hidden) behind a profile or the workflow,
          so a card's voice takes and preview are still there on return. */}
      <div hidden={view.kind !== "library"}>
        <h2 className="srOnly">Talent library</h2>
        <details className="studioNoteDisclosure">
          <summary>How personality and voice differ</summary>
          <p>
            <strong>Personality</strong> controls what the host believes and says. <strong>Voice</strong> controls what
            the host physically sounds like. Talent keeps those separate so changing a voice never erases the character.
            An episode is cast with exactly two hosts.
          </p>
        </details>

        {active.length > 0 && (
          <div className="hostFilterRow mt-6" role="group" aria-label="Filter hosts">
            {([
              ["all", `All hosts (${active.length})`],
              ["needsVoice", `Need a voice (${needsVoice.length})`],
              ["onAir", `On air (${onAir.length})`],
            ] as Array<[typeof filter, string]>).map(([value, label]) => (
              <button key={value} type="button" aria-pressed={filter === value} className={filter === value ? "btnPrimary" : "btnGhost"} onClick={() => setFilter(value)}>
                {label}
              </button>
            ))}
          </div>
        )}

        {filter === "needsVoice" && needsVoice.length > 0 && (
          <div className="hostVoiceBanner mt-4">
            These hosts can&apos;t speak yet. Open <strong>Create voice</strong> on a card: Fish designs three takes, you keep one, and the host is ready to put on air.
          </div>
        )}

        <div className="grid2 talentGrid mt-6">
          {shown.map((host, index) => (
            <TalentCard
              key={host.id}
              host={host}
              accent={index % 2 === 0 ? "var(--host-a)" : "var(--host-b)"}
              // A house-cast host cannot be edited in place, so "Edit host" forks
              // it first and hands back the COPY's id — which is the host that
              // must open, not the one that was clicked.
              onEdit={(hostId) => setView({ kind: "edit", id: hostId ?? host.id })}
              onOpen={() => setView({ kind: "profile", id: host.id })}
            />
          ))}
        </div>

        {active.length === 0 && (
          <div className="emptyState mt-6">
            <div className="emptyStateIcon">{Icon.hosts}</div>
            <div className="emptyStateTitle">No talent yet</div>
            <div className="emptyStateBody">Create a host to give your show a voice and a point of view.</div>
            <button type="button" className="btnGhost" onClick={() => setView({ kind: "create" })}>Create a host</button>
          </div>
        )}
        {active.length > 0 && shown.length === 0 && (
          <div className="emptyNote mt-6">{filter === "needsVoice" ? "Every host has a voice." : "No host is on air yet. Create a voice, then press Put on air."}</div>
        )}

        {archived.length > 0 && (
          <div className="mt-8">
            <button type="button" className="advLink" aria-expanded={showArchived} onClick={() => setShowArchived((value) => !value)}>
              {showArchived ? "Hide" : "Show"} archived hosts ({archived.length})
            </button>
            {showArchived && <div className="grid2 talentGrid mt-4">{archived.map((host) => <ArchivedCard key={host.id} host={host} />)}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
