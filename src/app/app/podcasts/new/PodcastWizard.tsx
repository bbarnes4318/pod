"use client";

import React, { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createPodcast, updatePodcast } from "../actions";
import { WEEKDAYS, WEEKDAY_LABELS, SEGMENT_MIN, SEGMENT_MAX, SEGMENT_DEFAULT, type PodcastInput } from "../config";
import { VERTICALS, TEAM_LEAGUE_BY_VERTICAL, teamLeagueIdsForVerticals } from "@/lib/verticals";
import {
  SHOW_TEMPLATES,
  defaultShowForgeState,
  templateBible,
  type ShowBible,
  type ShowForgeState,
  type ShowStoryline,
} from "@/lib/shows/showForge";

export interface WizardHost { id: string; name: string; role: string }
export interface WizardTeam { id: string; leagueId: string; name: string }
export interface WizardInitial {
  name?: string;
  cadence?: "one_time" | "recurring";
  scheduleDays?: string[];
  verticals?: string[];
  teams?: string[];
  segmentCount?: number;
  hostIds?: string[];
  showForge?: ShowForgeState;
}

const STEPS = ["Spark", "Promise", "World", "Cast", "Episode DNA", "Storylines", "Schedule", "Launch"];
const TEMPLATE_COPY: Record<ShowBible["templateId"], { title: string; kicker: string; icon: string }> = {
  rivalry_room: { title: "The Rivalry Room", kicker: "Two believers. One argument. No fake neutrality.", icon: "⚡" },
  insider_room: { title: "Inside the Building", kicker: "Why organizations decide—and who pays.", icon: "🔐" },
  fan_court: { title: "Fan Court", kicker: "Put the decision on trial from the fan's seat.", icon: "⚖" },
  season_story: { title: "The Season Story", kicker: "Standalone episodes that build a larger chapter.", icon: "🎬" },
  custom: { title: "Build Your Own", kicker: "Start with a blank creative room.", icon: "✦" },
};

const TONE_LABELS: Record<ShowBible["tone"], string> = {
  combustible: "Combustible",
  smart_funny: "Smart + funny",
  intimate: "Intimate",
  cinematic: "Cinematic",
  fast_loose: "Fast + loose",
};

