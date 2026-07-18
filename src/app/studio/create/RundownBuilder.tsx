"use client";

// Studio multi-topic rundown builder: Show → Topics → Hosts → Production →
// Review → Create. Manual / Automatic / Hybrid, all routed through the SHARED
// createEpisodeDraft via createStudioEpisode. Durable cross-session resume
// (autosaved StudioDraft). The backend's finalOrder is the source of truth.

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
import { validateRundownDraft, applyModeChange } from "@/lib/studio/rundownRules";
import { getShowFormat, listShowFormats, isGenerationReadyFormat } from "@/lib/formats/showFormatRegistry";
import { MAX_DESCRIPTION_LEN } from "@/lib/episodeLimits";
// Shared rundown core — the SAME picker/tray Admin uses (src/components/rundown).
import TopicRundownPicker from "@/components/rundown/TopicRundownPicker";
import RundownTray from "@/components/rundown/RundownTray";

type Mode = "manual" | "automatic" | "hybrid";
export interface BuilderPodcast { id: string; name: string; verticals: string[]; teamIds: string[]; teamNames: string[]; segmentCount: number; hostIds: string[]; }
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
  podcasts, initialTopics, hosts, initialDraft, maxTopics, seedTopicId,
}: {
  podcasts: BuilderPodcast[];
  initialTopics: StudioTopicVM[];
  hosts: BuilderHost[];
  initialDraft: RundownDraftState | null;
  maxTopics: number;
  seedTopicId?: string | null;
}) {
  const d = initialDraft;
  const seeded = !d && seedTopicId && initialTopics.some((t) => t.id === seedTopicId && t.eligible) ? [seedTopicId] : [];

  const [mode, setModeState] = useState<Mode>(d?.mode ?? "manual");
  const [selectedIds, setSelectedIds] = useState<string[]>(d?.selectedTopicIds ?? seeded);
  const [leadTopicId, setLeadTopicId] = useState<string | null>(d?.leadTopicId ?? null);
  const [targetTopicCount, setTargetTopicCount] = useState<number>(d?.targetTopicCount ?? 3);
  const [podcastId, setPodcastId] = useState<string | null>(d?.podcastId ?? null);
  const [formatId, setFormatId] = useState<string>((d as { formatId?: string })?.formatId ?? "two_host_debate");
  const format = getShowFormat(formatId) ?? getShowFormat("two_host_debate")!;
  const [hostIds, setHostIds] = useState<string[]>(d?.hostIds?.length ? d.hostIds : hosts.slice(0, 2).map((h) => h.id));
  const [ttsProvider, setTtsProvider] = useState<string>(d?.ttsProvider ?? "");
  const [voicePicks, setVoicePicks] = useState<Record<string, string>>(() => voicePicksFromOverrides(d?.ttsVoiceOverrides));
  const [productionStyle, setProductionStyle] = useState<string>(d?.productionStyle ?? "light");
  const [sfxDensity, setSfxDensity] = useState<string>(d?.sfxDensity ?? "medium");
  const [title, setTitle] = useState<string>(d?.title ?? "");
  const [description, setDescription] = useState<string>(d?.description ?? "");
  const [step, setStep] = useState<RundownStep>(d?.activeStep ?? "show");

  // Selection preferences (automatic/hybrid) — distinct from board filters.
  const [verticals, setVerticals] = useState<string[]>(d?.verticals ?? []);
  const [leagueIds, setLeagueIds] = useState<string[]>(d?.leagueIds ?? []);
  const [teams, setTeams] = useState<string[]>(d?.teams ?? []);
  const [sport, setSport] = useState<string>(d?.sport ?? "");
  const [minDebateScore, setMinDebateScore] = useState<number | null>(d?.minDebateScore ?? null);

  // ---- Inheritance PROVENANCE ----
  // Restored from the draft's explicit `overrides` record — NOT inferred from
  // "the value is non-empty" (an inherited host list is non-empty too) or from
  // "a draft exists" (autosaving a default must never make it an override).
  // Legacy drafts without `overrides` default to false ⇒ values stay inherited
  // and remain replaceable by the next podcast.
  const [hostSelectionDirty, setHostSelectionDirty] = useState<boolean>(d?.overrides?.hosts ?? false);
  const [targetCountDirty, setTargetCountDirty] = useState<boolean>(d?.overrides?.targetTopicCount ?? false);
  const [prefsDirty, setPrefsDirty] = useState<boolean>(d?.overrides?.selectionPreferences ?? false);

  const [topics, setTopics] = useState<StudioTopicVM[]>(initialTopics);
  const [loadingTopics, setLoadingTopics] = useState(false);
  const [inheritNote, setInheritNote] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<{ id: string; reason: string; category?: string }[]>([]);
  const [result, setResult] = useState<CreateResult | null>(null);
  const [srMsg, setSrMsg] = useState("");
  const announce = useCallback((m: string) => setSrMsg(m), []);

  const byId = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);
  const podcastScoped = !!podcastId;

  const stateSnapshot: RundownDraftState = useMemo(
    () => ({
      mode, selectedTopicIds: selectedIds, leadTopicId, targetTopicCount, podcastId,
      hostIds, ttsProvider: ttsProvider || null, ttsVoiceOverrides: buildVoiceOverrides(voicePicks, ttsProvider),
      productionStyle: (productionStyle || null) as RundownDraftState["productionStyle"], sfxDensity: (sfxDensity || null) as RundownDraftState["sfxDensity"], title: title || null, description: description || null,
      verticals: verticals.length ? verticals : undefined, leagueIds: leagueIds.length ? leagueIds : undefined,
      teams: teams.length ? teams : undefined, sport: sport || null, minDebateScore, activeStep: step,
      // Persist WHY each value holds what it holds, so a reload can still tell an
      // inherited value from a deliberate override.
      overrides: { hosts: hostSelectionDirty, targetTopicCount: targetCountDirty, selectionPreferences: prefsDirty },
    }),
    [mode, selectedIds, leadTopicId, targetTopicCount, podcastId, hostIds, ttsProvider, voicePicks, productionStyle, sfxDensity, title, description, verticals, leagueIds, teams, sport, minDebateScore, step, hostSelectionDirty, targetCountDirty, prefsDirty]
  );

  // ---- Autosave (debounced, cross-session resume) ----
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (result) return;
    const id = setTimeout(() => { void saveStudioRundownDraft(stateSnapshot); }, 700);
    return () => clearTimeout(id);
  }, [stateSnapshot, result]);

  // ---- Mode switching (item 3) — pure transition keeps state consistent ----
  const setMode = (next: Mode) => {
    if (next === mode) return;
    const r = applyModeChange({ mode, selectedTopicIds: selectedIds, leadTopicId, targetTopicCount }, next, maxTopics);
    setSelectedIds(r.selectedTopicIds);
    setLeadTopicId(r.leadTopicId);
    if (r.targetTopicCount !== targetTopicCount) { setTargetTopicCount(r.targetTopicCount); setTargetCountDirty(true); }
    if (next === "automatic") announce("Automatic mode — hand-picked topics cleared; the studio will select them.");
    if (r.note) { setInheritNote(r.note); announce(r.note); }
    setModeState(next);
  };

  // ---- Re-scope topics when the podcast changes ----
  const refreshTopics = useCallback(async (pid: string | null) => {
    setLoadingTopics(true);
    try { const res = await getStudioTopics(pid); if (res.success) setTopics(res.topics); }
    finally { setLoadingTopics(false); }
  }, []);

  // ---- Podcast selection + inheritance with dirty-state ----
  // A NON-dirty field always takes the newly selected show's value — INCLUDING an
  // empty one — so nothing stale survives a switch. Standalone resets non-dirty
  // fields to studio defaults. Dirty fields (explicit episode overrides, incl.
  // those restored from a draft) are always kept and called out.
  const onSelectPodcast = (pid: string | null) => {
    setPodcastId(pid);
    const pod = pid ? podcasts.find((p) => p.id === pid) ?? null : null;
    const applied: string[] = [];
    const kept: string[] = [];

    if (hostSelectionDirty) kept.push("hosts");
    else { setHostIds(pod ? pod.hostIds.slice(0, 2) : hosts.slice(0, 2).map((h) => h.id)); if (pod) applied.push("hosts"); }

    if (targetCountDirty) kept.push("target count");
    else { setTargetTopicCount(pod?.segmentCount ? Math.min(maxTopics, Math.max(1, pod.segmentCount)) : 3); if (pod) applied.push("target count"); }

    if (prefsDirty) kept.push("verticals/teams");
    else {
      setVerticals(pod?.verticals ?? []);
      setTeams(pod?.teamNames ?? []); // resolved NAMES — never raw Team ids
      if (pod) applied.push("verticals, teams");
    }

    const where = pod ? `“${pod.name}”` : "Standalone";
    const parts: string[] = [];
    if (applied.length) parts.push(`Inherited ${applied.join(", ")} from ${where}.`);
    else if (!pod) parts.push("Standalone — cleared show-inherited settings.");
    if (kept.length) parts.push(`Kept your override${kept.length > 1 ? "s" : ""}: ${kept.join(", ")}.`);
    setInheritNote(parts.length ? parts.join(" ") : null);
    void refreshTopics(pid);
  };

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

  const validation = useMemo(() => {
    const base = validateRundownDraft({ mode, selectedTopicIds: selectedIds, targetTopicCount, maxTopics });
    if (!base.ok) return base;
    if (hostIds.length < format.speakerMin) {
      return { ok: false as const, error: `The ${format.displayName} format needs at least ${format.speakerMin} host${format.speakerMin === 1 ? "" : "s"}.` };
    }
    return { ok: true as const };
  }, [mode, selectedIds, targetTopicCount, maxTopics, hostIds, format]);

  const estimate = useMemo(
    () => estimateRundown({ topicCount: mode === "automatic" ? targetTopicCount : mode === "hybrid" ? Math.max(selectedIds.length, targetTopicCount) : selectedIds.length }),
    [mode, targetTopicCount, selectedIds.length]
  );

  const goNext = () => { const i = STEPS.findIndex((s) => s.key === step); if (i < STEPS.length - 1) setStep(STEPS[i + 1].key); };
  const goBack = () => { const i = STEPS.findIndex((s) => s.key === step); if (i > 0) setStep(STEPS[i - 1].key); setError(null); };

  const changeTarget = (n: number) => { setTargetTopicCount(n); setTargetCountDirty(true); };
  const markPrefsDirty = () => setPrefsDirty(true);

  const submit = async () => {
    if (!validation.ok || submitting) return;
    setSubmitting(true); setError(null); setRejected([]);
    try {
      const res = await createStudioEpisode({
        mode,
        selectedTopicIds: mode === "automatic" ? [] : selectedIds,
        targetTopicCount,
        leadTopicId,
        podcastId,
        hostIds,
        // Standalone episodes carry the picked format; a podcast episode
        // inherits the show's format server-side unless it differs.
        format: podcastId ? undefined : formatId,
        ttsProvider: ttsProvider || undefined,
        ttsVoiceOverrides: buildVoiceOverrides(voicePicks, ttsProvider),
        productionStyle,
        sfxDensity,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        // Selection preferences (auto/hybrid) — only sent when the user set them,
        // else the server inherits from the podcast.
        verticals: prefsDirty && verticals.length ? verticals : undefined,
        leagueIds: leagueIds.length ? leagueIds : undefined,
        teams: prefsDirty && teams.length ? teams : undefined,
        sport: sport || undefined,
        minDebateScore: minDebateScore ?? undefined,
      });
      if (!res.success) {
        setError(res.error || "Couldn't create the episode.");
        if ("rejectedTopics" in res && res.rejectedTopics) setRejected(res.rejectedTopics);
        return; // draft is retained server-side on failure
      }
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong creating the episode.");
    } finally { setSubmitting(false); }
  };

  if (result && result.success) return <ResultView result={result} topicsById={byId} />;

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const autoSlots = mode === "hybrid" ? Math.max(0, targetTopicCount - selectedIds.length) : mode === "automatic" ? targetTopicCount : 0;

  return (
    <div className="rundownBuilder">
      <p aria-live="polite" className="srOnly" style={srOnlyStyle}>{srMsg}</p>

      <ol className="stepRail" aria-label="Create steps">
        {STEPS.map((s, i) => {
          const state = i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
          return (
            <li key={s.key} className={`stepPill step-${state}`} aria-current={state === "active" ? "step" : undefined}>
              <button type="button" data-testid={`step-${s.key}`} onClick={() => setStep(s.key)} style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: "0.4rem" }}>
                <span className="stepDot">{state === "done" ? "✓" : i + 1}</span>
                <span className="stepLabel">{s.label}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="studioCard createAlert" role="alert" data-testid="create-error">
          <strong>{error}</strong>
          {rejected.length > 0 && (
            <ul className="createReasons">{rejected.map((r, i) => <li key={i}>{topicTitle(byId, r.id)}: {r.reason}</li>)}</ul>
          )}
        </div>
      )}

      {/* ---------------- SHOW ---------------- */}
      {step === "show" && (
        <div className="studioCard">
          <h2 className="sectionTitle" style={{ marginTop: 0 }}>Where does this episode live?</h2>
          <div className="segRow" style={{ flexWrap: "wrap", marginBottom: "0.8rem" }}>
            <button type="button" data-testid="podcast-standalone" className={`segBtn${podcastId === null ? " on" : ""}`} aria-pressed={podcastId === null} onClick={() => onSelectPodcast(null)}>Standalone episode</button>
            {podcasts.map((p) => (
              <button key={p.id} type="button" data-testid={`podcast-${p.id}`} className={`segBtn${podcastId === p.id ? " on" : ""}`} aria-pressed={podcastId === p.id} onClick={() => onSelectPodcast(p.id)}>{p.name}</button>
            ))}
          </div>
          {inheritNote && <p className="stageHint" role="status" data-testid="inherit-note">↩ {inheritNote}</p>}

          <label className="fieldLabel" htmlFor="epTitle">Episode title <span className="stageHint">(optional)</span></label>
          <input id="epTitle" data-testid="episode-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Auto-generated if left blank" />

          <label className="fieldLabel" htmlFor="epDesc" style={{ marginTop: "0.8rem" }}>Description <span className="stageHint">(optional)</span></label>
          <textarea id="epDesc" data-testid="episode-description" className="input" value={description} maxLength={MAX_DESCRIPTION_LEN} rows={3} onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION_LEN))} placeholder="Show notes / summary for this episode" style={{ resize: "vertical" }} />
          <div className="stageHint" style={{ textAlign: "right" }} data-testid="desc-count">{description.length}/{MAX_DESCRIPTION_LEN}</div>

          <div className="fieldLabel" style={{ marginTop: "0.4rem" }}>Mode</div>
          <div className="segRow" role="radiogroup" aria-label="Rundown mode">
            {(["manual", "automatic", "hybrid"] as Mode[]).map((m) => (
              <button key={m} type="button" data-testid={`mode-${m}`} role="radio" aria-checked={mode === m} className={`segBtn${mode === m ? " on" : ""}`} onClick={() => setMode(m)} style={{ textTransform: "capitalize" }}>{m}</button>
            ))}
          </div>
          <p className="stageHint" style={{ marginTop: "0.5rem" }}>
            {mode === "manual" && "You pick every topic and their order."}
            {mode === "automatic" && "The studio selects the strongest eligible topics at creation. You set the target count and preferences."}
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
              <label className="fieldLabel" htmlFor="targetCount">Target topic count: <strong data-testid="target-count">{targetTopicCount}</strong></label>
              <input id="targetCount" type="range" min={1} max={maxTopics} value={targetTopicCount} onChange={(e) => changeTarget(Number(e.target.value))} style={{ width: "100%" }} />
              {mode === "hybrid" && <p className="stageHint" data-testid="hybrid-slots">{selectedIds.length} pinned · {targetTopicCount} target · {autoSlots} will be selected automatically</p>}
              {mode === "automatic" && <p className="stageHint">{targetTopicCount} topics will be selected automatically at creation.</p>}
              <AutoPrefs
                mode={mode} topics={topics} podcastScoped={podcastScoped}
                verticals={verticals} setVerticals={(v) => { setVerticals(v); markPrefsDirty(); }}
                leagueIds={leagueIds} setLeagueIds={(v) => { setLeagueIds(v); markPrefsDirty(); }}
                sport={sport} setSport={(v) => { setSport(v); markPrefsDirty(); }}
                teams={teams} setTeams={(v) => { setTeams(v); markPrefsDirty(); }}
                minDebateScore={minDebateScore} setMinDebateScore={(v) => { setMinDebateScore(v); markPrefsDirty(); }}
              />
            </div>
          )}
          <div className="rundownTwoCol">
            <div>
              {loadingTopics ? <div className="studioCard emptyNote">Loading takes…</div> : (
                <TopicRundownPicker topics={topics} selectedIds={selectedIds} onToggle={toggleTopic} selectionDisabled={mode === "automatic"} podcastScoped={podcastScoped} announce={announce} />
              )}
            </div>
            <div className="rundownTrayCol">
              <RundownTray items={orderedSelected} leadTopicId={leadTopicId} maxTopics={maxTopics} mode={mode} targetTopicCount={targetTopicCount} estimate={estimate} podcastScoped={podcastScoped} onReorder={reorder} onRemove={removeTopic} onSetLead={setLead} />
            </div>
          </div>
          {!validation.ok && <p className="stageHint" role="note" style={{ marginTop: "0.6rem", color: "var(--warning-color, #b45309)" }}>{validation.error}</p>}
          <StepNav onBack={goBack} onNext={goNext} nextLabel="Hosts →" nextDisabled={!validation.ok} />
        </div>
      )}

      {/* ---------------- HOSTS ---------------- */}
      {step === "hosts" && (
        <div className="studioCard">
          <h2 className="sectionTitle" style={{ marginTop: 0 }}>🎙 Format &amp; Hosts</h2>
          <div className="segRow" style={{ flexWrap: "wrap", marginBottom: 8 }} role="radiogroup" aria-label="Show format">
            {listShowFormats().filter((f) => isGenerationReadyFormat(f.id)).map((f) => (
              <button key={f.id} type="button" data-testid={`format-${f.id}`} className={`segBtn${formatId === f.id ? " on" : ""}`} aria-pressed={formatId === f.id}
                title={f.description}
                onClick={() => { setFormatId(f.id); setHostIds((prev) => prev.slice(0, f.speakerMax)); }}>
                {f.displayName} ({f.speakerMin === f.speakerMax ? f.speakerMin : `${f.speakerMin}-${f.speakerMax}`} voice{f.speakerMax === 1 ? "" : "s"})
              </button>
            ))}
          </div>
          <p className="stageHint">
            <strong>{format.description}</strong>{" "}
            Pacing: {format.pacing} Best for: {format.useCase}{" "}
            {format.roles.slice(0, format.speakerMax).map((r, i) => `Seat ${i + 1}: ${r.name}${r.required ? "" : " (optional)"}`).join(" · ")}. Only your own and shared hosts appear here.
          </p>
          <div className="segRow" style={{ flexWrap: "wrap" }}>
            {hosts.map((h) => {
              const seat = hostIds.indexOf(h.id);
              const on = seat >= 0;
              return (
                <button key={h.id} type="button" data-testid={`host-${h.id}`} className={`segBtn${on ? " on" : ""}`} aria-pressed={on}
                  onClick={() => {
                    setHostSelectionDirty(true);
                    setHostIds((prev) => prev.includes(h.id)
                      ? (prev.length <= 1 ? prev : prev.filter((x) => x !== h.id))
                      : prev.length < format.speakerMax
                        ? [...prev, h.id]
                        : [...prev.slice(0, format.speakerMax - 1), h.id]);
                  }}>
                  {on && <strong style={{ marginRight: 4 }}>{seat + 1}</strong>}{h.name}
                </button>
              );
            })}
            {hosts.length === 0 && <span className="stageHint">No active hosts — <Link href="/studio/hosts">add one →</Link></span>}
          </div>
          <StepNav onBack={goBack} onNext={goNext} nextLabel="Production →" nextDisabled={hostIds.length < format.speakerMin} />
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
          sfxDensity={sfxDensity} title={title} description={description} estimate={estimate} validation={validation}
          prefs={{ verticals, leagueIds, teams, sport, minDebateScore }} submitting={submitting} onBack={goBack} onSubmit={submit}
        />
      )}

      <p style={{ marginTop: "1rem" }}>
        <button type="button" className="advLink" data-testid="discard-draft" onClick={async () => { await discardStudioRundownDraft(); window.location.reload(); }}>Discard this draft</button>
      </p>
    </div>
  );
}

