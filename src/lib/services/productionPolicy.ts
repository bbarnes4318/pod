// VERSIONED PRODUCTION POLICY — the closing leg of the listener-learning loop.
//
//   [listenerLearning.ts] collect -> aggregate -> HERE: evaluate -> promote or
//   refuse (with a recorded reason) -> rollback.
//
// FOUR HARD RULES, all enforced in code rather than by convention:
//
//  1. MINIMUM SAMPLE + CONFIDENCE. A promotion needs a real sample per arm, a
//     real total, a real effect size, and a real significance test. Callers may
//     TIGHTEN the thresholds; an attempt to loosen them is ignored (see
//     resolveThresholds) — a learning loop that can talk itself into a lower
//     bar is not a safeguard.
//
//  2. BOUNDED ADJUSTABLES ONLY. ADJUSTABLE_POLICY_FIELDS is an allow-list with
//     per-field bounds AND a per-promotion step cap. IMMUTABLE_POLICY_RULES —
//     evidence, safety and character rules — are not merely "not adjustable":
//     they are read from this module's constant at resolve time, so even a
//     hand-edited database row cannot weaken them.
//
//  3. PER-SHOW IDENTITY. Every version row, decision row, read and write is
//     scoped by podcastId. There is no global policy and no cross-show write
//     path; assertShowScoped() fails loudly if a foreign row ever appears.
//
//  4. EXPLAINABLE + REVERSIBLE. A promoted version records the signal, the two
//     arms, their sample sizes, the effect, the significance, the causing
//     episode ids and the listener cohorts. Rollback restores the previous
//     version row untouched, and a rollback with nothing behind it is a
//     recorded no-op rather than an error.
//
//  5. NO AUTOMATIC PROMOTION FROM ANONYMOUS TRAFFIC — a deliberate choice,
//     not an oversight, and the reason is written down rather than hidden in a
//     threshold.
//
//     /api/learning/* is public. listenerLearning.ts section 8 makes forging an
//     audience expensive (server-issued signed context, strict per-signal
//     validation, dedupe, per-listener and per-source rate limits, one-shot
//     pairwise trials, and a per-source cap on credible listeners). It does not
//     make it IMPOSSIBLE: a listener id is self-asserted and IP diversity is
//     purchasable. We cannot establish that fully anonymous traffic is
//     trustworthy enough to move production settings by itself.
//
//     So: a promotion whose deciding signal is listener- or panel-sourced is
//     STAGED (outcome "staged", code "awaiting_human_approval") and applied only
//     when a named human calls approveStagedPolicyPromotion(). The evidence, the
//     stats and the exact bounded proposal are all in the staged decision, so
//     approval is an informed click rather than a rubber stamp.
//
//     Production-sourced signals — derived server-side from real artifacts by
//     deriveProductionSignals(), unreachable from any client — may still promote
//     automatically. The distinction is who could have manufactured the number.
//
//     Two further gates back this up: sample sizes are counted in CREDIBLE
//     INDEPENDENT LISTENERS (countCredibleListeners), not raw rows or raw
//     anonymous ids; and a person-sourced comparison with no raw events to count
//     is refused outright ("unverifiable_sample") rather than trusted.

import crypto from "node:crypto";
import {
  LEARNING_SIGNALS,
  countCredibleListeners,
  eventScopeKey,
  isLearningSignalKey,
  signalDescriptor,
  type AggregateScopeKind,
  type ConfidenceLabel,
  type LearningAggregateRow,
  type LearningEventRecord,
  type LearningSignalKey,
  type LearningStore,
  type PolicyDecisionRecord,
  type PolicyVersionRecord,
} from "./listenerLearning";

/* ------------------------------------------------------------------ */
/* 1. What learning may and may not touch.                             */
/* ------------------------------------------------------------------ */

export type PolicyFieldBound =
  | { kind: "number"; label: string; min: number; max: number; maxStep: number }
  | { kind: "enum"; label: string; options: readonly string[] }
  | { kind: "boolean"; label: string }
  | { kind: "weight_map"; label: string; keys: readonly string[]; min: number; max: number; maxStep: number };

/**
 * The ONLY fields an automated promotion may write. Everything here is a
 * production PREFERENCE — how the show is shaped — never what it is allowed
 * to assert, air, or sound like as a character.
 */
export const ADJUSTABLE_POLICY_FIELDS = {
  coldOpenArchetypeWeights: {
    kind: "weight_map",
    label: "Cold-open archetype priors",
    keys: ["accusation", "consequence", "contradiction"],
    min: 0.15,
    max: 0.5,
    maxStep: 0.1,
  },
  coldOpenTargetSeconds: { kind: "number", label: "Cold-open target length (s)", min: 8, max: 45, maxStep: 8 },
  segmentTargetMinutes: { kind: "number", label: "Segment target length (min)", min: 3, max: 12, maxStep: 2 },
  interruptionDensity: { kind: "number", label: "Interruption density", min: 0, max: 0.35, maxStep: 0.08 },
  sfxDensity: { kind: "enum", label: "SFX density", options: ["none", "subtle", "standard", "dense"] },
  musicBedGainDb: { kind: "number", label: "Music bed gain (dB)", min: -30, max: -12, maxStep: 3 },
  recapEnabled: { kind: "boolean", label: "Mid-episode recap" },
} as const satisfies Record<string, PolicyFieldBound>;

export type AdjustablePolicyField = keyof typeof ADJUSTABLE_POLICY_FIELDS;

export const ADJUSTABLE_POLICY_FIELD_NAMES = Object.keys(ADJUSTABLE_POLICY_FIELDS) as AdjustablePolicyField[];

/** Baseline preferences for a show that has never been promoted. */
export const DEFAULT_POLICY_PREFERENCES: Record<AdjustablePolicyField, unknown> = {
  coldOpenArchetypeWeights: { accusation: 1 / 3, consequence: 1 / 3, contradiction: 1 / 3 },
  coldOpenTargetSeconds: 22,
  segmentTargetMinutes: 6,
  interruptionDensity: 0.12,
  sfxDensity: "subtle",
  musicBedGainDb: -22,
  recapEnabled: false,
};

