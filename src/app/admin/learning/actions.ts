"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, adminIdentity } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import {
  AGGREGATE_SCOPE_KINDS,
  LEARNING_SIGNALS,
  LEARNING_SIGNAL_KEYS,
  LEARNING_RETENTION_DAYS,
  createPrismaLearningStore,
  purgeExpiredLearningEvents,
  recomputeAggregates,
  type AggregateScopeKind,
  type LearningSignalKey,
} from "@/lib/services/listenerLearning";
import {
  ADJUSTABLE_POLICY_FIELDS,
  IMMUTABLE_POLICY_RULES,
  DEFAULT_PROMOTION_THRESHOLDS,
  getActivePolicyVersion,
  rollbackProductionPolicy,
  runLearningPromotionCycle,
} from "@/lib/services/productionPolicy";

/* ---------------------------------------------------------------- */
/* View models (all dates serialized — server components only pass   */
/* plain data to the client component).                              */
/* ---------------------------------------------------------------- */

export interface AggregateRowVm {
  scopeKind: AggregateScopeKind;
  scopeKey: string;
  scopeLabel: string;
  signalKey: LearningSignalKey;
  signalLabel: string;
  direction: "higher_better" | "lower_better";
  unit: string;
  sampleSize: number;
  mean: number;
  marginOfError: number;
  confidence: "low" | "moderate" | "high";
  windowStart: string;
  windowEnd: string;
}

export interface PolicyVersionVm {
  version: number;
  status: string;
  preferences: Record<string, unknown>;
  rationale: string;
  evidence: Record<string, unknown>;
  promotedFromVersion: number | null;
  promotedBy: string | null;
  promotedAt: string;
  rolledBackAt: string | null;
  rolledBackBy: string | null;
  rolledBackReason: string | null;
}

export interface PolicyDecisionVm {
  outcome: string;
  code: string;
  reason: string;
  resultingVersion: number | null;
  actor: string | null;
  decidedAt: string;
}

export interface LearningViewData {
  shows: { id: string; name: string }[];
  podcastId: string | null;
  podcastName: string | null;
  rawEventCount: number;
  consentedEventCount: number;
  signals: { key: LearningSignalKey; label: string; source: string; unit: string; direction: string }[];
  aggregates: AggregateRowVm[];
  scopeKinds: AggregateScopeKind[];
  policyVersions: PolicyVersionVm[];
  decisions: PolicyDecisionVm[];
  activeVersion: number | null;
  adjustableFields: { field: string; label: string; bound: string }[];
  immutableFields: string[];
  thresholds: typeof DEFAULT_PROMOTION_THRESHOLDS;
  retentionDays: number;
  error: string | null;
}

const SCOPE_LABELS: Record<AggregateScopeKind, string> = {
  episode: "Episode",
  show: "Show",
  format: "Format",
  opening_variant: "Opening variant",
  host_pair: "Host pair",
  voice_policy: "Voice policy version",
  production_policy: "Production policy version",
};

export async function scopeLabel(kind: AggregateScopeKind): Promise<string> {
  return SCOPE_LABELS[kind];
}

function boundSummary(field: string): string {
  const b = ADJUSTABLE_POLICY_FIELDS[field as keyof typeof ADJUSTABLE_POLICY_FIELDS] as
    | { kind: string; min?: number; max?: number; maxStep?: number; options?: readonly string[] }
    | undefined;
  if (!b) return "";
  if (b.kind === "number") return `${b.min} … ${b.max} (max ±${b.maxStep} per promotion)`;
  if (b.kind === "weight_map") return `each weight ${b.min} … ${b.max} (max ±${b.maxStep} per promotion)`;
  if (b.kind === "enum") return (b.options ?? []).join(" | ");
  return "true | false";
}

/* ---------------------------------------------------------------- */
/* Reads                                                             */
/* ---------------------------------------------------------------- */

