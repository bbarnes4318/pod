// The DURABLE last-known-good record the live canary compares itself against,
// and the comparison itself.
//
// WHY THIS IS A SEPARATE MODULE
//
// "Is today worse than yesterday?" is the only question in the canary that is
// pure: given two records it has one answer, and it must be answerable without a
// network, an API key, or a rendered byte. Keeping it here means the regression
// thresholds are testable directly, and the canary script stays a sequence of
// live stages rather than a script with a comparison engine buried in it.
//
// WHAT A BASELINE IS ALLOWED TO CONTAIN
//
// Names, numbers and DIGESTS. Never a voice id, never a key, never a transcript.
// The baseline is written into a CI cache and restored into later runs, so
// anything stored here outlives the run that produced it — a voice id sitting in
// a cache entry is a leak with a long tail. Voice identity is therefore carried
// as a salted-free SHA-256 prefix (`voiceFingerprint`), which is enough to prove
// "the voice changed" and useless for reaching the voice.

import { createHash } from "crypto";
import fs from "node:fs";

// ---------------------------------------------------------------- thresholds
//
// Module constants, not env-tunable, for the same reason the seven-role
// director bounds are: an operator who can widen the bound at deploy time can
// silence the alarm without a code review.

/** A drop of more than this many performance points is a quality regression. */
export const BASELINE_MAX_SCORE_DROP = 12;
/** Slower than this multiple of the baseline is a latency regression. */
export const BASELINE_MAX_LATENCY_RATIO = 2.5;
/** More than this multiple of the baseline token spend is reported, not failed:
 *  script length legitimately varies run to run, so this is an observation. */
export const BASELINE_COST_ATTENTION_RATIO = 2;

// ---------------------------------------------------------------- record shape

export interface CanaryProviderSnapshot {
  /** The model the provider REPORTED rendering on. */
  model: string;
  /** Where the request went. Not a secret — a hostname, never a key. */
  endpoint: string;
  latencyMs: number;
  performanceScore: number;
  /** Digest of the voice ids used, so a changed voice is visible and the id is
   *  not. See voiceFingerprint. */
  voiceFingerprint: string;
}

export interface CanaryRoleSnapshot {
  role: string;
  requestedModel: string;
  actualProvider: string | null;
  actualModel: string | null;
}

export interface CanaryBaselineRecord {
  ranAt: string;
  status: string;
  providers: Record<string, CanaryProviderSnapshot>;
  roles: CanaryRoleSnapshot[];
  /** Token totals only. A dollar figure is recorded when — and only when — the
   *  operator configured rates; see costLedger.estimateCostUsd. */
  cost: { tokens: number; estimatedCostUsd: number | null } | null;
}

/**
 * Stable digest of one provider's voice configuration.
 *
 * SHA-256 over the joined parts, truncated to 16 hex characters: long enough
 * that two different configurations will not collide in this lifetime, short
 * enough to read in a CI summary, and one-way so the artifact never carries the
 * voice ids themselves.
 */