/**
 * Evidence, safety and character rules. NOT adjustable, NOT negotiable, and
 * deliberately not stored as the source of truth: resolveEffectivePolicy()
 * always returns THIS object, so a tampered or stale row cannot weaken them.
 * Each key is named so a rejection can say exactly which rule was targeted.
 */
export const IMMUTABLE_POLICY_RULES = {
  // --- evidence ---------------------------------------------------------
  evidenceRequiredForFactualClaims: true,
  minEvidenceRefsPerClaim: 1,
  factCheckGateEnabled: true,
  unresolvedClaimsBlockPublish: true,
  numbersMustAppearInReferences: true,
  // --- safety -----------------------------------------------------------
  gamblingDisclaimerRequired: true,
  profitPromiseLanguageBanned: true,
  complianceGateEnabled: true,
  explicitContentPolicy: "channel_default",
  // --- character --------------------------------------------------------
  hostIdentityLocked: true,
  hostCharacterRulesLocked: true,
  hostVoiceProvenanceRequired: true,
  retiredHostNamesBanned: true,
} as const;

export type ImmutablePolicyField = keyof typeof IMMUTABLE_POLICY_RULES;

export const IMMUTABLE_POLICY_FIELD_NAMES = Object.keys(IMMUTABLE_POLICY_RULES) as ImmutablePolicyField[];

/**
 * A change is also refused when the key merely LOOKS like it belongs to a
 * protected domain. The allow-list already blocks unknown keys; this makes the
 * rejection say "immutable" instead of "unknown", so an operator reading the
 * decision log learns the actual rule rather than assuming a typo.
 */
const IMMUTABLE_DOMAIN_PATTERN =
  /(evidence|fact[_-]?check|citation|claim|safety|compliance|disclaimer|gambling|explicit|profanity|moderation|character|persona|host[_-]?identity|voice[_-]?provenance|roster|bible)/i;

export type PolicyRejectionCode = "immutable_field" | "unknown_field" | "out_of_bounds" | "step_too_large" | "empty_proposal";

export interface PolicyValidationIssue {
  field: string;
  code: PolicyRejectionCode;
  reason: string;
}

export type PolicyProposal = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Validate a proposed change against the allow-list, the bounds, and the
 * per-promotion step cap. `current` supplies the values the step cap is
 * measured against.
 */
export function validatePolicyProposal(
  proposal: PolicyProposal,
  current: Record<string, unknown> = DEFAULT_POLICY_PREFERENCES
): { ok: true; normalized: Record<string, unknown> } | { ok: false; issues: PolicyValidationIssue[] } {
  const issues: PolicyValidationIssue[] = [];
  const normalized: Record<string, unknown> = {};
  const keys = Object.keys(proposal ?? {});

  if (!keys.length) {
    return { ok: false, issues: [{ field: "(proposal)", code: "empty_proposal", reason: "A promotion must change at least one bounded preference." }] };
  }

  for (const key of keys) {
    if ((IMMUTABLE_POLICY_FIELD_NAMES as string[]).includes(key) || IMMUTABLE_DOMAIN_PATTERN.test(key)) {
      issues.push({ field: key, code: "immutable_field", reason: `"${key}" is an evidence/safety/character rule. Learning may never weaken it.` });
      continue;
    }
    if (!(ADJUSTABLE_POLICY_FIELD_NAMES as string[]).includes(key)) {
      issues.push({ field: key, code: "unknown_field", reason: `"${key}" is not a known bounded production preference.` });
      continue;
    }

    const bound = ADJUSTABLE_POLICY_FIELDS[key as AdjustablePolicyField] as PolicyFieldBound;
    const value = proposal[key];

    if (bound.kind === "number") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < bound.min || n > bound.max) {
        issues.push({ field: key, code: "out_of_bounds", reason: `"${key}" must be a number in [${bound.min}, ${bound.max}]; got ${JSON.stringify(value)}.` });
        continue;
      }
      const from = Number(current[key] ?? DEFAULT_POLICY_PREFERENCES[key as AdjustablePolicyField]);
      if (Number.isFinite(from) && Math.abs(n - from) > bound.maxStep + 1e-9) {
        issues.push({ field: key, code: "step_too_large", reason: `"${key}" may move at most ${bound.maxStep} per promotion (from ${from} to ${n}).` });
        continue;
      }
      normalized[key] = n;
    } else if (bound.kind === "enum") {
      if (typeof value !== "string" || !bound.options.includes(value)) {
        issues.push({ field: key, code: "out_of_bounds", reason: `"${key}" must be one of ${bound.options.join(" | ")}; got ${JSON.stringify(value)}.` });
        continue;
      }
      normalized[key] = value;
    } else if (bound.kind === "boolean") {
      if (typeof value !== "boolean") {
        issues.push({ field: key, code: "out_of_bounds", reason: `"${key}" must be a boolean; got ${JSON.stringify(value)}.` });
        continue;
      }
      normalized[key] = value;
    } else {
      // weight_map
      if (!isPlainObject(value)) {
        issues.push({ field: key, code: "out_of_bounds", reason: `"${key}" must be an object of weights.` });
        continue;
      }
      const fromMap = isPlainObject(current[key]) ? (current[key] as Record<string, unknown>) : (DEFAULT_POLICY_PREFERENCES[key as AdjustablePolicyField] as Record<string, unknown>);
      const out: Record<string, number> = {};
      let bad = false;
      for (const weightKey of Object.keys(value)) {
        if (!bound.keys.includes(weightKey)) {
          issues.push({ field: `${key}.${weightKey}`, code: "unknown_field", reason: `"${weightKey}" is not a known archetype.` });
          bad = true;
          continue;
        }
        const n = Number(value[weightKey]);
        if (!Number.isFinite(n) || n < bound.min || n > bound.max) {
          issues.push({ field: `${key}.${weightKey}`, code: "out_of_bounds", reason: `"${key}.${weightKey}" must be in [${bound.min}, ${bound.max}]; got ${JSON.stringify(value[weightKey])}.` });
          bad = true;
          continue;
        }
        const from = Number(fromMap?.[weightKey] ?? 1 / bound.keys.length);
        if (Number.isFinite(from) && Math.abs(n - from) > bound.maxStep + 1e-9) {
          issues.push({ field: `${key}.${weightKey}`, code: "step_too_large", reason: `"${key}.${weightKey}" may move at most ${bound.maxStep} per promotion (from ${from.toFixed(3)} to ${n}).` });
          bad = true;
          continue;
        }
        out[weightKey] = n;
      }
      if (bad) continue;
      // Every archetype keeps a floor: a learned prior narrows the show, it
      // never eliminates an opening style outright.
      for (const weightKey of bound.keys) {
        if (!(weightKey in out)) out[weightKey] = Number(fromMap?.[weightKey] ?? 1 / bound.keys.length);
      }
      normalized[key] = out;
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, normalized };
}

