"use client";

// AI Quick Start. Describe the show → an editable recommendation with the
// reason for each choice → accept. Accepting calls the SAME createPodcast
// action as the Custom wizard (or hands a business show to the existing
// business setup form, prefilled). Nothing is saved before that.

import React, { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPodcast } from "@/app/app/podcasts/actions";
import { WEEKDAYS, WEEKDAY_LABELS, SEGMENT_MAX, SEGMENT_MIN, type PodcastInput } from "@/app/app/podcasts/config";
import PodcastWizard, { type WizardHost, type WizardTeam } from "@/app/app/podcasts/new/PodcastWizard";
import { SELECTABLE_VERTICALS } from "@/lib/verticals";
import { SCRIPT_STYLES, TONES, type QuickStartProposal, type ReasonKey } from "@/lib/shows/quickStart";
import type { ShowBible } from "@/lib/shows/showForge";
import BusinessSetupForm from "./business/BusinessSetupForm";
import { recommendShowSetup } from "./quickStartActions";
import "../shows-intel.css";

const CUSTOM_HREF = "/studio/shows/new?type=sports";
const FORMAT_NAMES: Record<ShowBible["templateId"], string> = {
  rivalry_room: "The Rivalry Room",
  insider_room: "Inside the Building",
  fan_court: "Fan Court",
  season_story: "The Season Story",
  custom: "Build Your Own",
};
const label = (s: string) => s.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());

function Why({ text }: { text?: string }) {
  return text ? <p className="qsWhy"><span className="qsWhyTag">Why</span> {text}</p> : null;
}

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button type="button" className={on ? "chip chipAccent bizToggle" : "chip bizToggle"} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  );
}

