"use server";

// Server actions for the blind voice audition console.
//
// Three rules this file exists to enforce:
//   1. NOTHING here returns provider / voiceId / model to the browser except
//      `revealAuditionAction`, which is only legal after a winner is locked and
//      which records that the audition was unblinded.
//   2. `promoteWinnerAction` is the ONLY action that changes a production
//      voice, it requires the operator to re-confirm the winning ballot, and it
//      writes an attributed row that `rollbackPromotionAction` can undo.
//   3. EVERY id that arrives from the browser — auditionId, hostId,
//      partnerHostId, ballotId, promotionId — is resolved through an ownership
//      guard BEFORE it is used, and a row you do not own answers exactly like a
//      row that does not exist.
//
// The guards themselves live in `voiceAudition.ts` (guarded* / authorize*) so
// that they can be executed against the in-memory store in
// `src/scripts/testVoiceAuditionAuthz.ts`. This module is the thin, session-
// resolving edge: it turns a cookie into an `AuditionViewer` and translates the
// service's AuthzResult into the `{ success }` shape the console expects.

import { revalidatePath } from "next/cache";
import { isTtsProviderId } from "@/lib/providers/tts/providerIds";
import { isVoiceIdValidForProvider } from "@/lib/providers/tts/voiceResolution";
import {
  addCandidate,
  authorizeAudition,
  authorizeHost,
  createAudition,
  guardedCastVote,
  guardedGetBallots,
  guardedOpenVoting,
  guardedPromote,
  guardedPromotionHistory,
  guardedReveal,
  guardedRollback,
  guardedSelectWinner,
  redactVoiceSecrets,
  VoiceAuditionError,
  type AuditionScores,
  type AuthzResult,
} from "@/lib/services/voiceAudition";
import { auditionDeps, auditionViewer } from "./store";

type Fail = { success: false; error: string };

function fail(error: unknown): Fail {
  if (error instanceof VoiceAuditionError) {
    return { success: false, error: redactVoiceSecrets(error.message) };
  }
  return {
    success: false,
    error: redactVoiceSecrets(
      error instanceof Error ? error.message : "That didn't work. Try again."
    ),
  };
}

/** AuthzResult -> the console's `{ success }` envelope. */
function refused<T>(result: Extract<AuthzResult<T>, { ok: false }>): Fail {
  return { success: false, error: result.error };
}

function refresh() {
  revalidatePath("/studio/auditions");
}

// ---------------------------------------------------------------------------