/* ------------------------------------------------------------------ */
/* 2. Sample-size + confidence safeguard.                              */
/* ------------------------------------------------------------------ */

export interface PromotionThresholds {
  /** Minimum observations in EACH arm. */
  minSamplePerArm: number;
  /** Minimum observations across both arms. */
  minTotalSample: number;
  /** Minimum directional improvement, in the signal's own units. */
  minEffect: number;
  /** Minimum |z| for the two-sample test (1.96 ≈ 95%). */
  minZScore: number;
  /** Aggregate confidence label the winning arm must already have reached. */
  minConfidence: ConfidenceLabel;
}

export const DEFAULT_PROMOTION_THRESHOLDS: PromotionThresholds = {
  minSamplePerArm: 60,
  minTotalSample: 150,
  minEffect: 0.03,
  minZScore: 1.96,
  minConfidence: "moderate",
};

const CONFIDENCE_RANK: Record<ConfidenceLabel, number> = { low: 0, moderate: 1, high: 2 };

/**
 * Overrides may only make the gate STRICTER. A caller asking for a smaller
 * sample or a weaker z gets the default instead — silently loosening a
 * safeguard from a call site is precisely the failure this loop must not have.
 */
export function resolveThresholds(overrides?: Partial<PromotionThresholds>): PromotionThresholds {
  const d = DEFAULT_PROMOTION_THRESHOLDS;
  if (!overrides) return { ...d };
  return {
    minSamplePerArm: Math.max(d.minSamplePerArm, overrides.minSamplePerArm ?? 0),
    minTotalSample: Math.max(d.minTotalSample, overrides.minTotalSample ?? 0),
    minEffect: Math.max(d.minEffect, overrides.minEffect ?? 0),
    minZScore: Math.max(d.minZScore, overrides.minZScore ?? 0),
    minConfidence:
      CONFIDENCE_RANK[overrides.minConfidence ?? d.minConfidence] > CONFIDENCE_RANK[d.minConfidence]
        ? (overrides.minConfidence as ConfidenceLabel)
        : d.minConfidence,
  };
}

/** Agresti-Coull adjusted proportion — stable when a proportion hits 0 or 1. */
function adjustedProportion(mean: number, n: number): { p: number; n: number } {
  const successes = Math.round(mean * n);
  return { p: (successes + 2) / (n + 4), n: n + 4 };
}

/** Two-sample z for the winner-vs-challenger comparison. */
export function twoSampleZ(
  a: { mean: number; stdDev: number; sampleSize: number },
  b: { mean: number; stdDev: number; sampleSize: number },
  unit: "proportion" | "continuous"
): number {
  if (a.sampleSize <= 0 || b.sampleSize <= 0) return 0;
  if (unit === "proportion") {
    const pa = adjustedProportion(a.mean, a.sampleSize);
    const pb = adjustedProportion(b.mean, b.sampleSize);
    const se = Math.sqrt((pa.p * (1 - pa.p)) / pa.n + (pb.p * (1 - pb.p)) / pb.n);
    if (!(se > 0)) return 0;
    return (pa.p - pb.p) / se;
  }
  const se = Math.sqrt((a.stdDev * a.stdDev) / a.sampleSize + (b.stdDev * b.stdDev) / b.sampleSize);
  if (!(se > 0)) return 0;
  return (a.mean - b.mean) / se;
}

export interface PolicyComparison {
  signalKey: LearningSignalKey;
  scopeKind: AggregateScopeKind;
  /** The arm the proposal favours. */
  winnerScopeKey: string;
  /** What it is being compared against. */
  challengerScopeKey: string;
}

export interface CredibleCounts {
  winner: number;
  challenger: number;
  total: number;
}

/**
 * How many CREDIBLE INDEPENDENT listeners stand behind each arm of a
 * comparison. Not rows, and not distinct anonymous ids — see the credibility
 * rule in listenerLearning.ts section 8.6.
 */
export function credibleCountsForComparison(events: LearningEventRecord[], comparison: PolicyComparison): CredibleCounts {
  const forArm = (scopeKey: string) =>
    countCredibleListeners(
      events.filter((e) => e.signalKey === comparison.signalKey && eventScopeKey(comparison.scopeKind, e) === scopeKey)
    );
  const winner = forArm(comparison.winnerScopeKey);
  const challenger = forArm(comparison.challengerScopeKey);
  return { winner, challenger, total: winner + challenger };
}

/** Signals that arrive through the PUBLIC endpoint and can never auto-promote. */
export function signalRequiresHumanApproval(signalKey: LearningSignalKey): boolean {
  const source = signalDescriptor(signalKey).source;
  return source === "listener" || source === "panel";
}

