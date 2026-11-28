"use client";

// Chemistry audition: pick two or three hosts and a subject, read the scene the
// writer produces from their profiles, then hear it in their real voices. Keep
// up to three takes side by side and put the pairing that works on a show.
//
// What is MEASURED (from the text: lines, word share, interruptions, turn runs)
// is shown apart from the writer's OPINION of the pairing. There is no
// chemistry score, because nothing measures chemistry.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { assignShowHosts, listMyShows, voiceChemistryScene, writeChemistryScene, type VoicedAudition } from "./chemistryActions";
import { AUDITION_STYLES, AUDITION_SUBJECTS, type AuditionScene, type AuditionStyleId, type AuditionSubjectId, type SceneFacts } from "@/lib/talent/chemistryAudition";
import type { StudioHostVM } from "./talentModel";

type Take = { id: number; scene: AuditionScene; facts: SceneFacts; audio: VoicedAudition | null };
const voiceReady = (id: string) => !!id && !/^PLACEHOLDER[_-]/i.test(id);
const SEAT_CLASS = ["chemSeatA", "chemSeatB", "chemSeatC"];

export function ChemistryAudition({ hosts, onClose }: { hosts: StudioHostVM[]; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [subjectId, setSubjectId] = useState<AuditionSubjectId>("trade");
  const [custom, setCustom] = useState("");
  const [style, setStyle] = useState<AuditionStyleId>("debate");
  const [phase, setPhase] = useState<"idle" | "writing" | "voicing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Take | null>(null);
  const [takes, setTakes] = useState<Take[]>([]);
  const seq = useRef(0);
  const name = (id: string) => hosts.find((h) => h.id === id)?.name ?? "Host";

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 3 ? p : [...p, id]));
  const canWrite = picked.length >= 2 && (subjectId !== "custom" || custom.trim().length >= 10) && phase === "idle";

  const write = async () => {
    setPhase("writing"); setError(null);
    try {
      const r = await writeChemistryScene({ hostIds: picked, subjectId, customSubject: custom, style });
      if (!r.success) { setError(r.error); return; }
      setCurrent({ id: ++seq.current, scene: r.scene, facts: r.facts, audio: null });
    } catch { setError("The request didn't reach the server. Check your connection and try again."); }
    finally { setPhase("idle"); }
  };
  const voice = async () => {
    if (!current) return;
    setPhase("voicing"); setError(null);
    try {
      const r = await voiceChemistryScene(current.scene);
      if (!r.success) { setError(r.error); return; }
      setCurrent({ ...current, audio: r.audio });
    } catch { setError("The request didn't reach the server. The scene is still here; try again."); }
    finally { setPhase("idle"); }
  };
  /** Recover a partial line-by-line voicing: only the failed lines are sent (and paid for). */
  const retryMissing = async () => {
    const a = current?.audio;
    if (!current || !a || a.mode !== "lines" || a.failedLines.length === 0) return;
    setPhase("voicing"); setError(null);
    try {
      const r = await voiceChemistryScene(current.scene, a.failedLines);
      if (!r.success) { setError(r.error); return; }
      if (r.audio.mode !== "lines") { setCurrent({ ...current, audio: r.audio }); return; }
      const clips = [...a.clips, ...r.audio.clips].sort((x, y) => x.lineIndex - y.lineIndex);
      setCurrent({ ...current, audio: { ...a, clips, failedLines: r.audio.failedLines } });
    } catch { setError("The request didn't reach the server. The voiced lines are kept; try again."); }
    finally { setPhase("idle"); }
  };
  const keep = () => { if (current) setTakes((t) => [current, ...t.filter((x) => x.id !== current.id)].slice(0, 3)); };

  return (
    <div className="studioCard chemCard" data-testid="chemistry-audition">
      <div className="briefHead">
        <h2 className="sectionTitle m-0">Chemistry audition</h2>
        <button type="button" className="btnGhost" onClick={onClose}>Close</button>
      </div>
      <p className="stageHint">Hear whether hosts work together before you cast them. A writer drafts a short scene from each host&apos;s profile, you read it, then voice it with their real voices.</p>

      <fieldset className="chemField">
        <legend className="fieldLabel">Talent (two or three)</legend>
        <div className="chemHosts">
          {hosts.map((h) => {
            const on = picked.includes(h.id);
            return (
              <button key={h.id} type="button" className={`chip${on ? " chip--on" : ""}`} aria-pressed={on} onClick={() => toggle(h.id)} disabled={!on && picked.length >= 3}>
                {h.name}{!voiceReady(h.ttsVoiceId) && <span className="stageHint"> · no voice yet</span>}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="chemRow">
        <label className="chemField">
          <span className="fieldLabel">Subject</span>
          <select className="input" value={subjectId} onChange={(e) => setSubjectId(e.target.value as AuditionSubjectId)}>
            {AUDITION_SUBJECTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            <option value="custom">Your own subject…</option>
          </select>
        </label>
        <label className="chemField">
          <span className="fieldLabel">Conversation style</span>
          <select className="input" value={style} onChange={(e) => setStyle(e.target.value as AuditionStyleId)}>
            {AUDITION_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {subjectId === "custom" && (
        <textarea className="input u-full mt-2" rows={2} maxLength={400} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Your audition subject" placeholder="e.g. Whether remote work is killing company culture" />
      )}

      <div className="planBar">
        <button type="button" className="btnPrimary" disabled={!canWrite} onClick={write} data-testid="chem-write">
          {phase === "writing" ? "Writing the scene…" : current ? "Write a new take" : "Write the scene"}
        </button>
        <span className="stageHint">About 60–90 seconds of conversation. Writing is one AI call; voicing is a separate step you start after reading it.</span>
      </div>
      {phase !== "idle" && <p className="stageHint" role="status">{phase === "writing" ? "The writer is working from each host's profile. Up to a minute." : "Recording with the hosts' voices. Up to a minute."}</p>}
      {error && <p className="noteWarn" role="alert">{error}</p>}

      {current && (
        <TakeView take={current} name={name} hosts={hosts}>
          {!current.audio && (
            <button type="button" className="btnPrimary" disabled={phase !== "idle"} onClick={voice} data-testid="chem-voice">
              {phase === "voicing" ? "Recording…" : `Voice it (~${current.facts.characters.toLocaleString()} characters)`}
            </button>
          )}
          {current.audio?.mode === "lines" && current.audio.failedLines.length > 0 && (
            <button type="button" className="btnGhost" disabled={phase !== "idle"} onClick={retryMissing} data-testid="chem-retry-missing">
              {phase === "voicing" ? "Recording…" : `Voice the ${current.audio.failedLines.length} missing line${current.audio.failedLines.length === 1 ? "" : "s"}`}
            </button>
          )}
          <button type="button" className="btnGhost" onClick={keep} disabled={takes.some((t) => t.id === current.id && !!t.audio === !!current.audio)}>Keep for comparison</button>
        </TakeView>
      )}

      {takes.length > 0 && (
        <section className="mt-3" aria-label="Kept takes">
          <h3 className="sectionTitle">Compare takes</h3>
          <div className="chemCompare">
            {takes.map((t) => <TakeView key={t.id} take={t} name={name} hosts={hosts} compact />)}
          </div>
        </section>
      )}
    </div>
  );
}

function TakeView({ take, name, hosts, compact, children }: { take: Take; name: (id: string) => string; hosts: StudioHostVM[]; compact?: boolean; children?: React.ReactNode }) {
  const [open, setOpen] = useState(!compact);
  const seatOf = (id: string) => take.scene.hostIds.indexOf(id);
  const f = take.facts;
  return (
    <article className="chemTake" aria-label={`Take: ${take.scene.hostIds.map(name).join(" and ")}`}>
      <div className="chemTakeHead">
        <strong>{take.scene.hostIds.map(name).join(" + ")}</strong>
        <span className="stageHint">{AUDITION_STYLES.find((s) => s.id === take.scene.style)?.label}</span>
      </div>
      {take.audio && <AuditionPlayer audio={take.audio} />}

      <div className="chemFacts" aria-label="Measured from the script">
        <span className="fieldLabel">Measured</span>
        <span>{f.lines} lines · ~{f.estimatedSeconds}s · {f.interruptions} interruption{f.interruptions === 1 ? "" : "s"} · longest run by one host: {f.longestRun}</span>
        <span>{f.perHost.map((p) => `${name(p.hostId)} ${p.wordShare}%`).join(" · ")} of the words</span>
        {f.strictlyAlternating && <span className="noteWarn">Strict turn-taking with no cut-ins: this reads like two speeches, not a conversation.</span>}
      </div>
      {(take.scene.modelNotes.works.length > 0 || take.scene.modelNotes.risks.length > 0) && (
        <div className="chemNotes">
          <span className="fieldLabel">The writer&apos;s opinion{take.scene.model ? ` (${take.scene.model})` : ""} — subjective, not measured</span>
          {take.scene.modelNotes.works.length > 0 && <p><strong>Works:</strong> {take.scene.modelNotes.works.join(" ")}</p>}
          {take.scene.modelNotes.risks.length > 0 && <p><strong>Risks:</strong> {take.scene.modelNotes.risks.join(" ")}</p>}
        </div>
      )}

      <button type="button" className="advLink" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide transcript" : "Show transcript"}</button>
      {open && (
        <ol className="chemTranscript">
          {take.scene.lines.map((l, i) => (
            <li key={i} className={SEAT_CLASS[seatOf(l.speakerHostId)] ?? ""}>
              <span className="chemSpeaker">{name(l.speakerHostId)}</span>
              <span>{l.isInterruption && <span className="stageHint">[cuts in] </span>}{l.text}</span>
            </li>
          ))}
        </ol>
      )}
      <div className="briefActions mt-2">
        {children}
        {take.scene.hostIds.length === 2 && <ApplyToShow hostIds={take.scene.hostIds} hosts={hosts} />}
      </div>
      {take.scene.hostIds.length > 2 && <p className="stageHint">Shows run with one or two hosts today, so a three-host take can be compared but not applied.</p>}
    </article>
  );
}

function AuditionPlayer({ audio }: { audio: VoicedAudition }) {
  const [i, setI] = useState(0);
  const ref = useRef<HTMLAudioElement>(null);
  const src = audio.mode === "scene" ? audio.audioDataUrl : audio.clips[i]?.audioDataUrl;
  useEffect(() => { if (audio.mode === "lines" && i > 0) ref.current?.play().catch(() => undefined); }, [i, audio.mode]);
  return (
    <div className="chemPlayer">
      <audio ref={ref} controls src={src} preload="metadata" onEnded={() => audio.mode === "lines" && i < audio.clips.length - 1 && setI(i + 1)} className="u-full" />
      <span className="stageHint">
        {audio.mode === "scene" ? `Performed as one scene (${audio.engine}).` : `Voiced line by line (${audio.engine}): the hosts are on different voice engines. Line ${i + 1} of ${audio.clips.length}.`}
        {audio.mode === "lines" && audio.failedLines.length > 0 && ` ${audio.failedLines.length} line(s) could not be voiced and are skipped in playback (lines ${audio.failedLines.map((n) => n + 1).join(", ")}).`}
      </span>
      {audio.mode === "lines" && i > 0 && <button type="button" className="advLink" onClick={() => setI(0)}>Play from the start</button>}
    </div>
  );
}

function ApplyToShow({ hostIds, hosts }: { hostIds: string[]; hosts: StudioHostVM[] }) {
  const [shows, setShows] = useState<{ id: string; name: string; hostIds: string[] }[] | null>(null);
  const [showId, setShowId] = useState("");
  const [state, setState] = useState<{ busy: boolean; msg: string | null; ok?: boolean }>({ busy: false, msg: null });
  const offAir = useMemo(() => hostIds.filter((id) => { const h = hosts.find((x) => x.id === id); return !h?.isActive || !voiceReady(h.ttsVoiceId); }), [hostIds, hosts]);
  if (!shows) return <button type="button" className="btnGhost" onClick={async () => setShows(await listMyShows())}>Cast them on a show…</button>;
  if (!shows.length) return <span className="stageHint">You have no shows yet. Create one, then cast these hosts on it.</span>;
  return (
    <span className="chemApply">
      <select className="input" value={showId} onChange={(e) => setShowId(e.target.value)} aria-label="Show to cast these hosts on">
        <option value="">Choose a show</option>
        {shows.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button type="button" className="btnPrimary" disabled={!showId || state.busy || offAir.length > 0} onClick={async () => {
        setState({ busy: true, msg: null });
        try {
          const r = await assignShowHosts(showId, hostIds);
          setState({ busy: false, ok: r.success, msg: r.success ? "Cast. New episodes of that show use these hosts." : r.error });
        } catch { setState({ busy: false, ok: false, msg: "The request didn't reach the server. Try again." }); }
      }}>{state.busy ? "Casting…" : "Cast on this show"}</button>
      {offAir.length > 0 && <span className="noteWarn">Put both hosts on air with a real voice first.</span>}
      {state.msg && <span className={state.ok ? "stageHint" : "noteWarn"} role="status">{state.msg}</span>}
    </span>
  );
}
