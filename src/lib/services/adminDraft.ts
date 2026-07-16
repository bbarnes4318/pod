// Durable, cross-session resume state for the ADMIN multi-topic rundown builder.
//
// Same purpose and same rules as the Studio draft — this is PRE-generation
// editor state, never an episode, and it is cleared once the episode exists.
// It deliberately reuses the SHARED rundown shape + refinement from
// studioDraft.ts, so Admin and Studio validate a rundown identically; the only
// additions are the two ADMIN-authority fields Studio has no business storing.
//
// WHY A SEPARATE TABLE (and not StudioDraft):
// StudioDraft.ownerId is a REQUIRED foreign key to User(id). The /admin surface
// authenticates with HTTP Basic Auth against env vars (adminIdentity()) and has
// NO User row, so an admin draft could never satisfy that FK. The safe,
// non-destructive choice is a parallel AdminDraft table keyed by the audited
// admin identity string — rather than weakening Studio's FK or fabricating a
// synthetic User row to point at.

import { z } from "zod";
import { db } from "../db";
import { RundownDraftShape, refineRundownDraft } from "./studioDraft";

/** The DB surface the admin draft helpers touch — satisfied by PrismaClient and
 *  the in-memory test doubles, so no `any` is needed at call sites. */
export interface AdminDraftDb {
  adminDraft: {
    findUnique: (args: unknown) => Promise<{ state: unknown } | null>;
    upsert: (args: unknown) => Promise<unknown>;
    deleteMany: (args: unknown) => Promise<unknown>;
  };
}

export const AdminRundownDraftStateSchema = z
  .object({
    ...RundownDraftShape,
    // ---- ADMIN AUTHORITY (absent from the Studio draft by design) ----
    // The operator's decision to permit a recently-used topic the
    // exclude_podcast policy would otherwise block. Persisting it is what makes
    // the decision survive a resume; it is NOT what authorizes it — the server
    // re-checks requireAdmin() on every mutation, and the shared creation core
    // strips the override for any non-admin actor.
    reuseOverride: z.boolean().default(false),
    reuseOverrideReason: z.string().trim().max(500).nullable().optional(),
  })
  .superRefine(refineRundownDraft);

export type AdminRundownDraftState = z.infer<typeof AdminRundownDraftStateSchema>;

/** Load + validate an operator's saved rundown draft. Returns null when there is
 *  no draft OR the stored blob no longer validates (fail-open to a fresh
 *  builder), matching the Studio draft's behaviour exactly. */
export async function loadAdminDraft(
  adminId: string,
  dbi: AdminDraftDb = db as unknown as AdminDraftDb
): Promise<AdminRundownDraftState | null> {
  const row = await dbi.adminDraft.findUnique({ where: { adminId } });
  if (!row) return null;
  const parsed = AdminRundownDraftStateSchema.safeParse(row.state);
  return parsed.success ? parsed.data : null;
}

/** Upsert an operator's rundown draft. Validated before persistence so a
 *  malformed payload can never poison the resume record. */
export async function saveAdminDraft(
  adminId: string,
  state: unknown,
  dbi: AdminDraftDb = db as unknown as AdminDraftDb
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = AdminRundownDraftStateSchema.safeParse(state);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message || "Invalid draft state." };
  }
  const value = parsed.data as unknown as object;
  await dbi.adminDraft.upsert({
    where: { adminId },
    create: { adminId, state: value },
    update: { state: value },
  });
  return { ok: true };
}

/** Remove an operator's rundown draft (after the episode is created, or on discard). */
export async function clearAdminDraft(
  adminId: string,
  dbi: AdminDraftDb = db as unknown as AdminDraftDb
): Promise<void> {
  await dbi.adminDraft.deleteMany({ where: { adminId } });
}
