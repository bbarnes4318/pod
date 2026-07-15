"use client";

// Studio multi-topic rundown builder: Show → Topics → Hosts → Production →
// Review → Create. Manual / Automatic / Hybrid, all routed through the SHARED
// createEpisodeDraft via the createStudioEpisode server action. Durable,
// cross-session resume via a server-side StudioDraft (autosaved). The backend's
// finalOrder is the source of truth for the created rundown — never the request.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  getStudioTopics,
  createStudioEpisode,
  saveStudioRundownDraft,
  discardStudioRundownDraft,
  startDebate,
} from "../../app/create/actions";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";
import type { RundownDraftState, RundownStep } from "@/lib/services/studioDraft";
import { estimateRundown } from "@/lib/services/episodeEstimate";
import { validateRundownDraft } from "@/lib/studio/rundownRules";
import TopicRundownPicker from "./TopicRundownPicker";
import RundownTray from "./RundownTray";

type Mode = "manual" | "automatic" | "hybrid";
export interface BuilderPodcast { id: string; name: string; verticals: string[]; teams: string[]; segmentCount: number; hostIds: string[]; }
export interface BuilderHost { id: string; name: string; intensity: number; }

const STEPS: { key: RundownStep; label: string }[] = [
  { key: "show", label: "Show" },
  { key: "topics", label: "Topics" },
  { key: "hosts", label: "Hosts" },
  { key: "production", label: "Production" },
  { key: "review", label: "Review" },
];
const PROD_STYLES = [{ k: "clean", l: "Clean" }, { k: "light", l: "Light" }, { k: "full", l: "Full" }];
const SFX = [{ k: "subtle", l: "Subtle" }, { k: "medium", l: "Balanced" }, { k: "hype", l: "Hype" }];
const TTS = [{ k: "", l: "Auto (host default)" }, { k: "elevenlabs", l: "ElevenLabs" }, { k: "cartesia", l: "Cartesia" }, { k: "openai", l: "OpenAI" }, { k: "fish", l: "Fish Audio" }];

type CreateResult = Awaited<ReturnType<typeof createStudioEpisode>>;