export async function createAuditionAction(input: { title: string; hostId: string; notes?: string }) {
  const deps = auditionDeps();
  const viewer = await auditionViewer();
  // You may only run an audition for a host you own. A shared/system host
  // (ownerId === null) is operator-only, exactly like every other write to it.
  const host = await authorizeHost(deps, viewer, input.hostId);
  if (!host.ok) return refused(host);
  try {
    const audition = await createAudition(deps, {
      ownerId: viewer!.id,
      hostId: host.value.id,
      title: input.title,
      notes: input.notes ?? null,
    });
    refresh();
    return { success: true as const, auditionId: audition.id };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Render ONE candidate. The client adds candidates one at a time so a
 * seven-minute render never sits inside a single opaque request, and so a
 * provider failure only costs that candidate.
 */
export async function addCandidateAction(input: {
  auditionId: string;
  provider: string;
  voiceId: string;
  model?: string;
  privateLabel?: string;
  partnerHostId: string;
}) {
  const deps = auditionDeps();
  const viewer = await auditionViewer();
  const gate = await authorizeAudition(deps, viewer, input.auditionId);
  if (!gate.ok) return refused(gate);
  const partner = await authorizeHost(deps, viewer, input.partnerHostId);
  if (!partner.ok) return refused(partner);

  const provider = input.provider.trim().toLowerCase();
  const voiceId = input.voiceId.trim();
  if (!isTtsProviderId(provider)) return { success: false as const, error: "That voice provider is not supported." };
  if (provider !== "stub" && !isVoiceIdValidForProvider(provider, voiceId)) {
    // Deliberately does not echo the provider back: validation messages are a
    // favourite way for an engine name to escape into a screenshot.
    return { success: false as const, error: "That voice id is not valid for the provider you chose." };
  }
  if (!partner.value.voiceId) {
    return { success: false as const, error: "The scene partner has no voice assigned yet." };
  }

  try {
    const candidate = await addCandidate(deps, {
      auditionId: gate.value.id,
      provider,
      voiceId,
      model: input.model?.trim() || null,
      privateLabel: input.privateLabel ?? null,
      partner: { provider: partner.value.provider, voiceId: partner.value.voiceId },
    });
    refresh();
    // Deliberately NOT returning provider/voiceId — only whether it rendered.
    // `renderError` was redacted of engine identity before it was stored.
    return {
      success: true as const,
      rendered: !candidate.renderError,
      problem: candidate.renderError,
      durationSec: candidate.durationMs ? Math.round(candidate.durationMs / 1000) : null,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function openVotingAction(auditionId: string) {
  const result = await guardedOpenVoting(auditionDeps(), await auditionViewer(), auditionId);
  if (!result.ok) return refused(result);
  refresh();
  return { success: true as const };
}

/** The blind read, exposed to the client. Identity is not reachable from here. */
export async function getBallotsAction(auditionId: string) {
  const result = await guardedGetBallots(auditionDeps(), await auditionViewer(), auditionId);
  if (!result.ok) return refused(result);
  return { success: true as const, ballots: result.value.ballots, tally: result.value.tally };
}

export async function castVoteAction(input: {
  auditionId: string;
  ballotId: string;
  scores: Partial<AuditionScores>;
  overall: number;
  notes?: string;
}) {
  const result = await guardedCastVote(auditionDeps(), await auditionViewer(), {
    auditionId: input.auditionId,
    ballotId: input.ballotId,
    scores: input.scores,
    overall: input.overall,
    notes: input.notes ?? null,
  });
  if (!result.ok) return refused(result);
  refresh();
  return { success: true as const, tally: result.value };
}

/** Records the decision. Changes no production voice — see promoteWinnerAction. */
export async function selectWinnerAction(input: { auditionId: string; ballotId: string }) {
  const result = await guardedSelectWinner(auditionDeps(), await auditionViewer(), input);
  if (!result.ok) return refused(result);
  refresh();
  return { success: true as const };
}

export async function revealAuditionAction(auditionId: string) {
  const result = await guardedReveal(auditionDeps(), await auditionViewer(), auditionId);
  if (!result.ok) return refused(result);
  refresh();
  return { success: true as const, candidates: result.value };
}

/**
 * The only writer of a production voice in this feature. Requires the operator
 * to restate the winning ballot id — a re-render or a stray click cannot
 * promote anything — and requires them to own BOTH the audition and the host.
 */
export async function promoteWinnerAction(input: {
  auditionId: string;
  acknowledgedBallotId: string;
  hostId?: string;
  reason?: string;
}) {
  const result = await guardedPromote(auditionDeps(), await auditionViewer(), input);
  if (!result.ok) return refused(result);
  refresh();
  revalidatePath("/studio/hosts");
  return { success: true as const, promotionId: result.value.promotionId };
}

export async function rollbackPromotionAction(input: { promotionId: string; reason?: string }) {
  const result = await guardedRollback(auditionDeps(), await auditionViewer(), input);
  if (!result.ok) return refused(result);
  refresh();
  revalidatePath("/studio/hosts");
  // The restored voice id stays on the server. The operator asked to undo a
  // change; naming the engine identity here would put it in the browser.
  return {
    success: true as const,
    alreadyRolledBack: result.value.alreadyRolledBack,
    hostName: result.value.hostName,
  };
}

/**
 * With no hostId this is "the voice changes on hosts YOU own", scoped by the
 * query. It used to be "every voice change on the deployment".
 */
export async function promotionHistoryAction(hostId?: string) {
  const result = await guardedPromotionHistory(auditionDeps(), await auditionViewer(), hostId);
  if (!result.ok) return refused(result);
  return { success: true as const, promotions: result.value };
}
