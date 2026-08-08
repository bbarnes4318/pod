"use server";

// The Studio-side remedy for an editorial hold.
//
// The guard's error message has always ended "A human must review it in Studio
// and record an explicit release." That sentence described a screen that did
// not exist: no component wrote `humanRelease`, so the only two ways past a
// hold were editing the database by hand or regenerating the script and hoping
// for a better verdict. Clicking Approve did not help — approval writes
// `Script.status`, which the gate never reads.

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/currentUser";
import { canViewOwned } from "@/lib/ownerScope";
import { recordHumanRelease, revokeHumanRelease } from "@/lib/services/scriptRelease";
import { queueTtsSegmentGenerationJob } from "@/lib/queue/podcastQueue";
import type { ScriptEditorialDecision } from "@/lib/services/scriptEditorialGate";

type Fail = { success: false; error: string };

async function ownedLatestScript(
  episodeId: string
): Promise<Fail | { success: true; scriptId: string; approvedBy: string }> {
  const user = await currentUser();
  if (!user) return { success: false, error: "Please sign in to do that." };
  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    select: { id: true, ownerId: true, scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true } } },
  });
  if (!episode) return { success: false, error: "That episode no longer exists." };
  if (!canViewOwned(user, episode)) return { success: false, error: "That episode belongs to someone else." };
  const scriptId = episode.scripts[0]?.id;
  if (!scriptId) return { success: false, error: "This episode has no script to release." };
  // Attribution must identify a person. Falling back to the opaque user id is
  // still attributable; "operator" would not be.
  return { success: true, scriptId, approvedBy: user.email || user.name || user.id };
}

/**
 * Record an attributable release from editorial hold, and — unless the caller
 * opts out — immediately resume the step the hold was blocking.
 *
 * `expectedDecision` is the verdict the panel rendered. If the script has been
 * re-evaluated since, the release is refused rather than applied to a verdict
 * the operator never read.
 */
export async function releaseScriptFromEditorialHold(
  episodeId: string,
  opts?: { expectedDecision?: ScriptEditorialDecision | "unknown"; note?: string; resumeVoices?: boolean }
) {
  const gate = await ownedLatestScript(episodeId);
  if (!gate.success) return gate;

  const result = await recordHumanRelease({
    scriptId: gate.scriptId,
    approvedBy: gate.approvedBy,
    expectedDecision: opts?.expectedDecision,
    note: opts?.note,
  });
  if (!result.success) return { success: false as const, error: result.error };

  // Recording the release without restarting anything would leave the operator
  // looking at an unchanged page, which is how this felt broken in the first
  // place. Not forceRegenerate: already-voiced lines are kept.
  let resumed = false;
  if (opts?.resumeVoices !== false) {
    try {
      await queueTtsSegmentGenerationJob({ scriptId: gate.scriptId });
      resumed = true;
    } catch (err) {
      // The release itself succeeded and is durable; report the queue failure
      // separately rather than implying nothing happened.
      return {
        success: true as const,
        released: true,
        resumed: false,
        releasedBy: result.record.approvedBy,
        warning: err instanceof Error ? err.message : "Released, but couldn't start voicing.",
      };
    }
  }

  revalidatePath(`/studio/episodes/${episodeId}`);
  return {
    success: true as const,
    released: true,
    resumed,
    releasedBy: result.record.approvedBy,
    wasBlocked: result.wasBlocked,
  };
}

/** Put a released script back under the gate. */
export async function revokeScriptEditorialRelease(episodeId: string) {
  const gate = await ownedLatestScript(episodeId);
  if (!gate.success) return gate;
  const res = await revokeHumanRelease(gate.scriptId);
  if (!res.success) return { success: false as const, error: res.error || "Couldn't revoke the release." };
  revalidatePath(`/studio/episodes/${episodeId}`);
  return { success: true as const };
}
