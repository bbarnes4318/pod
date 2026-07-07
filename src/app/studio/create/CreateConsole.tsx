"use client";

// The streaming take → episode Create flow.
//
// This is an editable, resumable STEPPER: Take → Style/Hosts/Length → Research
// → Script → Preview → Voices → Mix → Assets. Back is always available. Two
// human checkpoints gate spend: you approve the RESEARCH before a script is
// written, and you approve the SCRIPT before any voices are synthesized
// (TTS is the expensive step).
//
// Every stage state is REAL. We don't fake progress: after each action we poll
// getCreateProgress(), which reads Episode.status (written by the BullMQ worker
// as each pipeline job finishes) plus the artifacts that have actually landed —
// the ResearchBrief, the generated Script (its lines), and the AudioSegment
// rows. The named stage lines ("Scouting the take…", "Writing the debate…",
// "Mixing the episode…") are derived from that live status. No new pipeline is
// introduced — each button enqueues an existing job behind an ownership check.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  approveTake,
  researchTake,
  produceEpisodeFromTopics,
  startDebate,
  approveEpisodeScript,
  castEpisodeVoices,
  mixEpisode,
  generateEpisodeAssets,
  getCreateProgress,
} from "../../app/create/actions";
import {
  CREATE_STAGES,
  STAGE_ORDER,
  stageForStatus,
  streamingMessage,
  type StageKey,
} from "@/lib/createFlow";
import TranscriptWorkspace from "../TranscriptWorkspace";

export interface StepperTake {
  id: string;
  title: string;
  sport: string;
  status: string;
  hasBrief: boolean;
  heat: number;
}
export interface StepperHost {
  id: string;
  name: string;
  intensity: number;
}
export interface ResumeEpisode {
  id: string;
  title: string;
  status: string;
  topicId: string | null;
}

type ProgressState = Awaited<ReturnType<typeof getCreateProgress>>;

const STYLES = [
  { key: "heated-debate", label: "Debate" },
  { key: "balanced-analysis", label: "Analysis" },
  { key: "sports-radio", label: "Sports radio" },
] as const;
const SFX = [
  { key: "subtle", label: "Clean" },
  { key: "medium", label: "Balanced" },
  { key: "hype", label: "Spicy" },
] as const;
const LENGTHS = [8, 10, 12, 15, 20];
const PROD_FOR_SFX: Record<string, string> = { subtle: "clean", medium: "light", hype: "full" };

const CHECKPOINTS: StageKey[] = ["research", "preview"];
const orderOf = (s: StageKey | "done" | "failed"): number =>
  s === "done" ? STAGE_ORDER.length : s === "failed" ? -1 : STAGE_ORDER.indexOf(s);

