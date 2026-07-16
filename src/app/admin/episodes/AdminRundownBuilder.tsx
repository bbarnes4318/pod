"use client";

// The Admin multi-topic rundown builder.
//
// This renders the SAME shared components Studio renders
// (src/components/rundown) and applies the SAME shared rules
// (src/lib/studio/rundownRules), against topics carrying the SAME shared
// eligibility contract. There is no Admin copy of the topic card, the tray, the
// ordering logic, or the eligibility rules — the only Admin additions are the
// authorized ACTIONS passed into the picker's extension point, and they are
// re-authorized server-side on every call.
//
// Manual    — the operator picks every topic and the exact order.
// Automatic — the operator sets preferences + a target; the shared backend picks.
// Hybrid    — the operator pins topics; the backend fills the remaining slots.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import TopicRundownPicker, { type TopicCardAction } from "@/components/rundown/TopicRundownPicker";
import RundownTray from "@/components/rundown/RundownTray";
import CustomTopicPanel from "./CustomTopicPanel";
import type { StudioTopicVM } from "@/lib/services/studioTopicPool";
import { PLATFORM_MAX_TOPICS } from "@/lib/episodeLimits";
import { applyModeChange, validateRundownDraft, dedupeIds, type RundownMode } from "@/lib/studio/rundownRules";
import { estimateRundown } from "@/lib/services/episodeEstimate";
import { REUSE_OVERRIDE_CONFIRMATION } from "@/lib/reuseOverride";
import {
  fetchAdminRundownTopics,
  createAdminRundownEpisode,
  resumeAdminRundownDraft,
  saveAdminRundownDraft,
  discardAdminRundownDraft,
  approveTopicFromRundown,
  requestResearchFromRundown,
} from "./rundownActions";
import type { ChangedSelection } from "@/lib/services/adminRundown";

interface CreateOutcome {
  episodeId: string;
  finalOrder: string[];
  autoSelectedTopicIds: string[];
  reasons: string[];
  requestedCount: number;
  reuseOverrideApplied: boolean;
  draftCleanupWarning?: string;
}