export default function RundownBuilder({
  podcasts,
  initialTopics,
  hosts,
  initialDraft,
  maxTopics,
  seedTopicId,
}: {
  podcasts: BuilderPodcast[];
  initialTopics: StudioTopicVM[];
  hosts: BuilderHost[];
  initialDraft: RundownDraftState | null;
  maxTopics: number;
  seedTopicId?: string | null;
}) {
  const d = initialDraft;
  // A ?topic= deep-link (from the takes board) seeds the first pick when there's
  // no saved draft to resume.
  const seeded = !d && seedTopicId && initialTopics.some((t) => t.id === seedTopicId && t.eligible) ? [seedTopicId] : [];
  const [mode, setMode] = useState<Mode>(d?.mode ?? "manual");
  const [selectedIds, setSelectedIds] = useState<string[]>(d?.selectedTopicIds ?? seeded);
  const [leadTopicId, setLeadTopicId] = useState<string | null>(d?.leadTopicId ?? null);
  const [targetTopicCount, setTargetTopicCount] = useState<number>(d?.targetTopicCount ?? 3);
  const [podcastId, setPodcastId] = useState<string | null>(d?.podcastId ?? null);
  const [hostIds, setHostIds] = useState<string[]>(d?.hostIds?.length ? d.hostIds : hosts.slice(0, 2).map((h) => h.id));
  const [ttsProvider, setTtsProvider] = useState<string>(d?.ttsProvider ?? "");
  const [voicePicks, setVoicePicks] = useState<Record<string, string>>(() => voicePicksFromOverrides(d?.ttsVoiceOverrides));
  const [productionStyle, setProductionStyle] = useState<string>(d?.productionStyle ?? "light");
  const [sfxDensity, setSfxDensity] = useState<string>(d?.sfxDensity ?? "medium");
  const [title, setTitle] = useState<string>(d?.title ?? "");
  const [description, setDescription] = useState<string>(d?.description ?? "");
  const [step, setStep] = useState<RundownStep>(d?.activeStep ?? "show");

  const [topics, setTopics] = useState<StudioTopicVM[]>(initialTopics);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<{ id: string; reason: string; category?: string }[]>([]);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [srMsg, setSrMsg] = useState("");
  const announce = useCallback((m: string) => setSrMsg(m), []);

  const byId = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);
  const podcastScoped = !!podcastId;

  // Build the persistable state snapshot.
  const stateSnapshot: RundownDraftState = useMemo(
    () => ({
      mode, selectedTopicIds: selectedIds, leadTopicId, targetTopicCount, podcastId,
      hostIds, ttsProvider: ttsProvider || null, ttsVoiceOverrides: buildVoiceOverrides(voicePicks, ttsProvider),
      productionStyle, sfxDensity, title: title || null, description: description || null, activeStep: step,
    }),
    [mode, selectedIds, leadTopicId, targetTopicCount, podcastId, hostIds, ttsProvider, voicePicks, productionStyle, sfxDensity, title, description, step]
  );

  // ---- Autosave (debounced, cross-session resume) ----
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (result) return; // stop saving once created
    const id = setTimeout(() => { void saveStudioRundownDraft(stateSnapshot); }, 800);
    return () => clearTimeout(id);
  }, [stateSnapshot, result]);

  // ---- Re-scope topics when the podcast changes ----
  const refreshTopics = useCallback(async (pid: string | null) => {
    setLoadingTopics(true);
    try {
      const res = await getStudioTopics(pid);
      if (res.success) setTopics(res.topics);
    } finally {
      setLoadingTopics(false);
    }
  }, []);

  const onSelectPodcast = (pid: string | null) => {
    setPodcastId(pid);
    if (pid) {
      const pod = podcasts.find((p) => p.id === pid);
      if (pod) {
        if (pod.segmentCount) setTargetTopicCount(Math.min(maxTopics, Math.max(1, pod.segmentCount)));
        if (pod.hostIds.length && !hostIds.length) setHostIds(pod.hostIds.slice(0, 2));
      }
    }
    void refreshTopics(pid);
  };

  // ---- Selection ----
  const orderedSelected = useMemo(
    () => selectedIds.map((id) => byId.get(id)).filter((t): t is StudioTopicVM => !!t),
    [selectedIds, byId]
  );

  const toggleTopic = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        if (leadTopicId === id) setLeadTopicId(next[0] ?? null);
        announce(`Removed from rundown. ${next.length} selected.`);
        return next;
      }
      if (prev.length >= maxTopics) { announce(`Maximum ${maxTopics} topics reached.`); return prev; }
      announce(`Added to rundown at position ${prev.length + 1}.`);
      return [...prev, id];
    });
  };

  const reorder = (from: number, to: number) => {
    setSelectedIds((prev) => {
      if (to < 0 || to >= prev.length) return prev;
      const next = [...prev];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      announce(`Moved ${byId.get(m)?.title ?? "topic"} to position ${to + 1}.`);
      return next;
    });
  };
  const removeTopic = (id: string) => toggleTopic(id);
  const setLead = (id: string) => {
    setSelectedIds((prev) => [id, ...prev.filter((x) => x !== id)]);
    setLeadTopicId(id);
    announce(`${byId.get(id)?.title ?? "Topic"} is now the lead story.`);
  };

  // ---- Validation (mirrors CreateEpisodeDraftInputSchema; the server re-validates) ----
  const validation = useMemo(() => {
    const base = validateRundownDraft({ mode, selectedTopicIds: selectedIds, targetTopicCount, maxTopics });
    if (!base.ok) return base;
    if (hostIds.length < 2) return { ok: false, error: "Pick two hosts." };
    return { ok: true as const };
  }, [mode, selectedIds, targetTopicCount, maxTopics, hostIds]);

  const estimate = useMemo(
    () => estimateRundown({ topicCount: mode === "automatic" ? targetTopicCount : mode === "hybrid" ? Math.max(selectedIds.length, targetTopicCount) : selectedIds.length }),
    [mode, targetTopicCount, selectedIds.length]
  );

  const goNext = () => { const i = STEPS.findIndex((s) => s.key === step); if (i < STEPS.length - 1) setStep(STEPS[i + 1].key); };
  const goBack = () => { const i = STEPS.findIndex((s) => s.key === step); if (i > 0) setStep(STEPS[i - 1].key); setError(null); };

  const submit = async () => {
    if (!validation.ok || submitting) return;
    setSubmitting(true);
    setError(null);
    setRejected([]);
    try {
      const res = await createStudioEpisode({
        mode,
        selectedTopicIds: mode === "automatic" ? [] : selectedIds,
        targetTopicCount,
        leadTopicId,
        podcastId,
        hostIds,
        ttsProvider: ttsProvider || undefined,
        ttsVoiceOverrides: buildVoiceOverrides(voicePicks, ttsProvider),
        productionStyle,
        sfxDensity,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
      });
      if (!res.success) {
        setError(res.error || "Couldn't create the episode.");
        if ("rejectedTopics" in res && res.rejectedTopics) setRejected(res.rejectedTopics);
        return;
      }
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong creating the episode.");
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Result view ----
  if (result && result.success) return <ResultView result={result} topicsById={byId} />;

  const stepIndex = STEPS.findIndex((s) => s.key === step);

  return (
    <div className="rundownBuilder">
      <p aria-live="polite" className="srOnly" style={srOnlyStyle}>{srMsg}</p>

      {/* Step rail */}
      <ol className="stepRail" aria-label="Create steps">
        {STEPS.map((s, i) => {
          const state = i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
          return (
            <li key={s.key} className={`stepPill step-${state}`} aria-current={state === "active" ? "step" : undefined}>
              <button type="button" className="stepPillBtn" onClick={() => setStep(s.key)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span className="stepDot">{state === "done" ? "✓" : i + 1}</span>
                <span className="stepLabel">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="studioCard createAlert" role="alert">
          <strong>{error}</strong>
          {rejected.length > 0 && (
            <ul className="createReasons">
              {rejected.map((r, i) => <li key={i}>{topicTitle(byId, r.id)}: {r.reason}</li>)}
            </ul>
          )}
        </div>
      )}

      {/* ---------------- SHOW ---------------- */}
      {step === "show" && (
        <div className="studioCard">
          <h2 className="sectionTitle" style={{ marginTop: 0 }}>Where does this episode live?</h2>
          <div className="segRow" style={{ flexWrap: "wrap", marginBottom: "0.8rem" }}>
            <button type="button" className={`segBtn${podcastId === null ? " on" : ""}`} aria-pressed={podcastId === null} onClick={() => onSelectPodcast(null)}>Standalone episode</button>
            {podcasts.map((p) => (
              <button key={p.id} type="button" className={`segBtn${podcastId === p.id ? " on" : ""}`} aria-pressed={podcastId === p.id} onClick={() => onSelectPodcast(p.id)}>{p.name}</button>
            ))}
          </div>
          {podcastId && <p className="stageHint">Inherited this show&apos;s verticals, teams, target count, and host lineup. Usage &amp; reuse below are scoped to this show. You can override episode settings in later steps.</p>}
          <label className="fieldLabel" htmlFor="epTitle">Episode title <span className="stageHint">(optional)</span></label>
          <input id="epTitle" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Auto-generated if left blank" />
          <div className="fieldLabel" style={{ marginTop: "0.8rem" }}>Mode</div>
          <div className="segRow" role="radiogroup" aria-label="Rundown mode">
            {(["manual", "automatic", "hybrid"] as Mode[]).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={`segBtn${mode === m ? " on" : ""}`} onClick={() => setMode(m)} style={{ textTransform: "capitalize" }}>{m}</button>
            ))}
          </div>
          <p className="stageHint" style={{ marginTop: "0.5rem" }}>
            {mode === "manual" && "You pick every topic and their order."}
            {mode === "automatic" && "The studio selects the strongest eligible topics at creation. You set the target count."}
            {mode === "hybrid" && "Pin the must-cover topics; the studio fills the rest to your target count."}
          </p>
          <StepNav onBack={null} onNext={goNext} nextLabel="Choose topics →" />
        </div>
      )}

      {/* ---------------- TOPICS ---------------- */}
      {step === "topics" && (
        <div>
          {mode !== "manual" && (
            <div className="studioCard" style={{ marginBottom: "0.8rem" }}>
              <label className="fieldLabel" htmlFor="targetCount">Target topic count: {targetTopicCount}</label>
              <input id="targetCount" type="range" min={1} max={maxTopics} value={targetTopicCount} onChange={(e) => setTargetTopicCount(Number(e.target.value))} style={{ width: "100%" }} />
              {mode === "hybrid" && (
                <p className="stageHint">{selectedIds.length} pinned · {targetTopicCount} target · {Math.max(0, targetTopicCount - selectedIds.length)} will be selected automatically</p>
              )}
              {mode === "automatic" && <p className="stageHint">{targetTopicCount} topics will be selected automatically at creation.</p>}
            </div>
          )}
          <div className="rundownTwoCol" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: "1rem", alignItems: "start" }}>
            <div>
              {loadingTopics ? <div className="studioCard emptyNote">Loading takes…</div> : (
                <TopicRundownPicker
                  topics={topics}
                  selectedIds={selectedIds}
                  onToggle={toggleTopic}
                  selectionDisabled={mode === "automatic"}
                  podcastScoped={podcastScoped}
                  announce={announce}
                />
              )}
            </div>
            <div style={{ position: "sticky", top: "1rem" }}>
              <RundownTray
                items={orderedSelected}
                leadTopicId={leadTopicId}
                maxTopics={maxTopics}
                mode={mode}
                targetTopicCount={targetTopicCount}
                estimate={estimate}
                onReorder={reorder}
                onRemove={removeTopic}
                onSetLead={setLead}
              />
            </div>
          </div>
          {!validation.ok && <p className="stageHint" role="note" style={{ marginTop: "0.6rem", color: "var(--warning-color, #b45309)" }}>{validation.error}</p>}
          <StepNav onBack={goBack} onNext={goNext} nextLabel="Hosts →" nextDisabled={!validation.ok} />
        </div>
      )}

      {/* ---------------- HOSTS ---------------- */}
      {step === "hosts" && (
        <div className="studioCard">
          <h2 className="sectionTitle" style={{ marginTop: 0 }}>🎙 Hosts</h2>
          <p className="stageHint">Two voices front the episode (chair A + chair B). Only your own and shared hosts appear here.</p>
          <div className="segRow" style={{ flexWrap: "wrap" }}>
            {hosts.map((h) => {
              const on = hostIds.includes(h.id);
              const chair = hostIds[0] === h.id ? "A" : hostIds[1] === h.id ? "B" : null;
              return (
                <button key={h.id} type="button" className={`segBtn${on ? " on" : ""}`} aria-pressed={on}
                  onClick={() => setHostIds((prev) => prev.includes(h.id) ? (prev.length <= 1 ? prev : prev.filter((x) => x !== h.id)) : prev.length < 2 ? [...prev, h.id] : [prev[0], h.id])}>
                  {chair && <strong style={{ marginRight: 4 }}>{chair}</strong>}{h.name}
                </button>
              );
            })}
            {hosts.length === 0 && <span className="stageHint">No active hosts — <Link href="/studio/hosts">add one →</Link></span>}
          </div>
          <StepNav onBack={goBack} onNext={goNext} nextLabel="Production →" nextDisabled={hostIds.length < 2} />
        </div>
      )}

      {/* ---------------- PRODUCTION ---------------- */}
      {step === "production" && (
        <div className="studioCard">
          <h2 className="sectionTitle" style={{ marginTop: 0 }}>Production</h2>
          <div className="fieldLabel">Sound-design level</div>
          <div className="segRow">{PROD_STYLES.map((p) => <button key={p.k} type="button" className={`segBtn${productionStyle === p.k ? " on" : ""}`} aria-pressed={productionStyle === p.k} onClick={() => setProductionStyle(p.k)}>{p.l}</button>)}</div>
          <div className="fieldLabel" style={{ marginTop: "0.8rem" }}>Reactions &amp; SFX</div>
          <div className="segRow">{SFX.map((s) => <button key={s.k} type="button" className={`segBtn${sfxDensity === s.k ? " on" : ""}`} aria-pressed={sfxDensity === s.k} onClick={() => setSfxDensity(s.k)}>{s.l}</button>)}</div>
          <div className="fieldLabel" style={{ marginTop: "0.8rem" }}>TTS engine</div>
          <select className="input" value={ttsProvider} onChange={(e) => { setTtsProvider(e.target.value); setVoicePicks({}); }}>
            {TTS.map((t) => <option key={t.k} value={t.k}>{t.l}</option>)}
          </select>
          {ttsProvider && hosts.filter((h) => hostIds.includes(h.id)).map((h) => (
            <div key={h.id} style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
              <span style={{ width: 120 }}>{h.name}</span>
              <input className="input" placeholder="provider voice id" value={voicePicks[h.id] ?? ""} onChange={(e) => setVoicePicks({ ...voicePicks, [h.id]: e.target.value })} />
            </div>
          ))}
          <StepNav onBack={goBack} onNext={goNext} nextLabel="Review →" />
        </div>
      )}

      {/* ---------------- REVIEW ---------------- */}
      {step === "review" && (
        <ReviewStep
          mode={mode} podcast={podcasts.find((p) => p.id === podcastId) ?? null}
          orderedSelected={orderedSelected} leadTopicId={leadTopicId} targetTopicCount={targetTopicCount}
          hosts={hosts.filter((h) => hostIds.includes(h.id))} ttsProvider={ttsProvider} productionStyle={productionStyle}
          sfxDensity={sfxDensity} title={title} estimate={estimate} validation={validation}
          submitting={submitting} onBack={goBack} onSubmit={submit}
        />
      )}

      <p style={{ marginTop: "1rem" }}>
        <button type="button" className="advLink" onClick={() => { void discardStudioRundownDraft(); window.location.reload(); }}>Discard this draft</button>
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ReviewStep({
  mode, podcast, orderedSelected, leadTopicId, targetTopicCount, hosts, ttsProvider, productionStyle, sfxDensity, title, estimate, validation, submitting, onBack, onSubmit,
}: {
  mode: Mode; podcast: BuilderPodcast | null; orderedSelected: StudioTopicVM[]; leadTopicId: string | null; targetTopicCount: number;
  hosts: BuilderHost[]; ttsProvider: string; productionStyle: string; sfxDensity: string; title: string;
  estimate: ReturnType<typeof estimateRundown>; validation: { ok: boolean; error?: string }; submitting: boolean; onBack: () => void; onSubmit: () => void;
}) {
  const autoSlots = mode === "hybrid" ? Math.max(0, targetTopicCount - orderedSelected.length) : mode === "automatic" ? targetTopicCount : 0;
  const lead = leadTopicId && orderedSelected.some((t) => t.id === leadTopicId) ? leadTopicId : orderedSelected[0]?.id;
  const warnings = orderedSelected.filter((t) => t.readiness !== "ready" || t.usedByShowRecent);
  return (
    <div className="studioCard">
      <h2 className="sectionTitle" style={{ marginTop: 0 }}>Review the rundown</h2>
      <dl className="reviewGrid" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.35rem 1rem", margin: 0 }}>
        <dt className="fieldLabel">Title</dt><dd>{title || "Auto-generated"}</dd>
        <dt className="fieldLabel">Show</dt><dd>{podcast ? podcast.name : "Standalone episode"}</dd>
        <dt className="fieldLabel">Mode</dt><dd style={{ textTransform: "capitalize" }}>{mode}</dd>
        <dt className="fieldLabel">Rundown</dt>
        <dd>
          {mode === "automatic" ? (
            <span>{targetTopicCount} topics selected automatically at creation.</span>
          ) : (
            <ol style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {orderedSelected.map((t) => (
                <li key={t.id}>{t.id === lead && <span className="chip chipAccent">★ Lead</span>} {t.title}{t.readiness !== "ready" && <span style={{ color: "var(--warning-color, #b45309)" }}> ⚠ {t.readiness.replace("_", " ")}</span>}</li>
              ))}
            </ol>
          )}
          {autoSlots > 0 && <p className="stageHint">+ {autoSlots} auto-selected slot{autoSlots === 1 ? "" : "s"}.</p>}
        </dd>
        <dt className="fieldLabel">Hosts</dt><dd>{hosts.map((h) => h.name).join(" + ") || "Default pairing"}</dd>
        <dt className="fieldLabel">Voice</dt><dd>{ttsProvider || "Host default"}</dd>
        <dt className="fieldLabel">Production</dt><dd>{productionStyle} · {sfxDensity} SFX</dd>
        <dt className="fieldLabel">Estimate</dt><dd>~{estimate.estimatedDurationMinutes} min · ~{estimate.estimatedWords.toLocaleString()} words · {estimate.estimatedCostUsd !== null ? `~$${estimate.estimatedCostUsd.toFixed(2)}` : "cost provider-dependent"}</dd>
      </dl>
      {warnings.length > 0 && (
        <div role="note" style={{ marginTop: "0.8rem", fontSize: "0.82rem", color: "var(--warning-color, #b45309)" }}>
          {warnings.map((t) => <div key={t.id}>⚠ {t.title}: {t.usedByShowRecent ? "recently used by this show" : t.readiness.replace("_", " ")}</div>)}
        </div>
      )}
      {!validation.ok && <p role="alert" style={{ color: "var(--warning-color, #b45309)", marginTop: "0.6rem" }}>{validation.error}</p>}
      <div className="stageActions">
        <button type="button" className="btnGhost" onClick={onBack}>← Back</button>
        <button type="button" className="btnPrimary" onClick={onSubmit} disabled={!validation.ok || submitting} style={{ marginLeft: "auto" }}>
          {submitting ? "Creating…" : "Create episode"}
        </button>
      </div>
    </div>
  );
}

function ResultView({ result, topicsById }: { result: Extract<CreateResult, { success: true }>; topicsById: Map<string, StudioTopicVM> }) {
  const reduced = result.finalOrder.length < result.requestedCount;
  const [starting, setStarting] = useState(false);
  return (
    <div className="studioCard">
      <h2 className="sectionTitle" style={{ marginTop: 0 }}>🎬 Episode created</h2>
      {reduced && (
        <div className="createAlert" role="status" style={{ marginBottom: "0.8rem" }}>
          {result.concurrentlyDroppedIds.length > 0
            ? `One or more automatically selected topics became unavailable while the episode was being created. Your episode was created with ${result.finalOrder.length} topic${result.finalOrder.length === 1 ? "" : "s"} instead of ${result.requestedCount}.`
            : `The studio found ${result.finalOrder.length} eligible topic${result.finalOrder.length === 1 ? "" : "s"} (you requested ${result.requestedCount}).`}
        </div>
      )}
      <p className="stageHint">This is the final rundown the studio actually created (from the backend), in order:</p>
      <ol style={{ paddingLeft: "1.2rem" }}>
        {result.finalOrder.map((id, i) => {
          const ref = result.selectedTopics.find((s) => s.id === id);
          return <li key={id}>{i === 0 && <span className="chip chipAccent">★ Lead</span>} {ref?.title ?? topicsById.get(id)?.title ?? id} {ref && !ref.pinned && <span className="chip">auto</span>}</li>;
        })}
      </ol>
      {result.rejectedTopics.length > 0 && (
        <div role="note" style={{ marginTop: "0.6rem", fontSize: "0.82rem" }}>
          <div className="fieldLabel">Not included</div>
          <ul className="createReasons">{result.rejectedTopics.map((r, i) => <li key={i}>{topicsById.get(r.id)?.title ?? r.id}: {r.reason}</li>)}</ul>
        </div>
      )}
      <div className="stageActions" style={{ marginTop: "1rem" }}>
        <Link href={`/studio/episodes/${result.episodeId}`} className="btnGhost">Open episode</Link>
        <button type="button" className="btnPrimary" style={{ marginLeft: "auto" }} disabled={starting}
          onClick={async () => { setStarting(true); if (result.episodeId) await startDebate(result.episodeId); window.location.href = `/studio/episodes/${result.episodeId}`; }}>
          {starting ? "Starting…" : "Start the debate →"}
        </button>
      </div>
    </div>
  );
}

function StepNav({ onBack, onNext, nextLabel, nextDisabled }: { onBack: (() => void) | null; onNext: () => void; nextLabel: string; nextDisabled?: boolean }) {
  return (
    <div className="stageActions" style={{ marginTop: "1rem" }}>
      {onBack ? <button type="button" className="btnGhost" onClick={onBack}>← Back</button> : <span />}
      <button type="button" className="btnPrimary" onClick={onNext} disabled={nextDisabled} style={{ marginLeft: "auto" }}>{nextLabel}</button>
    </div>
  );
}

/* ---- helpers ---- */
const srOnlyStyle: React.CSSProperties = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 };

function topicTitle(byId: Map<string, StudioTopicVM>, id: string): string { return byId.get(id)?.title ?? id; }

/** Build TtsVoiceOverrides from {hostId → voiceId} picks + a chosen engine. */
function buildVoiceOverrides(picks: Record<string, string>, engine: string): Record<string, { provider: string; voiceId: string }> | undefined {
  if (!engine) return undefined;
  const out: Record<string, { provider: string; voiceId: string }> = {};
  for (const [hostId, voiceId] of Object.entries(picks)) { const v = voiceId.trim(); if (v) out[hostId] = { provider: engine, voiceId: v }; }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Reverse of buildVoiceOverrides, to restore per-host picks from a saved draft. */
function voicePicksFromOverrides(overrides: unknown): Record<string, string> {
  if (!overrides || typeof overrides !== "object") return {};
  const out: Record<string, string> = {};
  for (const [hostId, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).voiceId === "string") out[hostId] = String((v as Record<string, unknown>).voiceId);
  }
  return out;
}
