"use client";

// The AI Executive Producer's brief, reviewed section by section.
//
// The creator drafts a brief from their goal, then for each section can keep
// it, edit it in place, ask for a fresh take on just that section, or drop it.
// What is on screen is exactly what is stored with the episode and handed to
// the script writers (lib/studio/executiveBrief briefPromptBlock): dropped
// sections are not sent. Every draft says whether an AI model wrote it or it
// was built from stored research without one.

import React, { useState } from "react";
import { proposeExecutiveBrief, type ProposeBriefInput } from "./producerActions";
import { BRIEF_SECTIONS, SECTION_LABEL, type BriefSection, type ExecutiveBrief } from "@/lib/studio/executiveBrief";

type Ctx = Omit<ProposeBriefInput, "section" | "current">;

const REASONED: BriefSection[] = ["title", "positioning", "audience", "angle", "thesis", "hook", "conclusion", "soundDirection"];
const LISTS: BriefSection[] = ["researchNeeds", "counterarguments", "disagreements", "insiderInsights", "takeaways"];

export function ExecutiveBriefPanel({ ctx, brief, setBrief, hostName, sourceTitle, disabledReason }: {
  ctx: Ctx;
  brief: ExecutiveBrief | null;
  setBrief: (b: ExecutiveBrief | null) => void;
  hostName: (id: string) => string;
  sourceTitle: (id: string) => string;
  /** Shown instead of the draft button when a brief can't be drafted yet. */
  disabledReason?: string | null;
}) {
  const [busy, setBusy] = useState<BriefSection | "all" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState<BriefSection | null>(null);
  const [draftText, setDraftText] = useState("");
  const [names, setNames] = useState<Record<string, string>>({});
  const nameOf = (id: string) => names[id] ?? hostName(id);

  const draft = async (section?: BriefSection) => {
    setBusy(section ?? "all"); setError(null);
    try {
      const r = await proposeExecutiveBrief({ ...ctx, section, current: section ? brief : undefined });
      if (!r.success) { setError(r.error); return; }
      setBrief(r.brief); setNote(r.note); setNames(r.hostNames);
    } catch {
      setError("The request didn't reach the server. Check your connection and try again; your current brief is unchanged.");
    } finally { setBusy(null); }
  };

  const toggleReject = (s: BriefSection) => brief && setBrief({ ...brief, rejected: brief.rejected.includes(s) ? brief.rejected.filter((x) => x !== s) : [...brief.rejected, s] });

  const startEdit = (s: BriefSection) => {
    if (!brief) return;
    const v = (brief as any)[s];
    setDraftText(
      REASONED.includes(s) ? v.value
      : LISTS.includes(s) ? (v as string[]).join("\n")
      : s === "segments" ? brief.segments.map((x) => `${x.title} :: ${x.goal}`).join("\n")
      : s === "hostAssignments" ? brief.hostAssignments.map((h) => `${nameOf(h.hostId)} :: ${h.perspective}`).join("\n")
      : brief.evidence.map((e) => `${sourceTitle(e.sourceId)} :: ${e.use}`).join("\n")
    );
    setEditing(s);
  };
  const saveEdit = () => {
    if (!brief || !editing) return;
    const lines = draftText.split("\n").map((l) => l.trim()).filter(Boolean);
    const split = (l: string) => { const i = l.indexOf("::"); return i < 0 ? [l, ""] : [l.slice(0, i).trim(), l.slice(i + 2).trim()]; };
    const next: any = { ...brief, rejected: brief.rejected.filter((x) => x !== editing) };
    if (REASONED.includes(editing)) next[editing] = { value: draftText.trim().slice(0, 500), rationale: "Edited by you." };
    else if (LISTS.includes(editing)) next[editing] = lines.slice(0, 8).map((l) => l.slice(0, 300));
    else if (editing === "segments") {
      const segs = lines.slice(0, 8).map((l, i) => { const [title, goal] = split(l); return { title: title.slice(0, 120), goal: (goal || title).slice(0, 400), sourceIds: brief.segments[i]?.sourceIds ?? [] }; });
      if (!segs.length) { setError("Keep at least one segment."); return; }
      next.segments = segs;
    } else if (editing === "hostAssignments") {
      // Host and story ids can't be typed: edit the text, keep the same people in the same order.
      next.hostAssignments = brief.hostAssignments.map((h, i) => ({ ...h, perspective: (split(lines[i] ?? "")[1] || h.perspective).slice(0, 400) }));
    } else if (editing === "evidence") {
      next.evidence = brief.evidence.map((e, i) => ({ ...e, use: (split(lines[i] ?? "")[1] ?? e.use).slice(0, 300) }));
    }
    setBrief(next); setEditing(null); setError(null);
  };

  if (!brief) {
    return (
      <div className="studioCard" data-testid="exec-brief-empty">
        <h2 className="sectionTitle mt-0">Production brief</h2>
        <p className="stageHint mb-2">The AI Executive Producer turns your goal into a brief the writers and hosts work to: the thesis, the hook, the segment plan, who argues what, and what the listener takes away. You review every part before anything is written.</p>
        {disabledReason ? <p className="noteWarn" role="note">{disabledReason}</p> : (
          <button type="button" className="btnPrimary" data-testid="exec-brief-draft" disabled={busy !== null} onClick={() => draft()}>
            {busy ? "Drafting the brief…" : "Draft the production brief"}
          </button>
        )}
        {busy && <p className="stageHint mt-2" role="status">This takes up to a minute. You can keep editing the rundown.</p>}
        {error && <p className="noteWarn mt-2" role="alert">{error}</p>}
      </div>
    );
  }

  const madeBy = brief.source === "model"
    ? <span className="statusPill statusPill--ok">Drafted by an AI model{brief.model ? ` (${brief.model})` : ""}</span>
    : <span className="statusPill statusPill--warn">Built from research on file, no AI model</span>;

  return (
    <div className="studioCard" data-testid="exec-brief">
      <div className="briefHead">
        <h2 className="sectionTitle m-0">Production brief</h2>
        {madeBy}
      </div>
      {note && <p className="noteWarn" role="note">{note}</p>}
      <p className="stageHint">This brief is stored with the episode and the script is written to it. Sections you drop are not used. It shapes the argument and structure; every fact still has to come from the research.</p>

      {BRIEF_SECTIONS.map((s) => {
        const off = brief.rejected.includes(s);
        return (
          <section key={s} className={`briefSection${off ? " briefSection--off" : ""}`} data-testid={`brief-${s}`} aria-label={SECTION_LABEL[s]}>
            <div className="briefSectionHead">
              <div className="fieldLabel">{SECTION_LABEL[s]}{off && <span className="stageHint"> · dropped, not used</span>}</div>
              <div className="briefActions">
                {editing !== s && <button type="button" className="advLink" onClick={() => startEdit(s)}>Edit</button>}
                <button type="button" className="advLink" disabled={busy !== null} onClick={() => draft(s)} aria-label={`New take on ${SECTION_LABEL[s]}`}>
                  {busy === s ? "Rethinking…" : "New take"}
                </button>
                <button type="button" className="advLink" onClick={() => toggleReject(s)}>{off ? "Use it" : "Drop"}</button>
              </div>
            </div>
            {editing === s ? (
              <div>
                {(s === "segments" || s === "hostAssignments" || s === "evidence") && <p className="stageHint">One per line, as “name :: text”.{s !== "segments" ? " Only the text after :: changes." : ""}</p>}
                <textarea className="input u-full" rows={REASONED.includes(s) ? 3 : 5} value={draftText} onChange={(e) => setDraftText(e.target.value)} aria-label={`Edit ${SECTION_LABEL[s]}`} />
                <div className="briefActions mt-2">
                  <button type="button" className="btnPrimary" onClick={saveEdit}>Save</button>
                  <button type="button" className="btnGhost" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : <SectionBody brief={brief} s={s} hostName={nameOf} sourceTitle={sourceTitle} />}
          </section>
        );
      })}

      <div className="briefFoot">
        <span className="stageHint">About {brief.targetMinutes} minutes · {brief.productionStyle} sound</span>
        <button type="button" className="btnGhost" disabled={busy !== null} onClick={() => draft()}>{busy === "all" ? "Redrafting…" : "Redraft everything"}</button>
        <button type="button" className="advLink" onClick={() => { setBrief(null); setNote(null); }}>Remove the brief</button>
      </div>
      {error && <p className="noteWarn" role="alert">{error}</p>}
    </div>
  );
}

function SectionBody({ brief, s, hostName, sourceTitle }: { brief: ExecutiveBrief; s: BriefSection; hostName: (id: string) => string; sourceTitle: (id: string) => string }) {
  const why = (r?: string) => (r ? <p className="briefWhy">Why: {r}</p> : null);
  if (REASONED.includes(s)) { const v = (brief as any)[s]; return <>{<p className="planValue">{v.value}</p>}{why(v.rationale)}</>; }
  if (LISTS.includes(s)) { const a = (brief as any)[s] as string[]; return a.length ? <ul className="briefList">{a.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="stageHint">None.</p>; }
  if (s === "segments") return <ol className="briefList">{brief.segments.map((x, i) => <li key={i}><strong>{x.title}</strong> — {x.goal}{x.sourceIds.length > 0 && <span className="stageHint"> · {x.sourceIds.map(sourceTitle).join("; ")}</span>}</li>)}</ol>;
  if (s === "hostAssignments") return brief.hostAssignments.length ? <ul className="briefList">{brief.hostAssignments.map((h) => <li key={h.hostId}><strong>{hostName(h.hostId)}</strong>{h.role ? ` (${h.role})` : ""}: {h.perspective}</li>)}</ul> : <p className="stageHint">No hosts assigned.</p>;
  return brief.evidence.length ? <ul className="briefList">{brief.evidence.map((e) => <li key={e.sourceId}><strong>{sourceTitle(e.sourceId)}</strong>{e.use ? `: ${e.use}` : ""}</li>)}</ul> : <p className="stageHint">No stories on file were picked as evidence.</p>;
}
