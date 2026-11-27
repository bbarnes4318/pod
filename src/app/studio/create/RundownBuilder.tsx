"use client";

// Episode creation. One rundown (show, stories, hosts, production), three ways
// to build it: AI Producer, Guided and Manual (see ApproachPanels.tsx). Manual
// is the full builder: Show → Topics → Hosts → Production → Review, with
// manual / automatic / hybrid topic selection. Everything is routed through the
// SHARED createEpisodeDraft via createStudioEpisode. Durable cross-session
// resume (autosaved StudioDraft). The backend's finalOrder is the source of truth.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import StudioPageHeader from "../StudioPageHeader";
import {
  getStudioTopics,
  createStudioEpisode,
  saveStudioRundownDraft,
  discardStudioRundownDraft,
} from "../../app/create/actions";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";
import type { RundownDraftState, RundownStep } from "@/lib/services/studioDraft";
import { estimateRundown } from "@/lib/services/episodeEstimate";
import { validateRundownDraft, applyModeChange, submissionSelection } from "@/lib/studio/rundownRules";
import { getShowFormat, listShowFormats, formatBlockedReason } from "@/lib/formats/showFormatRegistry";
import { MAX_HOSTS } from "@/lib/episodeLimits";
// Shared rundown core — the SAME picker/tray Admin uses (src/components/rundown).
import TopicRundownPicker from "@/components/rundown/TopicRundownPicker";
import RundownTray from "@/components/rundown/RundownTray";
import QualityTierPicker from "../QualityTierPicker";
import { DEFAULT_QUALITY_TIER, tierInfo, type QualityTier } from "@/lib/providers/llm/qualityTiers";
import { ApproachChooser, ProducerPanel, GuidedPanel, BusinessHandoff, APPROACHES, type Approach, type BusinessShowEntry, type RundownHandle } from "./ApproachPanels";
import "./create.css";

import { AutoPrefs, ReviewStep, ResultView, TopicPickerSkeleton, topicTitle, buildVoiceOverrides, voicePicksFromOverrides, type Mode, type BuilderPodcast, type BuilderHost, type CreateResult } from "./parts";
export type { BuilderPodcast, BuilderHost } from "./parts";

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


