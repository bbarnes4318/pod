"use client";

// Studio multi-topic rundown builder: Show → Topics → Hosts → Production →
// Review → Create. Manual / Automatic / Hybrid, all routed through the SHARED
// createEpisodeDraft via createStudioEpisode. Durable cross-session resume
// (autosaved StudioDraft). The backend's finalOrder is the source of truth.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import StudioPageHeader from "../StudioPageHeader";
import {
  getStudioTopics,
  createStudioEpisode,
  saveStudioRundownDraft,
  discardStudioRundownDraft,
  startDebate,
  setEpisodeQualityTier,
} from "../../app/create/actions";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";
import type { RundownDraftState, RundownStep } from "@/lib/services/studioDraft";
import { estimateRundown } from "@/lib/services/episodeEstimate";
import { validateRundownDraft, applyModeChange, submissionSelection } from "@/lib/studio/rundownRules";
import { getShowFormat, listShowFormats, formatBlockedReason } from "@/lib/formats/showFormatRegistry";
import { MAX_DESCRIPTION_LEN, MAX_HOSTS } from "@/lib/episodeLimits";
// Shared rundown core — the SAME picker/tray Admin uses (src/components/rundown).
import TopicRundownPicker from "@/components/rundown/TopicRundownPicker";
import RundownTray from "@/components/rundown/RundownTray";
import ProductionConsole from "../ProductionConsole";
import QualityTierPicker from "../QualityTierPicker";
import {
  DEFAULT_QUALITY_TIER,
  formatTierCost,
  formatTierDuration,
  tierInfo,
  type QualityTier,
} from "@/lib/providers/llm/qualityTiers";

type Mode = "manual" | "automatic" | "hybrid";
export interface BuilderPodcast { id: string; name: string; verticals: string[]; teamIds: string[]; teamNames: string[]; segmentCount: number; hostIds: string[]; format?: string | null; }
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
// Engine choices come from the SERVER, which knows which providers this
// deployment actually has credentials for. Hard-coding the list meant three of
// four options could only fail later, after the script was already paid for.
export interface TtsEngineChoice { key: string; label: string; available: boolean; reason?: string }

type CreateResult = Awaited<ReturnType<typeof createStudioEpisode>>;