export interface PromotionStats {
  signalKey: LearningSignalKey;
  scopeKind: AggregateScopeKind;
  winner: { scopeKey: string; mean: number; sampleSize: number; stdDev: number; confidence: ConfidenceLabel; marginOfError: number };
  challenger: { scopeKey: string; mean: number; sampleSize: number; stdDev: number; confidence: ConfidenceLabel; marginOfError: number };
  /** Directional improvement (already sign-corrected for lower_better signals). */
  effect: number;
  zScore: number;
  totalSample: number;
  /** Credible independent listeners per arm. null for server-derived signals. */
  credible: CredibleCounts | null;
  thresholds: PromotionThresholds;
}

export type ReadinessResult =
  | { ready: true; stats: PromotionStats }
  | {
      ready: false;
      code: "unknown_signal" | "missing_arm" | "insufficient_sample" | "low_confidence" | "no_clear_winner" | "unverifiable_sample";
      reason: string;
      stats: Partial<PromotionStats>;
    };

/**
 * Does the evidence clear the sample-size AND confidence bar?
 *
 * For a person-sourced signal the sample thresholds are applied TWICE: once to
 * the raw aggregate sample, and once to the count of credible independent
 * listeners. `credible` must be supplied for those signals — a comparison whose
 * independence cannot be counted is refused, not assumed.
 */
export function evaluatePromotionReadiness(input: {
  aggregates: LearningAggregateRow[];
  comparison: PolicyComparison;
  thresholds?: Partial<PromotionThresholds>;
  credible?: CredibleCounts | null;
}): ReadinessResult {
  const thresholds = resolveThresholds(input.thresholds);
  const { signalKey, scopeKind, winnerScopeKey, challengerScopeKey } = input.comparison;

  if (!isLearningSignalKey(signalKey)) {
    return { ready: false, code: "unknown_signal", reason: `Unknown signal "${String(signalKey)}".`, stats: { thresholds } };
  }
  const pick = (key: string) => input.aggregates.find((r) => r.scopeKind === scopeKind && r.scopeKey === key && r.signalKey === signalKey) ?? null;
  const winnerRow = pick(winnerScopeKey);
  const challengerRow = pick(challengerScopeKey);

  if (!winnerRow || !challengerRow) {
    const missing = [!winnerRow ? winnerScopeKey : null, !challengerRow ? challengerScopeKey : null].filter(Boolean).join(", ");
    return { ready: false, code: "missing_arm", reason: `No aggregate for ${missing} on "${signalKey}".`, stats: { thresholds } };
  }

  const descriptor = signalDescriptor(signalKey);
  const asStats = (r: LearningAggregateRow) => ({
    scopeKey: r.scopeKey,
    mean: r.mean,
    sampleSize: r.sampleSize,
    stdDev: r.stdDev,
    confidence: r.confidence,
    marginOfError: r.marginOfError,
  });
  const unit: "proportion" | "continuous" = descriptor.unit === "usd_per_minute" ? "continuous" : "proportion";
  const rawZ = twoSampleZ(winnerRow, challengerRow, unit);
  const sign = descriptor.direction === "higher_better" ? 1 : -1;
  const effect = sign * (winnerRow.mean - challengerRow.mean);
  const zScore = sign * rawZ;
  const totalSample = winnerRow.sampleSize + challengerRow.sampleSize;

  const needsCredible = signalRequiresHumanApproval(signalKey);
  const stats: PromotionStats = {
    signalKey,
    scopeKind,
    winner: asStats(winnerRow),
    challenger: asStats(challengerRow),
    effect,
    zScore,
    totalSample,
    credible: needsCredible ? input.credible ?? null : null,
    thresholds,
  };

  if (
    winnerRow.sampleSize < thresholds.minSamplePerArm ||
    challengerRow.sampleSize < thresholds.minSamplePerArm ||
    totalSample < thresholds.minTotalSample
  ) {
    return {
      ready: false,
      code: "insufficient_sample",
      reason: `Need ≥${thresholds.minSamplePerArm} per arm and ≥${thresholds.minTotalSample} total; have ${winnerRow.sampleSize} vs ${challengerRow.sampleSize} (total ${totalSample}).`,
      stats,
    };
  }

  // CREDIBLE INDEPENDENT LISTENERS, not raw anonymous ids. A stranger rotating
  // a fresh id per request is one source, and one source is worth at most
  // MAX_CREDIBLE_LISTENERS_PER_SOURCE listeners however many ids it invents.
  if (needsCredible) {
    if (!input.credible) {
      return {
        ready: false,
        code: "unverifiable_sample",
        reason: `"${signalKey}" comes from the public endpoint; its raw events must be supplied so credible independent listeners can be counted.`,
        stats,
      };
    }
    const c = input.credible;
    if (c.winner < thresholds.minSamplePerArm || c.challenger < thresholds.minSamplePerArm || c.total < thresholds.minTotalSample) {
      return {
        ready: false,
        code: "insufficient_sample",
        reason:
          `Raw sample is large enough but CREDIBLE independent listeners are not: ` +
          `${c.winner} vs ${c.challenger} (total ${c.total}); need ≥${thresholds.minSamplePerArm} per arm and ≥${thresholds.minTotalSample} total.`,
        stats,
      };
    }
  }

  if (effect < thresholds.minEffect) {
    return {
      ready: false,
      code: "no_clear_winner",
      reason: `Effect ${effect.toFixed(4)} is below the ${thresholds.minEffect} minimum for "${signalKey}".`,
      stats,
    };
  }

  if (zScore < thresholds.minZScore) {
    return {
      ready: false,
      code: "low_confidence",
      reason: `z=${zScore.toFixed(3)} is below the ${thresholds.minZScore} significance bar.`,
      stats,
    };
  }

  if (CONFIDENCE_RANK[winnerRow.confidence] < CONFIDENCE_RANK[thresholds.minConfidence]) {
    return {
      ready: false,
      code: "low_confidence",
      reason: `Winning arm confidence is "${winnerRow.confidence}"; "${thresholds.minConfidence}" is required.`,
      stats,
    };
  }

  return { ready: true, stats };
}