export default function RundownBuilder({
  podcasts, initialTopics, hosts, initialDraft, maxTopics, seedTopicId, seedPodcastId, ttsEngines, businessShows = [],
}: {
  /** The viewer's business shows. They share this front door and are handed
   *  to their own research engine; they never enter the sports rundown. */
  businessShows?: BusinessShowEntry[];
  podcasts: BuilderPodcast[];
  initialTopics: StudioTopicVM[];
  hosts: BuilderHost[];
  initialDraft: RundownDraftState | null;
  maxTopics: number;
  seedTopicId?: string | null;
  /** "New episode" pressed from a show: start inside that show, on Topics. */
  seedPodcastId?: string | null;
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
  // HOW the rundown is being built. A saved draft from before approaches
  // existed was built by hand, so it resumes in Manual; a fresh start opens on
  // AI Producer. `view` says whether the approach's own workspace or one of the
  // five Manual steps is on screen; the rail always opens a Manual step.
  const [approach, setApproach] = useState<Approach>(d?.approach ?? (d || seedTopic ? "manual" : "producer"));
  const [view, setView] = useState<"steps" | "approach">("steps");
  const [objective, setObjective] = useState<string>(d?.objective ?? "");
  const [bizShowId, setBizShowId] = useState<string | null>(null);
  const bizShow = bizShowId ? businessShows.find((b) => b.id === bizShowId) ?? null : null;

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
      approach, objective: objective || null,
      // Persist WHY each value holds what it holds, so a reload can still tell an
      // inherited value from a deliberate override.
      overrides: { hosts: hostSelectionDirty, targetTopicCount: targetCountDirty, selectionPreferences: prefsDirty },
    }),
    [mode, selectedIds, leadTopicId, targetTopicCount, podcastId, formatId, hostIds, ttsProvider, voicePicks, productionStyle, sfxDensity, title, description, verticals, leagueIds, teams, sport, minDebateScore, step, hostSelectionDirty, targetCountDirty, prefsDirty, approach, objective]
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

  // Arriving from a show ("New episode" on its page, or on Home) starts the
  // rundown inside that show with its hosts, length and coverage inherited,
  // and skips the "which show?" step the visitor has already answered.
  // Runs once; a draft already on this show is left exactly as it was.
  const seededShow = useRef(false);
  useEffect(() => {
    if (seededShow.current || !seedPodcastId) return;
    seededShow.current = true;
    if (!podcasts.some((p) => p.id === seedPodcastId)) return;
    // A one-time seed from the URL, applied through the same handler a click
    // uses so inheritance behaves identically.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (podcastId !== seedPodcastId) onSelectPodcast(seedPodcastId);
    setStep((current) => (current === "show" ? "topics" : current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedPodcastId]);

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

  // Host seats, capped at what the pipeline can actually voice (MAX_HOSTS),
  // never at the format's aspirational speakerMax.
  const toggleHost = (id: string) => {
    setHostSelectionDirty(true);
    setHostIds((prev) => prev.includes(id)
      ? (prev.length <= 1 ? prev : prev.filter((x) => x !== id))
      : prev.length < seatCap
        ? [...prev, id]
        : [...prev.slice(0, seatCap - 1), id]);
  };
  // AI Producer and Guided write an explicit, ordered rundown: that is Manual
  // topic selection as far as the server is concerned, so what the proposal
  // shows is exactly what gets created.
  const setRundown = (ids: string[], leadId: string | null) => {
    setModeState("manual");
    setSelectedIds(ids.slice(0, maxTopics));
    setLeadTopicId(leadId);
  };
  const openStep = (next: RundownStep) => { setView("steps"); setStep(next); setError(null); };

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

  const goNext = () => {
    // Leaving the Show step enters the chosen approach's own workspace.
    if (step === "show" && approach !== "manual") { setView("approach"); return; }
    const i = STEPS.findIndex((s) => s.key === step);
    if (i < STEPS.length - 1) setStep(STEPS[i + 1].key);
  };

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
  const inApproach = view === "approach" && !bizShow;
  // In an approach workspace no Manual step is "current": Show is done and the
  // rest are reachable, each showing the value the approach has filled in.
  const railIndex = inApproach ? 0.5 : stepIndex;
  const rundownHandle: RundownHandle = {
    topics, selectedIds, leadTopicId, maxTopics, targetTopicCount,
    setTargetTopicCount: (n) => { setTargetTopicCount(n); setTargetCountDirty(true); },
    setRundown, objective, setObjective,
    showName: activePodcast?.name ?? null,
    hosts, hostIds, toggleHost, productionStyle, setProductionStyle, sfxDensity, setSfxDensity,
    estimateMinutes: estimate.estimatedDurationMinutes,
    openStep,
  };
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
        subtitle={APPROACHES.find((a) => a.key === approach)!.line}
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
            const state = i < railIndex ? "done" : i === railIndex ? "active" : "todo";
            return (
              <li key={s.key}>
                <button
                  type="button"
                  data-testid={`step-${s.key}`}
                  onClick={() => openStep(s.key)}
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
      {!inApproach && step === "show" && (
        <>
          <div className="studioCard mb-3">
            <h2 className="sectionTitle mt-0">Where does this episode live?</h2>
            <p className="stageHint mb-3">A show lends the episode its format, hosts and topic preferences. A standalone episode starts from studio defaults.</p>
            <div className="segRow u-wrap">
              <button type="button" data-testid="podcast-standalone" className={`segBtn${podcastId === null && !bizShow ? " on" : ""}`} aria-pressed={podcastId === null && !bizShow} onClick={() => { setBizShowId(null); onSelectPodcast(null); }}>Standalone episode</button>
              {podcasts.map((p) => (
                <button key={p.id} type="button" data-testid={`podcast-${p.id}`} className={`segBtn${podcastId === p.id && !bizShow ? " on" : ""}`} aria-pressed={podcastId === p.id && !bizShow} onClick={() => { setBizShowId(null); onSelectPodcast(p.id); }}>{p.name}</button>
              ))}
              {/* Business shows use the same front door. Choosing one does not
                  touch the sports rundown; it opens that show's approved research. */}
              {businessShows.map((b) => (
                <button key={b.id} type="button" data-testid={`bizshow-${b.id}`} className={`segBtn${bizShowId === b.id ? " on" : ""}`} aria-pressed={bizShowId === b.id} onClick={() => setBizShowId(b.id)}>
                  {b.name} <span className="approachTag">Business</span>
                </button>
              ))}
            </div>
          </div>
          {bizShow ? (
            <BusinessHandoff show={bizShow} />
          ) : (
            <div className="studioCard">
              <h2 className="sectionTitle mt-0">How do you want to make it?</h2>
              <p className="stageHint mb-3">All three build the same episode and you can switch at any point without losing anything.</p>
              <ApproachChooser value={approach} onChange={setApproach} />
            </div>
          )}
        </>
      )}

      {inApproach && approach === "producer" && <ProducerPanel r={rundownHandle} />}
      {inApproach && approach === "guided" && <GuidedPanel r={rundownHandle} />}

      {/* ---------------- TOPICS ---------------- */}
      {!inApproach && step === "topics" && (
        <div>
          {/* Mode lives WITH the topics it governs. It used to sit on step one,
              where it decided the behaviour of a screen you had not reached. */}
          <p className="stageHint mb-2">
            Picking by hand.{" "}
            <button type="button" className="advLink" data-testid="open-producer" onClick={() => { setApproach("producer"); setView("approach"); }}>Have the studio propose the whole episode</button>
            {" or "}
            <button type="button" className="advLink" data-testid="open-guided" onClick={() => { setApproach("guided"); setView("approach"); }}>be guided through it</button>.
          </p>
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
      {!inApproach && step === "hosts" && (
        <div className="studioCard">
          <h2 className="sectionTitle mt-0">Format and hosts</h2>
          {podcastScoped ? (
            /* A podcast episode INHERITS the show's format server-side, so the
               control must not pretend to change it. Read-only, with the real
               place to change it linked. */
            <p className="stageHint mb-2" data-testid="format-inherited">
              This show uses <strong className="u-strong">{format.displayName}</strong> — change it in{" "}
              <Link href={`/studio/shows/${podcastId}`}>show settings →</Link>
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
                  onClick={() => toggleHost(h.id)}>
                  {on && <strong className="mr-12">{seat + 1}</strong>}{h.name}
                </button>
              );
            })}
            {hosts.length === 0 && <span className="stageHint">No active hosts — <Link href="/studio/hosts">add one →</Link></span>}
          </div>
        </div>
      )}

      {/* ---------------- PRODUCTION ---------------- */}
      {!inApproach && step === "production" && (
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
      {!inApproach && step === "review" && (
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

          {!validation.ok && (inApproach ? selectedIds.length > 0 : step !== "show") && (
            <p className="noteWarn createPreviewWarn" role="note">{validation.error}</p>
          )}
        </div>

        <div className="createPreviewCta">
          {bizShow && step === "show" && !inApproach ? (
            <p className="stageHint">Choose an approved topic to generate this show&apos;s episode.</p>
          ) : inApproach ? (
            <>
              {/* An approach ends at Review: the title is set there and the
                  server's checks run against the same rundown shown here. */}
              <button type="button" data-testid="approach-review" className="btnPrimary u-full" disabled={!validation.ok} onClick={() => openStep("review")}>
                Review and create
              </button>
              <button type="button" className="advLink" onClick={() => openStep("show")}>Change show or approach</button>
            </>
          ) : step === "review" ? (
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
              {step === "show" && approach !== "manual" ? `Start with ${APPROACHES.find((a) => a.key === approach)!.name}` : `Continue to ${STEPS[stepIndex + 1].label.toLowerCase()}`}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
