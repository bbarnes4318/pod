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
  if (input.mode === "automatic" && n > 0) return { ok: false, error: "Automatic mode doesn't take hand-picked topics." };
  if (input.mode === "hybrid" && n === 0) return { ok: false, error: "Hybrid mode needs at least one pinned topic." };
  if (input.mode === "hybrid" && n > input.targetTopicCount) {
    return { ok: false, error: `Pinned topics (${n}) can't exceed the target count (${input.targetTopicCount}).` };
  }
  return { ok: true };
}
