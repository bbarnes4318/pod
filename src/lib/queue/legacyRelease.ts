// Durable legacy release for the editorial-gate rollout.
//
// WHAT WAS WRONG. The first rollout policy was a pure function that returned
// "grandfathered: true" and a reason saying the script was "allowed once".
// Nothing was written down. The same pre-cutover script was therefore
// re-grandfathered at every queue boundary it touched (tts, stitch, assets) and
// again after every worker restart, forever. "Allowed once" was simply false.
//
// WHAT IT IS NOW. A release is a row with a UNIQUE constraint on scriptId, so
// "one decision per script" is a database invariant rather than a claim. The row
// records who released it, what the policy compared, and exactly which
// downstream stages the release permits. Restarting the worker changes nothing,
// because the decision is not in memory.
//
// SCOPE. A release is NOT a blanket pass. It names the stages it permits. The
// default system release covers the remaining production chain for an episode
// that was already in flight when enforcement landed — and nothing else.

import type { RolloutDecision } from "./rolloutPolicy";

/**
 * The production chain a script already in flight needs in order to finish.
 * Anything outside this list requires a real verdict, not a compatibility
 * allowance.
 */
export const DEFAULT_LEGACY_RELEASE_STAGES = [
  "tts:generate-segments",
  "audio:stitch-final",
  "content:generate-assets",
] as const;

/** The actor recorded for the automatic compatibility path. Never a person. */
export const SYSTEM_ROLLOUT_ACTOR = "system:editorial-gate-rollout";