export async function fetchLearningData(podcastId?: string | null): Promise<LearningViewData> {
  await requireAdmin();

  const base: LearningViewData = {
    shows: [],
    podcastId: null,
    podcastName: null,
    rawEventCount: 0,
    consentedEventCount: 0,
    signals: LEARNING_SIGNAL_KEYS.map((key) => ({
      key,
      label: LEARNING_SIGNALS[key].label,
      source: LEARNING_SIGNALS[key].source,
      unit: LEARNING_SIGNALS[key].unit,
      direction: LEARNING_SIGNALS[key].direction,
    })),
    aggregates: [],
    scopeKinds: AGGREGATE_SCOPE_KINDS,
    policyVersions: [],
    decisions: [],
    activeVersion: null,
    adjustableFields: Object.keys(ADJUSTABLE_POLICY_FIELDS).map((field) => ({
      field,
      label: (ADJUSTABLE_POLICY_FIELDS[field as keyof typeof ADJUSTABLE_POLICY_FIELDS] as { label: string }).label,
      bound: boundSummary(field),
    })),
    immutableFields: Object.keys(IMMUTABLE_POLICY_RULES),
    thresholds: DEFAULT_PROMOTION_THRESHOLDS,
    retentionDays: LEARNING_RETENTION_DAYS,
    error: null,
  };

  try {
    const shows = await db.podcast.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
    base.shows = shows;
    const selected = podcastId && shows.some((s) => s.id === podcastId) ? podcastId : shows[0]?.id ?? null;
    if (!selected) return base;

    base.podcastId = selected;
    base.podcastName = shows.find((s) => s.id === selected)?.name ?? null;

    const store = createPrismaLearningStore(db);
    const [events, aggregates, versions, decisions] = await Promise.all([
      store.listEvents({ podcastId: selected }),
      store.listAggregates(selected),
      store.listPolicyVersions(selected),
      store.listPolicyDecisions(selected),
    ]);

    base.rawEventCount = events.length;
    base.consentedEventCount = events.filter((e) => e.consented).length;
    base.aggregates = aggregates
      .map((a) => ({
        scopeKind: a.scopeKind,
        scopeKey: a.scopeKey,
        scopeLabel: SCOPE_LABELS[a.scopeKind],
        signalKey: a.signalKey,
        signalLabel: LEARNING_SIGNALS[a.signalKey]?.label ?? a.signalKey,
        direction: LEARNING_SIGNALS[a.signalKey]?.direction ?? "higher_better",
        unit: LEARNING_SIGNALS[a.signalKey]?.unit ?? "ratio",
        sampleSize: a.sampleSize,
        mean: a.mean,
        marginOfError: a.marginOfError,
        confidence: a.confidence,
        windowStart: a.windowStart.toISOString(),
        windowEnd: a.windowEnd.toISOString(),
      }))
      .sort((x, y) => x.scopeKind.localeCompare(y.scopeKind) || x.scopeKey.localeCompare(y.scopeKey) || x.signalKey.localeCompare(y.signalKey));

    base.policyVersions = versions
      .map((v) => ({
        version: v.version,
        status: v.status,
        preferences: v.preferences,
        rationale: v.rationale,
        evidence: v.evidence,
        promotedFromVersion: v.promotedFromVersion,
        promotedBy: v.promotedBy,
        promotedAt: v.promotedAt.toISOString(),
        rolledBackAt: v.rolledBackAt ? v.rolledBackAt.toISOString() : null,
        rolledBackBy: v.rolledBackBy,
        rolledBackReason: v.rolledBackReason,
      }))
      .sort((a, b) => b.version - a.version);
    base.activeVersion = versions.find((v) => v.status === "active")?.version ?? null;

    base.decisions = decisions
      .map((d) => ({
        outcome: d.outcome,
        code: d.code,
        reason: d.reason,
        resultingVersion: d.resultingVersion,
        actor: d.actor,
        decidedAt: d.decidedAt.toISOString(),
      }))
      .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
      .slice(0, 40);
  } catch (e) {
    base.error = e instanceof Error ? e.message : "Failed to load learning data.";
  }

  return base;
}

/* ---------------------------------------------------------------- */
/* Writes                                                            */
/* ---------------------------------------------------------------- */

export async function recomputeLearningAggregates(podcastId: string): Promise<{ success: boolean; rows?: number; error?: string }> {
  await requireAdmin();
  try {
    const store = createPrismaLearningStore(db);
    const rows = await recomputeAggregates(store, podcastId, { aliveAt: new Date() });
    revalidatePath("/admin/learning");
    return { success: true, rows: rows.length };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Recompute failed." };
  }
}

/**
 * Run one closed-loop cycle for ONE show: recompute this show's aggregates from
 * its raw events, derive a bounded candidate, and either promote it or record
 * why it was refused. No other show is read or written.
 */
export async function runPolicyCycle(podcastId: string): Promise<{ success: boolean; promoted?: boolean; message?: string; error?: string }> {
  await requireAdmin();
  try {
    const store = createPrismaLearningStore(db);
    const aggregates = await recomputeAggregates(store, podcastId, { aliveAt: new Date() });
    const events = await store.listEvents({ podcastId });
    const result = await runLearningPromotionCycle(store, {
      podcastId,
      aggregates,
      events,
      actor: adminIdentity(),
    });
    revalidatePath("/admin/learning");
    if (result.promoted) {
      return { success: true, promoted: true, message: `Promoted to v${result.version.version}: ${result.version.rationale}` };
    }
    return { success: true, promoted: false, message: `No change (${result.code}): ${result.reason}` };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Policy cycle failed." };
  }
}

export async function rollbackPolicy(podcastId: string, reason: string): Promise<{ success: boolean; message?: string; error?: string }> {
  await requireAdmin();
  try {
    const store = createPrismaLearningStore(db);
    const result = await rollbackProductionPolicy(store, { podcastId, actor: adminIdentity(), reason: reason || "Operator rollback." });
    revalidatePath("/admin/learning");
    if (result.rolledBack) return { success: true, message: `Restored v${result.restoredVersion.version} exactly.` };
    return { success: true, message: `Nothing to roll back: ${result.reason}` };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Rollback failed." };
  }
}

export async function purgeExpiredLearningData(): Promise<{ success: boolean; removed?: number; error?: string }> {
  await requireAdmin();
  try {
    const store = createPrismaLearningStore(db);
    const removed = await purgeExpiredLearningEvents(store, new Date());
    revalidatePath("/admin/learning");
    return { success: true, removed };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Purge failed." };
  }
}

export async function currentPolicySummary(podcastId: string): Promise<{ version: number; preferences: Record<string, unknown> } | null> {
  await requireAdmin();
  try {
    const store = createPrismaLearningStore(db);
    const active = await getActivePolicyVersion(store, podcastId);
    return { version: active.version, preferences: active.preferences };
  } catch {
    return null;
  }
}