/* ------------------------------------------------------------------ */
/* 3. Per-show versioning, promotion, rollback.                        */
/* ------------------------------------------------------------------ */

function newId(): string {
  return crypto.randomUUID();
}

/** A row from another show must never reach this code path. */
export function assertShowScoped<T extends { podcastId: string }>(rows: T[], podcastId: string): T[] {
  for (const r of rows) {
    if (r.podcastId !== podcastId) {
      throw new Error(`Show isolation violated: row for "${r.podcastId}" reached the policy path for "${podcastId}".`);
    }
  }
  return rows;
}

async function loadVersions(store: LearningStore, podcastId: string): Promise<PolicyVersionRecord[]> {
  const rows = await store.listPolicyVersions(podcastId);
  return assertShowScoped(rows, podcastId).sort((a, b) => a.version - b.version);
}

function baselineVersion(podcastId: string, now: Date): PolicyVersionRecord {
  return {
    id: newId(),
    podcastId,
    version: 1,
    status: "active",
    preferences: { ...DEFAULT_POLICY_PREFERENCES },
    immutableRules: { ...IMMUTABLE_POLICY_RULES },
    rationale: "Baseline production policy — nothing learned yet.",
    evidence: { baseline: true, episodeIds: [], cohorts: [], signals: [] },
    promotedFromVersion: null,
    promotedBy: "system",
    promotedAt: now,
    rolledBackAt: null,
    rolledBackBy: null,
    rolledBackReason: null,
  };
}

/** The active version for ONE show, creating this show's baseline if needed. */
export async function getActivePolicyVersion(store: LearningStore, podcastId: string, now: Date = new Date()): Promise<PolicyVersionRecord> {
  const versions = await loadVersions(store, podcastId);
  const active = versions.find((v) => v.status === "active");
  if (active) return active;
  if (versions.length) {
    // Every version rolled back — the earliest one is the show's floor.
    const first = versions[0];
    await store.updatePolicyVersion(podcastId, first.version, { status: "active" });
    return { ...first, status: "active" };
  }
  const baseline = baselineVersion(podcastId, now);
  await store.insertPolicyVersion(baseline);
  return baseline;
}

/**
 * What the pipeline should actually use. Preferences come from the show's
 * active version merged over the defaults; the immutable rules come from THIS
 * MODULE'S constant, never from the stored row — so a tampered, stale, or
 * partially-migrated row cannot weaken evidence, safety or character rules.
 */
export async function resolveEffectivePolicy(
  store: LearningStore,
  podcastId: string,
  now: Date = new Date()
): Promise<{ version: number; preferences: Record<string, unknown>; immutable: typeof IMMUTABLE_POLICY_RULES }> {
  const active = await getActivePolicyVersion(store, podcastId, now);
  return {
    version: active.version,
    preferences: { ...DEFAULT_POLICY_PREFERENCES, ...active.preferences },
    immutable: { ...IMMUTABLE_POLICY_RULES },
  };
}

export interface PromotionInput {
  podcastId: string;
  /** The bounded change being proposed. */
  proposal: PolicyProposal;
  comparison: PolicyComparison;
  aggregates: LearningAggregateRow[];
  /** Raw events for explainability — causing episodes and listener cohorts. */
  events?: LearningEventRecord[];
  actor: string;
  rationale?: string;
  thresholds?: Partial<PromotionThresholds>;
  now?: Date;
  /**
   * A NAMED HUMAN taking responsibility for applying a listener- or
   * panel-sourced change. Absent, such a change is staged instead of applied.
   * Never set this from an automated caller — that is the whole control.
   */
  approval?: { humanActor: string; approvedDecisionId?: string | null } | null;
}

export type PromotionResult =
  | { promoted: true; version: PolicyVersionRecord; decision: PolicyDecisionRecord }
  | { promoted: false; code: string; reason: string; decision: PolicyDecisionRecord };

function explainability(input: PromotionInput, stats: PromotionStats) {
  const relevant = (input.events ?? []).filter(
    (e) =>
      e.podcastId === input.podcastId &&
      e.signalKey === stats.signalKey &&
      (stats.scopeKind !== "opening_variant" ||
        e.openingVariant === stats.winner.scopeKey ||
        e.openingVariant === stats.challenger.scopeKey)
  );
  const episodeIds = [...new Set(relevant.map((e) => e.episodeId).filter((v): v is string => !!v))].sort();
  const cohorts = [...new Set(relevant.map((e) => e.cohort).filter((v): v is string => !!v))].sort();
  const countries = [...new Set(relevant.map((e) => e.country).filter((v): v is string => !!v))].sort();
  return {
    signalKey: stats.signalKey,
    scopeKind: stats.scopeKind,
    winner: stats.winner,
    challenger: stats.challenger,
    effect: stats.effect,
    zScore: stats.zScore,
    totalSample: stats.totalSample,
    thresholds: stats.thresholds,
    episodeIds,
    cohorts,
    countries,
    rawEventsConsidered: relevant.length,
  };
}

/**
 * Attempt an automated policy change for ONE show. Every outcome — including
 * every refusal — is written to ProductionPolicyDecision with a machine code
 * and a human reason.
 */
