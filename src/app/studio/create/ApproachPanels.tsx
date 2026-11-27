"use client";

// Three ways to make an episode, over ONE rundown.
//
//   AI Producer  You say what the episode should do; the studio proposes the
//                whole production (stories, order, lead, hosts, sound) with the
//                reason for each choice. You accept it, swap a story, or take
//                it into Manual.
//   Guided       The studio asks one question at a time and recommends an
//                answer from the research, starting with the story the episode
//                is built around.
//   Manual       Every control, in your order (the existing rundown builder).
//
// All three write the SAME rundown state and create through the SAME action,
// so what a proposal shows is exactly what gets made, and switching approach
// never loses work. The recommendations come from lib/studio/productionPlan —
// deterministic, from stored research. No model is called until the episode is
// created, and the copy says so.

import React, { useMemo, useState } from "react";
import Link from "next/link";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";
import { planProduction, rankForObjective, suggestCompanions, type PlannedTopic } from "@/lib/studio/productionPlan";
import { OpportunityActions } from "../shows/[id]/BusinessResearchClient";
import type { BuilderHost } from "./parts";

export type Approach = "producer" | "guided" | "manual";

export const APPROACHES: { key: Approach; name: string; line: string; detail: string }[] = [
  { key: "producer", name: "AI Producer", line: "Tell it the goal. It proposes the whole episode.", detail: "Stories, order, hosts and sound, each with its reason. Accept it or change anything." },
  { key: "guided", name: "Guided", line: "Build it together, one decision at a time.", detail: "The studio recommends an answer at each step from the research. You choose." },
  { key: "manual", name: "Manual", line: "Every control, in your order.", detail: "Pick and order the stories yourself, set hosts, voices and production by hand." },
];

export function ApproachChooser({ value, onChange }: { value: Approach; onChange: (a: Approach) => void }) {
  return (
    <div className="approachGrid" role="radiogroup" aria-label="How do you want to make this episode?">
      {APPROACHES.map((a) => (
        <button
          key={a.key} type="button" role="radio" aria-checked={value === a.key} data-testid={`approach-${a.key}`}
          className={`approachCard${value === a.key ? " on" : ""}`} onClick={() => onChange(a.key)}
        >
          <span className="approachName">{a.name}</span>
          <span className="approachLine">{a.line}</span>
          <span className="approachDetail">{a.detail}</span>
        </button>
      ))}
    </div>
  );
}

/** What both panels need from the builder. One rundown, shared. */
export interface RundownHandle {
  topics: StudioTopicVM[];
  selectedIds: string[];
  leadTopicId: string | null;
  maxTopics: number;
  targetTopicCount: number;
  setTargetTopicCount: (n: number) => void;
  /** Replace the rundown (ordered, lead first) in one move. */
  setRundown: (ids: string[], leadId: string | null) => void;
  objective: string;
  setObjective: (s: string) => void;
  showName: string | null;
  hosts: BuilderHost[];
  hostIds: string[];
  toggleHost: (id: string) => void;
  productionStyle: string;
  setProductionStyle: (s: string) => void;
  sfxDensity: string;
  setSfxDensity: (s: string) => void;
  estimateMinutes: number;
  /** Open one of the Manual steps on this same rundown. */
  openStep: (step: "topics" | "hosts" | "production" | "review") => void;
}

const NO_MODEL_NOTE = "Recommendations come from the research already on file (heat, evidence, your objective). No AI model runs, and nothing is charged, until you create the episode.";

function TopicLine({ topic, plan, tag, children }: { topic: StudioTopicVM; plan?: PlannedTopic; tag?: string; children?: React.ReactNode }) {
  const why = topic.brief?.whyMattersNow?.trim() || topic.summary?.trim() || null;
  return (
    <div className="planTopic">
      <div className="planTopicHead">
        {tag && <span className="statusPill statusPill--live">{tag}</span>}
        <span className="planTopicTitle">{topic.title}</span>
      </div>
      {why && <p className="planTopicWhy">{why}</p>}
      {plan && <p className="planTopicReasons">{plan.reasons.join(" · ")}</p>}
      {children && <div className="planTopicActions">{children}</div>}
    </div>
  );
}

const STYLES = [
  { k: "clean", l: "Clean", d: "Voices only. No music or effects." },
  { k: "light", l: "Light", d: "A music bed at the open and close, light transitions." },
  { k: "full", l: "Full", d: "Music bed, stingers between segments and reactions." },
];

/* ------------------------------------------------------------------ *
 * AI Producer
 * ------------------------------------------------------------------ */