export default function QuickStart({ hosts, teams }: { hosts: WizardHost[]; teams: WizardTeam[] }) {
  const router = useRouter();
  const [description, setDescription] = useState("");
  const [proposal, setProposal] = useState<QuickStartProposal | null>(null);
  const [input, setInput] = useState<PodcastInput | null>(null);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState<{ message: string; unavailable?: boolean } | null>(null);
  const [pending, start] = useTransition();

  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res = await recommendShowSetup(description);
      if (!res.success) return setError({ message: res.error, unavailable: res.unavailable });
      setProposal(res.proposal);
      setInput(res.proposal.kind === "sports" ? res.proposal.input : null);
    });
  };

  const reset = () => { setProposal(null); setInput(null); setCustom(false); setError(null); };

  if (!proposal) {
    return (
      <form onSubmit={ask} className="studioCard bizForm" data-testid="quick-start">
        <div>
          <h2 className="m-0">Quick start</h2>
          <p className="bizLead">
            Describe the show in a sentence or two. You get a complete recommended setup with the reason for each choice. You can change anything, and nothing is saved until you accept.
          </p>
        </div>
        <label>
          <span className="fieldLabel">What is the show?</span>
          <textarea
            className="textarea"
            maxLength={1200}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. A twice-weekly NFL show where two friends who never agree put the week's worst coaching decision on trial."
          />
        </label>
        {error && (
          <p role="alert" className="gateResult gate-err bizFlush">
            {error.message}{" "}
            {error.unavailable && <Link href={CUSTOM_HREF}>Open Custom</Link>}
          </p>
        )}
        <div>
          <button className="btnPrimary" disabled={pending || description.trim().length < 15}>
            {pending ? "Thinking…" : "Recommend a setup"}
          </button>
        </div>
      </form>
    );
  }

  const flags = proposal.flags.length > 0 && (
    <div className="gateResult gate-warn" data-testid="quick-start-flags">
      <strong>Not the recommendation&apos;s choice, check these:</strong>
      <ul className="qsFlags">{proposal.flags.map((f) => <li key={f}>{f}</li>)}</ul>
    </div>
  );

  if (proposal.kind === "business") {
    return (
      <div className="bizStack" data-testid="quick-start-business">
        <div className="studioCard bizStackTight">
          <h2 className="m-0">This reads as a business show</h2>
          <Why text={proposal.reasons.kind} />
          <Why text={proposal.reasons.business} />
          <p className="bizNote">
            The form below is prefilled from your description. Business name, industry and audience are suggestions: correct them. Your description is used exactly as you wrote it.
          </p>
          {flags}
          <div><button type="button" className="btnGhost" onClick={reset}>Start over</button></div>
        </div>
        <BusinessSetupForm initial={proposal.prefill} />
      </div>
    );
  }

  if (!input) return null;

  if (custom) {
    return (
      <div className="bizStack">
        <div><button type="button" className="btnGhost" onClick={() => setCustom(false)}>← Back to the recommendation</button></div>
        <PodcastWizard hosts={hosts} teams={teams} initial={input} hideIdentity />
      </div>
    );
  }

  const r = proposal.reasons;
  const bible = input.showForge.bible;
  const patch = (p: Partial<PodcastInput>) => setInput({ ...input, ...p });
  const patchBible = (p: Partial<ShowBible>) => patch({ showForge: { ...input.showForge, bible: { ...bible, ...p } } });
  const flip = (list: string[], v: string, max?: number) =>
    list.includes(v) ? list.filter((x) => x !== v) : max && list.length >= max ? list : [...list, v];
  const why = (k: ReasonKey) => <Why text={r[k]} />;

  const blocker =
    !input.name.trim() ? "Give the show a name."
    : input.verticals.length === 0 ? "Pick at least one sports world."
    : input.hostIds.length === 0 ? (hosts.length ? "Choose one or two hosts." : "Create a host in Talent first.")
    : input.cadence === "recurring" && input.scheduleDays.length === 0 ? "Choose at least one release day."
    : bible.premise.trim().length < 8 || bible.audiencePromise.trim().length < 8 ? "The premise and the listener promise need a sentence each."
    : null;

  const accept = () => {
    setError(null);
    start(async () => {
      // Same action, same server-side validation and plan checks as Custom.
      const res = await createPodcast(input);
      if (!res.success) return setError({ message: res.error });
      router.push(`/studio/shows/${res.podcastId}`);
    });
  };

  return (
    <div className="studioCard bizForm" data-testid="quick-start-proposal">
      <div>
        <h2 className="m-0">Recommended setup</h2>
        <p className="bizLead">A recommendation from your description, not a saved show. Edit anything, then create it.</p>
        {why("kind")}
      </div>
      {flags}

      <label>
        <span className="fieldLabel">Show name</span>
        <input className="input" maxLength={80} value={input.name} onChange={(e) => patch({ name: e.target.value })} />
        {why("name")}
      </label>

      <div className="qsBlock">
        <span className="fieldLabel">Format</span>
        <p className="bizBody"><strong>{FORMAT_NAMES[bible.templateId]}</strong></p>
        {why("format")}
        <label>
          <span className="fieldLabel">What the show is about</span>
          <textarea className="textarea" maxLength={1500} value={bible.premise} onChange={(e) => patchBible({ premise: e.target.value })} />
        </label>
        <label>
          <span className="fieldLabel">Promise to the listener</span>
          <textarea className="textarea" maxLength={1000} value={bible.audiencePromise} onChange={(e) => patchBible({ audiencePromise: e.target.value })} />
        </label>
      </div>

      <div className="qsBlock">
        <div className="bizGrid2">
          <label>
            <span className="fieldLabel">Tone</span>
            <select className="select" value={bible.tone} onChange={(e) => patchBible({ tone: e.target.value as ShowBible["tone"] })}>
              {TONES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
            </select>
          </label>
          <label>
            <span className="fieldLabel">Script style</span>
            <select
              className="select"
              value={input.showForge.scriptStyle}
              onChange={(e) => patch({ showForge: { ...input.showForge, scriptStyle: e.target.value as PodcastInput["showForge"]["scriptStyle"] } })}
            >
              {SCRIPT_STYLES.map((s) => <option key={s} value={s}>{label(s)}</option>)}
            </select>
          </label>
        </div>
        {why("tone")}
      </div>

      <fieldset className="bizFieldset qsBlock">
        <legend className="fieldLabel">Sports worlds</legend>
        <div className="bizChips">
          {SELECTABLE_VERTICALS.map((v) => (
            <Chip key={v} on={input.verticals.includes(v)} onClick={() => patch({ verticals: flip(input.verticals, v) })}>{v}</Chip>
          ))}
        </div>
        {why("verticals")}
      </fieldset>

      <fieldset className="bizFieldset qsBlock">
        <legend className="fieldLabel">Cast (one or two)</legend>
        {hosts.length === 0 ? (
          <p className="bizNote">You have no hosts yet. <Link href="/studio/hosts">Create one in Talent</Link>, then come back.</p>
        ) : (
          <div className="bizChips">
            {hosts.map((h) => (
              <Chip key={h.id} on={input.hostIds.includes(h.id)} onClick={() => patch({ hostIds: flip(input.hostIds, h.id, 2) })}>
                {h.name} · {h.role}
              </Chip>
            ))}
          </div>
        )}
        {why("hosts")}
      </fieldset>

      <div className="qsBlock">
        <div className="bizGrid2">
          <label>
            <span className="fieldLabel">Cadence</span>
            <select
              className="select"
              value={input.cadence}
              onChange={(e) => {
                const cadence = e.target.value as PodcastInput["cadence"];
                patch({ cadence, scheduleDays: cadence === "recurring" && input.scheduleDays.length === 0 ? ["mon"] : input.scheduleDays });
              }}
            >
              <option value="recurring">Recurring</option>
              <option value="one_time">One-time</option>
            </select>
          </label>
          <label>
            <span className="fieldLabel">Topics per episode</span>
            <input
              className="input"
              type="number"
              min={SEGMENT_MIN}
              max={SEGMENT_MAX}
              value={input.segmentCount}
              onChange={(e) => patch({ segmentCount: Math.min(SEGMENT_MAX, Math.max(SEGMENT_MIN, Number(e.target.value) || SEGMENT_MIN)) })}
            />
          </label>
        </div>
        {input.cadence === "recurring" && (
          <div className="bizChips" role="group" aria-label="Release days">
            {WEEKDAYS.map((d) => (
              <Chip key={d} on={input.scheduleDays.includes(d)} onClick={() => patch({ scheduleDays: flip(input.scheduleDays, d) })}>{WEEKDAY_LABELS[d]}</Chip>
            ))}
          </div>
        )}
        {why("cadence")}
        {why("segments")}
      </div>

      <div className="qsBlock">
        <span className="fieldLabel">Recurring segments</span>
        <ul className="qsSegments">
          {bible.recurringSegments.map((s) => (
            <li key={s.id}><strong>{s.name}</strong> <span className="bizNote">({label(s.frequency)})</span><br />{s.purpose}</li>
          ))}
        </ul>
        <p className="bizNote">
          Point of view, host chemistry, rituals, segments, teams and season storylines can be edited in Custom, which opens with this setup filled in.
        </p>
      </div>

      {error && <p role="alert" className="gateResult gate-err bizFlush">{error.message}</p>}
      {blocker && <p className="bizNote" role="status">{blocker}</p>}

      <div className="qsActions">
        <button type="button" className="btnPrimary" disabled={pending || !!blocker} onClick={accept}>
          {pending ? "Creating…" : "Create this show"}
        </button>
        <button type="button" className="btnGhost" disabled={pending} onClick={() => setCustom(true)}>Fine-tune in Custom</button>
        <button type="button" className="btnGhost" disabled={pending} onClick={reset}>Start over</button>
      </div>
    </div>
  );
}