export async function promoteProductionPolicy(store: LearningStore, input: PromotionInput): Promise<PromotionResult> {
  const now = input.now ?? new Date();
  const podcastId = input.podcastId;

  const record = async (
    outcome: PolicyDecisionRecord["outcome"],
    code: string,
    reason: string,
    detail: Record<string, unknown> | null,
    resultingVersion: number | null
  ): Promise<PolicyDecisionRecord> => {
    const decision: PolicyDecisionRecord = {
      id: newId(),
      podcastId,
      outcome,
      code,
      reason,
      resultingVersion,
      detail,
      actor: input.actor,
      decidedAt: now,
    };
    await store.insertPolicyDecision(decision);
    return decision;
  };

  const active = await getActivePolicyVersion(store, podcastId, now);

  // 1. Bounds + immutability FIRST. A change that targets an evidence, safety
  //    or character rule is refused no matter how much data supports it.
  const validation = validatePolicyProposal(input.proposal, { ...DEFAULT_POLICY_PREFERENCES, ...active.preferences });
  if (!validation.ok) {
    const worst =
      validation.issues.find((i) => i.code === "immutable_field") ??
      validation.issues.find((i) => i.code === "unknown_field") ??
      validation.issues[0];
    const decision = await record("rejected", worst.code, worst.reason, { issues: validation.issues }, null);
    return { promoted: false, code: worst.code, reason: worst.reason, decision };
  }

  // 2. Sample size + confidence + CREDIBLE INDEPENDENT LISTENERS.
  const scopedEvents = (input.events ?? []).filter((e) => e.podcastId === podcastId);
  const needsHuman = isLearningSignalKey(input.comparison.signalKey) && signalRequiresHumanApproval(input.comparison.signalKey);
  const credible = needsHuman && input.events ? credibleCountsForComparison(scopedEvents, input.comparison) : null;

  const readiness = evaluatePromotionReadiness({
    aggregates: assertShowScoped(
      input.aggregates.filter((a) => a.podcastId === podcastId),
      podcastId
    ),
    comparison: input.comparison,
    thresholds: input.thresholds,
    credible,
  });
  if (!readiness.ready) {
    const decision = await record("rejected", readiness.code, readiness.reason, { stats: readiness.stats as unknown as Record<string, unknown>, proposal: validation.normalized }, null);
    return { promoted: false, code: readiness.code, reason: readiness.reason, decision };
  }

  // 3. HUMAN APPROVAL GATE. The evidence is good enough for a person to look
  //    at; it is not, by itself, authority to change the show. Staging happens
  //    HERE rather than in the caller so no call site can route around it.
  if (needsHuman && !input.approval?.humanActor) {
    const reason =
      `Evidence clears every automated gate, but "${LEARNING_SIGNALS[readiness.stats.signalKey].label}" is collected from a public, ` +
      `unauthenticated endpoint (${signalDescriptor(readiness.stats.signalKey).source}-sourced). ` +
      `${readiness.stats.credible?.winner ?? 0} vs ${readiness.stats.credible?.challenger ?? 0} credible independent listeners. ` +
      `A named human must approve this change before it is applied.`;
    const decision = await record(
      "staged",
      "awaiting_human_approval",
      reason,
      {
        proposal: validation.normalized,
        comparison: input.comparison as unknown as Record<string, unknown>,
        stats: readiness.stats as unknown as Record<string, unknown>,
        evidence: explainability(input, readiness.stats) as unknown as Record<string, unknown>,
      },
      null
    );
    return { promoted: false, code: "awaiting_human_approval", reason, decision };
  }

  // 4. Promote — a NEW version for THIS show only.
  const evidence = explainability(input, readiness.stats);
  const version: PolicyVersionRecord = {
    id: newId(),
    podcastId,
    version: active.version + 1,
    status: "active",
    preferences: { ...DEFAULT_POLICY_PREFERENCES, ...active.preferences, ...validation.normalized },
    immutableRules: { ...IMMUTABLE_POLICY_RULES },
    rationale:
      input.rationale ??
      `"${evidence.winner.scopeKey}" beat "${evidence.challenger.scopeKey}" on ${LEARNING_SIGNALS[readiness.stats.signalKey].label} ` +
        `(${evidence.winner.mean.toFixed(3)} vs ${evidence.challenger.mean.toFixed(3)}, n=${evidence.winner.sampleSize}/${evidence.challenger.sampleSize}, z=${evidence.zScore.toFixed(2)}).`,
    evidence: {
      ...evidence,
      changedFields: Object.keys(validation.normalized),
      credible: readiness.stats.credible,
      approvedBy: input.approval?.humanActor ?? null,
      approvedDecisionId: input.approval?.approvedDecisionId ?? null,
      automatic: !needsHuman,
    },
    promotedFromVersion: active.version,
    promotedBy: input.approval?.humanActor ?? input.actor,
    promotedAt: now,
    rolledBackAt: null,
    rolledBackBy: null,
    rolledBackReason: null,
  };

  await store.updatePolicyVersion(podcastId, active.version, { status: "superseded" });
  await store.insertPolicyVersion(version);
  const decision = await record("promoted", "promoted", version.rationale, { changedFields: Object.keys(validation.normalized), evidence: evidence as unknown as Record<string, unknown> }, version.version);

  return { promoted: true, version, decision };
}

export type RollbackResult =
  | { rolledBack: true; restoredVersion: PolicyVersionRecord; decision: PolicyDecisionRecord }
  | { rolledBack: false; code: "no_prior_version"; reason: string; decision: PolicyDecisionRecord };

/**
 * Restore the version the active one superseded — the stored row is reactivated
 * UNCHANGED, so the restoration is exact rather than reconstructed. Rolling
 * back with nothing behind the active version is a recorded no-op, which makes
 * repeated rollbacks safe instead of destructive.
 */
export async function rollbackProductionPolicy(
  store: LearningStore,
  input: { podcastId: string; actor: string; reason?: string; now?: Date }
): Promise<RollbackResult> {
  const now = input.now ?? new Date();
  const podcastId = input.podcastId;
  const versions = await loadVersions(store, podcastId);
  const active = versions.find((v) => v.status === "active") ?? null;

  const decide = async (outcome: PolicyDecisionRecord["outcome"], code: string, reason: string, resultingVersion: number | null) => {
    const decision: PolicyDecisionRecord = {
      id: newId(),
      podcastId,
      outcome,
      code,
      reason,
      resultingVersion,
      detail: { fromVersion: active?.version ?? null },
      actor: input.actor,
      decidedAt: now,
    };
    await store.insertPolicyDecision(decision);
    return decision;
  };

  const prior = active?.promotedFromVersion != null ? versions.find((v) => v.version === active.promotedFromVersion) ?? null : null;

  if (!active || !prior) {
    const reason = !active
      ? "No active policy version to roll back."
      : `Version ${active.version} is this show's baseline — there is nothing behind it.`;
    const decision = await decide("rejected", "no_prior_version", reason, active?.version ?? null);
    return { rolledBack: false, code: "no_prior_version", reason, decision };
  }

  await store.updatePolicyVersion(podcastId, active.version, {
    status: "rolled_back",
    rolledBackAt: now,
    rolledBackBy: input.actor,
    rolledBackReason: input.reason ?? "Operator rollback.",
  });
  await store.updatePolicyVersion(podcastId, prior.version, { status: "active" });

  const decision = await decide("rolled_back", "rolled_back", `Rolled back v${active.version} → v${prior.version}.`, prior.version);
  return { rolledBack: true, restoredVersion: { ...prior, status: "active" }, decision };
}

