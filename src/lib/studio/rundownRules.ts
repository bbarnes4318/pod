// Pure, client-safe rundown helpers shared by the Studio builder (UI pre-checks)
// and the createStudioEpisode server action (ordering). NO server imports, so it
// runs in the browser too.
//
// NOTE: this is NOT a second backend validation service — the AUTHORITATIVE
// validation is CreateEpisodeDraftInputSchema in episodeCreation.ts, which the
// server always re-runs. `validateRundownDraft` is a UX pre-check that mirrors
// those same rules so the Create button reflects them before submission.

export type RundownMode = "manual" | "automatic" | "hybrid";

/** Dedupe ids preserving first-seen order (matches createEpisodeDraft). */
export function dedupeIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Move the lead-story topic to the front, preserving the order of the rest. */
export function leadFirst(ids: string[], leadId?: string | null): string[] {
  if (!leadId || !ids.includes(leadId)) return ids;
  return [leadId, ...ids.filter((id) => id !== leadId)];
}

export interface ModeSelection {
  selectedTopicIds: string[];
  leadTopicId: string | null;
  targetTopicCount: number;
}
export interface ModeChangeResult extends ModeSelection {
  /** Human note when the transition adjusted something (e.g. clamped target). */
  note?: string;
}

/**
 * Pure selection transition when the producer changes mode.
 *
 * NON-DESTRUCTIVE: picks are never deleted by a mode switch. Entering
 * Automatic KEEPS the hand-picked topics in state — the UI greys them and the
 * submit path strips them (createStudioEpisode sends [] in automatic), so they
 * never leak into an automatic creation, but flipping back to Manual/Hybrid
 * restores exactly what the producer had. Mode switching used to empty the
 * selection both entering and leaving Automatic with no confirm and no undo.
 */
export function applyModeChange(prev: ModeSelection & { mode: RundownMode }, next: RundownMode, maxTopics: number): ModeChangeResult {
  if (next === prev.mode) return { ...prev };
  const kept = prev.selectedTopicIds;
  const lead = prev.leadTopicId && kept.includes(prev.leadTopicId) ? prev.leadTopicId : null;
  // Entering Automatic: keep picks (inactive), note what happened to them.
  if (next === "automatic") {
    return {
      selectedTopicIds: kept,
      leadTopicId: lead,
      targetTopicCount: prev.targetTopicCount,
      note: kept.length > 0 ? `Your ${kept.length} pick${kept.length === 1 ? "" : "s"} are kept for Manual/Hybrid — Automatic ignores them.` : undefined,
    };
  }
  // Leaving Automatic, or Manual ↔ Hybrid: picks come back live; clamp the
  // Hybrid target so it can never sit below the pinned count.
  if (next === "hybrid" && prev.targetTopicCount < kept.length) {
    const targetTopicCount = Math.min(maxTopics, kept.length);
    return { selectedTopicIds: kept, leadTopicId: lead, targetTopicCount, note: `Target count raised to ${targetTopicCount} so it isn't below your ${kept.length} pinned topics.` };
  }
  return { selectedTopicIds: kept, leadTopicId: lead, targetTopicCount: prev.targetTopicCount };
}

export interface RundownValidationInput {
  mode: RundownMode;
  selectedTopicIds: string[];
  targetTopicCount: number;
  maxTopics: number;
}

/** UX pre-check mirroring CreateEpisodeDraftInputSchema's mode rules. */
export function validateRundownDraft(input: RundownValidationInput): { ok: boolean; error?: string } {
  const n = dedupeIds(input.selectedTopicIds).length;
  if (input.selectedTopicIds.length > input.maxTopics) {
    return { ok: false, error: `No more than ${input.maxTopics} topics per episode.` };
  }
  if (input.mode === "manual" && n === 0) return { ok: false, error: "Manual mode needs at least one topic." };
  // Automatic: kept picks are inactive (the submit path strips them), so their
  // presence is not an error — they're just not part of this creation.
  if (input.mode === "hybrid" && n === 0) return { ok: false, error: "Hybrid mode needs at least one pinned topic." };
  if (input.mode === "hybrid" && n > input.targetTopicCount) {
    return { ok: false, error: `Pinned topics (${n}) can't exceed the target count (${input.targetTopicCount}).` };
  }
  return { ok: true };
}
