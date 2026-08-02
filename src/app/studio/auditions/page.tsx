import React from "react";
import { db } from "@/lib/db";
import { ownerScope } from "@/lib/ownerScope";
import {
  AUDITION_SCENES,
  AUDITION_PACK_VERSION,
  validateAuditionPack,
} from "@/lib/services/voiceAuditionScenes";
import {
  blindLabelFor,
  getBallots,
  guardedListAuditions,
  guardedPromotionHistory,
  tallyAudition,
  type AuditionScores,
} from "@/lib/services/voiceAudition";
import { auditionDeps, auditionViewer } from "./store";
import AuditionConsole, {
  type AuditionVM,
  type HostOptionVM,
  type PromotionVM,
} from "./AuditionConsole";

export const dynamic = "force-dynamic";

export default async function AuditionsPage() {
  // Server components serialize their props into the HTML, so everything below
  // is scoped by the QUERY. Nothing is fetched broadly and narrowed in the JSX:
  // narrowing in the component still ships the wide result to the browser.
  const viewer = await auditionViewer();
  const deps = auditionDeps();

  const hosts = await db.aiHost.findMany({
    // `ownerScope` is the app-wide rule: operators see everything (including
    // legacy/system ownerId=null rows), everyone else sees strictly their own.
    // Signed out matches nothing.
    where: { ...ownerScope(viewer), isArchived: false },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, ttsProvider: true, ttsVoiceId: true, ownerId: true },
  });
  const hostOptions: HostOptionVM[] = hosts.map((host) => ({
    id: host.id,
    name: host.name,
    hasVoice: /^[0-9a-f]{32}$/i.test(host.ttsVoiceId || ""),
    ownedByMe: !!viewer && host.ownerId === viewer.id,
  }));
  const hostNameById = new Map(hosts.map((host) => [host.id, host.name]));

  const auditionsResult = await guardedListAuditions(deps, viewer);
  const auditions = auditionsResult.ok ? auditionsResult.value : [];

  const vms: AuditionVM[] = await Promise.all(
    auditions.map(async (audition) => {
      // listCandidates carries identity, so it stays on the server. It is used
      // here only to map this voter's own candidate-keyed votes back onto
      // ballot ids, and to count how many are still to be entered.
      const candidates = await deps.store.listCandidates(audition.id);
      const ballotIdByCandidate = new Map(candidates.map((candidate) => [candidate.id, candidate.ballotId]));

      const ballots = audition.status === "draft" ? [] : await getBallots(deps, audition.id);
      const tally = audition.status === "draft" ? [] : await tallyAudition(deps, audition.id);

      // Scoped to this viewer in the query — the console only ever renders
      // "your scores", so other panelists' ballots never leave the database.
      const votes = viewer ? await deps.store.listVotes(audition.id, viewer.id) : [];
      const myVotes: Record<string, { scores: AuditionScores; overall: number; notes: string | null }> = {};
      for (const vote of votes) {
        const ballotId = ballotIdByCandidate.get(vote.candidateId);
        if (ballotId) myVotes[ballotId] = { scores: vote.scores, overall: vote.overall, notes: vote.notes };
      }

      const winnerBallotId = audition.winnerCandidateId
        ? ballotIdByCandidate.get(audition.winnerCandidateId) ?? null
        : null;

      // Identity is only ever attached once the audition has been unblinded.
      const revealed = audition.unblindedAt
        ? candidates
            .slice()
            .sort((left, right) => left.blindPosition - right.blindPosition)
            .map((candidate) => ({
              ballotId: candidate.ballotId,
              blindLabel: blindLabelFor(candidate.blindPosition),
              privateLabel: candidate.privateLabel,
              provider: candidate.provider,
              voiceId: candidate.voiceId,
              model: candidate.model,
              performanceScore: candidate.metrics?.performanceScore ?? null,
              loudnessRangeLu: candidate.metrics?.loudnessRangeLu ?? null,
              durationSec: candidate.durationMs ? Math.round(candidate.durationMs / 1000) : null,
              isWinner: candidate.id === audition.winnerCandidateId,
            }))
        : null;

      return {
        id: audition.id,
        title: audition.title,
        notes: audition.notes,
        status: audition.status,
        hostId: audition.hostId,
        hostName: audition.hostId ? hostNameById.get(audition.hostId) ?? "(host removed)" : "—",
        packVersion: audition.packVersion,
        policyVersion: audition.policyVersion,
        createdAt: audition.createdAt.toISOString(),
        candidateCount: candidates.length,
        // Draft-only, and producer-authored — never an engine identity.
        draftEntries:
          audition.status === "draft"
            ? candidates.map((candidate, index) => ({
                label: candidate.privateLabel || `Entry ${index + 1}`,
                rendered: !!candidate.audioAssetUrl && !candidate.renderError,
                problem: candidate.renderError,
              }))
            : null,
        ballots,
        tally,
        myVotes,
        winnerBallotId,
        winnerSelectedAt: audition.winnerSelectedAt?.toISOString() ?? null,
        unblinded: !!audition.unblindedAt,
        revealed,
      };
    })
  );

  // Owner-scoped in the query (hosts you own; everything for an operator) and
  // projected to a summary that carries no provider, voice id or model.
  const historyResult = await guardedPromotionHistory(deps, viewer);
  const promotions: PromotionVM[] = (historyResult.ok ? historyResult.value : []).map((promotion) => ({
    id: promotion.id,
    kind: promotion.kind,
    status: promotion.status,
    hostId: promotion.hostId,
    hostName: hostNameById.get(promotion.hostId) ?? "(host removed)",
    auditionId: promotion.auditionId,
    actorLabel: promotion.actorLabel || "unknown operator",
    reason: promotion.reason,
    createdAt: promotion.createdAt,
    rolledBackAt: promotion.rolledBackAt,
    revertsPromotionId: promotion.revertsPromotionId,
    canRollback: promotion.canRollback,
  }));

  const pack = validateAuditionPack();

  return (
    <AuditionConsole
      hosts={hostOptions}
      auditions={vms}
      promotions={promotions}
      pack={{
        version: AUDITION_PACK_VERSION,
        sceneCount: AUDITION_SCENES.length,
        scenes: AUDITION_SCENES.map((scene) => ({
          id: scene.id,
          title: scene.title,
          listenFor: scene.listenFor,
        })),
        totalWords: pack.totalWords,
        estimatedMinutes: Number((pack.estimatedDurationSec / 60).toFixed(1)),
      }}
      signedIn={!!viewer}
    />
  );
}