/* ------------------------------------------------------------------ */
/* 3b. The human approval leg.                                         */
/* ------------------------------------------------------------------ */

/**
 * A promotion that cleared every automated gate and is waiting for a person.
 * The proposal and the statistics that produced it are carried verbatim from
 * the staged decision, so the approver sees exactly what was proposed.
 */
export interface StagedPromotion {
  decisionId: string;
  podcastId: string;
  reason: string;
  stagedAt: Date;
  proposal: PolicyProposal;
  comparison: PolicyComparison | null;
  stats: Partial<PromotionStats> | null;
  evidence: Record<string, unknown> | null;
}

function detailObject(detail: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const v = detail?.[key];
  return isPlainObject(v) ? v : null;
}

/** Decision ids that a later decision already approved or dismissed. */
function resolvedStagedIds(decisions: PolicyDecisionRecord[]): Set<string> {
  const resolved = new Set<string>();
  for (const d of decisions) {
    const approved = d.detail?.approvedDecisionId;
    const dismissed = d.detail?.dismissedDecisionId;
    if (typeof approved === "string") resolved.add(approved);
    if (typeof dismissed === "string") resolved.add(dismissed);
  }
  return resolved;
}

/**
 * Everything currently awaiting a human for ONE show, newest first. A staged
 * decision that has already been approved or dismissed is not returned — an
 * approval queue that keeps re-offering settled items trains people to click
 * through it.
 */
export async function listStagedPolicyPromotions(store: LearningStore, podcastId: string): Promise<StagedPromotion[]> {
  const decisions = assertShowScoped(await store.listPolicyDecisions(podcastId), podcastId);
  const resolved = resolvedStagedIds(decisions);
  return decisions
    .filter((d) => d.outcome === "staged" && !resolved.has(d.id))
    .map((d) => ({
      decisionId: d.id,
      podcastId: d.podcastId,
      reason: d.reason,
      stagedAt: d.decidedAt,
      proposal: detailObject(d.detail, "proposal") ?? {},
      comparison: (detailObject(d.detail, "comparison") as unknown as PolicyComparison | null) ?? null,
      stats: (detailObject(d.detail, "stats") as unknown as Partial<PromotionStats> | null) ?? null,
      evidence: detailObject(d.detail, "evidence"),
    }))
    .sort((a, b) => b.stagedAt.getTime() - a.stagedAt.getTime());
}

export type StagedResolutionFailure = {
  promoted: false;
  code: "unknown_staged_decision" | "already_resolved" | "human_actor_required" | "incomplete_staged_decision";
  reason: string;
  decision: null;
};

/**
 * APPLY a staged promotion, on the authority of a NAMED HUMAN.
 *
 * The staged proposal is NOT trusted as pre-approved evidence. It is re-run
 * through promoteProductionPolicy() against the aggregates and raw events as
 * they are NOW — bounds, step cap, sample size, significance and credible
 * independent listeners are all re-checked at approval time. A proposal whose
 * support has since evaporated is refused here exactly as it would have been
 * refused when it was staged, and the refusal is recorded.
 *
 * The ONLY thing approval supplies is the `approval.humanActor` that the gate in
 * promoteProductionPolicy() requires. That is the whole point: a person, named
 * in the version row, takes responsibility for a change that anonymous traffic
 * suggested.
 */
export async function approveStagedPolicyPromotion(
  store: LearningStore,
  input: {
    podcastId: string;
    decisionId: string;
    /** A real, identifiable operator. Never an automated caller's name. */
    humanActor: string;
    aggregates: LearningAggregateRow[];
    events?: LearningEventRecord[];
    thresholds?: Partial<PromotionThresholds>;
    rationale?: string;
    now?: Date;
  }
): Promise<PromotionResult | StagedResolutionFailure> {
  const now = input.now ?? new Date();
  const humanActor = (input.humanActor ?? "").trim();
  if (!humanActor) {
    return {
      promoted: false,
      code: "human_actor_required",
      reason: "A staged promotion is applied on a named person's authority; an empty actor is not one.",
      decision: null,
    };
  }

  const decisions = assertShowScoped(await store.listPolicyDecisions(input.podcastId), input.podcastId);
  const staged = decisions.find((d) => d.id === input.decisionId && d.outcome === "staged") ?? null;
  if (!staged) {
    return { promoted: false, code: "unknown_staged_decision", reason: `No staged promotion "${input.decisionId}" for this show.`, decision: null };
  }
  if (resolvedStagedIds(decisions).has(staged.id)) {
    return { promoted: false, code: "already_resolved", reason: "That staged promotion has already been approved or dismissed.", decision: null };
  }

  const proposal = detailObject(staged.detail, "proposal");
  const comparison = detailObject(staged.detail, "comparison") as unknown as PolicyComparison | null;
  if (!proposal || !comparison || !isLearningSignalKey(comparison.signalKey)) {
    return {
      promoted: false,
      code: "incomplete_staged_decision",
      reason: "The staged decision does not carry a proposal and comparison to re-verify.",
      decision: null,
    };
  }

  return promoteProductionPolicy(store, {
    podcastId: input.podcastId,
    proposal,
    comparison,
    aggregates: input.aggregates,
    events: input.events,
    actor: humanActor,
    rationale: input.rationale,
    thresholds: input.thresholds,
    now,
    approval: { humanActor, approvedDecisionId: staged.id },
  });
}

