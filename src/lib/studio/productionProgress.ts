// Pure decision layer for the production console.
//
// Everything that decides WHAT the user is told lives here — which stage is
// active, which failed, whether the pipeline is stalled, which progress
// affordance is honest — as one pure function over a snapshot of the pipeline.
// The DB reads live in services/createProgress.ts and do nothing but assemble
// that snapshot. Splitting them keeps the rules testable without a database
// (see scripts/testProductionProgress.ts).
//
// No server-only or client-only code here: the console imports these types.

import { PRODUCTION_STAGES, productionStageForStatus, productionStageIndex } from "@/lib/createFlow";

export type StageState = "done" | "active" | "todo" | "failed" | "checkpoint";

/** What a stage's JobLog row looks like, reduced to what the rules need. */
export interface StageJobSnapshot {
  status: string; // running | completed | completed_with_errors | failed
  error: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface VoicingProgress {
  done: number;
  /** null = no honest denominator exists (scene mode plans scenes as it goes). */
  total: number | null;
  failed: number;
  unit: string;
}

export interface ProgressStageVM {
  key: string;
  label: string;
  blurb: string;
  state: StageState;
  /** Real ms: running-so-far for the active stage, total for a finished one. */
  elapsedMs: number | null;
  /** Median of recent completed runs of this job. null = not enough history. */
  typicalMs: number | null;
  /** Real sub-progress. Only ever non-null for `voices`. */
  progress: VoicingProgress | null;
  error: string | null;
}

export interface DeriveInput {
  status: string | null | undefined;
  hasScript: boolean;
  nowMs: number;
  /** Episode.updatedAt — the "last time anything moved" clock for stall detection. */
  episodeUpdatedAtMs: number;
  /** Latest JobLog per stage key. */
  jobs: Map<string, StageJobSnapshot>;
  voicing: VoicingProgress | null;
  /** Median duration per JobLog.jobType. */
  typicalMsByJobType: Map<string, number>;
  /** EpisodeAudioRender.startedAt when a mix is currently running. */
  mixStartedAtMs: number | null;
  /** EpisodeAudioRender.failureReason when the latest mix failed. */
  mixFailureReason: string | null;
}

export interface DeriveResult {
  stage: string;
  stages: ProgressStageVM[];
  failure: { stage: string; label: string; message: string; atIso: string } | null;
  stalled: boolean;
  awaitingUser: boolean;
  done: boolean;
  headline: string;
  pollAfterMs: number;
}

/** A stage with no running job and no movement for this long reads as stalled. */
export const STALL_AFTER_MS = 4 * 60 * 1000;

/**
 * Turn an engineer-facing failure string into something a creator can act on.
 * JobLog.error and EpisodeAudioRender.failureReason are already scrubbed of
 * URLs/keys by their writers, so the fallback safely passes the text through
 * (trimmed) rather than hiding a problem behind a generic apology.
 */
export function humanFailure(raw: string | null | undefined): string {
  const msg = (raw || "").trim();
  if (!msg) return "This step failed. Retry it, or open the ops console for the full log.";
  const low = msg.toLowerCase();
  if (low.includes("insufficient_credit") || low.includes("402")) {
    return "The voice provider rejected the request for billing reasons — top up the account and retry.";
  }
  if (low.includes("rate limit") || low.includes("429")) {
    return "The provider rate-limited this job. Waiting a moment and retrying usually clears it.";
  }
  if (low.includes("timeout") || low.includes("etimedout")) {
    return "The step timed out waiting on an upstream provider. Retrying is safe.";
  }
  return msg.length > 220 ? `${msg.slice(0, 217)}…` : msg;
}

export function deriveProduction(input: DeriveInput): DeriveResult {
  const { status, hasScript, nowMs, jobs, typicalMsByJobType } = input;

  const activeKey = productionStageForStatus(status, hasScript);
  const done = activeKey === "done";
  const activeIdx = done ? PRODUCTION_STAGES.length : productionStageIndex(activeKey);

  const stages: ProgressStageVM[] = PRODUCTION_STAGES.map((stage, idx) => {
    const job = jobs.get(stage.key);
    const typicalMs = stage.jobType ? typicalMsByJobType.get(stage.jobType) ?? null : null;

    let state: StageState = idx < activeIdx ? "done" : idx === activeIdx ? "active" : "todo";
    let elapsedMs: number | null = null;
    let error: string | null = null;

    if (state === "done" && job && job.status !== "running") {
      elapsedMs = job.updatedAtMs - job.createdAtMs;
    }

    if (state === "active") {
      if (stage.checkpoint) {
        // Waiting on the human, not on a worker — never show a busy affordance.
        state = "checkpoint";
      } else if (job?.status === "running") {
        elapsedMs = nowMs - job.createdAtMs;
      } else if (stage.key === "mix" && input.mixStartedAtMs !== null) {
        elapsedMs = nowMs - input.mixStartedAtMs;
      }

      // The JobLog is authoritative for failure. Episode.status can't be: the
      // worker rolls it BACK on failure rather than writing "failed", so a dead
      // episode is indistinguishable from one that never started this stage.
      const mixFailed = stage.key === "mix" && !!input.mixFailureReason;
      if (job?.status === "failed" || mixFailed) {
        state = "failed";
        error = humanFailure(mixFailed ? input.mixFailureReason : job?.error);
        if (job) elapsedMs = job.updatedAtMs - job.createdAtMs;
      }
    }

    return {
      key: stage.key,
      label: stage.label,
      blurb: stage.blurb,
      state,
      elapsedMs,
      typicalMs,
      // Voicing is the ONLY stage the pipeline reports incrementally, so it is
      // the only stage that may carry a counted progress value.
      progress: stage.key === "voices" && (state === "active" || state === "failed") ? input.voicing : null,
      error,
    };
  });

  const activeStage = stages.find((s) => s.state === "active" || s.state === "failed" || s.state === "checkpoint");
  const awaitingUser = activeStage?.state === "checkpoint";

  const failedStage = stages.find((s) => s.state === "failed");
  const failure = failedStage
    ? {
        stage: failedStage.key,
        label: failedStage.label,
        message: failedStage.error ?? "This step failed.",
        atIso: new Date(jobs.get(failedStage.key)?.updatedAtMs ?? nowMs).toISOString(),
      }
    : null;

  // Stalled = nothing running, nothing failed, nothing waiting on the user, and
  // nothing has moved for a while. That's a job that was never picked up (worker
  // down or queue drained) — a different problem from a job that ran and died.
  const activeJob = activeStage ? jobs.get(activeStage.key) : undefined;
  const stalled =
    !done &&
    !failure &&
    !awaitingUser &&
    activeJob?.status !== "running" &&
    input.mixStartedAtMs === null &&
    nowMs - input.episodeUpdatedAtMs > STALL_AFTER_MS;

  const stageDef = PRODUCTION_STAGES.find((s) => s.key === activeKey);
  const headline = done
    ? "Episode ready"
    : failure
      ? `${failure.label} failed`
      : stalled
        ? "Waiting for a production worker"
        : awaitingUser
          ? "Your read is next"
          : stageDef?.verb ?? "Working…";

  // Poll fast while voicing (the only stage that visibly ticks), slower on
  // opaque stages, and slowest — but never zero — while stopped or waiting on
  // the user, since either can be resolved from another tab or by an operator.
  const pollAfterMs = done ? 0 : failure || awaitingUser ? 10000 : activeKey === "voices" ? 2500 : 4000;

  return { stage: activeKey, stages, failure, stalled, awaitingUser, done, headline, pollAfterMs };
}
