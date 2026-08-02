"use server";

// Server actions for the blind voice audition console.
//
// Two rules this file exists to enforce:
//   1. NOTHING here returns provider / voiceId / model to the browser except
//      `revealAuditionAction`, which is only legal after a winner is locked and
//      which records that the audition was unblinded.
//   2. `promoteWinnerAction` is the ONLY action that changes a production
//      voice, it requires the operator to re-confirm the winning ballot, and it
//      writes an attributed row that `rollbackPromotionAction` can undo.

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { isTtsProviderId } from "@/lib/providers/tts/providerIds";
import { isVoiceIdValidForProvider } from "@/lib/providers/tts/voiceResolution";
import {
  addCandidate,
  castVote,
  createAudition,
  createPrismaVoiceAuditionStore,
  getBallots,
  listPromotionHistory,
  openVoting,
  promoteWinner,
  revealAudition,
  rollbackPromotion,
  selectWinner,
  tallyAudition,
  VoiceAuditionError,
  type AuditionScores,
  type VoiceAuditionDeps,
  type VoiceAuditionPrismaClient,
} from "@/lib/services/voiceAudition";

// The Prisma delegates are structurally compatible with the narrow port the
// store needs; the cast keeps the service free of a compile-time dependency on
// generated client types.
// Async because every export of a "use server" module must be a server action.
export async function auditionDeps(): Promise<VoiceAuditionDeps> {
  return { store: createPrismaVoiceAuditionStore(db as unknown as VoiceAuditionPrismaClient) };
}

type Fail = { success: false; error: string };

function fail(error: unknown): Fail {
  if (error instanceof VoiceAuditionError) return { success: false, error: error.message };
  return {
    success: false,
    error: error instanceof Error ? error.message : "That didn't work. Try again.",
  };
}

async function requireProducer(): Promise<
  { ok: true; user: { id: string; name: string | null; email: string | null; role: string } } | { ok: false; error: string }
> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "Please sign in to run a voice audition." };
  return { ok: true, user };
}

/** Auditions are owner-scoped exactly like hosts and episodes. */
async function requireOwnedAudition(auditionId: string) {
  const gate = await requireProducer();
  if (!gate.ok) return gate;
  const audition = await (await auditionDeps()).store.getAudition(auditionId);
  if (!audition) return { ok: false as const, error: "That audition no longer exists." };
  if (audition.ownerId && audition.ownerId !== gate.user.id && gate.user.role !== "ADMIN") {
    return { ok: false as const, error: "That audition belongs to another account." };
  }
  return { ok: true as const, user: gate.user, audition };
}

async function requireOwnedHost(hostId: string) {
  const gate = await requireProducer();
  if (!gate.ok) return gate;
  const host = await db.aiHost.findUnique({
    where: { id: hostId },
    select: { id: true, name: true, ownerId: true, ttsProvider: true, ttsVoiceId: true },
  });
  if (!host) return { ok: false as const, error: "That host no longer exists." };
  if (host.ownerId !== null && host.ownerId !== gate.user.id && gate.user.role !== "ADMIN") {
    return { ok: false as const, error: "That host belongs to another account." };
  }
  return { ok: true as const, user: gate.user, host };
}

function actorLabel(user: { name: string | null; email: string | null }): string {
  return user.name || user.email || "unknown operator";
}

function refresh() {
  revalidatePath("/studio/auditions");
}

// ---------------------------------------------------------------------------