/**
 * Decline a staged promotion. Recorded rather than deleted: "a human looked at
 * this and said no" is evidence, and without it the same candidate would be
 * re-staged on the next cycle with nothing to show it had been considered.
 */
export async function dismissStagedPolicyPromotion(
  store: LearningStore,
  input: { podcastId: string; decisionId: string; humanActor: string; reason?: string; now?: Date }
): Promise<{ dismissed: true; decision: PolicyDecisionRecord } | StagedResolutionFailure> {
  const now = input.now ?? new Date();
  const humanActor = (input.humanActor ?? "").trim();
  if (!humanActor) {
    return { promoted: false, code: "human_actor_required", reason: "A dismissal is recorded against a named person.", decision: null };
  }
  const decisions = assertShowScoped(await store.listPolicyDecisions(input.podcastId), input.podcastId);
  const staged = decisions.find((d) => d.id === input.decisionId && d.outcome === "staged") ?? null;
  if (!staged) {
    return { promoted: false, code: "unknown_staged_decision", reason: `No staged promotion "${input.decisionId}" for this show.`, decision: null };
  }
  if (resolvedStagedIds(decisions).has(staged.id)) {
    return { promoted: false, code: "already_resolved", reason: "That staged promotion has already been approved or dismissed.", decision: null };
  }

  const decision: PolicyDecisionRecord = {
    id: newId(),
    podcastId: input.podcastId,
    outcome: "rejected",
    code: "human_dismissed",
    reason: input.reason?.trim() || "A reviewer declined this staged change.",
    resultingVersion: null,
    detail: { dismissedDecisionId: staged.id, stagedReason: staged.reason },
    actor: humanActor,
    decidedAt: now,
  };
  await store.insertPolicyDecision(decision);
  return { dismissed: true, decision };
}

/* ------------------------------------------------------------------ */
/* 4. Turning aggregates into a candidate proposal (the automated leg). */
/* ------------------------------------------------------------------ */

export interface ColdOpenProposal {
  proposal: PolicyProposal;
  comparison: PolicyComparison;
  winner: string;
  challenger: string;
}

/**
 * The automated candidate: nudge this show's cold-open priors toward whichever
 * archetype is actually winning its blind pairwise tests. The nudge is bounded
 * by ADJUSTABLE_POLICY_FIELDS (floor 0.15, ceiling 0.5, at most 0.1 per
 * promotion), so a run of wins narrows the show's opening style without ever
 * deleting one — and the change still has to clear the sample/confidence gate.
 */
export function proposeColdOpenWeightChange(input: {
  aggregates: LearningAggregateRow[];
  current: Record<string, unknown>;
  step?: number;
}): ColdOpenProposal | null {
  const bound = ADJUSTABLE_POLICY_FIELDS.coldOpenArchetypeWeights;
  const rows = input.aggregates
    .filter((r) => r.scopeKind === "opening_variant" && r.signalKey === "cold_open_pairwise")
    .sort((a, b) => b.mean - a.mean || a.scopeKey.localeCompare(b.scopeKey));
  if (rows.length < 2) return null;

  const winner = rows[0];
  const challenger = rows[rows.length - 1];
  if (winner.scopeKey === challenger.scopeKey) return null;

  const currentMap = isPlainObject(input.current.coldOpenArchetypeWeights)
    ? (input.current.coldOpenArchetypeWeights as Record<string, number>)
    : (DEFAULT_POLICY_PREFERENCES.coldOpenArchetypeWeights as Record<string, number>);

  const step = Math.min(input.step ?? bound.maxStep, bound.maxStep);
  const next: Record<string, number> = {};
  for (const key of bound.keys) {
    const from = Number(currentMap[key] ?? 1 / bound.keys.length);
    const delta = key === winner.scopeKey ? step : key === challenger.scopeKey ? -step : 0;
    // Clamp into the field's absolute bounds AND into the step window around
    // the current value. Deliberately NOT rounded for display: rounding a
    // candidate can push it a fraction past the very step cap it was built to
    // respect, and the validator would then (correctly) refuse the change.
    const bounded = Math.min(bound.max, Math.max(bound.min, from + delta));
    next[key] = Math.min(from + step, Math.max(from - step, bounded));
  }

  return {
    proposal: { coldOpenArchetypeWeights: next },
    comparison: {
      signalKey: "cold_open_pairwise",
      scopeKind: "opening_variant",
      winnerScopeKey: winner.scopeKey,
      challengerScopeKey: challenger.scopeKey,
    },
    winner: winner.scopeKey,
    challenger: challenger.scopeKey,
  };
}

/** One call: derive a candidate from this show's aggregates and try to promote it. */
export async function runLearningPromotionCycle(
  store: LearningStore,
  input: { podcastId: string; aggregates: LearningAggregateRow[]; events?: LearningEventRecord[]; actor: string; thresholds?: Partial<PromotionThresholds>; now?: Date }
): Promise<PromotionResult | { promoted: false; code: "no_candidate"; reason: string; decision: null }> {
  const now = input.now ?? new Date();
  const active = await getActivePolicyVersion(store, input.podcastId, now);
  const scoped = input.aggregates.filter((a) => a.podcastId === input.podcastId);
  const candidate = proposeColdOpenWeightChange({ aggregates: scoped, current: active.preferences });
  if (!candidate) {
    return { promoted: false, code: "no_candidate", reason: "Not enough distinct cold-open arms to compare.", decision: null };
  }
  return promoteProductionPolicy(store, {
    podcastId: input.podcastId,
    proposal: candidate.proposal,
    comparison: candidate.comparison,
    aggregates: scoped,
    events: input.events,
    actor: input.actor,
    thresholds: input.thresholds,
    now,
  });
}