export default function CreateConsole({
  takes,
  hosts,
  highlightTopic,
  resume,
}: {
  takes: StepperTake[];
  hosts: StepperHost[];
  highlightTopic?: string;
  resume: ResumeEpisode | null;
}) {
  // ---- Smart defaults: a first-timer reaches Generate in one click ----
  const defaultHostIds = useMemo(() => hosts.slice(0, 2).map((h) => h.id), [hosts]);
  const [style, setStyle] = useState<string>("heated-debate");
  const [sfx, setSfx] = useState<string>("hype");
  const [lengthMin, setLengthMin] = useState<number>(12);
  const [hostIds, setHostIds] = useState<string[]>(defaultHostIds);

  const seedTake = highlightTopic ? takes.find((t) => t.id === highlightTopic) : undefined;
  const [topicId, setTopicId] = useState<string | null>(resume?.topicId ?? seedTake?.id ?? null);
  const [episodeId, setEpisodeId] = useState<string | null>(resume?.id ?? null);
  const [stage, setStage] = useState<StageKey>(
    resume ? (() => { const s = stageForStatus(resume.status, true); return s === "done" || s === "failed" ? "assets" : s; })()
      : seedTake ? "setup" : "take"
  );

  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<string[] | null>(null);
  const [voicing, setVoicing] = useState(false);

  const currentTake = topicId ? takes.find((t) => t.id === topicId) : undefined;

  // Host colour coding: the higher-intensity host (chair A) is Max=orange, the
  // second is Doc=blue. Sanctioned override of the "orange = CTA only" rule.
  const hostA = hosts.find((h) => h.id === hostIds[0]);
  const hostB = hosts.find((h) => h.id === hostIds[1]);
  const colorForSpeaker = useCallback(
    (speaker: string): string => {
      const s = speaker.trim().toLowerCase();
      if (hostA && s === hostA.name.toLowerCase()) return "var(--host-max)";
      if (hostB && s === hostB.name.toLowerCase()) return "var(--host-doc)";
      return "var(--text-muted)";
    },
    [hostA, hostB]
  );

  // ---- REAL progress polling ----
  // The poll both snapshots progress AND advances the UI to follow the real
  // pipeline — except at the two checkpoints, which wait for a human approval.
  // (Advancing here, inside the async callback, keeps derived navigation out of
  // an effect body.)
  const stageRef = useRef<StageKey>(stage);
  stageRef.current = stage;
  const poll = useCallback(async () => {
    if (!topicId && !episodeId) return;
    try {
      const p = await getCreateProgress({ topicId: topicId ?? undefined, episodeId: episodeId ?? undefined });
      setProgress(p);
      if (!p.ok) return;
      const cur = stageRef.current;
      const pstage = p.stage as StageKey | "done" | "failed";
      if (cur === "script" && p.script?.present) {
        setStage("preview");
      } else if ((cur === "voices" || cur === "mix" || cur === "assets") && orderOf(pstage) > orderOf(cur)) {
        if (pstage === "done") setStage("assets");
        else if (!CHECKPOINTS.includes(pstage as StageKey)) setStage(pstage as StageKey);
      }
    } catch {
      /* transient — keep the last good snapshot */
    }
  }, [topicId, episodeId]);

  const liveStages: StageKey[] = ["research", "script", "preview", "voices", "mix", "assets"];
  const isLive = liveStages.includes(stage);
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(poll, 2500);
    poll();
    return () => clearInterval(id);
  }, [isLive, poll]);

  // Progressive reveal of script lines as they "land" (the script arrives as a
  // unit from the worker; we reveal it line-by-line for a live feel).
  const scriptLines = progress?.ok ? progress.script?.lines ?? [] : [];
  const [revealCount, setRevealCount] = useState(0);
  useEffect(() => {
    if (stage !== "script" && stage !== "preview") return;
    if (revealCount >= scriptLines.length) return;
    const id = setInterval(() => setRevealCount((n) => Math.min(scriptLines.length, n + 2)), 90);
    return () => clearInterval(id);
  }, [stage, revealCount, scriptLines.length]);
  useEffect(() => {
    if (stage === "preview") setRevealCount(scriptLines.length);
  }, [stage, scriptLines.length]);

  // ---- Action runner ----
  const run = async (fn: () => Promise<any>, onOk?: (res: any) => void) => {
    setBusy(true);
    setError(null);
    setReasons(null);
    try {
      const res = await fn();
      if (res && res.success === false) {
        setError(res.error || "That didn't work — try again.");
        if (Array.isArray(res.reasons)) setReasons(res.reasons);
        return;
      }
      onOk?.(res);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  // ---- Stage transitions ----
  const goBack = () => {
    const i = STAGE_ORDER.indexOf(stage);
    if (i > 0) setStage(STAGE_ORDER[i - 1]);
    setError(null);
    setReasons(null);
  };

  const pickTake = (id: string) => {
    setTopicId(id);
    setEpisodeId(null);
    setProgress(null);
    setStage("setup");
  };

  const beginResearch = () =>
    run(
      async () => {
        if (!topicId) return { success: false, error: "Pick a take first." };
        if (currentTake?.status === "pending") {
          const a = await approveTake(topicId);
          if (a && (a as any).success === false) return a;
        }
        if (!currentTake?.hasBrief) {
          const r = await researchTake(topicId, false);
          if (r && (r as any).success === false) return r;
        }
        return { success: true };
      },
      () => {
        setStage("research");
        setProgress(null);
      }
    );

  const approveResearch = () =>
    run(
      async () => {
        if (!topicId) return { success: false, error: "No take selected." };
        const prod = PROD_FOR_SFX[sfx] ?? "light";
        const res: any = await produceEpisodeFromTopics([topicId], undefined, undefined, {
          hostIds,
          productionStyle: prod,
          sfxDensity: sfx,
        });
        if (res?.success === false) return res;
        if (!res?.episodeId) return { success: false, error: "Episode wasn't created — try again." };
        const s: any = await startDebate(res.episodeId, {
          scriptStyle: style as any,
          targetDurationMinutes: lengthMin,
        });
        if (s?.success === false) return s;
        return { success: true, episodeId: res.episodeId };
      },
      (res) => {
        setEpisodeId(res.episodeId);
        setRevealCount(0);
        setVoicing(false);
        setStage("script");
        setProgress(null);
      }
    );

  const approveScript = () =>
    run(
      () => (episodeId ? approveEpisodeScript(episodeId) : Promise.resolve({ success: false, error: "No episode." })),
      () => setStage("voices")
    );

  const rewriteScript = () =>
    run(
      () =>
        episodeId
          ? startDebate(episodeId, { scriptStyle: style as any, targetDurationMinutes: lengthMin, forceRegenerate: true })
          : Promise.resolve({ success: false, error: "No episode." }),
      () => {
        setRevealCount(0);
        setStage("script");
        setProgress(null);
      }
    );

  const doCastVoices = () =>
    run(
      () => (episodeId ? castEpisodeVoices(episodeId) : Promise.resolve({ success: false, error: "No episode." })),
      () => {
        setVoicing(true);
        poll();
      }
    );

  const doMix = () =>
    run(() => (episodeId ? mixEpisode(episodeId) : Promise.resolve({ success: false, error: "No episode." })), () => poll());

  const doAssets = () =>
    run(
      () => (episodeId ? generateEpisodeAssets(episodeId) : Promise.resolve({ success: false, error: "No episode." })),
      () => poll()
    );

  // ---- Derived live state ----
  const epStatus = progress?.ok ? progress.episode?.status ?? null : null;
  const brief = progress?.ok ? progress.brief : null;
  const script = progress?.ok ? progress.script : null;
  const audio = progress?.ok ? progress.audio : null;
  const researching = !!topicId && !brief?.present;
  const liveMsg = streamingMessage(epStatus, researching && stage === "research");
  const done = progress?.ok && progress.stage === "done";

  const stepperActiveIndex = STAGE_ORDER.indexOf(stage);

  return (
    <div>
      {/* ---------------- Progress rail ---------------- */}
      <ol className="stepRail" aria-label="Create progress">
        {CREATE_STAGES.map((s, i) => {
          const state = done || i < stepperActiveIndex ? "done" : i === stepperActiveIndex ? "active" : "todo";
          return (
            <li key={s.key} className={`stepPill step-${state}`} aria-current={state === "active" ? "step" : undefined}>
              <span className="stepDot">{state === "done" ? "✓" : i + 1}</span>
              <span className="stepLabel">{s.short}</span>
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="studioCard createAlert" role="alert">
          <strong>{error}</strong>
          {reasons && reasons.length > 0 && (
            <ul className="createReasons">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ---------------- Stage bodies ---------------- */}
      {stage === "take" && (
        <TakePicker takes={takes} highlight={topicId} onPick={pickTake} />
      )}

      {stage === "setup" && currentTake && (
        <SetupStage
          take={currentTake}
          style={style}
          setStyle={setStyle}
          sfx={sfx}
          setSfx={setSfx}
          lengthMin={lengthMin}
          setLengthMin={setLengthMin}
          hosts={hosts}
          hostIds={hostIds}
          setHostIds={setHostIds}
          busy={busy}
          onBack={goBack}
          onGenerate={beginResearch}
        />
      )}

      {stage === "research" && (
        <StageShell
          title="Research"
          live={liveMsg}
          working={researching}
          onBack={goBack}
          primary={{
            label: brief?.present ? "Approve research → write the script" : "Researching…",
            disabled: busy || !brief?.present,
            onClick: approveResearch,
          }}
          checkpointNote="Checkpoint — review the brief before a script is written."
        >
          {!brief?.present ? (
            <SkeletonLines label="Scouting the take, pulling facts & angles…" />
          ) : (
            <div className="briefBlock">
              {brief.whyMattersNow && (
                <p className="briefWhy">
                  <span className="briefTag">Why now</span>
                  {brief.whyMattersNow}
                </p>
              )}
              <div className="briefMeta">
                <span className="chip chipSuccess">{brief.factCount} facts</span>
                {brief.mainAngle && <span className="chip">{brief.mainAngle}</span>}
              </div>
              {(brief.argA || brief.argB) && (
                <div className="briefArgs">
                  {brief.argA && (
                    <div className="briefArg" style={{ borderColor: "var(--host-max)" }}>
                      <span className="briefArgHost" style={{ color: "var(--host-max)" }}>{hostA?.name ?? "Host A"}</span>
                      {brief.argA}
                    </div>
                  )}
                  {brief.argB && (
                    <div className="briefArg" style={{ borderColor: "var(--host-doc)" }}>
                      <span className="briefArgHost" style={{ color: "var(--host-doc)" }}>{hostB?.name ?? "Host B"}</span>
                      {brief.argB}
                    </div>
                  )}
                </div>
              )}
              {brief.talkingPoints.length > 0 && (
                <ul className="briefPoints">
                  {brief.talkingPoints.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </StageShell>
      )}

      {stage === "script" && (
        <StageShell
          title="Script"
          live={liveMsg}
          working={!script?.present}
          onBack={goBack}
          primary={{
            label: script?.present ? "Review the script →" : "Writing the debate…",
            disabled: busy || !script?.present,
            onClick: () => setStage("preview"),
          }}
        >
          {!script?.present ? (
            <SkeletonLines label="The hosts are writing the debate…" />
          ) : (
            <ScriptView lines={scriptLines.slice(0, revealCount)} colorForSpeaker={colorForSpeaker} live />
          )}
        </StageShell>
      )}

      {stage === "preview" && (
        <StageShell
          title="Preview"
          live={script ? `${script.lineCount} lines${script.estMinutes ? ` · ~${script.estMinutes} min` : ""}${script.quality != null ? ` · quality ${script.quality}/100` : ""}` : liveMsg}
          working={false}
          onBack={goBack}
          primary={{
            label: busy ? "Approving…" : "Approve script → cast voices",
            disabled: busy || !script?.present,
            onClick: approveScript,
          }}
          secondary={{ label: busy ? "…" : "Rewrite the debate", disabled: busy || !script?.present, onClick: rewriteScript }}
          checkpointNote="Checkpoint — approving locks the script and starts fact-checking. Voices (the costly step) run only after this."
        >
          {episodeId ? (
            <TranscriptWorkspace episodeId={episodeId} showPublish={false} />
          ) : (
            <ScriptView lines={scriptLines} colorForSpeaker={colorForSpeaker} />
          )}
        </StageShell>
      )}

      {stage === "voices" && (
        <VoicesStage
          status={epStatus}
          audio={audio}
          busy={busy}
          voicing={voicing}
          liveMsg={liveMsg}
          onBack={goBack}
          onCast={doCastVoices}
        />
      )}

      {stage === "mix" && (
        <StageShell
          title="Mix"
          live={liveMsg}
          working={epStatus === "audio_stitching"}
          onBack={goBack}
          primary={
            epStatus === "audio_segments_ready"
              ? { label: busy ? "Starting…" : "Mix the episode", disabled: busy, onClick: doMix }
              : undefined
          }
        >
          <p className="stageHint">Stitches the voiced lines with the sound bed into the final cut.</p>
        </StageShell>
      )}

      {stage === "assets" && (
        <StageShell
          title="Assets"
          live={done ? "Episode ready" : liveMsg}
          working={epStatus === "audio_ready" || epStatus === "content_generating"}
          onBack={goBack}
          primary={
            done && episodeId
              ? undefined
              : epStatus === "audio_ready"
                ? { label: busy ? "Starting…" : "Generate show notes & assets", disabled: busy, onClick: doAssets }
                : undefined
          }
        >
          {done && episodeId ? (
            <div className="doneBlock">
              <div className="doneTitle">🎧 Your episode is ready</div>
              <Link href={`/studio/episodes/${episodeId}`} className="btnPrimary">Open the episode →</Link>
            </div>
          ) : (
            <p className="stageHint">Transcript, chapters, and show notes for the finished audio.</p>
          )}
        </StageShell>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function TakePicker({ takes, highlight, onPick }: { takes: StepperTake[]; highlight: string | null; onPick: (id: string) => void }) {
  return (
    <div>
      <div className="sectionHead" style={{ marginTop: 0 }}>
        <h2 className="sectionTitle">Pick a take</h2>
      </div>
      {takes.length === 0 ? (
        <div className="emptyNote">No takes on the board yet — check The Board for fresh material.</div>
      ) : (
        <div className="boardGrid">
          {takes.map((t) => (
            <button
              key={t.id}
              type="button"
              className="studioCard boardCard clickable takeChoice"
              onClick={() => onPick(t.id)}
              style={t.id === highlight ? { borderColor: "var(--accent)", boxShadow: "var(--shadow-accent)" } : undefined}
            >
              <div className="boardCardTop">
                <span className="chip">{t.sport}</span>
                {t.hasBrief && <span className="chip chipSuccess">Researched</span>}
              </div>
              <span className="epTitle boardCardTitle">{t.title}</span>
              <span className="takeChoiceCta">Use this take →</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SetupStage({
  take, style, setStyle, sfx, setSfx, lengthMin, setLengthMin, hosts, hostIds, setHostIds, busy, onBack, onGenerate,
}: {
  take: StepperTake;
  style: string; setStyle: (s: string) => void;
  sfx: string; setSfx: (s: string) => void;
  lengthMin: number; setLengthMin: (n: number) => void;
  hosts: StepperHost[]; hostIds: string[]; setHostIds: (ids: string[]) => void;
  busy: boolean; onBack: () => void; onGenerate: () => void;
}) {
  const toggleHost = (id: string) => {
    if (hostIds.includes(id)) {
      if (hostIds.length <= 2) return; // keep at least 2
      setHostIds(hostIds.filter((h) => h !== id));
    } else if (hostIds.length < 2) {
      setHostIds([...hostIds, id]);
    } else {
      setHostIds([hostIds[0], id]); // replace second slot
    }
  };
  return (
    <div className="studioCard">
      <div className="setupHead">
        <span className="chip">{take.sport}</span>
        <span className="epTitle" style={{ fontSize: "1.05rem" }}>{take.title}</span>
      </div>

      <div className="setupGrid">
        <div>
          <div className="fieldLabel">Format</div>
          <div className="segRow">
            {STYLES.map((s) => (
              <button key={s.key} type="button" className={`segBtn${style === s.key ? " on" : ""}`} onClick={() => setStyle(s.key)} aria-pressed={style === s.key}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="fieldLabel">Reactions & SFX</div>
          <div className="segRow">
            {SFX.map((s) => (
              <button key={s.key} type="button" className={`segBtn${sfx === s.key ? " on" : ""}`} onClick={() => setSfx(s.key)} aria-pressed={sfx === s.key}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="fieldLabel">Length</div>
          <div className="segRow">
            {LENGTHS.map((n) => (
              <button key={n} type="button" className={`segBtn${lengthMin === n ? " on" : ""}`} onClick={() => setLengthMin(n)} aria-pressed={lengthMin === n}>
                {n}m
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="fieldLabel">Hosts (pick 2)</div>
          <div className="segRow" style={{ flexWrap: "wrap" }}>
            {hosts.map((h) => {
              const on = hostIds.includes(h.id);
              const chairColor = hostIds[0] === h.id ? "var(--host-max)" : hostIds[1] === h.id ? "var(--host-doc)" : undefined;
              return (
                <button
                  key={h.id}
                  type="button"
                  className={`segBtn hostBtn${on ? " on" : ""}`}
                  onClick={() => toggleHost(h.id)}
                  aria-pressed={on}
                  style={on && chairColor ? { borderColor: chairColor, color: chairColor } : undefined}
                >
                  <span className="hostSwatch" style={{ background: chairColor ?? "var(--border-hover)" }} />
                  {h.name}
                </button>
              );
            })}
            {hosts.length === 0 && <span className="stageHint">No active hosts configured.</span>}
          </div>
        </div>
      </div>

      <div className="stageActions">
        <button type="button" className="btnGhost" onClick={onBack}>← Back</button>
        <button type="button" className="btnPrimary" onClick={onGenerate} disabled={busy || hostIds.length < 2}>
          {busy ? "Starting…" : "Generate Episode"}
        </button>
      </div>
    </div>
  );
}

function StageShell({
  title, live, working, onBack, primary, secondary, checkpointNote, children,
}: {
  title: string;
  live: string;
  working: boolean;
  onBack: () => void;
  primary?: { label: string; disabled?: boolean; onClick: () => void };
  secondary?: { label: string; disabled?: boolean; onClick: () => void };
  checkpointNote?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="studioCard">
      <div className="stageTop">
        <h2 className="sectionTitle" style={{ margin: 0 }}>{title}</h2>
        <span className={`statusPill ${working ? "statusPill--live" : "statusPill--ok"}`} role="status" aria-live="polite">
          {live}
        </span>
      </div>
      <div className="stageBody">{children}</div>
      {checkpointNote && <p className="checkpointNote">🛡 {checkpointNote}</p>}
      <div className="stageActions">
        <button type="button" className="btnGhost" onClick={onBack}>← Back</button>
        {secondary && (
          <button type="button" className="btnGhost" onClick={secondary.onClick} disabled={secondary.disabled} style={{ marginLeft: "auto" }}>
            {secondary.label}
          </button>
        )}
        {primary && (
          <button type="button" className="btnPrimary" onClick={primary.onClick} disabled={primary.disabled} style={secondary ? { marginLeft: "0.6rem" } : undefined}>
            {primary.label}
          </button>
        )}
      </div>
    </div>
  );
}

function VoicesStage({
  status, audio, busy, voicing, liveMsg, onBack, onCast,
}: {
  status: string | null;
  audio: { totalSegments: number; readySegments: number } | null;
  busy: boolean;
  voicing: boolean;
  liveMsg: string;
  onBack: () => void;
  onCast: () => void;
}) {
  const factChecking = status === "script_approved";
  const readyToCast = status === "fact_checked";
  const total = audio?.totalSegments ?? 0;
  const ready = audio?.readySegments ?? 0;
  // "Casting" once the user has kicked TTS (local flag) or some lines are voiced
  // but not all. AudioSegment stubs exist from script-gen, so ready>0 is the
  // real signal that synthesis is underway.
  const casting = voicing || (ready > 0 && ready < total);
  const pct = total > 0 ? Math.round((ready / total) * 100) : 0;

  const primary =
    readyToCast && !casting
      ? { label: busy ? "Starting…" : "Cast the voices", disabled: busy, onClick: onCast }
      : undefined;

  return (
    <StageShell
      title="Voices"
      live={factChecking ? "Fact-checking the claims…" : casting ? `Casting voices… ${ready}/${total}` : liveMsg}
      working={factChecking || casting}
      onBack={onBack}
      primary={primary}
    >
      {factChecking && <SkeletonLines label="Verifying every claim against the sources before we spend on voices…" />}
      {(readyToCast || casting || total > 0) && (
        <div>
          <p className="stageHint">Each line is synthesized by its host voice. This is the first step that spends TTS budget.</p>
          {total > 0 && (
            <div className="voiceProg">
              <div className="scoreBarTrack"><div className="scoreBarFill" style={{ width: `${pct}%` }} /></div>
              <span className="voiceProgLabel">{ready}/{total} lines voiced</span>
            </div>
          )}
        </div>
      )}
    </StageShell>
  );
}

function ScriptView({
  lines, colorForSpeaker, live,
}: {
  lines: { speaker: string; text: string; tone: string | null }[];
  colorForSpeaker: (s: string) => string;
  live?: boolean;
}) {
  return (
    <div className={`scriptScroller${live ? " scriptLive" : ""}`}>
      {lines.map((l, i) => (
        <div key={i} className="scriptLine">
          <span className="scriptSpeaker" style={{ color: colorForSpeaker(l.speaker) }}>{l.speaker}</span>
          <span className="scriptText">{l.text}</span>
        </div>
      ))}
      {lines.length === 0 && <div className="stageHint">No lines yet.</div>}
    </div>
  );
}

function SkeletonLines({ label }: { label: string }) {
  return (
    <div className="skelWrap" aria-live="polite">
      <div className="skelPulse" />
      <div className="skelBar" style={{ width: "92%" }} />
      <div className="skelBar" style={{ width: "78%" }} />
      <div className="skelBar" style={{ width: "85%" }} />
      <p className="stageHint" style={{ marginTop: "0.6rem" }}>{label}</p>
    </div>
  );
}
