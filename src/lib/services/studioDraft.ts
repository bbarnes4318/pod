// Durable, cross-session resume state for the Studio multi-topic rundown BUILDER.
//
// This is PRE-generation editor state (mode, selected topics + order, lead
// story, target count, podcast, hosts, production settings, title/description,
// active step) persisted server-side so a producer can close the tab or switch
// machines and resume with nothing lost. It is NOT an episode and NEVER holds a
// generated episode's immutable topic snapshots — once the episode is created
// the draft is cleared. Parsing is fail-open: a corrupt/legacy blob resumes as
// "no draft" (a fresh builder) rather than crashing the page.

import { z } from "zod";
import { db } from "../db";

/** The DB surface the draft helpers touch — satisfied by PrismaClient and the
 *  in-memory test doubles, so no `any` is needed at call sites. */
export interface StudioDraftDb {
  studioDraft: {
    findUnique: (args: unknown) => Promise<{ state: unknown } | null>;
    upsert: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
}

export const RUNDOWN_STEPS = ["show", "topics", "hosts", "production", "review"] as const;
export type RundownStep = (typeof RUNDOWN_STEPS)[number];

export const RundownDraftStateSchema = z.object({
  mode: z.enum(["manual", "automatic", "hybrid"]),
  selectedTopicIds: z.array(z.string().min(1)).default([]),
  leadTopicId: z.string().min(1).nullable().optional(),
  targetTopicCount: z.number().int().min(1).max(24).default(3),
  podcastId: z.string().min(1).nullable().optional(),
  hostIds: z.array(z.string().min(1)).default([]),
  ttsProvider: z.string().min(1).nullable().optional(),
  ttsVoiceOverrides: z.unknown().optional(),
  productionStyle: z.string().min(1).nullable().optional(),
  sfxDensity: z.string().min(1).nullable().optional(),
  title: z.string().max(200).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  activeStep: z.enum(RUNDOWN_STEPS).default("show"),
});

export type RundownDraftState = z.infer<typeof RundownDraftStateSchema>;

/** Load + validate a user's saved rundown draft. Returns null when there is no
 *  draft OR the stored blob no longer validates (fail-open to a fresh builder). */
export async function loadStudioDraft(
  ownerId: string,
  dbi: StudioDraftDb = db as unknown as StudioDraftDb
): Promise<RundownDraftState | null> {
  const row = await dbi.studioDraft.findUnique({ where: { ownerId } });
  if (!row) return null;
  const parsed = RundownDraftStateSchema.safeParse(row.state);
  return parsed.success ? parsed.data : null;
}

/** Upsert a user's rundown draft. The state is validated before persistence so a
 *  malformed client payload can never poison the resume record. */
export async function saveStudioDraft(
  ownerId: string,
  state: unknown,
  dbi: StudioDraftDb = db as unknown as StudioDraftDb
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = RundownDraftStateSchema.safeParse(state);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || "Invalid draft state." };
  }
  const value = parsed.data as unknown as object;
  await dbi.studioDraft.upsert({
    where: { ownerId },
    create: { ownerId, state: value },
    update: { state: value },
  });
  return { ok: true };
}

/** Remove a user's rundown draft (after the episode is created, or on discard). */
export async function clearStudioDraft(
  ownerId: string,
  dbi: StudioDraftDb = db as unknown as StudioDraftDb
): Promise<void> {
  await dbi.studioDraft.deleteMany({ where: { ownerId } });
}