export interface LegacyReleaseRecord {
  id: string;
  scriptId: string;
  scriptCreatedAt: Date;
  cutoverAt: Date;
  reason: string;
  actorKind: string;
  actorId: string | null;
  permittedStages: string[];
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

export interface LegacyReleaseStore {
  find(scriptId: string): Promise<LegacyReleaseRecord | null>;
  /**
   * Create the release, or return the existing one. MUST be idempotent on
   * scriptId — concurrent queue boundaries race here by design, and the unique
   * constraint is what makes exactly one row win.
   */
  create(input: {
    scriptId: string;
    scriptCreatedAt: Date;
    cutoverAt: Date;
    reason: string;
    actorKind: string;
    actorId: string | null;
    permittedStages: string[];
  }): Promise<LegacyReleaseRecord>;
  revoke(scriptId: string, revokedBy: string, reason: string): Promise<LegacyReleaseRecord | null>;
  count(): Promise<number>;
}

export const prismaLegacyReleaseStore: LegacyReleaseStore = {
  async find(scriptId) {
    const { db } = await import("../db");
    return db.scriptLegacyRelease.findUnique({ where: { scriptId } });
  },
  async create(input) {
    const { db } = await import("../db");
    // Idempotent by construction: two workers reaching this at the same moment
    // both end up pointing at the same row rather than minting two releases.
    return db.scriptLegacyRelease.upsert({
      where: { scriptId: input.scriptId },
      update: {},
      create: {
        scriptId: input.scriptId,
        scriptCreatedAt: input.scriptCreatedAt,
        cutoverAt: input.cutoverAt,
        reason: input.reason,
        actorKind: input.actorKind,
        actorId: input.actorId,
        permittedStages: [...input.permittedStages],
      },
    });
  },
  async revoke(scriptId, revokedBy, reason) {
    const { db } = await import("../db");
    const existing = await db.scriptLegacyRelease.findUnique({ where: { scriptId } });
    if (!existing || existing.revokedAt) return existing;
    return db.scriptLegacyRelease.update({
      where: { scriptId },
      data: { revokedAt: new Date(), revokedBy, revokedReason: reason },
    });
  },
  async count() {
    const { db } = await import("../db");
    return db.scriptLegacyRelease.count();
  },
};

/** In-memory store for offline tests. Enforces the same uniqueness invariant. */
export function createInMemoryLegacyReleaseStore(): LegacyReleaseStore & { rows: Map<string, LegacyReleaseRecord> } {
  const rows = new Map<string, LegacyReleaseRecord>();
  let seq = 0;
  return {
    rows,
    async find(scriptId) {
      return rows.get(scriptId) ?? null;
    },
    async create(input) {
      const existing = rows.get(input.scriptId);
      if (existing) return existing;
      const row: LegacyReleaseRecord = {
        id: `rel_${++seq}`,
        scriptId: input.scriptId,
        scriptCreatedAt: input.scriptCreatedAt,
        cutoverAt: input.cutoverAt,
        reason: input.reason,
        actorKind: input.actorKind,
        actorId: input.actorId,
        permittedStages: [...input.permittedStages],
        createdAt: new Date(),
        revokedAt: null,
        revokedBy: null,
        revokedReason: null,
      };
      rows.set(input.scriptId, row);
      return row;
    },
    async revoke(scriptId, revokedBy, reason) {
      const row = rows.get(scriptId);
      if (!row || row.revokedAt) return row ?? null;
      row.revokedAt = new Date();
      row.revokedBy = revokedBy;
      row.revokedReason = reason;
      return row;
    },
    async count() {
      return rows.size;
    },
  };
}

let activeStore: LegacyReleaseStore = prismaLegacyReleaseStore;

export function __setLegacyReleaseStoreForTests(store: LegacyReleaseStore | null): void {
  activeStore = store ?? prismaLegacyReleaseStore;
}

export function legacyReleaseStore(): LegacyReleaseStore {
  return activeStore;
}

export type LegacyReleaseOutcome =
  | { allowed: true; record: LegacyReleaseRecord; created: boolean }
  | { allowed: false; reason: string; record?: LegacyReleaseRecord };

/**
 * Resolve the durable release for a script that the gate could not clear.
 *
 * `decision` must already have established that the script is UNMEASURED and
 * predates the cutover — this function does not re-decide eligibility, it makes
 * the decision durable and checks the requested stage against its scope.
 */
export async function resolveLegacyRelease(
  scriptId: string,
  stage: string,
  decision: RolloutDecision
): Promise<LegacyReleaseOutcome> {
  const store = legacyReleaseStore();
  const existing = await store.find(scriptId);

  if (existing) {
    if (existing.revokedAt) {
      return {
        allowed: false,
        reason:
          `A legacy release for this script was revoked at ${existing.revokedAt.toISOString()}` +
          `${existing.revokedBy ? ` by ${existing.revokedBy}` : ""}` +
          `${existing.revokedReason ? `: ${existing.revokedReason}` : "."} ` +
          `Re-evaluate the script to give it a real verdict.`,
        record: existing,
      };
    }
    if (!existing.permittedStages.includes(stage)) {
      return {
        allowed: false,
        reason:
          `The legacy release for this script permits ${existing.permittedStages.join(", ")} ` +
          `but not ${stage}. A compatibility release is scoped, not a blanket pass.`,
        record: existing,
      };
    }
    return { allowed: true, record: existing, created: false };
  }

  // Eligibility was decided upstream; refuse to invent one here.
  if (!decision.grandfathered || !decision.scriptCreatedAt || !decision.cutoverAt) {
    return { allowed: false, reason: decision.reason };
  }
  if (!(DEFAULT_LEGACY_RELEASE_STAGES as readonly string[]).includes(stage)) {
    return {
      allowed: false,
      reason:
        `${stage} is outside the default legacy release scope ` +
        `(${DEFAULT_LEGACY_RELEASE_STAGES.join(", ")}), so no release will be created for it.`,
    };
  }

  const record = await store.create({
    scriptId,
    scriptCreatedAt: new Date(decision.scriptCreatedAt),
    cutoverAt: new Date(decision.cutoverAt),
    reason: decision.reason,
    actorKind: "system",
    actorId: SYSTEM_ROLLOUT_ACTOR,
    permittedStages: [...DEFAULT_LEGACY_RELEASE_STAGES],
  });
  return { allowed: true, record, created: true };
}