/* ---------------- Auto/Hybrid selection preferences (item 5) ---------------- */
function AutoPrefs({
  mode, topics, podcastScoped, verticals, setVerticals, leagueIds, setLeagueIds, sport, setSport, teams, setTeams, minDebateScore, setMinDebateScore,
}: {
  mode: Mode; topics: StudioTopicVM[]; podcastScoped: boolean;
  verticals: string[]; setVerticals: (v: string[]) => void;
  leagueIds: string[]; setLeagueIds: (v: string[]) => void;
  sport: string; setSport: (v: string) => void;
  teams: string[]; setTeams: (v: string[]) => void;
  minDebateScore: number | null; setMinDebateScore: (v: number | null) => void;
}) {
  const sports = useMemo(() => [...new Set(topics.map((t) => t.sport).filter(Boolean))].sort(), [topics]);
  const leagues = useMemo(() => [...new Set(topics.map((t) => t.leagueId).filter(Boolean) as string[])].sort(), [topics]);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <details className="advPanel" data-testid="auto-prefs" style={{ marginTop: "0.7rem" }} open>
      <summary className="advPanelHead" style={{ cursor: "pointer" }}>Selection preferences <span className="stageHint">— these steer the {mode} pick (separate from the board filters below)</span></summary>
      <div className="rundownPrefsGrid" style={{ marginTop: "0.6rem" }}>
        <div>
          <div className="fieldLabel">Sport</div>
          <select className="input" data-testid="pref-sport" value={sport} onChange={(e) => setSport(e.target.value)}>
            <option value="">Any</option>
            {sports.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div className="fieldLabel">Min debate score: {minDebateScore ?? "any"}</div>
          <input type="range" min={0} max={100} step={5} value={minDebateScore ?? 0} data-testid="pref-mindebate" onChange={(e) => setMinDebateScore(Number(e.target.value) || null)} style={{ width: "100%" }} />
        </div>
        {leagues.length > 0 && (
          <div style={{ gridColumn: "1 / -1" }}>
            <div className="fieldLabel">Leagues</div>
            <div className="segRow" style={{ flexWrap: "wrap" }}>
              {leagues.map((l) => <button key={l} type="button" data-testid={`pref-league-${l}`} className={`segBtn${leagueIds.includes(l) ? " on" : ""}`} aria-pressed={leagueIds.includes(l)} onClick={() => toggle(leagueIds, l, setLeagueIds)}>{l}</button>)}
            </div>
          </div>
        )}
        <div style={{ gridColumn: "1 / -1" }}>
          <div className="fieldLabel">Verticals</div>
          <div className="segRow" style={{ flexWrap: "wrap" }}>
            {sports.map((s) => <button key={s} type="button" data-testid={`pref-vertical-${s}`} className={`segBtn${verticals.includes(s) ? " on" : ""}`} aria-pressed={verticals.includes(s)} onClick={() => toggle(verticals, s, setVerticals)}>{s}</button>)}
          </div>
          {podcastScoped && <p className="stageHint">Verticals/teams start inherited from the show; change them to override just this episode.</p>}
        </div>
        <div style={{ gridColumn: "1 / -1" }}>
          <div className="fieldLabel">Team names (comma-separated)</div>
          <input className="input" data-testid="pref-teams" value={teams.join(", ")} placeholder="e.g. Chiefs, Eagles" onChange={(e) => setTeams(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        </div>
      </div>
    </details>
  );
}

/* ---------------- Review ---------------- */
function ReviewStep({
  mode, podcast, orderedSelected, leadTopicId, targetTopicCount, hosts, ttsProvider, productionStyle, sfxDensity, title, description, estimate, validation, prefs, submitting, onBack, onSubmit,
}: {
  mode: Mode; podcast: BuilderPodcast | null; orderedSelected: StudioTopicVM[]; leadTopicId: string | null; targetTopicCount: number;
  hosts: BuilderHost[]; ttsProvider: string; productionStyle: string; sfxDensity: string; title: string; description: string;
  estimate: ReturnType<typeof estimateRundown>; validation: { ok: boolean; error?: string };
  prefs: { verticals: string[]; leagueIds: string[]; teams: string[]; sport: string; minDebateScore: number | null };
  submitting: boolean; onBack: () => void; onSubmit: () => void;
}) {
  const autoSlots = mode === "hybrid" ? Math.max(0, targetTopicCount - orderedSelected.length) : mode === "automatic" ? targetTopicCount : 0;
  const lead = leadTopicId && orderedSelected.some((t) => t.id === leadTopicId) ? leadTopicId : orderedSelected[0]?.id;
  const warnings = orderedSelected.filter((t) => t.readiness !== "ready" || t.usedByShowRecent);
  const prefSummary = [prefs.sport && `sport ${prefs.sport}`, prefs.verticals.length && `verticals ${prefs.verticals.join("/")}`, prefs.leagueIds.length && `leagues ${prefs.leagueIds.join("/")}`, prefs.teams.length && `teams ${prefs.teams.join("/")}`, prefs.minDebateScore != null && `min debate ${prefs.minDebateScore}`].filter(Boolean).join(" · ");
  return (
    <div className="studioCard">
      <h2 className="sectionTitle" style={{ marginTop: 0 }}>Review the rundown</h2>
      <dl className="reviewGrid" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.35rem 1rem", margin: 0 }}>
        <dt className="fieldLabel">Title</dt><dd>{title || "Auto-generated"}</dd>
        {description && (<><dt className="fieldLabel">Description</dt><dd data-testid="review-description">{description}</dd></>)}
        <dt className="fieldLabel">Show</dt><dd>{podcast ? podcast.name : "Standalone episode"}</dd>
        <dt className="fieldLabel">Mode</dt><dd style={{ textTransform: "capitalize" }} data-testid="review-mode">{mode}</dd>
        <dt className="fieldLabel">Rundown</dt>
        <dd>
          {mode === "automatic" ? <span>{targetTopicCount} topics selected automatically at creation.</span> : (
            <ol style={{ margin: 0, paddingLeft: "1.1rem" }} data-testid="review-rundown">
              {orderedSelected.map((t) => (
                <li key={t.id}>{t.id === lead && <span className="chip chipAccent">★ Lead</span>} {t.title}{t.readiness !== "ready" && <span style={{ color: "var(--warning-color, #b45309)" }}> ⚠ {t.readiness.replace("_", " ")}</span>}</li>
              ))}
            </ol>
          )}
          {autoSlots > 0 && <p className="stageHint">+ {autoSlots} auto-selected slot{autoSlots === 1 ? "" : "s"}.</p>}
        </dd>
        {mode !== "manual" && prefSummary && (<><dt className="fieldLabel">Auto preferences</dt><dd data-testid="review-prefs">{prefSummary}</dd></>)}
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
        <button type="button" data-testid="create-episode" className="btnPrimary" onClick={onSubmit} disabled={!validation.ok || submitting} style={{ marginLeft: "auto" }}>
          {submitting ? "Creating…" : "Create episode"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- Result (item 13: startDebate error handling) ---------------- */
function ResultView({ result, topicsById }: { result: Extract<CreateResult, { success: true }>; topicsById: Map<string, StudioTopicVM> }) {
  const reduced = result.finalOrder.length < result.requestedCount;
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const start = async () => {
    setStarting(true); setStartError(null);
    try {
      if (!result.episodeId) throw new Error("No episode id.");
      const res = (await startDebate(result.episodeId)) as { success?: boolean; error?: string };
      if (res && res.success === false) { setStartError(res.error || "Couldn't start the debate."); return; }
      window.location.href = `/studio/episodes/${result.episodeId}`;
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Couldn't start the debate.");
    } finally { setStarting(false); }
  };
  return (
    <div className="studioCard">
      <h2 className="sectionTitle" style={{ marginTop: 0 }}>🎬 Episode created</h2>
      {result.draftCleanupWarning && <div className="createAlert" role="status" data-testid="draft-warning" style={{ marginBottom: "0.6rem" }}>{result.draftCleanupWarning}</div>}
      {reduced && (
        <div className="createAlert" role="status" data-testid="reduced-notice" style={{ marginBottom: "0.8rem" }}>
          {result.concurrentlyDroppedIds.length > 0
            ? `One or more automatically selected topics became unavailable while the episode was being created. Your episode was created with ${result.finalOrder.length} topic${result.finalOrder.length === 1 ? "" : "s"} instead of ${result.requestedCount}.`
            : `The studio found ${result.finalOrder.length} eligible topic${result.finalOrder.length === 1 ? "" : "s"} (you requested ${result.requestedCount}).`}
        </div>
      )}
      <p className="stageHint">This is the final rundown the studio actually created (from the backend), in order:</p>
      <ol style={{ paddingLeft: "1.2rem" }} data-testid="result-final-order">
        {result.finalOrder.map((id, i) => {
          const ref = result.selectedTopics.find((s) => s.id === id);
          return <li key={id} data-testid={`final-${id}`}>{i === 0 && <span className="chip chipAccent">★ Lead</span>} {ref?.title ?? topicsById.get(id)?.title ?? id} {ref && !ref.pinned && <span className="chip">auto</span>}</li>;
        })}
      </ol>
      {result.rejectedTopics.length > 0 && (
        <div role="note" style={{ marginTop: "0.6rem", fontSize: "0.82rem" }}>
          <div className="fieldLabel">Not included</div>
          <ul className="createReasons">{result.rejectedTopics.map((r, i) => <li key={i}>{topicsById.get(r.id)?.title ?? r.id}: {r.reason}</li>)}</ul>
        </div>
      )}
      {startError && <p role="alert" data-testid="start-error" style={{ color: "var(--warning-color, #b45309)", marginTop: "0.6rem" }}>{startError}</p>}
      <div className="stageActions" style={{ marginTop: "1rem" }}>
        <Link href={`/studio/episodes/${result.episodeId}`} className="btnGhost">Open episode</Link>
        <button type="button" data-testid="start-debate" className="btnPrimary" style={{ marginLeft: "auto" }} disabled={starting} onClick={start}>
          {starting ? "Starting…" : "Start the debate →"}
        </button>
      </div>
    </div>
  );
}

function StepNav({ onBack, onNext, nextLabel, nextDisabled }: { onBack: (() => void) | null; onNext: () => void; nextLabel: string; nextDisabled?: boolean }) {
  return (
    <div className="stageActions" style={{ marginTop: "1rem" }}>
      {onBack ? <button type="button" data-testid="step-back" className="btnGhost" onClick={onBack}>← Back</button> : <span />}
      <button type="button" data-testid="step-next" className="btnPrimary" onClick={onNext} disabled={nextDisabled} style={{ marginLeft: "auto" }}>{nextLabel}</button>
    </div>
  );
}

const srOnlyStyle: React.CSSProperties = { position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0,0,0,0)", whiteSpace: "nowrap", border: 0 };
function topicTitle(byId: Map<string, StudioTopicVM>, id: string): string { return byId.get(id)?.title ?? id; }
function buildVoiceOverrides(picks: Record<string, string>, engine: string): Record<string, { provider: string; voiceId: string }> | undefined {
  if (!engine) return undefined;
  const out: Record<string, { provider: string; voiceId: string }> = {};
  for (const [hostId, voiceId] of Object.entries(picks)) { const v = voiceId.trim(); if (v) out[hostId] = { provider: engine, voiceId: v }; }
  return Object.keys(out).length > 0 ? out : undefined;
}
function voicePicksFromOverrides(overrides: unknown): Record<string, string> {
  if (!overrides || typeof overrides !== "object") return {};
  const out: Record<string, string> = {};
  for (const [hostId, v] of Object.entries(overrides as Record<string, unknown>)) {
    if (v && typeof v === "object" && typeof (v as Record<string, unknown>).voiceId === "string") out[hostId] = String((v as Record<string, unknown>).voiceId);
  }
  return out;
}