export function voiceFingerprint(parts: Array<string | null | undefined>): string {
  return createHash("sha256").update(parts.map((p) => p ?? "").join("|")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------- loading

export interface BaselineLoad {
  path: string;
  present: boolean;
  record: CanaryBaselineRecord | null;
  /** Why a present file could not be used. A corrupt baseline is reported, not
   *  silently treated as "no baseline" — the second spelling hides the fact that
   *  nothing has been compared for however long the file has been broken. */
  error: string | null;
}

export function loadCanaryBaseline(path: string): BaselineLoad {
  if (!fs.existsSync(path)) return { path, present: false, record: null, error: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(path, "utf8")) as Partial<CanaryBaselineRecord> & {
      providers?: Record<string, Partial<CanaryProviderSnapshot>>;
    };
    if (!parsed || typeof parsed !== "object" || !parsed.providers) {
      return { path, present: true, record: null, error: "baseline file has no providers block" };
    }
    return {
      path,
      present: true,
      record: {
        ranAt: String(parsed.ranAt ?? "(unrecorded)"),
        status: String(parsed.status ?? "(unrecorded)"),
        providers: Object.fromEntries(
          Object.entries(parsed.providers).map(([name, snapshot]) => [
            name,
            {
              model: String(snapshot?.model ?? ""),
              endpoint: String(snapshot?.endpoint ?? ""),
              latencyMs: Number(snapshot?.latencyMs ?? 0),
              performanceScore: Number(snapshot?.performanceScore ?? 0),
              voiceFingerprint: String(snapshot?.voiceFingerprint ?? ""),
            },
          ])
        ),
        roles: Array.isArray(parsed.roles) ? (parsed.roles as CanaryRoleSnapshot[]) : [],
        cost: parsed.cost ?? null,
      },
      error: null,
    };
  } catch (error) {
    return { path, present: true, record: null, error: (error as Error).message };
  }
}

// ---------------------------------------------------------------- comparison

export type BaselineAlertClass =
  | "quality_regression"
  | "latency_regression"
  | "voice_drift"
  | "model_drift";

export interface BaselineRegression {
  alertClass: BaselineAlertClass;
  message: string;
}

export interface BaselineComparison {
  compared: boolean;
  baselineRanAt: string | null;
  providers: Record<string, { scoreDelta: number; latencyRatio: number }>;
  voice: { drifted: boolean; changes: string[] };
  model: { drifted: boolean; changes: string[] };
  cost: { ratio: number | null; note: string } | null;
  /** In severity order: the caller fails on the first one. */
  regressions: BaselineRegression[];
}

export function emptyComparison(): BaselineComparison {
  return {
    compared: false,
    baselineRanAt: null,
    providers: {},
    voice: { drifted: false, changes: [] },
    model: { drifted: false, changes: [] },
    cost: null,
    regressions: [],
  };
}

/**
 * Compare this run against the last known good one.
 *
 * VOICE DRIFT is identity drift: the provider rendered on a different model, or
 * a different endpoint, or with a different voice configuration than the record
 * says it did last time. It deliberately does NOT try to infer drift from
 * acoustic metrics — the canary writes a freshly generated script every run, so
 * pitch and pace legitimately differ and an acoustic threshold would produce
 * daily false alarms that teach everyone to ignore the alert. Acoustic numbers
 * are still reported; they are just not a gate.
 */
export function compareToBaseline(
  current: CanaryBaselineRecord,
  baseline: CanaryBaselineRecord | null
): BaselineComparison {
  const comparison = emptyComparison();
  if (!baseline) return comparison;
  comparison.compared = true;
  comparison.baselineRanAt = baseline.ranAt;

  for (const [name, now] of Object.entries(current.providers)) {
    const before = baseline.providers[name];
    if (!before) continue;

    const scoreDelta = now.performanceScore - before.performanceScore;
    const latencyRatio = now.latencyMs / Math.max(1, before.latencyMs);
    comparison.providers[name] = { scoreDelta, latencyRatio };

    if (before.voiceFingerprint && now.voiceFingerprint !== before.voiceFingerprint) {
      comparison.voice.drifted = true;
      comparison.voice.changes.push(
        `${name}: the voice configuration digest changed (${before.voiceFingerprint} -> ${now.voiceFingerprint}). ` +
          `Either a CANARY_*_VOICE_* value was edited or the provider is serving a different voice for the same id.`
      );
    }
    if (before.model && now.model !== before.model) {
      comparison.voice.drifted = true;
      comparison.voice.changes.push(
        `${name}: rendered on '${now.model}' but the baseline rendered on '${before.model}'.`
      );
    }
    if (before.endpoint && now.endpoint !== before.endpoint) {
      comparison.voice.drifted = true;
      comparison.voice.changes.push(
        `${name}: requests now go to '${now.endpoint}'; the baseline used '${before.endpoint}'.`
      );
    }

    if (scoreDelta < -BASELINE_MAX_SCORE_DROP) {
      comparison.regressions.push({
        alertClass: "quality_regression",
        message: `${name} performance score regressed ${Math.abs(Math.round(scoreDelta))} points against the baseline (floor is ${BASELINE_MAX_SCORE_DROP}).`,
      });
    }
    if (latencyRatio > BASELINE_MAX_LATENCY_RATIO) {
      comparison.regressions.push({
        alertClass: "latency_regression",
        message: `${name} latency regressed to ${latencyRatio.toFixed(1)}x the baseline (ceiling is ${BASELINE_MAX_LATENCY_RATIO}x).`,
      });
    }
  }

  const baselineRoles = new Map(baseline.roles.map((r) => [r.role, r]));
  for (const role of current.roles) {
    const before = baselineRoles.get(role.role);
    if (!before || !before.actualModel || !role.actualModel) continue;
    if (before.actualModel !== role.actualModel || before.actualProvider !== role.actualProvider) {
      comparison.model.drifted = true;
      comparison.model.changes.push(
        `${role.role}: served by ${role.actualProvider}/${role.actualModel}; the baseline was served by ${before.actualProvider}/${before.actualModel}.`
      );
    }
  }

  if (current.cost && baseline.cost && baseline.cost.tokens > 0) {
    const ratio = current.cost.tokens / baseline.cost.tokens;
    comparison.cost = {
      ratio,
      note:
        ratio > BASELINE_COST_ATTENTION_RATIO
          ? `Token spend is ${ratio.toFixed(1)}x the baseline. Reported, not failed: the canary writes a new script every run, so length varies.`
          : `Token spend is ${ratio.toFixed(2)}x the baseline.`,
    };
  }

  // Voice drift is reported as a regression LAST so quality and latency (which
  // name a specific number) lead the alert reason when several fire at once.
  if (comparison.voice.drifted) {
    comparison.regressions.push({
      alertClass: "voice_drift",
      message: comparison.voice.changes.join(" "),
    });
  }
  if (comparison.model.drifted) {
    comparison.regressions.push({
      alertClass: "model_drift",
      message: comparison.model.changes.join(" "),
    });
  }
  return comparison;
}