export default function RundownBuilder({
  podcasts, initialTopics, hosts, initialDraft, maxTopics, seedTopicId, ttsEngines,
}: {
  podcasts: BuilderPodcast[];
  initialTopics: StudioTopicVM[];
  hosts: BuilderHost[];
  initialDraft: RundownDraftState | null;
  maxTopics: number;
  seedTopicId?: string | null;
  ttsEngines: TtsEngineChoice[];
}) {
  const d = initialDraft;
  // ?topic= is honoured even when a draft exists: the seed MERGES into the
  // draft's picks (it used to be silently discarded whenever a draft existed —
  // which is nearly always — making "Generate episode" on a board card a no-op).
  const seedTopic = seedTopicId ? initialTopics.find((t) => t.id === seedTopicId) ?? null : null;
  const draftIds = d?.selectedTopicIds ?? [];
  const seedMerged = !!seedTopic?.eligible && !draftIds.includes(seedTopic.id);
  const [mode, setModeState] = useState<Mode>(d?.mode ?? "manual");
  const [selectedIds, setSelectedIds] = useState<string[]>(seedMerged ? [...draftIds, seedTopic!.id] : draftIds);
  const [leadTopicId, setLeadTopicId] = useState<string | null>(d?.leadTopicId ?? null);
  // The seed's outcome is always REPORTED, including the failure cases.
  const [seedNote, setSeedNote] = useState<string | null>(() => {
    if (!seedTopicId) return null;
    if (!seedTopic) return "That topic isn't in the current pool, so it wasn't added to your rundown.";
    if (!seedTopic.eligible) return `“${seedTopic.title}” can't be added: ${seedTopic.readiness.replace(/_/g, " ")}.`;
    return seedMerged ? `Added “${seedTopic.title}” to your rundown.` : `“${seedTopic.title}” is already in your rundown.`;
  });
  const [targetTopicCount, setTargetTopicCount] = useState<number>(d?.targetTopicCount ?? 3);
  const [podcastId, setPodcastId] = useState<string | null>(d?.podcastId ?? null);
  const [formatId, setFormatId] = useState<string>(d?.formatId ?? "two_host_debate");
  // A podcast episode inherits the SHOW's format (the server enforces this);
  // standalone episodes use the picked one. The UI must gate and describe
  // against the format that will actually apply.
  const activePodcast = podcastId ? podcasts.find((p) => p.id === podcastId) ?? null : null;
  const format = getShowFormat(activePodcast ? activePodcast.format ?? "two_host_debate" : formatId) ?? getShowFormat("two_host_debate")!;
  // What the pipeline can actually voice today, regardless of the format's
  // aspirational seat count.
  const seatCap = Math.min(format.speakerMax, MAX_HOSTS);
  const [hostIds, setHostIds] = useState<string[]>(d?.hostIds?.length ? d.hostIds : hosts.slice(0, 2).map((h) => h.id));
  const [ttsProvider, setTtsProvider] = useState<string>(d?.ttsProvider ?? "");
  const [voicePicks, setVoicePicks] = useState<Record<string, string>>(() => voicePicksFromOverrides(d?.ttsVoiceOverrides));
  const [productionStyle, setProductionStyle] = useState<string>(d?.productionStyle ?? "light");
  const [sfxDensity, setSfxDensity] = useState<string>(d?.sfxDensity ?? "medium");
  // Which models write THIS episode. Starts null — "not chosen" — rather than
  // pre-selecting a default, so a user who never touches it inherits the show's
  // tier (or the deployment default for a standalone episode) instead of having
  // a choice silently made for them.
  const [qualityTier, setQualityTier] = useState<QualityTier | null>(null);
  const [title, setTitle] = useState<string>(d?.title ?? "");
  const [description, setDescription] = useState<string>(d?.description ?? "");
  // A seed deep-links to the Topics step so the user lands where the topic is.
  const [step, setStep] = useState<RundownStep>(seedTopic?.eligible ? "topics" : d?.activeStep ?? "show");

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
      mode, selectedTopicIds: selectedIds, leadTopicId, targetTopicCount, podcastId, formatId,
      hostIds, ttsProvider: ttsProvider || null, ttsVoiceOverrides: buildVoiceOverrides(voicePicks, ttsProvider),
      productionStyle: (productionStyle || null) as RundownDraftState["productionStyle"], sfxDensity: (sfxDensity || null) as RundownDraftState["sfxDensity"], title: title || null, description: description || null,
      verticals: verticals.length ? verticals : undefined, leagueIds: leagueIds.length ? leagueIds : undefined,
      teams: teams.length ? teams : undefined, sport: sport || null, minDebateScore, activeStep: step,
      // Persist WHY each value holds what it holds, so a reload can still tell an
      // inherited value from a deliberate override.
      overrides: { hosts: hostSelectionDirty, targetTopicCount: targetCountDirty, selectionPreferences: prefsDirty },
    }),
    [mode, selectedIds, leadTopicId, targetTopicCount, podcastId, formatId, hostIds, ttsProvider, voicePicks, productionStyle, sfxDensity, title, description, verticals, leagueIds, teams, sport, minDebateScore, step, hostSelectionDirty, targetCountDirty, prefsDirty]
  );

  // ---- Autosave (debounced, cross-session resume) ----
  // Every save is HANDLED: the result drives a visible three-state indicator
  // (saving / saved / failed-with-retry). The old fire-and-forget `void save()`
  // meant a rejected draft failed silently on every keystroke and the user
  // found out by reloading into an empty form.
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(initialDraft ? "saved" : "idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const discardedRef = useRef(false);
  const saveNow = useCallback(async (snap: RundownDraftState) => {
    if (discardedRef.current) return;
    setSaveState("saving");
    try {
      const res = (await saveStudioRundownDraft(snap)) as { ok?: boolean; success?: boolean; error?: string };
      if (discardedRef.current) return;
      if (res && (res.ok === false || res.success === false)) {
        setSaveState("error");
        setSaveError(res.error || "Couldn't save your draft.");
        // The one save state worth announcing — a settled failure.
        announce(`Couldn't save your draft: ${res.error || "unknown error"}. A retry button is available.`);
      } else {
        setSaveState("saved");
        setSaveError(null);
        setSavedAt(new Date());
      }
    } catch {
      if (!discardedRef.current) {
        setSaveState("error");
        setSaveError("Couldn't reach the studio — check your connection.");
        announce("Couldn't save your draft — connection problem. A retry button is available.");
      }
    }
  }, [announce]);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (result || discardedRef.current) return;
    const id = setTimeout(() => { void saveNow(stateSnapshot); }, 700);
    return () => clearTimeout(id);
  }, [stateSnapshot, result, saveNow]);

  // ---- Discard (two-step confirm; only offered when a draft exists) ----
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const hasDraft = initialDraft !== null || savedAt !== null;
  const discardDraft = async () => {
    setDiscarding(true);
    // Stop any in-flight/pending autosave from resurrecting the draft.
    discardedRef.current = true;
    try { await discardStudioRundownDraft(); } finally { window.location.reload(); }
  };

  // ---- Mode switching — non-destructive: picks are kept, never deleted ----
  const setMode = (next: Mode) => {
    if (next === mode) return;
    const r = applyModeChange({ mode, selectedTopicIds: selectedIds, leadTopicId, targetTopicCount }, next, maxTopics);
    setSelectedIds(r.selectedTopicIds);
    setLeadTopicId(r.leadTopicId);
    if (r.targetTopicCount !== targetTopicCount) { setTargetTopicCount(r.targetTopicCount); setTargetCountDirty(true); }
    if (r.note) { setInheritNote(r.note); announce(r.note); }
    else if (next === "automatic") announce("Automatic mode — the studio selects the topics at creation.");
    setModeState(next);
  };

  // ---- Re-scope topics when the podcast changes ----
  // The selection is RECONCILED against the new pool: picks (including kept
  // picks in Automatic) that aren't available for the new show are removed
  // EXPLICITLY and named in a dismissible notice — never silently dropped by a
  // display-time filter while the count and validator still count them.
  const [dropNote, setDropNote] = useState<string | null>(null);
  const reconcileRefs = useRef({ selectedIds, leadTopicId, byId });
  useEffect(() => { reconcileRefs.current = { selectedIds, leadTopicId, byId }; }, [selectedIds, leadTopicId, byId]);
  const refreshTopics = useCallback(async (pid: string | null) => {
    setLoadingTopics(true);
    try {
      const res = await getStudioTopics(pid);
      if (res.success) {
        // A pick survives the switch only if it's still in the pool AND still
        // eligible under the new show's rules (e.g. "recently used by this
        // show" flips eligibility per show while pool membership stays put).
        // Keeping an ineligible pick would let the count/validator pass while
        // the server rejects it at create — the ghost-id trap.
        const vmById = new Map(res.topics.map((t) => [t.id, t]));
        const { selectedIds: prev, leadTopicId: lead, byId: oldById } = reconcileRefs.current;
        const dropped = prev.filter((id) => !(vmById.get(id)?.eligible ?? false));
        if (dropped.length > 0) {
          const why = (id: string) => {
            const vm = vmById.get(id);
            if (!vm) return "no longer in the pool";
            if (vm.usedByShowRecent) return "recently used by this show";
            return vm.readiness.replace(/_/g, " ");
          };
          const names = dropped.map((id) => `${oldById.get(id)?.title ?? id} (${why(id)})`);
          setSelectedIds(prev.filter((id) => !dropped.includes(id)));
          if (lead && dropped.includes(lead)) setLeadTopicId(null);
          const msg = `Removed from your rundown for this show: ${names.join(", ")}.`;
          setDropNote(msg);
          announce(msg);
        }
        setTopics(res.topics);
      }
    } finally { setLoadingTopics(false); }
  }, [announce]);

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

  const changeTarget = (n: number) => { setTargetTopicCount(n); setTargetCountDirty(true); };
  const markPrefsDirty = () => setPrefsDirty(true);

  const submit = async () => {
    if (!validation.ok || submitting) return;
    setSubmitting(true); setError(null); setRejected([]);
    try {
      // Automatic strips BOTH the kept picks and the lead — a lead pointing at
      // a topic outside the (empty) list is exactly the state the creation
      // rules declare illegal.
      const sel = submissionSelection(mode, selectedIds, leadTopicId);
      const res = await createStudioEpisode({
        mode,
        selectedTopicIds: sel.selectedTopicIds,
        targetTopicCount,
        leadTopicId: sel.leadTopicId,
        podcastId,
        hostIds,
        // Standalone episodes carry the picked format; a podcast episode
        // inherits the show's format server-side unless it differs.
        format: podcastId ? undefined : formatId,
        ttsProvider: ttsProvider || undefined,
        ttsVoiceOverrides: buildVoiceOverrides(voicePicks, ttsProvider),
        productionStyle,
        sfxDensity,
        // Omitted when unchosen so the server falls back to podcast -> default
        // rather than receiving a value the user never picked.
        qualityTier: qualityTier ?? undefined,
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

  if (result && result.success)
    return <ResultView result={result} topicsById={byId} initialTier={qualityTier} inheritsFromShow={!!podcastId} />;

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const autoSlots = mode === "hybrid" ? Math.max(0, targetTopicCount - selectedIds.length) : mode === "automatic" ? targetTopicCount : 0;

  // What the rail shows UNDER each step name. A rail that only lists step names
  // makes you open a step to remember what you put in it; this answers the
  // question in place.
  const railValue: Record<RundownStep, string> = {
    show: podcastId ? podcasts.find((p) => p.id === podcastId)?.name ?? "Show" : "Standalone",
    topics:
      mode === "automatic" ? `${targetTopicCount} chosen for you`
      : mode === "hybrid" ? `${selectedIds.length} pinned + ${autoSlots}`
      : selectedIds.length ? `${selectedIds.length} picked` : "Nothing picked yet",
    hosts: hosts.filter((h) => hostIds.includes(h.id)).map((h) => h.name).join(" + ") || "No hosts",
    // THE TIER LEADS THIS LINE. Sound-design level and SFX density change how
    // the episode sounds; the tier is the only thing here that decides whether
    // it costs money and whether it takes three minutes or twelve. A rail that
    // summarised the Production step as "clean · medium" hid the one setting a
    // user would want to check before pressing the button.
    production: `${qualityTier ? tierInfo(qualityTier).label : podcastId ? "Show's tier" : `${tierInfo(DEFAULT_QUALITY_TIER).label} (default)`} · ${productionStyle} · ${sfxDensity}`,
    review: `~${estimate.estimatedDurationMinutes} min`,
  };

  // The topic the show will open on — the lead if one is set, otherwise
  // whatever sits first in the rundown. Automatic has no lead until creation,
  // so it has nothing honest to preview.
  const leadPreview =
    mode === "automatic" ? null
    : orderedSelected.find((t) => t.id === leadTopicId) ?? orderedSelected[0] ?? null;

  // The one CTA. It sits in the preview column at a fixed spot and changes its
  // verb, never its position — the old flow put Next at the bottom of whichever
  // card was open, so the button moved every time the step did.
  const ctaDisabled =
    step === "topics" ? !validation.ok
    : step === "hosts" ? hostIds.length < Math.min(format.speakerMin, MAX_HOSTS)
    : step === "review" ? !validation.ok || submitting
    : false;

  return (
    <div className="rundownBuilder createLayout">
      <p aria-live="polite" className="srOnly">{srMsg}</p>

      {/* Identity, save state and the destructive action all live in the shell
          chrome now. The save line used to sit in the page body under a
          -0.75rem negative margin, and Discard sat below the step card where it
          moved every time the step changed. */}
      <StudioPageHeader
        title="Create an episode"
        subtitle="Pick the takes. We'll build the show."
        status={
          <span data-testid="save-status" data-state={saveState}>
            {saveState === "saving" && "Saving…"}
            {saveState === "saved" && `Saved${savedAt ? ` ${savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`}
            {saveState === "error" && (
              <span>
                Couldn&apos;t save — {saveError}{" "}
                <button type="button" data-testid="save-retry" onClick={() => void saveNow(stateSnapshot)}>Retry</button>
              </span>
            )}
            {saveState === "idle" && "Draft saves as you build."}
          </span>
        }
        actions={
          hasDraft ? (
            confirmingDiscard ? (
              <span role="alertdialog" aria-label="Confirm discard">
                <span>Discard this draft?</span>
                <button type="button" data-testid="discard-confirm" disabled={discarding} onClick={() => void discardDraft()}>
                  {discarding ? "Discarding…" : "Yes, discard"}
                </button>
                <button type="button" data-testid="discard-cancel" disabled={discarding} onClick={() => setConfirmingDiscard(false)}>Cancel</button>
              </span>
            ) : (
              <button type="button" data-testid="discard-draft" onClick={() => setConfirmingDiscard(true)}>Discard draft</button>
            )
          ) : undefined
        }
      />

      {/* ---- ZONE 1: the rundown rail ----
          Vertical, and it carries VALUES, not just step names: what show, how
          many topics, which hosts. The old horizontal pill strip could only say
          which step you were on, so remembering what you had chosen meant
          opening the step again. */}
      <nav className="createRail" aria-label="Create steps">
        <ol className="createRailList">
          {STEPS.map((s, i) => {
            const state = i < stepIndex ? "done" : i === stepIndex ? "active" : "todo";
            return (
              <li key={s.key}>
                <button
                  type="button"
                  data-testid={`step-${s.key}`}
                  onClick={() => { setStep(s.key); setError(null); }}
                  className={`createRailBtn step-${state}`}
                  aria-current={state === "active" ? "step" : undefined}
                >
                  <span className="stepDot">{state === "done" ? "✓" : i + 1}</span>
                  <span className="createRailText">
                    <span className="createRailLabel">{s.label}</span>
                    <span className="createRailValue">{railValue[s.key]}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* ---- ZONE 2: the workspace ---- */}
      <div className="createWork">
        {/* One slot for everything the studio has to say. Notices used to be
            inserted into the document above the step card, so every message
            pushed the whole form down and the control you were about to click
            moved out from under the cursor. This slot overlays instead. */}
        <div className="createToasts" role="presentation">
          {seedNote && (
            <div className="createToast" role="status" data-testid="seed-note">
              <span>{seedNote}</span>
              <button type="button" className="advLink" onClick={() => setSeedNote(null)}>Dismiss</button>
            </div>
          )}
          {dropNote && (
            <div className="createToast" role="status" data-testid="dropped-note">
              <span>{dropNote}</span>
              <button type="button" className="advLink" onClick={() => setDropNote(null)}>Dismiss</button>
            </div>
          )}
          {inheritNote && (
            <div className="createToast" role="status" data-testid="inherit-note">
              <span>↩ {inheritNote}</span>
              <button type="button" className="advLink" onClick={() => setInheritNote(null)}>Dismiss</button>
            </div>
          )}
          {error && (
            <div className="createToast createToast--error" role="alert" data-testid="create-error">
              <span>
                <strong>{error}</strong>
                {rejected.length > 0 && (
                  <ul className="createReasons">{rejected.map((r, i) => <li key={i}>{topicTitle(byId, r.id)}: {r.reason}</li>)}</ul>
                )}
              </span>
            </div>
          )}
        </div>

      {/* ---------------- SHOW ---------------- */}
      {/* Step one asks ONE question. Title, description and mode all used to be
          crammed in here, which meant the first screen of the flow was four
          unrelated decisions deep before you had said what you were making. */}
      {step === "show" && (
        <div className="studioCard">
          <h2 className="sectionTitle mt-0">Where does this episode live?</h2>
          <p className="stageHint mb-3">A show lends the episode its format, hosts and topic preferences. A standalone episode starts from studio defaults.</p>
          <div className="segRow u-wrap">
            <button type="button" data-testid="podcast-standalone" className={`segBtn${podcastId === null ? " on" : ""}`} aria-pressed={podcastId === null} onClick={() => onSelectPodcast(null)}>Standalone episode</button>
            {podcasts.map((p) => (
              <button key={p.id} type="button" data-testid={`podcast-${p.id}`} className={`segBtn${podcastId === p.id ? " on" : ""}`} aria-pressed={podcastId === p.id} onClick={() => onSelectPodcast(p.id)}>{p.name}</button>
            ))}
          </div>
        </div>
      )}

      {/* ---------------- TOPICS ---------------- */}
      {step === "topics" && (
        <div>
          {/* Mode lives WITH the topics it governs. It used to sit on step one,
              where it decided the behaviour of a screen you had not reached. */}
          <div className="studioCard mb-3">
            <div className="fieldLabel">How should the topics be chosen?</div>
            <div className="segRow" role="radiogroup" aria-label="How topics are chosen">
              <button
                type="button" data-testid="mode-manual" role="radio" aria-checked={mode === "manual"}
                className={`segBtn${mode === "manual" || mode === "hybrid" ? " on" : ""}`}
                onClick={() => setMode("manual")}
              >
                I&apos;ll pick them
              </button>
              <button
                type="button" data-testid="mode-automatic" role="radio" aria-checked={mode === "automatic"}
                className={`segBtn${mode === "automatic" ? " on" : ""}`}
                onClick={() => setMode("automatic")}
              >
                The studio picks
              </button>
            </div>
            {/* Hybrid is not a third way of working — it is picking your own and
                letting the studio top the rundown up. Modelled as what it is. */}
            {mode !== "automatic" && (
              <div className="createHybrid">
                <button
                  type="button" data-testid="mode-hybrid" role="checkbox" aria-checked={mode === "hybrid"}
                  id="hybridToggle" className={`checkBox${mode === "hybrid" ? " on" : ""}`}
                  onClick={() => setMode(mode === "hybrid" ? "manual" : "hybrid")}
                >
                  {mode === "hybrid" ? "✓" : ""}
                </button>
                <label htmlFor="hybridToggle">Let the studio fill the rest up to my target count</label>
              </div>
            )}
            <p className="stageHint mt-2">
              {mode === "manual" && "You pick every topic and their order."}
              {mode === "automatic" && "The studio selects the strongest eligible topics at creation. You set the target count and preferences."}
              {mode === "hybrid" && "Pin the must-cover topics; the studio fills the rest to your target count."}
            </p>

            {mode !== "manual" && (
              <div className="mt-3">
                <label className="fieldLabel" htmlFor="targetCount">Target topic count: <strong data-testid="target-count">{targetTopicCount}</strong></label>
                <input id="targetCount" type="range" min={1} max={maxTopics} value={targetTopicCount} onChange={(e) => changeTarget(Number(e.target.value))} className="u-full" />
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
          </div>

          <div className="rundownTwoCol">
            <div>
              {loadingTopics ? <TopicPickerSkeleton /> : (
                <TopicRundownPicker topics={topics} selectedIds={selectedIds} onToggle={toggleTopic} selectionDisabled={mode === "automatic"} podcastScoped={podcastScoped} announce={announce} dense pageSize={12} />
              )}
            </div>
            <div className="rundownTrayCol">
              {/* In Automatic the kept picks are INACTIVE: the tray shows the
                  automatic plan, and a note explains where the picks went. */}
              {mode === "automatic" && selectedIds.length > 0 && (
                <p className="stageHint mt-0" data-testid="kept-picks-note">
                  {selectedIds.length} pick{selectedIds.length === 1 ? "" : "s"} kept for Manual/Hybrid — Automatic ignores them.
                </p>
              )}
              <RundownTray items={mode === "automatic" ? [] : orderedSelected} leadTopicId={leadTopicId} maxTopics={maxTopics} mode={mode} targetTopicCount={targetTopicCount} estimate={estimate} podcastScoped={podcastScoped} onReorder={reorder} onRemove={removeTopic} onSetLead={setLead} />
            </div>
          </div>
        </div>
      )}

      {/* ---------------- HOSTS ---------------- */}
      {step === "hosts" && (
        <div className="studioCard">
          <h2 className="sectionTitle mt-0">Format and hosts</h2>
          {podcastScoped ? (
            /* A podcast episode INHERITS the show's format server-side, so the
               control must not pretend to change it. Read-only, with the real
               place to change it linked. */
            <p className="stageHint mb-2" data-testid="format-inherited">
              This show uses <strong className="u-strong">{format.displayName}</strong> — change it in{" "}
              <Link href={`/app/podcasts/${podcastId}`}>show settings →</Link>
            </p>
          ) : (
            <div className="segRow u-wrap mb-2" role="radiogroup" aria-label="Show format">
              {listShowFormats().map((f) => {
                const blocked = formatBlockedReason(f.id);
                return (
                  <button key={f.id} type="button" data-testid={`format-${f.id}`} className={`segBtn${formatId === f.id ? " on" : ""}`} aria-pressed={formatId === f.id}
                    disabled={!!blocked} aria-disabled={!!blocked}
                    title={blocked ?? f.description}
                    onClick={() => { setFormatId(f.id); setHostIds((prev) => prev.slice(0, Math.min(f.speakerMax, MAX_HOSTS))); }}>
                    {f.displayName} ({f.speakerMin === f.speakerMax ? f.speakerMin : `${f.speakerMin}-${f.speakerMax}`} voice{f.speakerMax === 1 ? "" : "s"})
                    {blocked && <span className="stageHint ml-2">{blocked}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <p className="stageHint">
            <strong>{format.description}</strong>{" "}
            Pacing: {format.pacing} Best for: {format.useCase}{" "}
            {format.roles.slice(0, seatCap).map((r, i) => `Seat ${i + 1}: ${r.name}${r.required ? "" : " (optional)"}`).join(" · ")}. Only your own and shared hosts appear here.
          </p>
          {format.speakerMax > MAX_HOSTS && (
            <p className="stageHint" data-testid="seat-cap-note">
              This format supports up to {format.speakerMax} seats; the studio currently voices {MAX_HOSTS} — extra seats are coming soon.
            </p>
          )}
          <div className="segRow u-wrap">
            {hosts.map((h) => {
              const seat = hostIds.indexOf(h.id);
              const on = seat >= 0;
              return (
                <button key={h.id} type="button" data-testid={`host-${h.id}`} className={`segBtn${on ? " on" : ""}`} aria-pressed={on}
                  onClick={() => {
                    setHostSelectionDirty(true);
                    // Cap at what the pipeline can actually voice (MAX_HOSTS),
                    // never at the format's aspirational speakerMax — a 3rd
                    // pick used to sail through to "at most two hosts" at the
                    // last click.
                    setHostIds((prev) => prev.includes(h.id)
                      ? (prev.length <= 1 ? prev : prev.filter((x) => x !== h.id))
                      : prev.length < seatCap
                        ? [...prev, h.id]
                        : [...prev.slice(0, seatCap - 1), h.id]);
                  }}>
                  {on && <strong className="mr-12">{seat + 1}</strong>}{h.name}
                </button>
              );
            })}
            {hosts.length === 0 && <span className="stageHint">No active hosts — <Link href="/studio/hosts">add one →</Link></span>}
          </div>
        </div>
      )}

      {/* ---------------- PRODUCTION ---------------- */}
      {step === "production" && (
        <div className="studioCard">
          {/* Which models WRITE this episode. FIRST in the Production step,
              because it is the only control here with a per-episode dollar cost
              and a ten-minute speed consequence — the rest change how it sounds,
              this changes what it costs and how long it takes.

              A standalone episode has no podcast to inherit a tier from, so this
              is the only place the question can be asked for one. Left
              untouched it inherits the show's tier, then the deployment
              default. */}
          <QualityTierPicker value={qualityTier} onChange={(t) => setQualityTier(t)} />
          {qualityTier === null && podcastId ? (
            <p className="hintText mt-2">Not set — this episode will use the show&apos;s tier.</p>
          ) : null}

          <h2 className="sectionTitle mt-4">Production</h2>
          <div className="fieldLabel">Sound-design level</div>
          <div className="segRow">{PROD_STYLES.map((p) => <button key={p.k} type="button" className={`segBtn${productionStyle === p.k ? " on" : ""}`} aria-pressed={productionStyle === p.k} onClick={() => setProductionStyle(p.k)}>{p.l}</button>)}</div>
          <div className="fieldLabel mt-3">Reactions &amp; SFX</div>
          <div className="segRow">{SFX.map((s) => <button key={s.k} type="button" className={`segBtn${sfxDensity === s.k ? " on" : ""}`} aria-pressed={sfxDensity === s.k} onClick={() => setSfxDensity(s.k)}>{s.l}</button>)}</div>
          <div className="fieldLabel mt-3">TTS engine</div>
          <select className="input" value={ttsProvider} onChange={(e) => { setTtsProvider(e.target.value); setVoicePicks({}); }}>
            {ttsEngines.map((t) => (
              <option key={t.key} value={t.key} disabled={!t.available}>
                {t.label}{t.available ? "" : ` — ${t.reason ?? "unavailable"}`}
              </option>
            ))}
          </select>
          {ttsProvider && hosts.filter((h) => hostIds.includes(h.id)).map((h) => (
            <div key={h.id} className="hostVoiceRow">
              <span className="hostVoiceName">{h.name}</span>
              <input className="input" placeholder="provider voice id" value={voicePicks[h.id] ?? ""} onChange={(e) => setVoicePicks({ ...voicePicks, [h.id]: e.target.value })} />
            </div>
          ))}
        </div>
      )}

      {/* ---------------- REVIEW ---------------- */}
      {/* Naming the episode is a REVIEW decision. On step one you have not yet
          chosen the topics, so there is nothing to name it after. */}
      {step === "review" && (
        <ReviewStep
          mode={mode} podcast={podcasts.find((p) => p.id === podcastId) ?? null}
          orderedSelected={mode === "automatic" ? [] : orderedSelected} leadTopicId={leadTopicId} targetTopicCount={targetTopicCount}
          hosts={hosts.filter((h) => hostIds.includes(h.id))} ttsProvider={ttsProvider} productionStyle={productionStyle}
          sfxDensity={sfxDensity} title={title} setTitle={setTitle} description={description} setDescription={setDescription}
          estimate={estimate} validation={validation} qualityTier={qualityTier}
          prefs={{ verticals, leagueIds, teams, sport, minDebateScore }}
        />
      )}
      </div>

      {/* ---- ZONE 3: the preview ----
          What you have actually built so far, and the one button that moves it
          forward. Both stay put: the column is sticky and the CTA is pinned to
          the bottom of it, so the primary action occupies the same pixels on
          every step. */}
      <aside className="createPreview" aria-label="Episode so far">
        <div className="createPreviewBody">
          <div className="createPreviewTitle">Episode so far</div>
          <dl className="createPreviewList">
            <dt>Show</dt>
            <dd>{podcastId ? podcasts.find((p) => p.id === podcastId)?.name ?? "Show" : "Standalone"}</dd>
            <dt>Rundown</dt>
            <dd>
              {mode === "automatic" ? (
                <span>{targetTopicCount} chosen at creation</span>
              ) : orderedSelected.length === 0 ? (
                <span className="createPreviewEmpty">Nothing picked yet</span>
              ) : (
                <ol className="createPreviewOrder" data-testid="preview-rundown">
                  {orderedSelected.map((t, i) => (
                    <li key={t.id}>
                      <span className="createPreviewNum">{i + 1}</span>
                      <span className="createPreviewTopic">{t.title}</span>
                    </li>
                  ))}
                  {autoSlots > 0 && <li className="createPreviewAuto">+ {autoSlots} auto-filled</li>}
                </ol>
              )}
            </dd>
            <dt>Hosts</dt>
            <dd>{hosts.filter((h) => hostIds.includes(h.id)).map((h) => h.name).join(" + ") || "Default pairing"}</dd>
            <dt>Runtime</dt>
            <dd>~{estimate.estimatedDurationMinutes} min · ~{estimate.estimatedWords.toLocaleString()} words</dd>
          </dl>

          {/* The cold open, from its INPUTS. This is deliberately not a
              generated script: writing one means calling the script pipeline,
              which this work is not allowed to touch and which costs a real
              model call. What it shows is exactly what the opener will be built
              from, so a weak lead is visible before you pay for it. */}
          {step === "review" && leadPreview && (
            <div className="createColdOpen" data-testid="cold-open-preview">
              <div className="createPreviewTitle">The show opens on</div>
              <p className="createColdOpenTopic">{leadPreview.title}</p>
              {leadPreview.summary && <p className="createColdOpenWhy">{leadPreview.summary}</p>}
              <p className="createColdOpenMeta">
                {leadPreview.evidenceCount} evidence item{leadPreview.evidenceCount === 1 ? "" : "s"} ·{" "}
                {leadPreview.sourceCount} source{leadPreview.sourceCount === 1 ? "" : "s"} · debate {Math.round(leadPreview.debateScore)}
              </p>
              <p className="createColdOpenNote">
                These are the inputs the opener is written from, not the script itself.
              </p>
            </div>
          )}

          {!validation.ok && step !== "show" && (
            <p className="noteWarn createPreviewWarn" role="note">{validation.error}</p>
          )}
        </div>

        <div className="createPreviewCta">
          {step === "review" ? (
            <button
              type="button" data-testid="create-episode" className="btnPrimary u-full"
              onClick={submit} disabled={ctaDisabled} aria-busy={submitting}
            >
              {submitting && <span className="btnSpin" aria-hidden="true" />}
              {submitting ? "Creating…" : "Create episode"}
            </button>
          ) : (
            <button
              type="button" data-testid="step-next" className="btnPrimary u-full"
              onClick={goNext} disabled={ctaDisabled}
            >
              Continue to {STEPS[stepIndex + 1].label.toLowerCase()}
            </button>
          )}
        </div>
      </aside>
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
    <details className="advPanel mt-3" data-testid="auto-prefs" open>
      <summary className="advPanelHead u-clickable">Selection preferences <span className="stageHint">— these steer the {mode} pick (separate from the board filters below)</span></summary>
      <div className="rundownPrefsGrid mt-3">
        <div>
          <div className="fieldLabel">Sport</div>
          <select className="input" data-testid="pref-sport" value={sport} onChange={(e) => setSport(e.target.value)}>
            <option value="">Any</option>
            {sports.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div className="fieldLabel">Min debate score: {minDebateScore === null ? "any" : minDebateScore}</div>
          {/* 0 maps EXPLICITLY to "any" (a ≥0 threshold filters nothing, so
              they are the same query). The old `|| null` coerced every falsy
              value blindly — same wire value, but by accident, and the label
              rendered "0" while the state said null. */}
          <input type="range" min={0} max={100} step={5} value={minDebateScore ?? 0} data-testid="pref-mindebate"
            aria-valuetext={minDebateScore === null ? "any" : String(minDebateScore)}
            onChange={(e) => { const v = Number(e.target.value); setMinDebateScore(v === 0 ? null : v); }} className="u-full" />
        </div>
        {leagues.length > 0 && (
          <div className="u-span">
            <div className="fieldLabel">Leagues</div>
            <div className="segRow u-wrap">
              {leagues.map((l) => <button key={l} type="button" data-testid={`pref-league-${l}`} className={`segBtn${leagueIds.includes(l) ? " on" : ""}`} aria-pressed={leagueIds.includes(l)} onClick={() => toggle(leagueIds, l, setLeagueIds)}>{l}</button>)}
            </div>
          </div>
        )}
        <div className="u-span">
          <div className="fieldLabel">Verticals</div>
          <div className="segRow u-wrap">
            {sports.map((s) => <button key={s} type="button" data-testid={`pref-vertical-${s}`} className={`segBtn${verticals.includes(s) ? " on" : ""}`} aria-pressed={verticals.includes(s)} onClick={() => toggle(verticals, s, setVerticals)}>{s}</button>)}
          </div>
          {podcastScoped && <p className="stageHint">Verticals/teams start inherited from the show; change them to override just this episode.</p>}
        </div>
        <div className="u-span">
          <div className="fieldLabel">Team names (comma-separated)</div>
          <input className="input" data-testid="pref-teams" value={teams.join(", ")} placeholder="e.g. Chiefs, Eagles" onChange={(e) => setTeams(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
        </div>
      </div>
    </details>
  );
}

/* ---------------- Review ---------------- */
function ReviewStep({
  mode, podcast, orderedSelected, leadTopicId, targetTopicCount, hosts, ttsProvider, productionStyle, sfxDensity,
  title, setTitle, description, setDescription, estimate, validation, prefs, qualityTier,
}: {
  mode: Mode; podcast: BuilderPodcast | null; orderedSelected: StudioTopicVM[]; leadTopicId: string | null; targetTopicCount: number;
  hosts: BuilderHost[]; ttsProvider: string; productionStyle: string; sfxDensity: string; qualityTier: QualityTier | null;
  title: string; setTitle: (v: string) => void; description: string; setDescription: (v: string) => void;
  estimate: ReturnType<typeof estimateRundown>; validation: { ok: boolean; error?: string };
  prefs: { verticals: string[]; leagueIds: string[]; teams: string[]; sport: string; minDebateScore: number | null };
}) {
  const autoSlots = mode === "hybrid" ? Math.max(0, targetTopicCount - orderedSelected.length) : mode === "automatic" ? targetTopicCount : 0;
  const lead = leadTopicId && orderedSelected.some((t) => t.id === leadTopicId) ? leadTopicId : orderedSelected[0]?.id;
  const warnings = orderedSelected.filter((t) => t.readiness !== "ready" || t.usedByShowRecent);
  const prefSummary = [prefs.sport && `sport ${prefs.sport}`, prefs.verticals.length && `verticals ${prefs.verticals.join("/")}`, prefs.leagueIds.length && `leagues ${prefs.leagueIds.join("/")}`, prefs.teams.length && `teams ${prefs.teams.join("/")}`, prefs.minDebateScore != null && `min debate ${prefs.minDebateScore}`].filter(Boolean).join(" · ");
  return (
    <div className="studioCard">
      <h2 className="sectionTitle mt-0">Review the rundown</h2>

      {/* Naming happens here, where the rundown is finally visible. */}
      <label className="fieldLabel" htmlFor="epTitle">Episode title <span className="stageHint">(optional)</span></label>
      <input id="epTitle" data-testid="episode-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} placeholder="Auto-generated if left blank" />

      <label className="fieldLabel mt-3" htmlFor="epDesc">Description <span className="stageHint">(optional)</span></label>
      <textarea id="epDesc" data-testid="episode-description" value={description} maxLength={MAX_DESCRIPTION_LEN} rows={3} onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION_LEN))} placeholder="Show notes / summary for this episode" className="input u-resizeY" />
      <div className="stageHint u-right" data-testid="desc-count">{description.length}/{MAX_DESCRIPTION_LEN}</div>

      <dl className="reviewGrid mt-4">
        {description && (<><dt className="fieldLabel">Description</dt><dd data-testid="review-description">{description}</dd></>)}
        <dt className="fieldLabel">Show</dt><dd>{podcast ? podcast.name : "Standalone episode"}</dd>
        <dt className="fieldLabel">Mode</dt><dd className="u-caps" data-testid="review-mode">{mode}</dd>
        <dt className="fieldLabel">Rundown</dt>
        <dd>
          {mode === "automatic" ? <span>{targetTopicCount} topics selected automatically at creation.</span> : (
            <ol className="reviewList" data-testid="review-rundown">
              {orderedSelected.map((t) => (
                <li key={t.id}>{t.id === lead && <span className="chip chipAccent">★ Lead</span>} {t.title}{t.readiness !== "ready" && <span className="noteWarn"> ⚠ {t.readiness.replace("_", " ")}</span>}</li>
              ))}
            </ol>
          )}
          {autoSlots > 0 && <p className="stageHint">+ {autoSlots} auto-selected slot{autoSlots === 1 ? "" : "s"}.</p>}
        </dd>
        {mode !== "manual" && prefSummary && (<><dt className="fieldLabel">Auto preferences</dt><dd data-testid="review-prefs">{prefSummary}</dd></>)}
        <dt className="fieldLabel">Hosts</dt><dd>{hosts.map((h) => h.name).join(" + ") || "Default pairing"}</dd>
        <dt className="fieldLabel">Voice</dt><dd>{ttsProvider || "Host default"}</dd>
        <dt className="fieldLabel">Production</dt><dd>{productionStyle} · {sfxDensity} SFX</dd>
        {/* The review grid summarised every setting that changes how the episode
            SOUNDS and none of the one that decides what it costs. */}
        <dt className="fieldLabel">Writing</dt>
        <dd data-testid="review-tier">
          {qualityTier ? (
            <>
              {tierInfo(qualityTier).label} · {formatTierCost(qualityTier)} · {formatTierDuration(qualityTier)}
              {tierInfo(qualityTier).speedWarning ? <span className="noteWarn"> ⚠ slower tier</span> : null}
            </>
          ) : podcast ? (
            "Inherits this show's tier"
          ) : (
            `${tierInfo(DEFAULT_QUALITY_TIER).label} (default) · ${formatTierCost(DEFAULT_QUALITY_TIER)} · ${formatTierDuration(DEFAULT_QUALITY_TIER)}`
          )}
        </dd>
        <dt className="fieldLabel">Estimate</dt><dd>~{estimate.estimatedDurationMinutes} min · ~{estimate.estimatedWords.toLocaleString()} words · {estimate.estimatedCostUsd !== null ? `~$${estimate.estimatedCostUsd.toFixed(2)}` : "cost provider-dependent"}</dd>
      </dl>
      {warnings.length > 0 && (
        <div role="note" className="noteWarn noteSmall mt-3">
          {warnings.map((t) => <div key={t.id}>⚠ {t.title}: {t.usedByShowRecent ? "recently used by this show" : t.readiness.replace("_", " ")}</div>)}
        </div>
      )}
      {!validation.ok && <p role="alert" className="noteWarn mt-3">{validation.error}</p>}
    </div>
  );
}

/* ---------------- Result (item 13: startDebate error handling) ---------------- */
/**
 * THE LAST SCREEN BEFORE ANY MONEY IS SPENT.
 *
 * "Start the debate" is the button that actually commits an episode to a set of
 * models — nothing before it calls a paid provider. The tier was choosable four
 * steps earlier, on the Production step of a five-step wizard, and then never
 * mentioned again: the rundown, the confirmation copy and the button itself all
 * stayed silent about whether pressing it would cost $1.75 or nothing, and
 * whether it would take three minutes or twelve.
 *
 * That is not a real choice. A setting buried behind a step the user has
 * already walked past is one they will not remember making, and the first time
 * they learn which tier they are on is when the bill or the wait arrives. So
 * the tier is restated HERE, changeable in place (setEpisodeQualityTier accepts
 * it for exactly as long as the episode is still a draft, which is now), with
 * the cost and the duration next to the button that commits to both.
 */
function ResultView({
  result,
  topicsById,
  initialTier,
  inheritsFromShow,
}: {
  result: Extract<CreateResult, { success: true }>;
  topicsById: Map<string, StudioTopicVM>;
  initialTier: QualityTier | null;
  inheritsFromShow: boolean;
}) {
  const reduced = result.finalOrder.length < result.requestedCount;
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [tier, setTier] = useState<QualityTier | null>(initialTier);

  // What the run will ACTUALLY use when nothing was picked. An unchosen tier
  // resolves episode -> podcast -> deployment default at generation time
  // (worker.ts), so the only honest thing to show for a standalone episode is
  // the deployment default itself rather than a blank.
  const effective = tier ?? (inheritsFromShow ? null : DEFAULT_QUALITY_TIER);

  const saveTier = async (next: QualityTier) => {
    if (!result.episodeId) throw new Error("No episode id.");
    const res = await setEpisodeQualityTier(result.episodeId, next);
    // QualityTierPicker renders a thrown message inline; returning quietly on a
    // rejected save would leave the card showing a tier the server never took.
    if (!res.ok) throw new Error(res.error);
    setTier(next);
  };
  const start = async () => {
    setStarting(true); setStartError(null);
    try {
      if (!result.episodeId) throw new Error("No episode id.");
      const res = (await startDebate(result.episodeId)) as { success?: boolean; error?: string };
      if (res && res.success === false) { setStartError(res.error || "Couldn't start the debate."); return; }
      // Stay put and hand over to the live console. The old behaviour was a hard
      // window.location navigation into a server-rendered page that showed no
      // progress — a white flash followed by a static card.
      setStarted(true);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Couldn't start the debate.");
    } finally { setStarting(false); }
  };

  if (started && result.episodeId) {
    return (
      <div className="fadeUp">
        <ProductionConsole episodeId={result.episodeId} offEpisodePage />
      </div>
    );
  }

  return (
    <div className="studioCard">
      {/* "🎬 Episode created" alone read as DONE. Nothing is running at this
          point — the episode is a draft and the studio is waiting for the
          customer to press Start. In the audit run that headline cost 25 minutes
          of watching a static screen for progress that was never coming. The
          heading now names the state, and the line below says what has to happen
          next in the same breath. */}
      <h2 className="sectionTitle mt-0">🎬 Rundown locked — not started yet</h2>
      <div className="createAlert mb-3" role="status" data-testid="not-started-notice">
        <strong>Nothing is generating yet.</strong> Your episode is saved as a draft. Press
        <strong> Start the debate</strong> below to begin writing the script — it takes several minutes
        and runs on our servers, so you can close the tab and come back.
      </div>
      {result.draftCleanupWarning && <div className="createAlert mb-3" role="status" data-testid="draft-warning">{result.draftCleanupWarning}</div>}
      {reduced && (
        <div className="createAlert mb-3" role="status" data-testid="reduced-notice">
          {result.concurrentlyDroppedIds.length > 0
            ? `One or more automatically selected topics became unavailable while the episode was being created. Your episode was created with ${result.finalOrder.length} topic${result.finalOrder.length === 1 ? "" : "s"} instead of ${result.requestedCount}.`
            : `The studio found ${result.finalOrder.length} eligible topic${result.finalOrder.length === 1 ? "" : "s"} (you requested ${result.requestedCount}).`}
        </div>
      )}
      <p className="stageHint">This is the final rundown the studio actually created (from the backend), in order:</p>
      <ol className="reviewList" data-testid="result-final-order">
        {result.finalOrder.map((id, i) => {
          const ref = result.selectedTopics.find((s) => s.id === id);
          return <li key={id} data-testid={`final-${id}`}>{i === 0 && <span className="chip chipAccent">★ Lead</span>} {ref?.title ?? topicsById.get(id)?.title ?? id} {ref && !ref.pinned && <span className="chip">auto</span>}</li>;
        })}
      </ol>
      {result.rejectedTopics.length > 0 && (
        <div role="note" className="noteSmall mt-3">
          <div className="fieldLabel">Not included</div>
          <ul className="createReasons">{result.rejectedTopics.map((r, i) => <li key={i}>{topicsById.get(r.id)?.title ?? r.id}: {r.reason}</li>)}</ul>
        </div>
      )}
      {/* The free-or-paid choice, at the moment it is actually being made. */}
      <div className="mt-4" data-testid="result-tier">
        <QualityTierPicker value={tier} onChange={saveTier} disabled={starting} />
        {tier === null && inheritsFromShow ? (
          <p className="hintText mt-2">Not set for this episode — it will use the show&apos;s tier.</p>
        ) : null}
      </div>

      {startError && <p role="alert" data-testid="start-error" className="noteWarn mt-3">{startError}</p>}

      {/* Cost and wait restated ON the commit, not four steps behind it. The
          free tier's wait is the headline here for the same reason it leads its
          badge: it is the surprise, and this is the last chance to avoid it. */}
      {effective ? (
        <p className="stageHint mt-3" data-testid="start-cost-note">
          Pressing Start writes this episode with <strong>{tierInfo(effective).label}</strong> —{" "}
          {formatTierCost(effective)}, about {formatTierDuration(effective)} before the script is ready.
          {tierInfo(effective).speedWarning ? " That wait is normal for this tier, not a stall." : ""}
        </p>
      ) : null}

      <div className="stageActions mt-4">
        <Link href={`/studio/episodes/${result.episodeId}`} className="btnGhost">Open episode</Link>
        <button type="button" data-testid="start-debate" className="btnPrimary u-mlAuto" disabled={starting} aria-busy={starting} onClick={start}>
          {starting && <span className="btnSpin" aria-hidden="true" />}
          {starting ? "Starting…" : effective ? `Start the debate — ${formatTierCost(effective)} →` : "Start the debate →"}
        </button>
      </div>
    </div>
  );
}

/** Re-scoping the board to another show refetches the topic pool. Hold the
 *  column's shape with take-card placeholders instead of collapsing it to a
 *  line of text, which used to make the whole picker jump. */
function TopicPickerSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading takes" className="skelStack">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="skelBlock">
          <div className="skelRow mb-4">
            <div className="skelChip" />
            <div className="skelChip" style={{ "--skel-w": "60px" } as React.CSSProperties} />
          </div>
          <div className="skelLine" />
          <div className="skelLine skelLine--short" />
        </div>
      ))}
    </div>
  );
}

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