export function ProducerPanel({ r }: { r: RundownHandle }) {
  const byId = useMemo(() => new Map(r.topics.map((t) => [t.id, t])), [r.topics]);
  // The ranking behind the current rundown, recomputed from the same inputs so
  // each story can show its reasons and "Swap" knows what comes next.
  const ranked = useMemo(() => rankForObjective(r.topics, r.objective), [r.topics, r.objective]);
  const rankedById = useMemo(() => new Map(ranked.map((p) => [p.id, p])), [ranked]);
  const [notes, setNotes] = useState<string[]>([]);
  const proposed = r.selectedIds.length > 0;

  const prepare = () => {
    const plan = planProduction({ topics: r.topics, objective: r.objective, target: r.targetTopicCount, maxTopics: r.maxTopics });
    r.setRundown(plan.topics.map((t) => t.id), plan.leadId);
    setNotes(plan.notes);
  };
  const swap = (id: string) => {
    const next = ranked.find((p) => !r.selectedIds.includes(p.id));
    if (!next) return;
    const ids = r.selectedIds.map((x) => (x === id ? next.id : x));
    r.setRundown(ids, r.leadTopicId === id ? next.id : r.leadTopicId);
  };
  const remove = (id: string) => {
    const ids = r.selectedIds.filter((x) => x !== id);
    r.setRundown(ids, r.leadTopicId === id ? ids[0] ?? null : r.leadTopicId);
  };
  const spare = ranked.some((p) => !r.selectedIds.includes(p.id));
  const hostNames = r.hosts.filter((h) => r.hostIds.includes(h.id)).map((h) => h.name);

  return (
    <div data-testid="producer-panel">
      <div className="studioCard mb-3">
        <h2 className="sectionTitle mt-0">What should this episode do?</h2>
        <p className="stageHint mb-2">A sentence is enough: the angle, the story you care about, the mood. Leave it empty for the strongest stories right now.</p>
        <label className="srOnly" htmlFor="producerObjective">Creative objective</label>
        <textarea
          id="producerObjective" data-testid="producer-objective" className="input u-full" rows={3} maxLength={500}
          placeholder="e.g. The trade deadline: who actually got better, and who panicked"
          value={r.objective} onChange={(e) => r.setObjective(e.target.value)}
        />
        <label className="fieldLabel mt-3" htmlFor="producerCount">Stories: <strong>{r.targetTopicCount}</strong></label>
        <input id="producerCount" type="range" min={1} max={r.maxTopics} value={r.targetTopicCount} onChange={(e) => r.setTargetTopicCount(Number(e.target.value))} className="u-full" />
        <div className="planBar">
          <button type="button" className="btnPrimary" data-testid="producer-prepare" onClick={prepare}>
            {proposed ? "Propose again" : "Propose the episode"}
          </button>
          <span className="stageHint">{NO_MODEL_NOTE}</span>
        </div>
      </div>

      {proposed && (
        <div className="studioCard" data-testid="producer-proposal">
          <h2 className="sectionTitle mt-0">The proposed episode{r.showName ? ` for ${r.showName}` : ""}</h2>
          {notes.map((n, i) => <p key={i} className="noteWarn" role="note">{n}</p>)}

          <div className="planSection">
            <div className="fieldLabel">Rundown</div>
            <ol className="planList">
              {r.selectedIds.map((id, i) => {
                const topic = byId.get(id);
                if (!topic) return null;
                return (
                  <li key={id}>
                    <TopicLine topic={topic} plan={rankedById.get(id)} tag={id === r.leadTopicId || (!r.leadTopicId && i === 0) ? "Opens the show" : undefined}>
                      {spare && <button type="button" className="advLink" onClick={() => swap(id)}>Swap for the next best</button>}
                      {r.selectedIds.length > 1 && <button type="button" className="advLink" onClick={() => remove(id)}>Remove</button>}
                    </TopicLine>
                  </li>
                );
              })}
            </ol>
            <button type="button" className="advLink" onClick={() => r.openStep("topics")}>Choose stories by hand</button>
          </div>

          <div className="planSection">
            <div className="fieldLabel">Hosts</div>
            <p className="planValue">{hostNames.join(" and ") || "No hosts chosen"}</p>
            <p className="stageHint">{r.showName ? `The hosts ${r.showName} is set up with.` : "The studio's default pairing."} <button type="button" className="advLink" onClick={() => r.openStep("hosts")}>Change hosts</button></p>
          </div>

          <div className="planSection">
            <div className="fieldLabel">Sound</div>
            <p className="planValue">{STYLES.find((s) => s.k === r.productionStyle)?.l ?? r.productionStyle}: {STYLES.find((s) => s.k === r.productionStyle)?.d}</p>
            <p className="stageHint">About {r.estimateMinutes} minutes at this length (an estimate from the story count). <button type="button" className="advLink" onClick={() => r.openStep("production")}>Change sound, voices or model tier</button></p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Guided
 * ------------------------------------------------------------------ */
export function GuidedPanel({ r }: { r: RundownHandle }) {
  const byId = useMemo(() => new Map(r.topics.map((t) => [t.id, t])), [r.topics]);
  const leadId = r.leadTopicId ?? r.selectedIds[0] ?? null;
  const lead = leadId ? byId.get(leadId) ?? null : null;
  const leads = useMemo(() => rankForObjective(r.topics, r.objective).slice(0, 4), [r.topics, r.objective]);
  // Recommended companions for the CURRENT lead, plus anything already added.
  const companions = useMemo(
    () => (leadId ? suggestCompanions(r.topics, [leadId], r.objective, 5) : []),
    [r.topics, r.objective, leadId]
  );
  const extras = r.selectedIds.filter((id) => id !== leadId);
  const room = r.maxTopics - r.selectedIds.length;

  const chooseLead = (id: string) => r.setRundown([id, ...r.selectedIds.filter((x) => x !== id && x !== leadId)], id);
  const toggleCompanion = (id: string) => {
    if (!leadId) return;
    const on = extras.includes(id);
    if (!on && room <= 0) return;
    r.setRundown([leadId, ...(on ? extras.filter((x) => x !== id) : [...extras, id])], leadId);
  };

  return (
    <div data-testid="guided-panel">
      <div className="studioCard mb-3">
        <div className="guidedStep">1</div>
        <h2 className="sectionTitle mt-0">What is the one story this episode has to cover?</h2>
        <label className="fieldLabel" htmlFor="guidedObjective">Have something in mind? (optional)</label>
        <input id="guidedObjective" data-testid="guided-objective" className="input u-full" maxLength={500} placeholder="A team, a player, a question" value={r.objective} onChange={(e) => r.setObjective(e.target.value)} />
        <p className="stageHint mt-2">{r.objective.trim() ? "The closest stories on file to that:" : "The strongest stories on file right now:"}</p>
        {leads.length === 0 ? (
          <p className="noteWarn" role="note">No story is ready to use yet. New ones arrive as the feeds update.</p>
        ) : (
          <div className="planList" role="radiogroup" aria-label="Lead story">
            {leads.map((p) => {
              const topic = byId.get(p.id)!;
              const on = p.id === leadId;
              return (
                <button key={p.id} type="button" role="radio" aria-checked={on} data-testid={`guided-lead-${p.id}`} className={`planChoice${on ? " on" : ""}`} onClick={() => chooseLead(p.id)}>
                  <TopicLine topic={topic} plan={p} tag={on ? "Your lead" : undefined} />
                  {topic.brief?.strongestDebateQuestion && <p className="planTopicWhy"><strong>The argument:</strong> {topic.brief.strongestDebateQuestion}</p>}
                </button>
              );
            })}
          </div>
        )}
        <button type="button" className="advLink" onClick={() => r.openStep("topics")}>See every story</button>
      </div>

      {lead && (
        <div className="studioCard mb-3">
          <div className="guidedStep">2</div>
          <h2 className="sectionTitle mt-0">What goes with it?</h2>
          <p className="stageHint mb-2">One story makes a short, focused episode. Each one you add is another segment. {room > 0 ? `Room for ${room} more.` : "The rundown is full."}</p>
          {companions.length === 0 && extras.length === 0 ? (
            <p className="stageHint">Nothing else in the pool is ready to pair with it.</p>
          ) : (
            <div className="planList">
              {[...extras.filter((id) => !companions.some((c) => c.id === id)).map((id) => ({ id, plan: undefined as PlannedTopic | undefined })), ...companions.map((c) => ({ id: c.id, plan: c }))].map(({ id, plan }) => {
                const topic = byId.get(id);
                if (!topic) return null;
                const on = extras.includes(id);
                return (
                  <label key={id} className={`planChoice${on ? " on" : ""}`}>
                    <input type="checkbox" checked={on} disabled={!on && room <= 0} data-testid={`guided-add-${id}`} onChange={() => toggleCompanion(id)} />
                    <TopicLine topic={topic} plan={plan} />
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {lead && (
        <div className="studioCard mb-3">
          <div className="guidedStep">3</div>
          <h2 className="sectionTitle mt-0">Who argues it?</h2>
          {(lead.brief?.argumentForHostA || lead.brief?.argumentForHostB) && (
            <div className="guidedSides">
              {lead.brief?.argumentForHostA && <p className="planTopicWhy"><strong>One side:</strong> {lead.brief.argumentForHostA}</p>}
              {lead.brief?.argumentForHostB && <p className="planTopicWhy"><strong>The other:</strong> {lead.brief.argumentForHostB}</p>}
            </div>
          )}
          <p className="stageHint mb-2">{r.showName ? `${r.showName}'s hosts are selected. ` : ""}An episode is voiced by up to two hosts.</p>
          <div className="segRow u-wrap">
            {r.hosts.map((h) => {
              const seat = r.hostIds.indexOf(h.id);
              return (
                <button key={h.id} type="button" className={`segBtn${seat >= 0 ? " on" : ""}`} aria-pressed={seat >= 0} onClick={() => r.toggleHost(h.id)}>
                  {seat >= 0 && <strong className="mr-12">{seat + 1}</strong>}{h.name}
                </button>
              );
            })}
            {r.hosts.length === 0 && <span className="stageHint">No hosts yet. <Link href="/studio/hosts">Add one in Talent</Link></span>}
          </div>
        </div>
      )}

      {lead && (
        <div className="studioCard">
          <div className="guidedStep">4</div>
          <h2 className="sectionTitle mt-0">How should it sound?</h2>
          <div className="planList" role="radiogroup" aria-label="Sound design">
            {STYLES.map((s) => (
              <button key={s.k} type="button" role="radio" aria-checked={r.productionStyle === s.k} className={`planChoice${r.productionStyle === s.k ? " on" : ""}`} onClick={() => r.setProductionStyle(s.k)}>
                <span className="planTopicTitle">{s.l}</span>
                <span className="planTopicWhy">{s.d}</span>
              </button>
            ))}
          </div>
          <p className="stageHint mt-2">About {r.estimateMinutes} minutes with {r.selectedIds.length} stor{r.selectedIds.length === 1 ? "y" : "ies"} (an estimate). <button type="button" className="advLink" onClick={() => r.openStep("production")}>Voices, effects and model tier</button></p>
          <p className="stageHint">{NO_MODEL_NOTE}</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Business shows: same front door, their own research engine
 * ------------------------------------------------------------------ */
export interface BusinessShowEntry {
  id: string;
  name: string;
  /** Open topics not yet approved. */
  candidateCount: number;
  approved: { id: string; title: string; coreQuestion: string; whyNow: string | null; dossierStatus: string | null }[];
}

export function BusinessHandoff({ show }: { show: BusinessShowEntry }) {
  return (
    <div className="studioCard" data-testid="business-handoff">
      <h2 className="sectionTitle mt-0">{show.name} is made from its own research</h2>
      <p className="stageHint mb-3">
        A business episode starts from a topic you have approved and its research dossier, so every claim has a source behind it.
        {show.approved.length > 0 ? " These are approved and waiting:" : ""}
      </p>
      {show.approved.length === 0 ? (
        <>
          <p className="noteWarn" role="note">
            No approved topic yet.{" "}
            {show.candidateCount > 0
              ? `${show.candidateCount} topic${show.candidateCount === 1 ? " is" : "s are"} waiting for your decision on the Editorial desk.`
              : "Run research for this show and the topics it finds appear on the Editorial desk."}
          </p>
          <Link href={`/studio/desk?desk=business&show=${show.id}`} className="btnPrimary">Open the Editorial desk</Link>
        </>
      ) : (
        <>
          <ol className="planList">
            {show.approved.map((o) => (
              <li key={o.id} className="planTopic">
                <div className="planTopicHead">
                  <span className={`statusPill statusPill--${o.dossierStatus === "READY" ? "ok" : "warn"}`}>
                    {o.dossierStatus === "READY" ? "Dossier ready" : o.dossierStatus ? "Dossier not ready" : "No dossier yet"}
                  </span>
                  <span className="planTopicTitle">{o.title}</span>
                </div>
                <p className="planTopicWhy">{o.coreQuestion}</p>
                {o.whyNow && <p className="planTopicReasons">Why now: {o.whyNow}</p>}
                <div className="planTopicActions">
                  <OpportunityActions podcastId={show.id} opportunityId={o.id} status="APPROVED" dossierStatus={o.dossierStatus} />
                  <Link href={`/studio/desk?desk=business&show=${show.id}&topic=${o.id}`} className="advLink">See the evidence</Link>
                </div>
              </li>
            ))}
          </ol>
          <Link href={`/studio/desk?desk=business&show=${show.id}`} className="sectionAction">
            All of this show&apos;s research{show.candidateCount > 0 ? ` (${show.candidateCount} waiting for a decision)` : ""}
          </Link>
        </>
      )}
    </div>
  );
}