export default function AdminRundownBuilder({ onCreated }: { onCreated?: () => void }) {
  const [mode, setMode] = useState<RundownMode>("manual");
  const [topics, setTopics] = useState<StudioTopicVM[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [leadTopicId, setLeadTopicId] = useState<string | null>(null);
  const [targetTopicCount, setTargetTopicCount] = useState(3);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Automatic/Hybrid backend SELECTION preferences (distinct from the picker's
  // board display filters — these actually steer the shared selector).
  const [sport, setSport] = useState("");
  const [minDebateScore, setMinDebateScore] = useState<number | "">("");

  const [reuseOverride, setReuseOverride] = useState(false);
  const [reuseOverrideReason, setReuseOverrideReason] = useState("");

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pendingActionIds, setPendingActionIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [live, setLive] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [changed, setChanged] = useState<ChangedSelection[]>([]);
  const [outcome, setOutcome] = useState<CreateOutcome | null>(null);

  const maxTopics = PLATFORM_MAX_TOPICS;
  const byId = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);
  const trayItems = useMemo(
    () => selectedIds.map((id) => byId.get(id)).filter((t): t is StudioTopicVM => !!t),
    [selectedIds, byId]
  );
  const estimate = useMemo(
    () => estimateRundown({ topicCount: mode === "automatic" ? targetTopicCount : Math.max(trayItems.length, mode === "hybrid" ? targetTopicCount : trayItems.length) }),
    [mode, targetTopicCount, trayItems.length]
  );

  // ---- Resume: restore the saved rundown and re-evaluate what changed -------
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await resumeAdminRundownDraft();
      if (!alive) return;
      if (!res.success) {
        setError(res.error);
        setLoading(false);
        return;
      }
      setTopics(res.topics);
      setTruncated(res.truncated);
      setChanged(res.changedSelections);
      if (res.draft) {
        const d = res.draft;
        setMode(d.mode);
        setSelectedIds(d.selectedTopicIds);
        setLeadTopicId(d.leadTopicId ?? null);
        setTargetTopicCount(d.targetTopicCount);
        setTitle(d.title ?? "");
        setDescription(d.description ?? "");
        setSport(d.sport ?? "");
        setMinDebateScore(d.minDebateScore ?? "");
        setReuseOverride(d.reuseOverride);
        setReuseOverrideReason(d.reuseOverrideReason ?? "");
        setNote("Restored your saved rundown.");
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const reloadTopics = useCallback(async (selected: string[]) => {
    const res = await fetchAdminRundownTopics({ selectedTopicIds: selected });
    if (res.success) {
      setTopics(res.topics);
      setTruncated(res.truncated);
    }
  }, []);

  // ---- Durable save (debounced) --------------------------------------------
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipFirstSave = useRef(true);
  useEffect(() => {
    if (loading) return;
    if (skipFirstSave.current) {
      skipFirstSave.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveAdminRundownDraft({
        mode,
        selectedTopicIds: selectedIds,
        leadTopicId,
        targetTopicCount,
        title: title || null,
        description: description || null,
        sport: sport || null,
        minDebateScore: minDebateScore === "" ? null : minDebateScore,
        reuseOverride,
        reuseOverrideReason: reuseOverrideReason || null,
        activeStep: "topics",
      });
    }, 600);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [loading, mode, selectedIds, leadTopicId, targetTopicCount, title, description, sport, minDebateScore, reuseOverride, reuseOverrideReason]);

  // ---- Rundown edits (shared rules) ----------------------------------------
  const changeMode = (next: RundownMode) => {
    const r = applyModeChange({ mode, selectedTopicIds: selectedIds, leadTopicId, targetTopicCount }, next, maxTopics);
    setMode(next);
    setSelectedIds(r.selectedTopicIds);
    setLeadTopicId(r.leadTopicId);
    setTargetTopicCount(r.targetTopicCount);
    setNote(r.note ?? null);
    setOutcome(null);
  };

  const toggleTopic = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        if (leadTopicId === id) setLeadTopicId(null);
        setLive(`${byId.get(id)?.title ?? "Topic"} removed from the rundown.`);
        return prev.filter((x) => x !== id);
      }
      if (prev.length >= maxTopics) {
        setLive(`The platform maximum is ${maxTopics} topics.`);
        setNote(`No more than ${maxTopics} topics per episode.`);
        return prev;
      }
      if (mode === "hybrid" && prev.length >= targetTopicCount) {
        setLive(`All ${targetTopicCount} slots are pinned. Raise the target to pin more.`);
        setNote(`Hybrid: pinned topics can't exceed the target count (${targetTopicCount}).`);
        return prev;
      }
      setLive(`${byId.get(id)?.title ?? "Topic"} added to the rundown.`);
      return dedupeIds([...prev, id]);
    });
    setOutcome(null);
  };

  const reorder = (from: number, to: number) => {
    setSelectedIds((prev) => {
      const next = [...prev];
      const [m] = next.splice(from, 1);
      next.splice(to, 0, m);
      setLive(`${byId.get(m)?.title ?? "Topic"} moved to position ${to + 1}.`);
      return next;
    });
  };

  const removeTopic = (id: string) => {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
    if (leadTopicId === id) setLeadTopicId(null);
    setChanged((prev) => prev.filter((c) => c.topicId !== id));
    setLive(`${byId.get(id)?.title ?? "Topic"} removed from the rundown.`);
  };

  const setLead = (id: string) => {
    setLeadTopicId(id);
    setLive(`${byId.get(id)?.title ?? "Topic"} is now the lead story.`);
  };

  // ---- Authorized Admin actions (server re-checks every one) ---------------
  const runAction = async (id: string, fn: () => Promise<{ success: boolean; error?: string }>, okMsg: string) => {
    setPendingActionIds((p) => [...p, id]);
    setError(null);
    try {
      const res = await fn();
      if (!res.success) {
        setError(res.error || "That action failed.");
        setLive(res.error || "That action failed.");
      } else {
        setNote(okMsg);
        setLive(okMsg);
        await reloadTopics(selectedIds);
      }
    } finally {
      setPendingActionIds((p) => p.filter((x) => x !== id));
    }
  };

  const cardActions = (t: StudioTopicVM): TopicCardAction[] => [
    { code: "approve", label: "Approve", run: (id) => runAction(id, () => approveTopicFromRundown(id), `Approved “${t.title}”.`) },
    { code: "research", label: "Start research", run: (id) => runAction(id, () => requestResearchFromRundown(id, false), `Research queued for “${t.title}”.`) },
    {
      code: "regenerate_research",
      label: "Regenerate research",
      run: (id) => runAction(id, () => requestResearchFromRundown(id, true), `Research regeneration queued for “${t.title}”.`),
    },
  ];

  // ---- Create ---------------------------------------------------------------
  const validation = validateRundownDraft({ mode, selectedTopicIds: selectedIds, targetTopicCount, maxTopics });
  const blockedSelected = trayItems.filter((t) => !t.eligibility.manuallySelectable && !(reuseOverride && t.eligibility.blockingReasons.every((r) => r.code === "reuse_policy_blocked")));

  const create = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    setOutcome(null);
    try {
      if (reuseOverride && !confirm(REUSE_OVERRIDE_CONFIRMATION)) {
        setBusy(false);
        return;
      }
      const res = await createAdminRundownEpisode(
        {
          mode,
          selectedTopicIds: mode === "automatic" ? [] : selectedIds,
          leadTopicId: mode === "automatic" ? null : leadTopicId,
          targetTopicCount,
          title: title || undefined,
          description: description || undefined,
          sport: sport || undefined,
          minDebateScore: minDebateScore === "" ? undefined : Number(minDebateScore),
          reuseOverride: reuseOverride || undefined,
        },
        { reuseOverrideReason: reuseOverrideReason || undefined }
      );
      if (!res.success) {
        setError(res.error);
        setLive(`Couldn't create the episode: ${res.error}`);
        return;
      }
      setOutcome({
        episodeId: res.episodeId,
        finalOrder: res.finalOrder,
        autoSelectedTopicIds: res.autoSelectedTopicIds,
        reasons: res.reasons,
        requestedCount: res.requestedCount,
        reuseOverrideApplied: res.reuseOverrideApplied,
        draftCleanupWarning: res.draftCleanupWarning,
      });
      setSelectedIds([]);
      setLeadTopicId(null);
      setChanged([]);
      setLive("Episode created.");
      onCreated?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const discard = async () => {
    // Clear LOCALLY FIRST, then tell the server. Awaiting the round-trip before
    // clearing means anything the operator picks while it's in flight gets
    // silently wiped when the response lands — their work disappearing a beat
    // after they did it. Clearing first makes the discard immediate and keeps
    // any later pick, because the pick applies to already-empty state.
    setSelectedIds([]);
    setLeadTopicId(null);
    setChanged([]);
    setOutcome(null);
    setNote("Draft discarded.");
    try {
      await discardAdminRundownDraft();
    } catch (err) {
      setError(`The draft couldn't be discarded on the server: ${(err as Error).message}`);
    }
  };

  if (loading) {
    return (
      <div className="studioCard" data-testid="admin-rundown-loading" role="status" aria-live="polite" style={{ padding: "1rem" }}>
        Loading the topic board…
      </div>
    );
  }

  return (
    <div data-testid="admin-rundown">
      {/* The BUILDER's announcements (selection, ordering, actions). The custom
          topic panel owns a separate region for its own outcomes — two widgets,
          two live regions, so an announcement from one never clobbers the other. */}
      <div aria-live="polite" data-testid="live-region" className="srOnly" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {live}
      </div>

      {/* -------- Mode -------- */}
      <div className="studioCard" style={{ padding: "0.85rem 1rem", marginBottom: "0.8rem" }}>
        <div className="sectionHead" style={{ marginTop: 0 }}>
          <h2 className="sectionTitle" style={{ margin: 0 }}>Rundown</h2>
        </div>
        <div role="radiogroup" aria-label="Rundown mode" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          {(["manual", "automatic", "hybrid"] as RundownMode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              data-testid={`mode-${m}`}
              className={mode === m ? "btnPrimary" : "btnGhost"}
              onClick={() => changeMode(m)}
            >
              {m === "manual" ? "Manual" : m === "automatic" ? "Automatic" : "Hybrid"}
            </button>
          ))}
        </div>
        <p className="stageHint" style={{ marginBottom: 0 }} data-testid="mode-hint">
          {mode === "manual"
            ? "You choose every topic and the exact order."
            : mode === "automatic"
            ? "You set the preferences and target; the platform picks the topics."
            : "You pin the topics that matter; the platform fills the remaining slots."}
        </p>
      </div>

      {/* -------- Changed-eligibility banner (never silently dropped) -------- */}
      {changed.length > 0 && (
        <div className="studioCard" role="alert" data-testid="changed-eligibility" style={{ padding: "0.85rem 1rem", marginBottom: "0.8rem", borderColor: "var(--warning-color, #b45309)" }}>
          <strong>Some topics changed while this draft was saved.</strong>
          <p className="stageHint" style={{ marginTop: "0.25rem" }}>
            They are still in your rundown — nothing was removed for you. Decide explicitly.
          </p>
          <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>
            {changed.map((c) => (
              <li key={c.topicId} data-testid={`changed-${c.topicId}`} data-code={c.blockingReasons[0]?.code} style={{ fontSize: "0.82rem" }}>
                {c.title}: {c.blockingReasons[0]?.message ?? "no longer selectable"}{" "}
                <button type="button" className="advLink" data-testid={`changed-remove-${c.topicId}`} onClick={() => removeTopic(c.topicId)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Custom topic + URL ingestion. A created topic lands on the board via
          the SAME shared eligibility contract as everything else — it is never
          auto-selected, and it shows its real blocking reason. */}
      <CustomTopicPanel
        onCreated={async () => {
          await reloadTopics(selectedIds);
          setNote("Custom topic created — pending approval. Find it on the board below.");
          setLive("Custom topic created and pending approval.");
        }}
      />

      {note && <p className="stageHint" role="note" data-testid="builder-note">{note}</p>}
      {error && <p role="alert" data-testid="builder-error" style={{ color: "var(--error-color, #b91c1c)" }}>{error}</p>}

      <div className="adminRundownLayout">
        {/* -------- Board -------- */}
        <section aria-label="Topic board">
          {truncated && (
            <p className="stageHint" role="note" data-testid="board-truncated">
              Showing the most recent topics only — narrow the search to find older ones.
            </p>
          )}
          <TopicRundownPicker
            topics={topics}
            selectedIds={selectedIds}
            onToggle={toggleTopic}
            selectionDisabled={mode === "automatic"}
            announce={setLive}
            cardActions={cardActions}
            pendingActionIds={pendingActionIds}
          />
        </section>

        {/* -------- Tray + settings -------- */}
        <aside style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
          <RundownTray
            items={trayItems}
            leadTopicId={leadTopicId}
            maxTopics={maxTopics}
            mode={mode}
            targetTopicCount={targetTopicCount}
            estimate={estimate}
            onReorder={reorder}
            onRemove={removeTopic}
            onSetLead={setLead}
          />

          <div className="studioCard" style={{ padding: "0.85rem 1rem" }}>
            <label className="fieldLabel" htmlFor="adminTargetCount">Target topics</label>
            <input
              id="adminTargetCount"
              data-testid="target-count"
              className="input"
              type="number"
              min={1}
              max={maxTopics}
              value={targetTopicCount}
              onChange={(e) => setTargetTopicCount(Math.max(1, Math.min(maxTopics, Number(e.target.value) || 1)))}
            />

            {mode !== "manual" && (
              <>
                <label className="fieldLabel" htmlFor="adminSport" style={{ marginTop: "0.6rem" }}>Sport preference</label>
                <input id="adminSport" data-testid="pref-sport" className="input" value={sport} onChange={(e) => setSport(e.target.value)} placeholder="Any" />
                <label className="fieldLabel" htmlFor="adminMinScore" style={{ marginTop: "0.6rem" }}>Minimum debate score</label>
                <input
                  id="adminMinScore"
                  data-testid="pref-min-score"
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={minDebateScore}
                  onChange={(e) => setMinDebateScore(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder="Platform default"
                />
                <p className="stageHint" style={{ marginBottom: 0 }}>
                  Applies to what the platform picks automatically — it never hides a topic from the board.
                </p>
              </>
            )}

            <label className="fieldLabel" htmlFor="adminTitle" style={{ marginTop: "0.6rem" }}>Title (optional)</label>
            <input id="adminTitle" data-testid="episode-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
            <label className="fieldLabel" htmlFor="adminDesc" style={{ marginTop: "0.6rem" }}>Description (optional)</label>
            <textarea id="adminDesc" data-testid="episode-description" className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          {/* -------- Admin reuse override -------- */}
          <div className="studioCard" style={{ padding: "0.85rem 1rem" }}>
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start" }}>
              <input type="checkbox" data-testid="reuse-override" checked={reuseOverride} onChange={(e) => setReuseOverride(e.target.checked)} style={{ marginTop: 4 }} />
              <span>
                <strong>Allow recently-used topics</strong>
                <span className="stageHint" style={{ display: "block" }}>
                  Admin-only. Permits a pinned topic the show&apos;s reuse policy would block. Audited.
                </span>
              </span>
            </label>
            {reuseOverride && (
              <input
                className="input"
                data-testid="reuse-override-reason"
                style={{ marginTop: "0.5rem" }}
                placeholder="Reason (recorded in the audit log)"
                value={reuseOverrideReason}
                onChange={(e) => setReuseOverrideReason(e.target.value)}
              />
            )}
          </div>

          {!validation.ok && <p role="alert" data-testid="validation-error" style={{ color: "var(--error-color, #b91c1c)", fontSize: "0.82rem" }}>{validation.error}</p>}
          {blockedSelected.length > 0 && (
            <p role="alert" data-testid="blocked-selected" style={{ color: "var(--warning-color, #b45309)", fontSize: "0.82rem" }}>
              {blockedSelected.length} selected topic{blockedSelected.length === 1 ? " is" : "s are"} blocked — resolve or remove before creating.
            </p>
          )}

          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button type="button" className="btnPrimary" data-testid="create-episode" disabled={busy || !validation.ok} onClick={create}>
              {busy ? "Creating…" : "Create episode"}
            </button>
            <button type="button" className="btnGhost" data-testid="discard-draft" disabled={busy} onClick={discard}>
              Discard draft
            </button>
          </div>
        </aside>
      </div>

      {/* -------- Result: the BACKEND's final order, never the optimistic one -------- */}
      {outcome && (
        <div className="studioCard" data-testid="create-result" style={{ padding: "0.85rem 1rem", marginTop: "0.8rem" }}>
          <h3 className="sectionTitle" style={{ marginTop: 0 }}>Episode created</h3>
          <ol data-testid="result-final-order" style={{ margin: "0.4rem 0", paddingLeft: "1.1rem" }}>
            {outcome.finalOrder.map((id) => {
              const t = byId.get(id);
              const auto = outcome.autoSelectedTopicIds.includes(id);
              return (
                <li key={id} data-testid={`final-${id}`} style={{ fontSize: "0.85rem" }}>
                  {t?.title ?? id} {auto && <span className="chip" data-testid={`auto-${id}`}>auto-filled</span>}
                </li>
              );
            })}
          </ol>
          {outcome.finalOrder.length < outcome.requestedCount && (
            <p role="note" data-testid="reduced-notice" style={{ color: "var(--warning-color, #b45309)", fontSize: "0.82rem" }}>
              ⚠ Only {outcome.finalOrder.length} of {outcome.requestedCount} requested topics qualified. Nothing unrelated was substituted.
            </p>
          )}
          {outcome.reuseOverrideApplied && (
            <p role="note" data-testid="override-applied" style={{ fontSize: "0.82rem" }}>
              Reuse override applied and recorded in the audit log.
            </p>
          )}
          {outcome.draftCleanupWarning && (
            <p role="alert" data-testid="draft-cleanup-warning" style={{ color: "var(--warning-color, #b45309)", fontSize: "0.82rem" }}>
              {outcome.draftCleanupWarning}
            </p>
          )}
          {outcome.reasons.length > 0 && (
            <details data-testid="selection-reasons">
              <summary style={{ cursor: "pointer", fontSize: "0.82rem" }}>Why these topics?</summary>
              <ul className="briefPoints">
                {outcome.reasons.map((r, i) => (
                  <li key={i} style={{ fontSize: "0.78rem" }}>{r}</li>
                ))}
              </ul>
            </details>
          )}
          <a className="advLink" data-testid="open-episode" href={`/admin/episodes/${outcome.episodeId}`}>Open episode</a>
        </div>
      )}
    </div>
  );
}