export async function createAuditionAction(input: { title: string; hostId: string; notes?: string }) {
  const gate = await requireOwnedHost(input.hostId);
  if (!gate.ok) return { success: false as const, error: gate.error };
  try {
    const audition = await createAudition(await auditionDeps(), {
      ownerId: gate.user.id,
      hostId: gate.host.id,
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
  const gate = await requireOwnedAudition(input.auditionId);
  if (!gate.ok) return { success: false as const, error: gate.error };
  const partner = await requireOwnedHost(input.partnerHostId);
  if (!partner.ok) return { success: false as const, error: partner.error };

  const provider = input.provider.trim().toLowerCase();
  const voiceId = input.voiceId.trim();
  if (!isTtsProviderId(provider)) return { success: false as const, error: "That voice provider is not supported." };
  if (provider !== "stub" && !isVoiceIdValidForProvider(provider, voiceId)) {
    return { success: false as const, error: `That voice id is not valid for ${provider}.` };
  }
  if (!partner.host.ttsVoiceId) {
    return { success: false as const, error: "The scene partner has no voice assigned yet." };
  }

  try {
    const candidate = await addCandidate(await auditionDeps(), {
      auditionId: gate.audition.id,
      provider,
      voiceId,
      model: input.model?.trim() || null,
      privateLabel: input.privateLabel ?? null,
      partner: { provider: partner.host.ttsProvider, voiceId: partner.host.ttsVoiceId },
    });
    refresh();
    // Deliberately NOT returning provider/voiceId — only whether it rendered.
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
  const gate = await requireOwnedAudition(auditionId);
  if (!gate.ok) return { success: false as const, error: gate.error };
  try {
    await openVoting(await auditionDeps(), auditionId);
    refresh();
    return { success: true as const };
  } catch (error) {
    return fail(error);
  }
}

/** The blind read, exposed to the client. Identity is not reachable from here. */
export async function getBallotsAction(auditionId: string) {
  const gate = await requireOwnedAudition(auditionId);
  if (!gate.ok) return { success: false as const, error: gate.error };
  try {
    const deps = await auditionDeps();
    const [ballots, tally] = await Promise.all([
      getBallots(deps, auditionId),
      tallyAudition(deps, auditionId),
    ]);
    return { success: true as const, ballots, tally };
  } catch (error) {
    return fail(error);
  }
}

export async function castVoteAction(input: {
  auditionId: string;
  ballotId: string;
  scores: Partial<AuditionScores>;
  overall: number;
  notes?: string;
}) {
  const gate = await requireOwnedAudition(input.auditionId);
  if (!gate.ok) return { success: false as const, error: gate.error };
  try {
    const deps = await auditionDeps();
    await castVote(deps, {
      auditionId: input.auditionId,
      ballotId: input.ballotId,
      voterId: gate.user.id,
      voterLabel: actorLabel(gate.user),
      scores: input.scores,
      overall: input.overall,
      notes: input.notes ?? null,
    });
    const tally = await tallyAudition(deps, input.auditionId);
    refresh();
    return { success: true as const, tally };
  } catch (error) {
    return fail(error);
  }
}

/** Records the decision. Changes no production voice — see promoteWinnerAction. */
export async function selectWinnerAction(input: { auditionId: string; ballotId: string }) {
  const gate = await requireOwnedAudition(input.auditionId);
  if (!gate.ok) return { success: false as const, error: gate.error };
  try {
    await selectWinner(await auditionDeps(), {
      auditionId: input.auditionId,
      ballotId: input.ballotId,
      actorId: gate.user.id,
    });
    refresh();
    return { success: true as const };
  } catch (error) {
    return fail(error);
  }
}

export async function revealAuditionAction(auditionId: string) {
  const gate = await requireOwnedAudition(auditionId);
  if (!gate.ok) return { success: false as const, error: gate.error };
  try {
    const revealed = await revealAudition(await auditionDeps(), { auditionId, actorId: gate.user.id });
    refresh();
    return { success: true as const, candidates: revealed.candidates };
  } catch (error) {
    return fail(error);
  }
}

/**
 * The only writer of a production voice in this feature. Requires the operator
 * to restate the winning ballot id — a re-render or a stray click cannot
 * promote anything.
 */
export async function promoteWinnerAction(input: {
  auditionId: string;
  acknowledgedBallotId: string;
  hostId?: string;
  reason?: string;
}) {
  const gate = await requireOwnedAudition(input.auditionId);
  if (!gate.ok) return { success: false as const, error: gate.error };
  const hostId = input.hostId || gate.audition.hostId || "";
  const host = await requireOwnedHost(hostId);
  if (!host.ok) return { success: false as const, error: host.error };
  try {
    const { promotion } = await promoteWinner(await auditionDeps(), {
      auditionId: input.auditionId,
      hostId: host.host.id,
      acknowledgedBallotId: input.acknowledgedBallotId,
      actorId: gate.user.id,
      actorLabel: actorLabel(gate.user),
      reason: input.reason ?? null,
    });
    refresh();
    revalidatePath("/studio/hosts");
    return { success: true as const, promotionId: promotion.id };
  } catch (error) {
    return fail(error);
  }
}

export async function rollbackPromotionAction(input: { promotionId: string; reason?: string }) {
  const gate = await requireProducer();
  if (!gate.ok) return { success: false as const, error: gate.error };
  const deps = await auditionDeps();
  const promotion = await deps.store.getPromotion(input.promotionId);
  if (!promotion) return { success: false as const, error: "That promotion is not in the history." };
  const host = await requireOwnedHost(promotion.hostId);
  if (!host.ok) return { success: false as const, error: host.error };
  try {
    const result = await rollbackPromotion(deps, {
      promotionId: input.promotionId,
      actorId: gate.user.id,
      actorLabel: actorLabel(gate.user),
      reason: input.reason ?? null,
    });
    refresh();
    revalidatePath("/studio/hosts");
    return {
      success: true as const,
      alreadyRolledBack: result.alreadyRolledBack,
      restoredVoiceId: result.restored?.voiceId ?? null,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function promotionHistoryAction(hostId?: string) {
  const gate = await requireProducer();
  if (!gate.ok) return { success: false as const, error: gate.error };
  try {
    return { success: true as const, promotions: await listPromotionHistory(await auditionDeps(), hostId) };
  } catch (error) {
    return fail(error);
  }
}