function newId(prefix: string) {
  return `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;
}

function starterStoryline(hostIds: string[]): ShowStoryline {
  return {
    id: newId("arc"),
    title: "The argument that changes them",
    premise: "A disagreement that begins as a sports take gradually exposes a deeper difference in how the hosts judge loyalty, power, or accountability.",
    status: "active",
    priority: 3,
    featuredHostIds: hostIds,
    beats: [
      { title: "Plant the fault line", direction: "Let the hosts discover the deeper disagreement naturally. Do not resolve it and do not announce that an arc has begun." },
      { title: "Make it personal", direction: "A new story should force one host to defend the standard they used earlier while the other points out the cost of that standard." },
      { title: "Earn movement", direction: "One host changes or sharpens a position in a way that costs them something. Resolve this chapter without manufacturing total agreement." },
    ],
  };
}

function Field({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span style={{ fontWeight: 800, fontSize: ".86rem" }}>{label}</span>
      {help && <span style={{ color: "var(--text-muted)", fontSize: ".75rem", lineHeight: 1.45 }}>{help}</span>}
      {children}
    </label>
  );
}

function Choice<T extends string>({ value, current, title, help, onClick }: { value: T; current: T; title: string; help?: string; onClick: (value: T) => void }) {
  const selected = value === current;
  return (
    <button type="button" onClick={() => onClick(value)} className={selected ? "btnPrimary" : "btnGhost"} style={{ textAlign: "left", minHeight: 62, padding: ".75rem .85rem" }}>
      <strong style={{ display: "block" }}>{selected ? "✓ " : ""}{title}</strong>
      {help && <span style={{ display: "block", fontSize: ".72rem", opacity: .82, marginTop: 4, lineHeight: 1.35 }}>{help}</span>}
    </button>
  );
}

export default function PodcastWizard({ hosts, teams, initial = {}, podcastId, prefillTopicTitle, hideIdentity }: {
  hosts: WizardHost[];
  teams: WizardTeam[];
  initial?: WizardInitial;
  podcastId?: string;
  prefillTopicTitle?: string;
  /**
   * Suppress the wizard's own title block. Surfaces that already name the page
   * in their chrome (the studio shell) pass this; without it the page carries
   * two <h1>s and ~90px of repeated identity above the first control.
   */
  hideIdentity?: boolean;
}) {
  const router = useRouter();
  const initialForge = initial.showForge || defaultShowForgeState();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(initial.name || "");
  const [cadence, setCadence] = useState<"one_time" | "recurring">(initial.cadence || "recurring");
  const [scheduleDays, setScheduleDays] = useState<string[]>(initial.scheduleDays || ["mon"]);
  const [verticals, setVerticals] = useState<string[]>(initial.verticals || []);
  const [teamIds, setTeamIds] = useState<string[]>(initial.teams || []);
  const [segmentCount, setSegmentCount] = useState(initial.segmentCount || SEGMENT_DEFAULT);
  const [hostIds, setHostIds] = useState<string[]>(initial.hostIds || []);
  const [showForge, setShowForge] = useState<ShowForgeState>(initialForge);
  const [error, setError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const bible = showForge.bible;
  const availableTeams = useMemo(() => {
    const leagues = new Set(teamLeagueIdsForVerticals(verticals));
    return teams.filter((team) => leagues.has(team.leagueId));
  }, [teams, verticals]);
  const selectedHosts = hosts.filter((host) => hostIds.includes(host.id));

  const setBible = <K extends keyof ShowBible>(key: K, value: ShowBible[K]) =>
    setShowForge((current) => ({ ...current, bible: { ...current.bible, [key]: value } }));

  const selectTemplate = (templateId: ShowBible["templateId"]) => {
    setShowForge((current) => ({ ...current, bible: templateBible(templateId) }));
  };

  const toggle = (value: string, current: string[], max?: number) => {
    if (current.includes(value)) return current.filter((item) => item !== value);
    if (max && current.length >= max) return current;
    return [...current, value];
  };

  const addSegment = () => setBible("recurringSegments", [
    ...bible.recurringSegments,
    { id: newId("segment"), name: "New recurring segment", purpose: "What this segment adds that the rest of the episode does not.", frequency: "often" },
  ]);

  const updateSegment = (index: number, patch: Partial<ShowBible["recurringSegments"][number]>) => {
    setBible("recurringSegments", bible.recurringSegments.map((segment, i) => i === index ? { ...segment, ...patch } : segment));
  };

  const addStoryline = () => setShowForge((current) => ({ ...current, storylines: [...current.storylines, starterStoryline(hostIds)] }));
  const updateStoryline = (index: number, patch: Partial<ShowStoryline>) =>
    setShowForge((current) => ({ ...current, storylines: current.storylines.map((storyline, i) => i === index ? { ...storyline, ...patch } : storyline) }));
  const removeStoryline = (index: number) =>
    setShowForge((current) => ({ ...current, storylines: current.storylines.filter((_, i) => i !== index) }));
  const updateBeat = (storyIndex: number, beatIndex: number, patch: Partial<ShowStoryline["beats"][number]>) => {
    const story = showForge.storylines[storyIndex];
    updateStoryline(storyIndex, { beats: story.beats.map((beat, i) => i === beatIndex ? { ...beat, ...patch } : beat) });
  };
  const addBeat = (storyIndex: number) => {
    const story = showForge.storylines[storyIndex];
    updateStoryline(storyIndex, { beats: [...story.beats, { title: `Beat ${story.beats.length + 1}`, direction: "Describe what should move in this chapter without inventing facts." }] });
  };

  const validateStep = (): string | null => {
    if (step === 0 && !name.trim()) return "Give the show a name.";
    if (step === 1) {
      if (bible.premise.trim().length < 8) return "Explain what the show is really about.";
      if (bible.audiencePromise.trim().length < 8) return "Tell listeners what they will consistently get.";
    }
    if (step === 2 && verticals.length === 0) return "Pick at least one sports world.";
    if (step === 3 && hostIds.length === 0) return "Choose at least one host.";
    if (step === 4 && bible.recurringSegments.length === 0) return "Give the show at least one recurring segment.";
    if (step === 5) {
      for (const storyline of showForge.storylines) {
        if (!storyline.title.trim() || !storyline.premise.trim()) return "Every storyline needs a title and premise.";
        if (storyline.beats.length < 2) return `“${storyline.title}” needs at least two beats.`;
        if (storyline.beats.some((beat) => !beat.title.trim() || !beat.direction.trim())) return `Finish every beat in “${storyline.title}.”`;
      }
    }
    if (step === 6 && cadence === "recurring" && scheduleDays.length === 0) return "Choose at least one release day.";
    return null;
  };

  const next = () => {
    const message = validateStep();
    if (message) { setError(message); return; }
    setError(null);
    setStep((value) => Math.min(STEPS.length - 1, value + 1));
  };

  const submit = () => {
    setError(null);
    const input: PodcastInput = {
      name: name.trim(), cadence, scheduleDays, verticals, teams: teamIds,
      segmentCount, hostIds, showForge,
    };
    startTransition(async () => {
      const result = podcastId ? await updatePodcast(podcastId, input) : await createPodcast(input);
      if (!result.success) { setError(result.error); return; }
      setSuccessId(result.podcastId);
      router.refresh();
    });
  };

  if (successId) {
    return (
      <div className="studioCard fadeUp" style={{ textAlign: "center", padding: "3rem 1.5rem", maxWidth: 760, margin: "0 auto" }}>
        <div style={{ fontSize: "3.5rem" }}>🎙️</div>
        <h1 className="displayTitle" style={{ fontSize: "2.25rem", marginTop: ".7rem" }}>{podcastId ? "Show bible updated" : "Your show is alive"}</h1>
        <p style={{ color: "var(--text-secondary)", maxWidth: 560, margin: ".8rem auto 1.4rem", lineHeight: 1.6 }}>
          <strong>{name}</strong> now has a premise, audience promise, cast chemistry, episode rituals, recurring segments, and {showForge.storylines.length || "no forced"} season storyline{showForge.storylines.length === 1 ? "" : "s"}.
        </p>
        <div style={{ display: "flex", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
          <Link className="btnPrimary" href={`/app/podcasts/${successId}`}>Open show headquarters</Link>
          <Link className="btnGhost" href="/app/podcasts">All shows</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      {/* The studio route names the page in its chrome, so the wizard must not
          repeat it there. Note the classes this block used — .pageTitle and
          .pageSub — no longer exist ANYWHERE: they were deleted with the old
          per-page chrome, and this file sits outside src/app/studio/**, so the
          token spec never caught it still reaching for them. It has been
          rendering unstyled since. */}
      {!hideIdentity && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: "1rem" }}>
          <div>
            <div style={{ fontSize: ".72rem", color: "var(--accent)", fontWeight: 900, letterSpacing: ".12em", textTransform: "uppercase" }}>Show Forge</div>
            <h1 style={{ fontFamily: "var(--font-display)", fontSize: "1.6rem", fontWeight: 800, margin: "0 0 3px" }}>{podcastId ? "Shape the show" : "Build a show people return to"}</h1>
            <p style={{ margin: 0, color: "var(--text-muted)", fontSize: ".9rem" }}>Not a topic filter. A real creative world for every episode.</p>
          </div>
          <div style={{ color: "var(--text-muted)", fontSize: ".78rem" }}>Step {step + 1} of {STEPS.length}</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${STEPS.length}, 1fr)`, gap: 5, marginBottom: "1.25rem" }}>
        {STEPS.map((title, index) => (
          <button key={title} type="button" onClick={() => index <= step && setStep(index)} style={{ border: 0, borderRadius: 999, height: 7, background: index <= step ? "var(--accent)" : "var(--border-color)", cursor: index <= step ? "pointer" : "default" }} title={title} />
        ))}
      </div>

      <div className="studioCard fadeUp" style={{ minHeight: 480, padding: "1.35rem" }}>
        <div style={{ fontSize: ".72rem", fontWeight: 900, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: ".1em" }}>{STEPS[step]}</div>

        {step === 0 && (
          <div style={{ marginTop: "1rem" }}>
            <Field label="What is the show called?" help="Use the name listeners will see in their podcast app.">
              <input className="advSelect" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. The Fourth Quarter" style={{ fontSize: "1.2rem", padding: ".9rem" }} />
            </Field>
            <div style={{ marginTop: "1.5rem", fontWeight: 800 }}>Choose the creative starting point</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 9 }}>
              {(Object.keys(TEMPLATE_COPY) as ShowBible["templateId"][]).map((id) => {
                const selected = bible.templateId === id;
                const copy = TEMPLATE_COPY[id];
                return (
                  <button key={id} type="button" onClick={() => selectTemplate(id)} className={selected ? "btnPrimary" : "btnGhost"} style={{ minHeight: 120, textAlign: "left", padding: "1rem" }}>
                    <span style={{ fontSize: "1.5rem" }}>{copy.icon}</span>
                    <strong style={{ display: "block", fontSize: "1rem", marginTop: 8 }}>{selected ? "✓ " : ""}{copy.title}</strong>
                    <span style={{ display: "block", fontSize: ".75rem", lineHeight: 1.4, marginTop: 5, opacity: .82 }}>{copy.kicker}</span>
                  </button>
                );
              })}
            </div>
            {prefillTopicTitle && <div className="advNote" style={{ marginTop: "1rem" }}>Your first episode can begin with: <strong>{prefillTopicTitle}</strong></div>}
          </div>
        )}

        {step === 1 && (
          <div style={{ display: "grid", gap: "1.15rem", marginTop: "1rem" }}>
            <Field label="What is this show really about?" help="Not the sport. The human question or conflict that gives every episode a point of view.">
              <textarea className="advSelect" rows={4} value={bible.premise} onChange={(event) => setBible("premise", event.target.value)} />
            </Field>
            <Field label="What promise are you making the listener?" help="Finish this thought: People return because every episode gives them…">
              <textarea className="advSelect" rows={3} value={bible.audiencePromise} onChange={(event) => setBible("audiencePromise", event.target.value)} />
            </Field>
            <Field label="How does this show judge a story?">
              <textarea className="advSelect" rows={3} value={bible.pointOfView} onChange={(event) => setBible("pointOfView", event.target.value)} />
            </Field>
            <div>
              <div style={{ fontWeight: 800, marginBottom: 8 }}>The room should feel…</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 8 }}>
                {(Object.keys(TONE_LABELS) as ShowBible["tone"][]).map((tone) => <Choice key={tone} value={tone} current={bible.tone} title={TONE_LABELS[tone]} onClick={(value) => setBible("tone", value)} />)}
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div style={{ marginTop: "1rem" }}>
            <h2 style={{ margin: 0 }}>Which sports worlds belong in this show?</h2>
            <p style={{ color: "var(--text-muted)", fontSize: ".8rem" }}>This controls which real researched stories can enter the show.</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: "1rem" }}>
              {VERTICALS.map((vertical) => (
                <button key={vertical} type="button" className={verticals.includes(vertical) ? "btnPrimary" : "btnGhost"} onClick={() => {
                  const next = toggle(vertical, verticals);
                  setVerticals(next);
                  const legal = new Set(teamLeagueIdsForVerticals(next));
                  setTeamIds((current) => current.filter((id) => teams.some((team) => team.id === id && legal.has(team.leagueId))));
                }}>{verticals.includes(vertical) ? "✓ " : ""}{vertical}</button>
              ))}
            </div>
            {availableTeams.length > 0 && (
              <div style={{ marginTop: "1.5rem" }}>
                <div style={{ fontWeight: 800 }}>Follow specific teams <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>(optional)</span></div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 8, maxHeight: 220, overflowY: "auto" }}>
                  {availableTeams.map((team) => <button key={team.id} type="button" className={teamIds.includes(team.id) ? "btnPrimary" : "btnGhost"} onClick={() => setTeamIds(toggle(team.id, teamIds))}>{teamIds.includes(team.id) ? "✓ " : ""}{team.name}</button>)}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div style={{ marginTop: "1rem" }}>
            <h2 style={{ margin: 0 }}>Cast the show</h2>
            <p style={{ color: "var(--text-muted)", fontSize: ".8rem" }}>Choose up to two hosts. Their Host Studio personalities and voices travel into every episode.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: "1rem" }}>
              {hosts.map((host) => {
                const selected = hostIds.includes(host.id);
                return <button key={host.id} type="button" className={selected ? "btnPrimary" : "btnGhost"} onClick={() => setHostIds(toggle(host.id, hostIds, 2))} style={{ minHeight: 100, textAlign: "left", padding: "1rem" }}><strong style={{ display: "block" }}>{selected ? "✓ " : ""}{host.name}</strong><span style={{ display: "block", fontSize: ".75rem", marginTop: 5, opacity: .82, lineHeight: 1.4 }}>{host.role}</span></button>;
              })}
            </div>
            <Field label="What is their chemistry?" help="Describe the relationship, not generic roles. What do they admire, resent, misunderstand, or need from each other?">
              <textarea className="advSelect" rows={4} value={bible.hostChemistry} onChange={(event) => setBible("hostChemistry", event.target.value)} style={{ marginTop: 8 }} />
            </Field>
            {selectedHosts.length > 0 && <div className="advNote" style={{ marginTop: "1rem" }}><strong>On-air room:</strong> {selectedHosts.map((host) => host.name).join(" + ")}</div>}
          </div>
        )}

        {step === 4 && (
          <div style={{ marginTop: "1rem" }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, .7fr) minmax(300px, 1.3fr)", gap: "1.2rem" }}>
              <div>
                <Field label="How many researched stories per episode?" help="This is the topic count, not the number of recurring segments.">
                  <input type="range" min={SEGMENT_MIN} max={SEGMENT_MAX} value={segmentCount} onChange={(event) => setSegmentCount(Number(event.target.value))} />
                </Field>
                <div className="displayTitle" style={{ fontSize: "3rem", marginTop: 8 }}>{segmentCount}</div>
                <Field label="Opening ritual" help="A repeatable way to enter—not a word-for-word script.">
                  <textarea className="advSelect" rows={3} value={bible.openingRitual} onChange={(event) => setBible("openingRitual", event.target.value)} />
                </Field>
                <Field label="Closing ritual">
                  <textarea className="advSelect" rows={3} value={bible.closingRitual} onChange={(event) => setBible("closingRitual", event.target.value)} />
                </Field>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><strong>Recurring segment library</strong><button type="button" className="btnGhost" onClick={addSegment}>+ Add segment</button></div>
                <p style={{ fontSize: ".75rem", color: "var(--text-muted)" }}>The writer may use these when they fit. They are never forced like a checklist.</p>
                <div style={{ display: "grid", gap: 9 }}>
                  {bible.recurringSegments.map((segment, index) => (
                    <div key={segment.id} style={{ border: "1px solid var(--border-color)", borderRadius: 10, padding: ".85rem", display: "grid", gap: 7 }}>
                      <input className="advSelect" value={segment.name} onChange={(event) => updateSegment(index, { name: event.target.value })} />
                      <textarea className="advSelect" rows={2} value={segment.purpose} onChange={(event) => updateSegment(index, { purpose: event.target.value })} />
                      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                        {(["every_episode", "often", "occasionally"] as const).map((frequency) => <button key={frequency} type="button" className={segment.frequency === frequency ? "btnPrimary" : "btnGhost"} onClick={() => updateSegment(index, { frequency })}>{frequency.replace("_", " ")}</button>)}
                        {bible.recurringSegments.length > 1 && <button type="button" className="btnGhost" style={{ marginLeft: "auto" }} onClick={() => setBible("recurringSegments", bible.recurringSegments.filter((_, i) => i !== index))}>Remove</button>}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 5 && (
          <div style={{ marginTop: "1rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div><h2 style={{ margin: 0 }}>Build season storylines</h2><p style={{ color: "var(--text-muted)", fontSize: ".8rem", maxWidth: 650 }}>A beat changes the relationship, framing, or conclusion. It never invents a news event. Active arcs are interleaved across episodes.</p></div>
              <button type="button" className="btnPrimary" onClick={addStoryline}>+ Add storyline</button>
            </div>
            {showForge.storylines.length === 0 && <div className="advNote" style={{ marginTop: "1rem" }}>Storylines are optional. The show bible still shapes every standalone episode. Add an arc when you want listeners to feel progression across episodes.</div>}
            <div style={{ display: "grid", gap: "1rem", marginTop: "1rem" }}>
              {showForge.storylines.map((storyline, storyIndex) => (
                <div key={storyline.id} style={{ border: "1px solid var(--border-color)", borderRadius: 12, padding: "1rem" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10 }}>
                    <input className="advSelect" value={storyline.title} onChange={(event) => updateStoryline(storyIndex, { title: event.target.value })} style={{ fontWeight: 800 }} />
                    <button type="button" className="btnGhost" onClick={() => removeStoryline(storyIndex)}>Remove</button>
                  </div>
                  <textarea className="advSelect" rows={3} value={storyline.premise} onChange={(event) => updateStoryline(storyIndex, { premise: event.target.value })} style={{ marginTop: 8 }} />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                    {(["active", "paused", "resolved"] as const).map((status) => <button key={status} type="button" className={storyline.status === status ? "btnPrimary" : "btnGhost"} onClick={() => updateStoryline(storyIndex, { status })}>{status}</button>)}
                    <label style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto", fontSize: ".75rem" }}>Priority <input type="number" min={1} max={5} className="advSelect" style={{ width: 70 }} value={storyline.priority} onChange={(event) => updateStoryline(storyIndex, { priority: Number(event.target.value) })} /></label>
                  </div>
                  <div style={{ marginTop: "1rem", fontWeight: 800 }}>Episode beats</div>
                  <div style={{ display: "grid", gap: 8, marginTop: 7 }}>
                    {storyline.beats.map((beat, beatIndex) => (
                      <div key={`${storyline.id}-${beatIndex}`} style={{ display: "grid", gridTemplateColumns: "36px minmax(140px, .7fr) minmax(220px, 1.3fr)", gap: 8, alignItems: "start" }}>
                        <div style={{ width: 30, height: 30, borderRadius: 999, display: "grid", placeItems: "center", background: "var(--border-color)", fontWeight: 900 }}>{beatIndex + 1}</div>
                        <input className="advSelect" value={beat.title} onChange={(event) => updateBeat(storyIndex, beatIndex, { title: event.target.value })} />
                        <textarea className="advSelect" rows={2} value={beat.direction} onChange={(event) => updateBeat(storyIndex, beatIndex, { direction: event.target.value })} />
                      </div>
                    ))}
                  </div>
                  {storyline.beats.length < 12 && <button type="button" className="btnGhost" onClick={() => addBeat(storyIndex)} style={{ marginTop: 8 }}>+ Add beat</button>}
                </div>
              ))}
            </div>
          </div>
        )}

        {step === 6 && (
          <div style={{ marginTop: "1rem" }}>
            <h2 style={{ margin: 0 }}>How does the show live?</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(220px, 1fr))", gap: 10, marginTop: "1rem" }}>
              <Choice value="one_time" current={cadence} title="One-time series" help="You decide when to make every episode." onClick={setCadence} />
              <Choice value="recurring" current={cadence} title="Recurring show" help="The system creates episodes on selected days." onClick={setCadence} />
            </div>
            {cadence === "recurring" && (
              <div style={{ marginTop: "1.25rem" }}>
                <div style={{ fontWeight: 800 }}>Release days</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                  {WEEKDAYS.map((day) => <button key={day} type="button" className={scheduleDays.includes(day) ? "btnPrimary" : "btnGhost"} onClick={() => setScheduleDays(toggle(day, scheduleDays))}>{scheduleDays.includes(day) ? "✓ " : ""}{WEEKDAY_LABELS[day]}</button>)}
                </div>
              </div>
            )}
            <div style={{ marginTop: "1.5rem" }}>
              <div style={{ fontWeight: 800 }}>Writing mode</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(150px, 1fr))", gap: 8, marginTop: 8 }}>
                <Choice value="heated-debate" current={showForge.scriptStyle} title="Heated debate" onClick={(value) => setShowForge((current) => ({ ...current, scriptStyle: value }))} />
                <Choice value="balanced-analysis" current={showForge.scriptStyle} title="Balanced analysis" onClick={(value) => setShowForge((current) => ({ ...current, scriptStyle: value }))} />
                <Choice value="sports-radio" current={showForge.scriptStyle} title="Sports radio" onClick={(value) => setShowForge((current) => ({ ...current, scriptStyle: value }))} />
              </div>
            </div>
          </div>
        )}

        {step === 7 && (
          <div style={{ marginTop: "1rem" }}>
            <div style={{ borderRadius: 18, padding: "1.4rem", background: "linear-gradient(135deg, rgba(255,255,255,.06), rgba(255,255,255,.015))", border: "1px solid var(--border-color)" }}>
              <div style={{ fontSize: ".7rem", color: "var(--accent)", textTransform: "uppercase", letterSpacing: ".12em", fontWeight: 900 }}>{TEMPLATE_COPY[bible.templateId].title}</div>
              <h2 className="displayTitle" style={{ fontSize: "2.5rem", margin: ".35rem 0" }}>{name || "Untitled show"}</h2>
              <p style={{ fontSize: "1rem", lineHeight: 1.55, maxWidth: 760 }}>{bible.premise}</p>
              <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: "1rem" }}>
                <span className="chip">{TONE_LABELS[bible.tone]}</span>
                <span className="chip">{segmentCount} stories / episode</span>
                <span className="chip">{bible.recurringSegments.length} recurring segments</span>
                <span className="chip">{showForge.storylines.length} season arcs</span>
                <span className="chip">{cadence === "recurring" ? scheduleDays.map((day) => WEEKDAY_LABELS[day].slice(0, 3)).join(" / ") : "Manual releases"}</span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10, marginTop: "1rem" }}>
              <div className="studioCard"><strong>Listener promise</strong><p style={{ fontSize: ".8rem", lineHeight: 1.5 }}>{bible.audiencePromise}</p></div>
              <div className="studioCard"><strong>Cast chemistry</strong><p style={{ fontSize: ".8rem", lineHeight: 1.5 }}>{bible.hostChemistry}</p><div style={{ fontSize: ".72rem", color: "var(--text-muted)" }}>{selectedHosts.map((host) => host.name).join(" + ")}</div></div>
              <div className="studioCard"><strong>Season engine</strong><p style={{ fontSize: ".8rem", lineHeight: 1.5 }}>{showForge.storylines.length ? showForge.storylines.filter((storyline) => storyline.status === "active").map((storyline) => storyline.title).join(" · ") : "Standalone episodes inside one consistent show world."}</p></div>
            </div>
            <div className="advNote" style={{ marginTop: "1rem" }}>Every generated episode receives this show bible. Active storyline beats are scheduled in order and may shape character movement—but the evidence system remains the only authority for real-world facts.</div>
          </div>
        )}

        {error && <div className="gateResult gate-err" style={{ marginTop: "1rem" }}>{error}</div>}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: "1rem", alignItems: "center" }}>
        {step > 0 ? <button type="button" className="btnGhost" onClick={() => { setError(null); setStep((value) => value - 1); }}>Back</button> : <Link className="btnGhost" href={podcastId ? `/app/podcasts/${podcastId}` : "/app/podcasts"}>Cancel</Link>}
        <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: ".75rem" }}>{STEPS[step]}</span>
        {step < STEPS.length - 1 ? <button type="button" className="btnPrimary" onClick={next}>Next</button> : <button type="button" className="btnPrimary" disabled={pending} onClick={submit}>{pending ? "Building the show…" : podcastId ? "Save show bible" : "Launch the show"}</button>}
      </div>
    </div>
  );
}
