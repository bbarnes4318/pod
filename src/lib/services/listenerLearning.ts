// CLOSED LISTENER-LEARNING LOOP — collection + aggregation half.
//
// ===========================================================================
// READ THIS FIRST: ANONYMOUS TRAFFIC DOES NOT AUTO-PROMOTE ANYTHING.
//
// /api/learning/* is a PUBLIC endpoint. Everything it collects is, by
// construction, from an unauthenticated stranger who chooses their own
// "listener id". The controls in section 8 (signed context, strict per-signal
// validation, dedupe, per-listener and per-source rate limits, one-shot
// pairwise trials, credible-listener counting) raise the cost of manufacturing
// an audience from "a for-loop" to "a distributed botnet with a real IP
// spread". They do NOT make the data trustworthy in the sense a promotion
// needs, and pretending otherwise with a bigger threshold would be dishonest:
//
//   • A listener id is self-asserted. The only independence evidence we have
//     is the source IP bucket, and IPs are rentable.
//   • listenerHash rotates per UTC day for privacy, so the SAME person is a
//     new "listener" tomorrow. The per-source credible cap (section 8.6) is
//     what bounds that, and it is a heuristic, not a proof.
//   • There is no bot check on this surface, by design — a CAPTCHA on a
//     podcast player is not something this project is going to ship.
//
// Therefore: a promotion whose deciding signal came from the public endpoint
// (source "listener" or "panel") is STAGED, never applied. A human approves it
// in /admin/learning. See productionPolicy.ts → promoteProductionPolicy(),
// runLearningPromotionCycle(), approveStagedPolicyPromotion().
// Production-sourced signals (derived server-side from real artifacts, never
// client-reported) may still promote automatically — a client cannot reach them.
// ===========================================================================
//
// Retention storage on its own is not a loop. This module is the first two
// legs of one:
//
//   collect (raw, attributable, consented, hashed)
//        -> aggregate (derived, recomputable, with sample size + confidence)
//        -> [productionPolicy.ts] evaluate -> promote/reject -> rollback
//
// TWO STORAGE LAYERS, ON PURPOSE
//   • ListenerLearningEvent     RAW. Append-only. THE RECORD.
//   • ListenerLearningAggregate DERIVED. Truncate-and-rebuild safe; every row
//     is reproduced exactly by computeAggregates() from the raw events.
//   Nothing downstream may treat an aggregate as evidence the raw events
//   cannot regenerate — that is what makes the loop auditable.
//
// PRIVACY
//   • No raw identifier is ever persisted. Listener ids are salted-hashed with
//     the existing ANALYTICS_HASH_SALT convention (see analyticsService.ts).
//   • Collection from listeners/panels is gated on an EXPLICIT consent flag.
//   • Geo is 2-letter ISO country at most, and only from an edge header.
//   • Free-form metadata is sanitized: PII-shaped keys and values are dropped
//     before write, not after.
//   • Every row carries `expiresAt`; purgeExpiredLearningEvents() is the
//     documented purge path (see PURGE PATH below).
//
// PERSISTENCE IS INJECTABLE (LearningStore). The Prisma implementation is the
// production one; the in-memory implementation is what the executed tests run
// against, so the loop is provable without a database.

import crypto from "node:crypto";
import { findRepetitions } from "./scriptRepetition";

/* ------------------------------------------------------------------ */
/* 1. The 14 signals.                                                  */
/* ------------------------------------------------------------------ */

export type LearningSource = "listener" | "panel" | "production";
export type LearningUnit = "ratio" | "score_0_1" | "usd_per_minute";

export interface LearningSignalDescriptor {
  label: string;
  source: LearningSource;
  unit: LearningUnit;
  /** Which way is better. Used by the dashboard and by policy evaluation. */
  direction: "higher_better" | "lower_better";
  min: number;
  max: number;
}

export const LEARNING_SIGNALS = {
  // --- from listeners --------------------------------------------------
  retention_15s: { label: "15-second retention", source: "listener", unit: "ratio", direction: "higher_better", min: 0, max: 1 },
  retention_60s: { label: "60-second retention", source: "listener", unit: "ratio", direction: "higher_better", min: 0, max: 1 },
  retention_180s: { label: "Minute-three retention", source: "listener", unit: "ratio", direction: "higher_better", min: 0, max: 1 },
  completion: { label: "Completion", source: "listener", unit: "ratio", direction: "higher_better", min: 0, max: 1 },
  next_episode_play: { label: "Next-episode play", source: "listener", unit: "ratio", direction: "higher_better", min: 0, max: 1 },
  cold_open_pairwise: { label: "Cold-open pairwise win", source: "listener", unit: "ratio", direction: "higher_better", min: 0, max: 1 },
  // --- from the controlled panel ---------------------------------------
  sounds_human: { label: '"Sounds human" rating', source: "panel", unit: "score_0_1", direction: "higher_better", min: 0, max: 1 },
  host_distinguishability: { label: "Host distinguishability", source: "panel", unit: "score_0_1", direction: "higher_better", min: 0, max: 1 },
  // --- measured on the production side ---------------------------------
  unsupported_claim_rate: { label: "Unsupported-claim rate", source: "production", unit: "ratio", direction: "lower_better", min: 0, max: 1 },
  repeated_point_rate: { label: "Repeated-point rate", source: "production", unit: "ratio", direction: "lower_better", min: 0, max: 1 },
  voice_regeneration_rate: { label: "Voice-regeneration rate", source: "production", unit: "ratio", direction: "lower_better", min: 0, max: 1 },
  transcript_word_error_rate: { label: "Transcript word-error rate", source: "production", unit: "ratio", direction: "lower_better", min: 0, max: 1 },
  speaker_attribution_error_rate: { label: "Speaker-attribution errors", source: "production", unit: "ratio", direction: "lower_better", min: 0, max: 1 },
  cost_per_publishable_minute: { label: "Cost per publishable minute", source: "production", unit: "usd_per_minute", direction: "lower_better", min: 0, max: 1000 },
} as const satisfies Record<string, LearningSignalDescriptor>;

export type LearningSignalKey = keyof typeof LEARNING_SIGNALS;

export const LEARNING_SIGNAL_KEYS = Object.keys(LEARNING_SIGNALS) as LearningSignalKey[];

export function isLearningSignalKey(v: unknown): v is LearningSignalKey {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(LEARNING_SIGNALS, v);
}

export function signalDescriptor(key: LearningSignalKey): LearningSignalDescriptor {
  return LEARNING_SIGNALS[key] as LearningSignalDescriptor;
}

/* ------------------------------------------------------------------ */
/* 2. Privacy primitives.                                              */
/* ------------------------------------------------------------------ */

/** How long a raw learning event may live before the purge path removes it. */
export const LEARNING_RETENTION_DAYS = 180;

/** Same env convention analyticsService.ts uses. */
function analyticsSalt(): string {
  return process.env.ANALYTICS_HASH_SALT || "take-machine-analytics";
}

export function utcDayBucket(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Salted hash of a listener/panelist identifier.
 *
 * The raw value NEVER leaves this function. `epoch` is the rotation window: a
 * listener hashes STABLY inside one epoch (so retention for a session can be
 * joined) and UNLINKABLY across epochs (so a hash cannot be used to follow a
 * person over time). Callers running a bounded experiment pass the experiment's
 * epoch; the default is the UTC day, matching the existing analytics convention.
 */
export function hashListenerId(rawId: string, opts: { epoch?: string; salt?: string } = {}): string {
  const epoch = opts.epoch ?? utcDayBucket();
  const salt = opts.salt ?? analyticsSalt();
  return crypto.createHash("sha256").update(`${rawId}|${epoch}|${salt}`).digest("hex").slice(0, 32);
}

/** Keys whose NAME alone means the value is potentially identifying. */
const PII_KEY_PATTERN =
  /(email|mail|ip|ipaddr|phone|tel|first_?name|last_?name|full_?name|username|address|street|postal|zip|user[_-]?agent|useragent|\bua\b|cookie|session|referrer|referer|latitude|longitude|\blat\b|\blon\b|\blng\b|dob|birth|ssn|raw)/i;

/** Values that LOOK identifying regardless of the key they arrived under. */
const PII_VALUE_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.]+/, // email
  /\b\d{1,3}(\.\d{1,3}){3}\b/, // IPv4
  /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/i, // IPv6-ish
  /\b\+?\d[\d\s().-]{8,}\d\b/, // phone-ish
];

/**
 * Strip identifying material from caller-supplied context BEFORE it is written.
 * Returns the surviving keys plus the names of what was dropped, so a dropped
 * field is visible in the admin surface rather than silently swallowed.
 */
export function sanitizeMetadata(input: unknown): { clean: Record<string, unknown> | null; dropped: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { clean: null, dropped: [] };
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (PII_KEY_PATTERN.test(key)) {
      dropped.push(key);
      continue;
    }
    if (typeof value === "string" && PII_VALUE_PATTERNS.some((re) => re.test(value))) {
      dropped.push(key);
      continue;
    }
    if (value !== null && typeof value === "object") {
      // Nested objects are not worth the audit surface; keep the loop honest.
      dropped.push(key);
      continue;
    }
    clean[key] = value;
  }
  return { clean: Object.keys(clean).length ? clean : null, dropped };
}

/** 2-letter ISO country from an edge geo header, or null. Nothing finer. */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw || !/^[A-Za-z]{2}$/.test(raw)) return null;
  const up = raw.toUpperCase();
  return up === "XX" ? null : up;
}

export function countryFromHeaders(headers: Headers): string | null {
  return normalizeCountry(
    headers.get("cf-ipcountry") ||
      headers.get("x-vercel-ip-country") ||
      headers.get("x-geo-country") ||
      headers.get("x-country-code")
  );
}

/* ------------------------------------------------------------------ */
/* 3. Records + the injectable store.                                  */
/* ------------------------------------------------------------------ */

export interface LearningEventRecord {
  id: string;
  signalKey: LearningSignalKey;
  source: LearningSource;
  episodeId: string | null;
  podcastId: string | null;
  formatId: string | null;
  openingVariant: string | null;
  hostPairKey: string | null;
  voicePolicyVersion: number | null;
  productionPolicyVersion: number | null;
  listenerHash: string | null;
  cohort: string | null;
  consented: boolean;
  country: string | null;
  value: number;
  unit: LearningUnit;
  occurredAt: Date;
  expiresAt: Date;
  metadata: Record<string, unknown> | null;
}

export type AggregateScopeKind =
  | "episode"
  | "show"
  | "format"
  | "opening_variant"
  | "host_pair"
  | "voice_policy"
  | "production_policy";

export const AGGREGATE_SCOPE_KINDS: AggregateScopeKind[] = [
  "episode",
  "show",
  "format",
  "opening_variant",
  "host_pair",
  "voice_policy",
  "production_policy",
];

export type ConfidenceLabel = "low" | "moderate" | "high";

export interface LearningAggregateRow {
  podcastId: string;
  scopeKind: AggregateScopeKind;
  scopeKey: string;
  signalKey: LearningSignalKey;
  sampleSize: number;
  mean: number;
  sum: number;
  minValue: number;
  maxValue: number;
  stdDev: number;
  marginOfError: number;
  confidence: ConfidenceLabel;
  windowStart: Date;
  windowEnd: Date;
}

export interface ColdOpenTrialRecord {
  id: string;
  trialToken: string;
  episodeId: string | null;
  podcastId: string | null;
  slotAVariantId: string;
  slotBVariantId: string;
  listenerHash: string | null;
  consented: boolean;
  country: string | null;
  winnerSlot: "A" | "B" | null;
  winnerVariantId: string | null;
  decidedAt: Date | null;
  servedAt: Date;
  expiresAt: Date;
}

export interface PolicyVersionRecord {
  id: string;
  podcastId: string;
  version: number;
  status: "active" | "superseded" | "rolled_back";
  preferences: Record<string, unknown>;
  immutableRules: Record<string, unknown>;
  rationale: string;
  evidence: Record<string, unknown>;
  promotedFromVersion: number | null;
  promotedBy: string | null;
  promotedAt: Date;
  rolledBackAt: Date | null;
  rolledBackBy: string | null;
  rolledBackReason: string | null;
}

export interface PolicyDecisionRecord {
  id: string;
  podcastId: string;
  /**
   * "staged" = the evidence cleared every automated gate but the deciding
   * signal came from the public endpoint, so a human must approve it. The
   * decision's `detail` carries the exact bounded proposal and the stats.
   */
  outcome: "promoted" | "rejected" | "rolled_back" | "staged";
  code: string;
  reason: string;
  resultingVersion: number | null;
  detail: Record<string, unknown> | null;
  actor: string | null;
  decidedAt: Date;
}

/**
 * Every persistence touch the loop makes. Implementations MUST scope every
 * read and write by podcastId where the signature offers one — show isolation
 * is enforced here as well as in productionPolicy.ts.
 */
export interface LearningStore {
  insertEvents(events: LearningEventRecord[]): Promise<void>;
  listEvents(filter?: { podcastId?: string; since?: Date; aliveAt?: Date }): Promise<LearningEventRecord[]>;
  deleteEventsExpiredBefore(now: Date): Promise<number>;
  /**
   * DEDUPE READ. How many events already exist for this exact
   * (listener, episode, signal) triple. See SIGNAL_INTAKE_RULES for the
   * per-signal dedupe key this backs.
   */
  countEvents(filter: { signalKey: LearningSignalKey; listenerHash: string; episodeId: string | null }): Promise<number>;

  replaceAggregates(podcastId: string, rows: LearningAggregateRow[]): Promise<void>;
  listAggregates(podcastId: string): Promise<LearningAggregateRow[]>;

  insertColdOpenTrial(trial: ColdOpenTrialRecord): Promise<void>;
  findColdOpenTrial(trialToken: string): Promise<ColdOpenTrialRecord | null>;
  updateColdOpenTrial(trialToken: string, patch: Partial<ColdOpenTrialRecord>): Promise<void>;
  /**
   * REPLAY PROTECTION, compare-and-set. Marks an UNDECIDED trial decided and
   * returns true; returns false if it was already decided. This is the single
   * point that makes "a trial resolves once" an invariant rather than a
   * read-then-write race — the Prisma implementation pushes the condition into
   * the WHERE clause so two concurrent votes cannot both win.
   */
  claimColdOpenTrial(trialToken: string, patch: Partial<ColdOpenTrialRecord>): Promise<boolean>;

  listPolicyVersions(podcastId: string): Promise<PolicyVersionRecord[]>;
  insertPolicyVersion(version: PolicyVersionRecord): Promise<void>;
  updatePolicyVersion(podcastId: string, version: number, patch: Partial<PolicyVersionRecord>): Promise<void>;
  insertPolicyDecision(decision: PolicyDecisionRecord): Promise<void>;
  listPolicyDecisions(podcastId: string): Promise<PolicyDecisionRecord[]>;
}

function newId(): string {
  return crypto.randomUUID();
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

/* ------------------------------------------------------------------ */
/* 3a. In-memory store (tests, dry runs).                              */
/* ------------------------------------------------------------------ */

export interface InMemoryLearningStore extends LearningStore {
  /** Direct read of everything persisted — used by tests to inspect rows. */
  dump(): {
    events: LearningEventRecord[];
    aggregates: LearningAggregateRow[];
    trials: ColdOpenTrialRecord[];
    policyVersions: PolicyVersionRecord[];
    policyDecisions: PolicyDecisionRecord[];
  };
}

export function createInMemoryLearningStore(): InMemoryLearningStore {
  const events: LearningEventRecord[] = [];
  const aggregates: LearningAggregateRow[] = [];
  const trials: ColdOpenTrialRecord[] = [];
  const policyVersions: PolicyVersionRecord[] = [];
  const policyDecisions: PolicyDecisionRecord[] = [];

  return {
    async insertEvents(rows) {
      for (const r of rows) events.push(clone(r));
    },
    async listEvents(filter = {}) {
      return events
        .filter((e) => (filter.podcastId ? e.podcastId === filter.podcastId : true))
        .filter((e) => (filter.since ? e.occurredAt >= filter.since : true))
        .filter((e) => (filter.aliveAt ? e.expiresAt > filter.aliveAt : true))
        .map(clone);
    },
    async deleteEventsExpiredBefore(now) {
      let removed = 0;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].expiresAt <= now) {
          events.splice(i, 1);
          removed++;
        }
      }
      return removed;
    },
    async countEvents(filter) {
      return events.filter(
        (e) => e.signalKey === filter.signalKey && e.listenerHash === filter.listenerHash && (e.episodeId ?? null) === (filter.episodeId ?? null)
      ).length;
    },
    async replaceAggregates(podcastId, rows) {
      for (let i = aggregates.length - 1; i >= 0; i--) {
        if (aggregates[i].podcastId === podcastId) aggregates.splice(i, 1);
      }
      for (const r of rows) aggregates.push(clone(r));
    },
    async listAggregates(podcastId) {
      return aggregates.filter((a) => a.podcastId === podcastId).map(clone);
    },
    async insertColdOpenTrial(trial) {
      trials.push(clone(trial));
    },
    async findColdOpenTrial(trialToken) {
      const found = trials.find((t) => t.trialToken === trialToken);
      return found ? clone(found) : null;
    },
    async updateColdOpenTrial(trialToken, patch) {
      const found = trials.find((t) => t.trialToken === trialToken);
      if (found) Object.assign(found, clone(patch));
    },
    async claimColdOpenTrial(trialToken, patch) {
      const found = trials.find((t) => t.trialToken === trialToken && t.decidedAt == null);
      if (!found) return false;
      Object.assign(found, clone(patch));
      return true;
    },
    async listPolicyVersions(podcastId) {
      return policyVersions.filter((v) => v.podcastId === podcastId).map(clone).sort((a, b) => a.version - b.version);
    },
    async insertPolicyVersion(version) {
      policyVersions.push(clone(version));
    },
    async updatePolicyVersion(podcastId, version, patch) {
      const found = policyVersions.find((v) => v.podcastId === podcastId && v.version === version);
      if (found) Object.assign(found, clone(patch));
    },
    async insertPolicyDecision(decision) {
      policyDecisions.push(clone(decision));
    },
    async listPolicyDecisions(podcastId) {
      return policyDecisions.filter((d) => d.podcastId === podcastId).map(clone);
    },
    dump() {
      return {
        events: events.map(clone),
        aggregates: aggregates.map(clone),
        trials: trials.map(clone),
        policyVersions: policyVersions.map(clone),
        policyDecisions: policyDecisions.map(clone),
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* 3b. Prisma store.                                                   */
/* ------------------------------------------------------------------ */

// The delegates are reached structurally rather than through the generated
// client types. Two reasons: (1) `prisma generate` is a separate, manual step
// in this repo, and a service that fails to COMPILE until someone remembers to
// run it is a worse failure mode than one that fails to QUERY; (2) it keeps
// this module free of a hard @prisma/client type dependency so the executed
// tests can run it with no database at all.
interface PrismaDelegate {
  create(args: { data: unknown }): Promise<unknown>;
  createMany?(args: { data: unknown[] }): Promise<unknown>;
  findMany(args?: unknown): Promise<unknown[]>;
  findUnique(args: unknown): Promise<unknown>;
  count?(args: unknown): Promise<number>;
  update(args: unknown): Promise<unknown>;
  updateMany?(args: unknown): Promise<{ count: number }>;
  deleteMany(args: unknown): Promise<{ count: number }>;
}

type PrismaLike = Record<string, PrismaDelegate>;

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(String(v));
}
function asDateOrNull(v: unknown): Date | null {
  return v == null ? null : asDate(v);
}

/** Production store. `client` is the Prisma client (src/lib/db). */
export function createPrismaLearningStore(client: unknown): LearningStore {
  const db = client as PrismaLike;
  return {
    async insertEvents(rows) {
      if (!rows.length) return;
      await db.listenerLearningEvent.createMany!({ data: rows.map((r) => ({ ...r })) });
    },
    async listEvents(filter = {}) {
      const where: Record<string, unknown> = {};
      if (filter.podcastId) where.podcastId = filter.podcastId;
      if (filter.since) where.occurredAt = { gte: filter.since };
      if (filter.aliveAt) where.expiresAt = { gt: filter.aliveAt };
      const rows = (await db.listenerLearningEvent.findMany({ where, orderBy: { occurredAt: "asc" } })) as Record<string, unknown>[];
      return rows.map((r) => ({
        ...(r as unknown as LearningEventRecord),
        occurredAt: asDate(r.occurredAt),
        expiresAt: asDate(r.expiresAt),
      }));
    },
    async deleteEventsExpiredBefore(now) {
      const res = await db.listenerLearningEvent.deleteMany({ where: { expiresAt: { lte: now } } });
      return res.count;
    },
    async countEvents(filter) {
      // Uses the @@index([episodeId, signalKey]) / @@index([listenerHash]) pair.
      return db.listenerLearningEvent.count!({
        where: { signalKey: filter.signalKey, listenerHash: filter.listenerHash, episodeId: filter.episodeId ?? null },
      });
    },
    async replaceAggregates(podcastId, rows) {
      await db.listenerLearningAggregate.deleteMany({ where: { podcastId } });
      if (rows.length) await db.listenerLearningAggregate.createMany!({ data: rows.map((r) => ({ ...r })) });
    },
    async listAggregates(podcastId) {
      const rows = (await db.listenerLearningAggregate.findMany({ where: { podcastId } })) as Record<string, unknown>[];
      return rows.map((r) => ({
        ...(r as unknown as LearningAggregateRow),
        windowStart: asDate(r.windowStart),
        windowEnd: asDate(r.windowEnd),
      }));
    },
    async insertColdOpenTrial(trial) {
      await db.coldOpenPairwiseTrial.create({ data: { ...trial } });
    },
    async findColdOpenTrial(trialToken) {
      const row = (await db.coldOpenPairwiseTrial.findUnique({ where: { trialToken } })) as Record<string, unknown> | null;
      if (!row) return null;
      return {
        ...(row as unknown as ColdOpenTrialRecord),
        servedAt: asDate(row.servedAt),
        expiresAt: asDate(row.expiresAt),
        decidedAt: asDateOrNull(row.decidedAt),
      };
    },
    async updateColdOpenTrial(trialToken, patch) {
      await db.coldOpenPairwiseTrial.update({ where: { trialToken }, data: { ...patch } });
    },
    async claimColdOpenTrial(trialToken, patch) {
      // The `decidedAt: null` predicate lives in the WHERE clause, so the
      // database — not this process — decides who wins a concurrent replay.
      const res = await db.coldOpenPairwiseTrial.updateMany!({ where: { trialToken, decidedAt: null }, data: { ...patch } });
      return res.count === 1;
    },
    async listPolicyVersions(podcastId) {
      const rows = (await db.productionPolicyVersion.findMany({ where: { podcastId }, orderBy: { version: "asc" } })) as Record<string, unknown>[];
      return rows.map((r) => ({
        ...(r as unknown as PolicyVersionRecord),
        promotedAt: asDate(r.promotedAt),
        rolledBackAt: asDateOrNull(r.rolledBackAt),
      }));
    },
    async insertPolicyVersion(version) {
      await db.productionPolicyVersion.create({ data: { ...version } });
    },
    async updatePolicyVersion(podcastId, version, patch) {
      // updateMany with BOTH keys: an update that could ever match another
      // show's row is exactly the homogenization risk this design forbids.
      await db.productionPolicyVersion.updateMany!({ where: { podcastId, version }, data: { ...patch } });
    },
    async insertPolicyDecision(decision) {
      await db.productionPolicyDecision.create({ data: { ...decision } });
    },
    async listPolicyDecisions(podcastId) {
      const rows = (await db.productionPolicyDecision.findMany({ where: { podcastId }, orderBy: { decidedAt: "desc" } })) as Record<string, unknown>[];
      return rows.map((r) => ({ ...(r as unknown as PolicyDecisionRecord), decidedAt: asDate(r.decidedAt) }));
    },
  };
}

/* ------------------------------------------------------------------ */
/* 4. Collection.                                                      */
/* ------------------------------------------------------------------ */

export interface LearningEventInput {
  signalKey: LearningSignalKey;
  value: number;
  episodeId?: string | null;
  podcastId?: string | null;
  formatId?: string | null;
  openingVariant?: string | null;
  hostPairKey?: string | null;
  voicePolicyVersion?: number | null;
  productionPolicyVersion?: number | null;
  /** RAW identifier — hashed here and never persisted. Listener/panel only. */
  listenerId?: string | null;
  /** Pre-hashed identifier when the caller already hashed (e.g. a route). */
  listenerHash?: string | null;
  hashEpoch?: string;
  cohort?: string | null;
  /** Must be true for listener- and panel-sourced signals. */
  consented?: boolean;
  country?: string | null;
  occurredAt?: Date;
  retentionDays?: number;
  metadata?: Record<string, unknown> | null;
  /**
   * SERVER-ONLY attestation, applied AFTER metadata sanitization so a client
   * can never spoof it. `sourceKey` is the salted source bucket (see
   * hashSourceIp); `credible` means the event cleared every intake control in
   * section 8. Only attested events are counted by countCredibleListeners().
   */
  attestation?: { credible: boolean; sourceKey: string | null } | null;
}

export type CollectionResult =
  | { ok: true; event: LearningEventRecord; droppedMetadataKeys: string[] }
  | {
      ok: false;
      code: "unknown_signal" | "consent_required" | "identifier_required" | "identifier_forbidden" | "invalid_value" | "out_of_range";
      reason: string;
    };

/** Reserved metadata keys. A client-supplied key starting with `_` is refused. */
export const ATTESTATION_SOURCE_KEY = "_src";
export const ATTESTATION_CREDIBLE_KEY = "_credible";

/**
 * Build one raw event. Pure — no I/O — so the consent/PII rules are testable
 * without a store. `recordLearningEvents()` is the persisting wrapper.
 */
export function buildLearningEvent(input: LearningEventInput): CollectionResult {
  if (!isLearningSignalKey(input.signalKey)) {
    return { ok: false, code: "unknown_signal", reason: `Unknown signal "${String(input.signalKey)}".` };
  }
  const descriptor = signalDescriptor(input.signalKey);
  const fromPerson = descriptor.source === "listener" || descriptor.source === "panel";

  if (fromPerson && input.consented !== true) {
    return { ok: false, code: "consent_required", reason: `"${input.signalKey}" is ${descriptor.source}-sourced; explicit consent is required.` };
  }

  const rawId = input.listenerId ?? null;
  let listenerHash = input.listenerHash ?? null;
  if (rawId) listenerHash = hashListenerId(rawId, { epoch: input.hashEpoch });

  if (fromPerson && !listenerHash) {
    return { ok: false, code: "identifier_required", reason: `"${input.signalKey}" needs an anonymous listener identifier to deduplicate.` };
  }
  if (!fromPerson && listenerHash) {
    // A production-side measurement is a property of the EPISODE. Attaching a
    // person to it would create an identifiability surface for no benefit.
    return { ok: false, code: "identifier_forbidden", reason: `"${input.signalKey}" is a production measurement and must not carry a listener identifier.` };
  }

  // A non-finite value is refused, and so is an in-range-looking value that is
  // actually outside the signal's declared range. The previous behaviour CLAMPED
  // out-of-range input, which quietly turned "value: 1e9" into a perfect score.
  const value = Number(input.value);
  if (typeof input.value === "boolean" || input.value === null || !Number.isFinite(value)) {
    return { ok: false, code: "invalid_value", reason: `"${input.signalKey}" received a non-numeric value.` };
  }
  if (value < descriptor.min || value > descriptor.max) {
    return {
      ok: false,
      code: "out_of_range",
      reason: `"${input.signalKey}" must be within [${descriptor.min}, ${descriptor.max}]; got ${value}.`,
    };
  }

  const occurredAt = input.occurredAt ?? new Date();
  const retentionDays = input.retentionDays ?? LEARNING_RETENTION_DAYS;
  const { clean, dropped } = sanitizeMetadata(input.metadata);
  // Attestation is stamped LAST: sanitization can never strip it and caller
  // metadata can never impersonate it.
  const attested = input.attestation
    ? { ...(clean ?? {}), [ATTESTATION_CREDIBLE_KEY]: input.attestation.credible, [ATTESTATION_SOURCE_KEY]: input.attestation.sourceKey }
    : clean;

  return {
    ok: true,
    droppedMetadataKeys: dropped,
    event: {
      id: newId(),
      signalKey: input.signalKey,
      source: descriptor.source,
      episodeId: input.episodeId ?? null,
      podcastId: input.podcastId ?? null,
      formatId: input.formatId ?? null,
      openingVariant: input.openingVariant ?? null,
      hostPairKey: input.hostPairKey ?? null,
      voicePolicyVersion: input.voicePolicyVersion ?? null,
      productionPolicyVersion: input.productionPolicyVersion ?? null,
      listenerHash,
      cohort: input.cohort ?? null,
      consented: fromPerson ? true : input.consented === true,
      country: normalizeCountry(input.country),
      value,
      unit: descriptor.unit,
      occurredAt,
      expiresAt: new Date(occurredAt.getTime() + retentionDays * 24 * 60 * 60 * 1000),
      metadata: attested,
    },
  };
}

/** Build + persist. Rejected inputs are returned, never silently dropped. */
export async function recordLearningEvents(
  store: LearningStore,
  inputs: LearningEventInput[]
): Promise<{ recorded: LearningEventRecord[]; rejected: Extract<CollectionResult, { ok: false }>[] }> {
  const recorded: LearningEventRecord[] = [];
  const rejected: Extract<CollectionResult, { ok: false }>[] = [];
  for (const input of inputs) {
    const result = buildLearningEvent(input);
    if (result.ok) recorded.push(result.event);
    else rejected.push(result);
  }
  if (recorded.length) await store.insertEvents(recorded);
  return { recorded, rejected };
}

/**
 * PURGE PATH (documented, not implied).
 *
 * THIS is the function a PostgreSQL integration job must call:
 *
 *     purgeExpiredLearningEvents(createPrismaLearningStore(db), new Date())
 *
 * It takes a plain LearningStore, so the same call proves the same behaviour
 * against the in-memory store offline and against real Prisma in CI. It returns
 * the number of rows removed.
 *
 * Every raw event is written with `expiresAt = occurredAt + retentionDays`.
 * This call deletes everything at or past that horizon. It is safe to run on
 * any schedule: aggregates are DERIVED, so after a purge the correct next step
 * is recomputeAggregates(), which will simply reflect the smaller raw window.
 * Nothing in the policy path reads a purged event — promotions record their
 * causing episode ids and sample sizes inline in the version's evidence blob,
 * so an already-promoted decision stays explainable after the raw rows expire.
 */
export async function purgeExpiredLearningEvents(store: LearningStore, now: Date = new Date()): Promise<number> {
  return store.deleteEventsExpiredBefore(now);
}

/* ------------------------------------------------------------------ */
/* 5. Aggregation (derived, recomputable).                             */
/* ------------------------------------------------------------------ */

/** Which value of `e` a given aggregate scope groups by. Exported so the policy
 *  layer can count credible listeners on the SAME scope the aggregate used. */
export function eventScopeKey(kind: AggregateScopeKind, e: LearningEventRecord): string | null {
  switch (kind) {
    case "episode":
      return e.episodeId;
    case "show":
      return e.podcastId;
    case "format":
      return e.formatId;
    case "opening_variant":
      return e.openingVariant;
    case "host_pair":
      return e.hostPairKey;
    case "voice_policy":
      return e.voicePolicyVersion == null ? null : `v${e.voicePolicyVersion}`;
    case "production_policy":
      return e.productionPolicyVersion == null ? null : `v${e.productionPolicyVersion}`;
  }
}

/** Sample-size thresholds for the reported confidence label. */
export const CONFIDENCE_MIN_SAMPLE_MODERATE = 30;
export const CONFIDENCE_MIN_SAMPLE_HIGH = 100;
const Z_95 = 1.959963985;

/**
 * Confidence label. Driven by sample size FIRST: a tiny sample whose values
 * happen to be identical has a margin of error of 0, and reporting that as
 * "high" confidence would be the exact false certainty this loop must avoid.
 */
export function confidenceFor(sampleSize: number, stdDev: number): { marginOfError: number; confidence: ConfidenceLabel } {
  if (sampleSize <= 0) return { marginOfError: 1, confidence: "low" };
  const marginOfError = (Z_95 * stdDev) / Math.sqrt(sampleSize);
  if (sampleSize < CONFIDENCE_MIN_SAMPLE_MODERATE) return { marginOfError, confidence: "low" };
  if (sampleSize < CONFIDENCE_MIN_SAMPLE_HIGH || marginOfError > 0.05) return { marginOfError, confidence: "moderate" };
  return { marginOfError, confidence: "high" };
}

/**
 * PURE derivation: raw events in, aggregate rows out. Deterministic ordering so
 * two runs over the same raw events produce byte-identical output — that is
 * what makes "recompute reproduces the same numbers" a testable claim rather
 * than a hope.
 */
export function computeAggregates(events: LearningEventRecord[]): LearningAggregateRow[] {
  const buckets = new Map<string, { row: Omit<LearningAggregateRow, "mean" | "stdDev" | "marginOfError" | "confidence">; values: number[] }>();

  for (const e of events) {
    if (!e.podcastId) continue; // aggregates are always show-scoped
    for (const kind of AGGREGATE_SCOPE_KINDS) {
      const scopeKey = eventScopeKey(kind, e);
      if (!scopeKey) continue;
      const id = `${e.podcastId} ${kind} ${scopeKey} ${e.signalKey}`;
      const existing = buckets.get(id);
      if (!existing) {
        buckets.set(id, {
          row: {
            podcastId: e.podcastId,
            scopeKind: kind,
            scopeKey,
            signalKey: e.signalKey,
            sampleSize: 1,
            sum: e.value,
            minValue: e.value,
            maxValue: e.value,
            windowStart: e.occurredAt,
            windowEnd: e.occurredAt,
          },
          values: [e.value],
        });
      } else {
        existing.row.sampleSize += 1;
        existing.row.sum += e.value;
        existing.row.minValue = Math.min(existing.row.minValue, e.value);
        existing.row.maxValue = Math.max(existing.row.maxValue, e.value);
        if (e.occurredAt < existing.row.windowStart) existing.row.windowStart = e.occurredAt;
        if (e.occurredAt > existing.row.windowEnd) existing.row.windowEnd = e.occurredAt;
        existing.values.push(e.value);
      }
    }
  }

  const rows: LearningAggregateRow[] = [];
  for (const { row, values } of buckets.values()) {
    const mean = row.sum / row.sampleSize;
    const variance = values.length > 1 ? values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1) : 0;
    const stdDev = Math.sqrt(variance);
    const { marginOfError, confidence } = confidenceFor(row.sampleSize, stdDev);
    rows.push({ ...row, mean, stdDev, marginOfError, confidence });
  }

  rows.sort(
    (a, b) =>
      a.podcastId.localeCompare(b.podcastId) ||
      a.scopeKind.localeCompare(b.scopeKind) ||
      a.scopeKey.localeCompare(b.scopeKey) ||
      a.signalKey.localeCompare(b.signalKey)
  );
  return rows;
}

/** Recompute + replace this show's aggregates from its raw events. */
export async function recomputeAggregates(
  store: LearningStore,
  podcastId: string,
  opts: { aliveAt?: Date } = {}
): Promise<LearningAggregateRow[]> {
  const events = await store.listEvents({ podcastId, aliveAt: opts.aliveAt });
  const rows = computeAggregates(events);
  await store.replaceAggregates(podcastId, rows);
  return rows;
}

export function findAggregate(
  rows: LearningAggregateRow[],
  scopeKind: AggregateScopeKind,
  scopeKey: string,
  signalKey: LearningSignalKey
): LearningAggregateRow | null {
  return rows.find((r) => r.scopeKind === scopeKind && r.scopeKey === scopeKey && r.signalKey === signalKey) ?? null;
}

/* ------------------------------------------------------------------ */
/* 6. Blind cold-open pairwise.                                        */
/* ------------------------------------------------------------------ */

export type ColdOpenSlot = "A" | "B";

export interface ColdOpenVariantInput {
  variantId: string;
  /** The cold-open copy itself. This is WHAT is being judged. */
  text: string;
}

/**
 * The payload actually served to a listener. It carries slot labels and
 * slot-scoped media URLs only — no variant id, no archetype name, no ordering
 * that depends on the caller's array order.
 */
export interface ColdOpenBlindPayload {
  trialToken: string;
  prompt: string;
  options: { slot: ColdOpenSlot; text: string; mediaUrl: string }[];
}

/** Deterministic, token-derived slot assignment — never the caller's order. */
function slotsFromToken(token: string): [0 | 1, 0 | 1] {
  const digest = crypto.createHash("sha256").update(`${token}|coldopen-slot|${analyticsSalt()}`).digest();
  return digest[0] % 2 === 0 ? [0, 1] : [1, 0];
}

export function buildColdOpenTrial(input: {
  episodeId?: string | null;
  podcastId?: string | null;
  variants: [ColdOpenVariantInput, ColdOpenVariantInput];
  listenerId?: string | null;
  hashEpoch?: string;
  consented: boolean;
  country?: string | null;
  now?: Date;
  /** Test seam. Production leaves it unset and gets a random opaque token. */
  trialToken?: string;
  retentionDays?: number;
}): { record: ColdOpenTrialRecord; payload: ColdOpenBlindPayload } | { error: string } {
  if (input.consented !== true) return { error: "consent_required" };
  const [a, b] = input.variants;
  if (!a?.variantId || !b?.variantId || a.variantId === b.variantId) return { error: "two_distinct_variants_required" };

  const now = input.now ?? new Date();
  const trialToken = input.trialToken ?? crypto.randomBytes(24).toString("hex");
  const [firstIdx, secondIdx] = slotsFromToken(trialToken);
  const slotA = input.variants[firstIdx];
  const slotB = input.variants[secondIdx];

  const record: ColdOpenTrialRecord = {
    id: newId(),
    trialToken,
    episodeId: input.episodeId ?? null,
    podcastId: input.podcastId ?? null,
    slotAVariantId: slotA.variantId,
    slotBVariantId: slotB.variantId,
    listenerHash: input.listenerId ? hashListenerId(input.listenerId, { epoch: input.hashEpoch }) : null,
    consented: true,
    country: normalizeCountry(input.country),
    winnerSlot: null,
    winnerVariantId: null,
    decidedAt: null,
    servedAt: now,
    expiresAt: new Date(now.getTime() + (input.retentionDays ?? LEARNING_RETENTION_DAYS) * 24 * 60 * 60 * 1000),
  };

  const payload: ColdOpenBlindPayload = {
    trialToken,
    prompt: "Two openings. Which one makes you want to keep listening?",
    options: [
      { slot: "A", text: slotA.text, mediaUrl: `/api/learning/cold-open/audio?trial=${trialToken}&slot=A` },
      { slot: "B", text: slotB.text, mediaUrl: `/api/learning/cold-open/audio?trial=${trialToken}&slot=B` },
    ],
  };

  return { record, payload };
}

/**
 * Defence in depth: refuse to serve a payload that mentions a variant id
 * anywhere in its serialization. Used by the serve route AND by the executed
 * blindness test, so the guarantee is enforced by the same code that proves it.
 */
export function assertColdOpenPayloadIsBlind(payload: ColdOpenBlindPayload, variantIds: string[]): void {
  const serialized = JSON.stringify(payload).toLowerCase();
  for (const id of variantIds) {
    const needle = id.toLowerCase();
    if (needle && serialized.includes(needle)) {
      throw new Error(`Cold-open payload leaked variant identity: "${id}"`);
    }
  }
  for (const opt of payload.options) {
    const keys = Object.keys(opt).sort().join(",");
    if (keys !== "mediaUrl,slot,text") {
      throw new Error(`Cold-open option carries unexpected fields: ${keys}`);
    }
  }
}

/** Serve a trial: persists the (identity-bearing) record, returns the blind payload. */
export async function serveColdOpenTrial(
  store: LearningStore,
  input: Parameters<typeof buildColdOpenTrial>[0]
): Promise<{ ok: true; payload: ColdOpenBlindPayload } | { ok: false; error: string }> {
  const built = buildColdOpenTrial(input);
  if ("error" in built) return { ok: false, error: built.error };
  assertColdOpenPayloadIsBlind(built.payload, [built.record.slotAVariantId, built.record.slotBVariantId]);
  await store.insertColdOpenTrial(built.record);
  return { ok: true, payload: built.payload };
}

/**
 * Record the listener's pick. The listener sends a SLOT; the variant identity
 * is resolved server-side from the stored trial, so the client never had to
 * know it. Emits two raw pairwise events (winner 1, loser 0) so the aggregate
 * by opening_variant is a real win rate.
 *
 * DEDUPE / REPLAY KEY: the TRIAL, not (listener, episode, signal). One listener
 * may legitimately resolve several distinct trials on the same episode, but a
 * single trial resolves exactly once — enforced by claimColdOpenTrial()'s
 * compare-and-set, so a resubmission loses the race rather than double-counting.
 *
 * `sourceKey` must come from a VERIFIED signed context (section 8); it is what
 * makes the emitted events countable as credible independent listeners.
 */
export async function recordColdOpenChoice(
  store: LearningStore,
  input: {
    trialToken: string;
    winnerSlot: ColdOpenSlot;
    now?: Date;
    formatId?: string | null;
    hostPairKey?: string | null;
    voicePolicyVersion?: number | null;
    productionPolicyVersion?: number | null;
    cohort?: string | null;
    sourceKey?: string | null;
  }
): Promise<{ ok: true; winnerVariantId: string; loserVariantId: string } | { ok: false; error: string }> {
  if (input.winnerSlot !== "A" && input.winnerSlot !== "B") return { ok: false, error: "invalid_slot" };
  const trial = await store.findColdOpenTrial(input.trialToken);
  if (!trial) return { ok: false, error: "unknown_trial" };
  if (trial.decidedAt) return { ok: false, error: "already_decided" };

  const winnerVariantId = input.winnerSlot === "A" ? trial.slotAVariantId : trial.slotBVariantId;
  const loserVariantId = input.winnerSlot === "A" ? trial.slotBVariantId : trial.slotAVariantId;
  const now = input.now ?? new Date();

  const claimed = await store.claimColdOpenTrial(trial.trialToken, {
    winnerSlot: input.winnerSlot,
    winnerVariantId,
    decidedAt: now,
  });
  if (!claimed) return { ok: false, error: "already_decided" };

  const shared = {
    attestation: input.sourceKey ? { credible: true, sourceKey: input.sourceKey } : null,
    signalKey: "cold_open_pairwise" as const,
    episodeId: trial.episodeId,
    podcastId: trial.podcastId,
    formatId: input.formatId ?? null,
    hostPairKey: input.hostPairKey ?? null,
    voicePolicyVersion: input.voicePolicyVersion ?? null,
    productionPolicyVersion: input.productionPolicyVersion ?? null,
    listenerHash: trial.listenerHash,
    cohort: input.cohort ?? null,
    consented: trial.consented,
    country: trial.country,
    occurredAt: now,
  };

  await recordLearningEvents(store, [
    { ...shared, openingVariant: winnerVariantId, value: 1 },
    { ...shared, openingVariant: loserVariantId, value: 0 },
  ]);

  return { ok: true, winnerVariantId, loserVariantId };
}

/* ------------------------------------------------------------------ */
/* 7. Production-side signals from real artifacts.                     */
/* ------------------------------------------------------------------ */

export interface ProductionScriptLine {
  text?: string;
  isFactualClaim?: boolean;
  evidenceRefs?: unknown[];
}

export interface ProductionArtifacts {
  episodeId: string;
  podcastId: string;
  formatId?: string | null;
  openingVariant?: string | null;
  hostPairKey?: string | null;
  voicePolicyVersion?: number | null;
  productionPolicyVersion?: number | null;
  /** Flattened script lines (Script.content) — carries claims + repetition. */
  scriptLines?: ProductionScriptLine[] | null;
  /** AudioSemanticQaReport fields (src/lib/audio/audioSemanticQa.ts). */
  semanticQa?: { wordErrorRate: number | null; speakerAttributionErrorRate: number | null } | null;
  /** Real regeneration counts (audio:regenerate-line jobs vs total lines). */
  voiceRegeneration?: { regeneratedLines: number; totalLines: number } | null;
  /** LLM cost ledger total (src/lib/providers/llm/costLedger.ts) + real runtime. */
  cost?: { totalUsd: number | null; publishableMinutes: number } | null;
  occurredAt?: Date;
}

/**
 * Derive the six production-side signals from artifacts that already exist.
 * A signal whose inputs are absent is simply NOT emitted — an unmeasured
 * quantity must never enter the loop as a zero.
 */
export function deriveProductionSignals(a: ProductionArtifacts): LearningEventInput[] {
  const dims = {
    episodeId: a.episodeId,
    podcastId: a.podcastId,
    formatId: a.formatId ?? null,
    openingVariant: a.openingVariant ?? null,
    hostPairKey: a.hostPairKey ?? null,
    voicePolicyVersion: a.voicePolicyVersion ?? null,
    productionPolicyVersion: a.productionPolicyVersion ?? null,
    occurredAt: a.occurredAt,
  };
  const out: LearningEventInput[] = [];
  const lines = a.scriptLines ?? null;

  if (lines && lines.length) {
    // Unsupported-claim rate: lines the writer flagged as factual claims that
    // carry no evidence reference. Same definition the fact-check gate uses.
    const claims = lines.filter((l) => l.isFactualClaim === true);
    if (claims.length) {
      const unsupported = claims.filter((l) => !Array.isArray(l.evidenceRefs) || l.evidenceRefs.length === 0).length;
      out.push({ ...dims, signalKey: "unsupported_claim_rate", value: unsupported / claims.length, metadata: { claims: claims.length, unsupported } });
    }
    // Repeated-point rate: the existing anti-repetition detector, not a new one.
    const report = findRepetitions(lines.map((l) => String(l.text ?? "")));
    if (report.totalLines > 0) {
      out.push({ ...dims, signalKey: "repeated_point_rate", value: report.repetitionRatio, metadata: { totalLines: report.totalLines, repeats: report.repeats.length } });
    }
  }

  if (a.voiceRegeneration && a.voiceRegeneration.totalLines > 0) {
    out.push({
      ...dims,
      signalKey: "voice_regeneration_rate",
      value: a.voiceRegeneration.regeneratedLines / a.voiceRegeneration.totalLines,
      metadata: { regeneratedLines: a.voiceRegeneration.regeneratedLines, totalLines: a.voiceRegeneration.totalLines },
    });
  }

  if (a.semanticQa) {
    if (typeof a.semanticQa.wordErrorRate === "number") {
      out.push({ ...dims, signalKey: "transcript_word_error_rate", value: a.semanticQa.wordErrorRate });
    }
    if (typeof a.semanticQa.speakerAttributionErrorRate === "number") {
      out.push({ ...dims, signalKey: "speaker_attribution_error_rate", value: a.semanticQa.speakerAttributionErrorRate });
    }
  }

  if (a.cost && typeof a.cost.totalUsd === "number" && a.cost.publishableMinutes > 0) {
    out.push({
      ...dims,
      signalKey: "cost_per_publishable_minute",
      value: a.cost.totalUsd / a.cost.publishableMinutes,
      metadata: { totalUsd: a.cost.totalUsd, publishableMinutes: a.cost.publishableMinutes },
    });
  }

  return out;
}

export async function recordProductionSignals(store: LearningStore, artifacts: ProductionArtifacts) {
  return recordLearningEvents(store, deriveProductionSignals(artifacts));
}

/** Order-independent host-pair key so "cal|zabala" and "zabala|cal" agree. */
export function hostPairKey(hostIds: string[]): string | null {
  const ids = hostIds.filter(Boolean).map((h) => h.trim().toLowerCase()).sort();
  return ids.length ? ids.join("|") : null;
}

/* ================================================================== */
/* 8. PUBLIC INTAKE HARDENING.                                         */
/*                                                                     */
/* Everything below exists because /api/learning/* is reachable by      */
/* anyone with curl. The route handlers are deliberately thin wrappers  */
/* around these functions: all of it is pure or store/clock-injected,   */
/* so the adversarial suite proves the real code path offline rather    */
/* than a re-implementation of it.                                      */
/* ================================================================== */

/* ---------------- 8.1 Size caps ---------------- */

/** Hard ceiling on a request body. Anything larger is refused with 413. */
export const MAX_INTAKE_BODY_BYTES = 4_096;
/** Ceiling on the sanitized metadata object a client may attach. */
export const MAX_METADATA_KEYS = 8;
export const MAX_METADATA_BYTES = 512;
export const MAX_METADATA_VALUE_CHARS = 120;
/** Bounds on the self-asserted anonymous listener identifier. */
export const MIN_LISTENER_ID_CHARS = 8;
export const MAX_LISTENER_ID_CHARS = 128;

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const COHORT_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;
const SAFE_STRING_PATTERN = /^[\w .,:/-]{1,120}$/;

export function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/* ---------------- 8.2 Per-signal intake rules ---------------- */

export interface SignalIntakeRule {
  /**
   * May a public client report this signal at all? Production-side signals are
   * derived from artifacts by the worker; a client asserting them would be
   * asserting its own quality score.
   */
  clientSubmittable: boolean;
  /** EXPLICIT numeric range. Never inferred, never clamped — out of range is a refusal. */
  min: number;
  max: number;
  /** When present, the ONLY accepted values (a milestone is reached or it is not). */
  allowedValues?: readonly number[];
  /** The complete set of metadata keys a client may attach. Anything else is refused. */
  metadataKeys: readonly string[];
  /** DEDUPE KEY, documented per signal. */
  dedupeKey: string;
}

/**
 * DEDUPE KEY PER SIGNAL — the authoritative table.
 *
 * Eleven of the fourteen dedupe on (listenerHash, episodeId, signalKey): a
 * listener either reached 60 seconds of an episode or did not, and repeating
 * the claim is not new evidence.
 *
 * cold_open_pairwise is the exception the naive key gets WRONG. A listener may
 * legitimately judge several distinct A/B trials on the same episode, so keying
 * on (listener, episode, signal) would throw away real data. It dedupes on the
 * TRIAL instead, enforced by compare-and-set in recordColdOpenChoice().
 *
 * The six production signals are not client-reachable at all; their events are
 * emitted once per derivation run by deriveProductionSignals(), keyed
 * (episodeId, signalKey, run). They are listed here for completeness and so a
 * future route cannot accidentally accept one.
 */
export const SIGNAL_INTAKE_RULES: Record<LearningSignalKey, SignalIntakeRule> = {
  retention_15s: {
    clientSubmittable: true, min: 0, max: 1, allowedValues: [0, 1],
    metadataKeys: ["playerBuild", "positionSeconds"],
    dedupeKey: "(listenerHash, episodeId, signalKey)",
  },
  retention_60s: {
    clientSubmittable: true, min: 0, max: 1, allowedValues: [0, 1],
    metadataKeys: ["playerBuild", "positionSeconds"],
    dedupeKey: "(listenerHash, episodeId, signalKey)",
  },
  retention_180s: {
    clientSubmittable: true, min: 0, max: 1, allowedValues: [0, 1],
    metadataKeys: ["playerBuild", "positionSeconds"],
    dedupeKey: "(listenerHash, episodeId, signalKey)",
  },
  completion: {
    clientSubmittable: true, min: 0, max: 1,
    metadataKeys: ["playerBuild", "positionSeconds", "durationSeconds"],
    dedupeKey: "(listenerHash, episodeId, signalKey)",
  },
  next_episode_play: {
    clientSubmittable: true, min: 0, max: 1, allowedValues: [0, 1],
    metadataKeys: ["playerBuild"],
    dedupeKey: "(listenerHash, episodeId, signalKey)",
  },
  cold_open_pairwise: {
    // NOT accepted here. It is produced server-side by resolving a trial the
    // server itself issued — that is the only way the variant identity stays
    // out of the client's hands.
    clientSubmittable: false, min: 0, max: 1, allowedValues: [0, 1],
    metadataKeys: [],
    dedupeKey: "(trialId)  — one resolution per server-issued trial",
  },
  sounds_human: {
    clientSubmittable: true, min: 0, max: 1,
    metadataKeys: ["playerBuild", "panelRound"],
    dedupeKey: "(listenerHash, episodeId, signalKey)",
  },
  host_distinguishability: {
    clientSubmittable: true, min: 0, max: 1,
    metadataKeys: ["playerBuild", "panelRound"],
    dedupeKey: "(listenerHash, episodeId, signalKey)",
  },
  unsupported_claim_rate: { clientSubmittable: false, min: 0, max: 1, metadataKeys: [], dedupeKey: "(episodeId, signalKey) per derivation run — server-derived" },
  repeated_point_rate: { clientSubmittable: false, min: 0, max: 1, metadataKeys: [], dedupeKey: "(episodeId, signalKey) per derivation run — server-derived" },
  voice_regeneration_rate: { clientSubmittable: false, min: 0, max: 1, metadataKeys: [], dedupeKey: "(episodeId, signalKey) per derivation run — server-derived" },
  transcript_word_error_rate: { clientSubmittable: false, min: 0, max: 1, metadataKeys: [], dedupeKey: "(episodeId, signalKey) per derivation run — server-derived" },
  speaker_attribution_error_rate: { clientSubmittable: false, min: 0, max: 1, metadataKeys: [], dedupeKey: "(episodeId, signalKey) per derivation run — server-derived" },
  cost_per_publishable_minute: { clientSubmittable: false, min: 0, max: 1000, metadataKeys: [], dedupeKey: "(episodeId, signalKey) per derivation run — server-derived" },
};

/** Field names that would let a client name the variant it judged. Always refused. */
const VARIANT_IDENTITY_KEYS = [
  "variantid", "variant", "variants", "openingvariant", "opening_variant",
  "winnervariantid", "winner_variant_id", "slotavariantid", "slotbvariantid",
  "archetype", "coldopenvariant",
];

/* ---------------- 8.3 Signed, tamper-evident context ---------------- */

/**
 * The client never names the episode, the show, or the variant it is reporting
 * on. The server issues a signed context; the client echoes it back verbatim.
 *
 * ENV: LEARNING_SIGNAL_SECRET (>= 16 chars). In production an unset or weak
 * secret means the intake FAILS CLOSED — every submission is refused with 503
 * rather than trusting unsigned attribution. Outside production a deterministic
 * dev secret is derived so the loop is still exercisable locally and in tests.
 */
export function resolveLearningSecret(env: Record<string, string | undefined> = process.env): string | null {
  const explicit = (env.LEARNING_SIGNAL_SECRET || "").trim();
  if (explicit.length >= 16) return explicit;
  if (env.NODE_ENV === "production") return null;
  return `learning-dev-secret|${env.ANALYTICS_HASH_SALT || "take-machine-analytics"}`;
}

/** How long an issued context stays valid. Short enough that a stolen token rots. */
export const LEARNING_CONTEXT_TTL_SECONDS = 2 * 60 * 60;

export interface LearningContextClaims {
  kind: "signal" | "cold_open";
  episodeId: string;
  podcastId: string | null;
  /** The trial id for a pairwise context; an opaque context id otherwise. */
  trialId: string;
  /** Epoch SECONDS the context was issued. */
  issuedAt: number;
  /** Server-computed source bucket, signed so the client cannot rewrite it. */
  src: string | null;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function hmac(payload: string, secret: string): string {
  return b64url(crypto.createHmac("sha256", secret).update(payload).digest());
}
function timingSafeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** HMAC-SHA256 over episodeId + trialId + issuedAt (+ show, source, kind). */
export function signLearningContext(claims: LearningContextClaims, secret: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${hmac(payload, secret)}`;
}

export type ContextVerification =
  | { ok: true; claims: LearningContextClaims }
  | { ok: false; code: "context_missing" | "context_malformed" | "context_forged" | "context_expired" | "context_wrong_kind"; reason: string };

export function verifyLearningContext(
  token: unknown,
  secret: string,
  now: Date,
  opts: { kind: LearningContextClaims["kind"]; ttlSeconds?: number }
): ContextVerification {
  if (typeof token !== "string" || !token) {
    return { ok: false, code: "context_missing", reason: "A server-issued context token is required." };
  }
  if (byteLength(token) > 1_024) {
    return { ok: false, code: "context_malformed", reason: "Context token is not a context token." };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, code: "context_malformed", reason: "Context token is malformed." };
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!timingSafeEquals(signature, hmac(payload, secret))) {
    return { ok: false, code: "context_forged", reason: "Context signature does not verify." };
  }
  let claims: LearningContextClaims;
  try {
    claims = JSON.parse(unb64url(payload).toString("utf8")) as LearningContextClaims;
  } catch {
    return { ok: false, code: "context_malformed", reason: "Context payload is not readable." };
  }
  if (!claims || typeof claims.episodeId !== "string" || typeof claims.trialId !== "string" || typeof claims.issuedAt !== "number") {
    return { ok: false, code: "context_malformed", reason: "Context payload is incomplete." };
  }
  if (claims.kind !== opts.kind) {
    return { ok: false, code: "context_wrong_kind", reason: `Context was issued for "${String(claims.kind)}", not "${opts.kind}".` };
  }
  const ttl = opts.ttlSeconds ?? LEARNING_CONTEXT_TTL_SECONDS;
  const ageSeconds = Math.floor(now.getTime() / 1000) - claims.issuedAt;
  if (!Number.isFinite(ageSeconds) || ageSeconds < -60 || ageSeconds > ttl) {
    return { ok: false, code: "context_expired", reason: "Context has expired; request a fresh one." };
  }
  return { ok: true, claims };
}

/* ---------------- 8.4 Source bucketing ---------------- */

/**
 * Salted bucket for a request source. NOT stored as an IP and not reversible.
 *
 * The epoch is the UTC MONTH, deliberately coarser than the daily listener
 * epoch: the per-source credible cap has to survive a listener id that rotates
 * every night, or "one machine, a new id each day" would read as a growing
 * audience. Monthly rotation still keeps the bucket from becoming a durable
 * identifier.
 */
export function sourceEpoch(at: Date = new Date()): string {
  return at.toISOString().slice(0, 7);
}

export function hashSourceIp(ip: string, opts: { epoch?: string; salt?: string } = {}): string {
  const epoch = opts.epoch ?? sourceEpoch();
  const salt = opts.salt ?? analyticsSalt();
  return crypto.createHash("sha256").update(`source|${ip}|${epoch}|${salt}`).digest("hex").slice(0, 24);
}

/** First forwarded hop, or the direct peer. Never persisted in raw form. */
export function sourceIpFromHeaders(headers: Headers, fallback?: string | null): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return headers.get("x-real-ip") || headers.get("cf-connecting-ip") || fallback || null;
}

/* ---------------- 8.5 Rate limiting ---------------- */

export interface RateLimitRuleSpec {
  limit: number;
  windowSeconds: number;
}

/**
 * DOCUMENTED WINDOWS. All fixed-window: a bucket is floor(epochSeconds/window),
 * so a limiter that trips recovers exactly when the next bucket opens.
 */
export const LEARNING_RATE_LIMITS = {
  /** Signals from one listener identifier: 30 per 10 minutes. */
  signal_per_listener: { limit: 30, windowSeconds: 600 },
  /** Signals from one source bucket: 120 per 10 minutes. */
  signal_per_source: { limit: 120, windowSeconds: 600 },
  /** Cold-open trials issued to one source bucket: 60 per 10 minutes. */
  trial_issue_per_source: { limit: 60, windowSeconds: 600 },
  /** Cold-open trials resolved by one source bucket: 60 per 10 minutes. */
  trial_resolve_per_source: { limit: 60, windowSeconds: 600 },
} as const satisfies Record<string, RateLimitRuleSpec>;

export type LearningRateLimitKind = keyof typeof LEARNING_RATE_LIMITS;

/** The only persistence the limiter needs. Injectable so it is provable offline. */
export interface RateLimitStore {
  /** Add 1 to `key`'s counter for this window and return the new total. */
  increment(key: string, windowSeconds: number, now: Date): Promise<number>;
}

export interface InMemoryRateLimitStore extends RateLimitStore {
  reset(): void;
  size(): number;
}

export function createInMemoryRateLimitStore(): InMemoryRateLimitStore {
  const counters = new Map<string, number>();
  return {
    async increment(key, windowSeconds, now) {
      const bucket = Math.floor(now.getTime() / 1000 / windowSeconds);
      const full = `${key}:${bucket}`;
      // Drop buckets that can no longer be current, so a long-lived process
      // does not accumulate one entry per identity per window forever.
      const prefix = `${key}:`;
      for (const existing of counters.keys()) {
        if (existing.startsWith(prefix) && existing !== full) counters.delete(existing);
      }
      const next = (counters.get(full) ?? 0) + 1;
      counters.set(full, next);
      return next;
    },
    reset() {
      counters.clear();
    },
    size() {
      return counters.size;
    },
  };
}

/**
 * Redis-backed limiter for production, where web runs as more than one process
 * and a process-local counter would silently multiply every limit.
 *
 * The shared ioredis client is created with `maxRetriesPerRequest: null`, so a
 * command issued while Redis is down NEVER settles. Every call is therefore
 * raced against a timeout, and a timeout THROWS — the caller turns that into a
 * 503. Unlike the admin limiter (src/lib/rateLimit.ts), this one fails CLOSED:
 * this is a public abuse boundary, and dropping optional telemetry is strictly
 * better than leaving the boundary open while Redis is unreachable.
 */
export function createRedisRateLimitStore(
  redis: { incr(key: string): Promise<number>; expire(key: string, seconds: number): Promise<unknown> },
  timeoutMs = 1_000
): RateLimitStore {
  const race = async <T>(p: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("rate_limiter_timeout")), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    async increment(key, windowSeconds, now) {
      const bucket = Math.floor(now.getTime() / 1000 / windowSeconds);
      const full = `learning:rl:${key}:${bucket}`;
      const count = await race(redis.incr(full));
      void race(Promise.resolve(redis.expire(full, windowSeconds + 5))).catch(() => {});
      return count;
    },
  };
}

export interface RateLimitVerdict {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

export async function consumeLearningRateLimit(
  store: RateLimitStore,
  kind: LearningRateLimitKind,
  identity: string,
  now: Date
): Promise<RateLimitVerdict> {
  const rule = LEARNING_RATE_LIMITS[kind] as RateLimitRuleSpec;
  const count = await store.increment(`${kind}:${identity}`, rule.windowSeconds, now);
  const elapsed = Math.floor(now.getTime() / 1000) % rule.windowSeconds;
  return {
    allowed: count <= rule.limit,
    count,
    limit: rule.limit,
    retryAfterSeconds: Math.max(1, rule.windowSeconds - elapsed),
  };
}

/* ---------------- 8.6 Credible-listener counting ---------------- */

/**
 * CREDIBILITY RULE (stated plainly so it can be argued with).
 *
 * An event counts toward a promotion's sample only when ALL of:
 *   1. it carries a server attestation (_credible === true) — meaning it
 *      arrived with a valid, unexpired, server-issued HMAC context;
 *   2. it carries a server-computed source bucket (_src) — meaning the request
 *      had a resolvable origin the server hashed itself;
 *   3. it passed dedupe for its signal's key;
 *   4. neither the per-listener nor the per-source limiter had tripped;
 *   5. consent was explicit and a listener hash exists.
 * (1)-(2) are visible on the stored row; (3)-(5) are preconditions of the row
 * existing at all — an event that failed any of them was never written.
 *
 * AND THEN, the part that actually matters: at most
 * MAX_CREDIBLE_LISTENERS_PER_SOURCE distinct listeners are counted per source
 * bucket. Rotating a fresh listener id per request from one machine therefore
 * buys 3 credible listeners, not 3,000.
 *
 * This is a COST control, not a proof of humanity. It is precisely why
 * listener-sourced promotions are staged for a human rather than applied.
 */
export const MAX_CREDIBLE_LISTENERS_PER_SOURCE = 3;

export function isCredibleEvent(e: LearningEventRecord): boolean {
  const md = e.metadata as Record<string, unknown> | null;
  return (
    !!e.listenerHash &&
    e.consented === true &&
    !!md &&
    md[ATTESTATION_CREDIBLE_KEY] === true &&
    typeof md[ATTESTATION_SOURCE_KEY] === "string" &&
    (md[ATTESTATION_SOURCE_KEY] as string).length > 0
  );
}

/**
 * Number of CREDIBLE INDEPENDENT listeners represented by `events` — NOT the
 * number of rows, and NOT the number of distinct anonymous ids.
 */
export function countCredibleListeners(
  events: LearningEventRecord[],
  opts: { maxPerSource?: number } = {}
): number {
  const maxPerSource = opts.maxPerSource ?? MAX_CREDIBLE_LISTENERS_PER_SOURCE;
  const bySource = new Map<string, Set<string>>();
  for (const e of events) {
    if (!isCredibleEvent(e)) continue;
    const src = String((e.metadata as Record<string, unknown>)[ATTESTATION_SOURCE_KEY]);
    let listeners = bySource.get(src);
    if (!listeners) {
      listeners = new Set<string>();
      bySource.set(src, listeners);
    }
    listeners.add(e.listenerHash!);
  }
  let total = 0;
  for (const listeners of bySource.values()) total += Math.min(listeners.size, maxPerSource);
  return total;
}

/* ---------------- 8.7 Payload validation ---------------- */

export type IntakeRejection = { ok: false; status: number; code: string; reason: string };
export type IntakeResult<T = Record<string, unknown>> = { ok: true; status: 200; body: T } | IntakeRejection;

function reject(status: number, code: string, reason: string): IntakeRejection {
  return { ok: false, status, code, reason };
}

/** Parse a capped body into a plain object, refusing everything else. */
export function parseIntakeBody(rawBody: string): { ok: true; body: Record<string, unknown> } | IntakeRejection {
  if (byteLength(rawBody) > MAX_INTAKE_BODY_BYTES) {
    return reject(413, "body_too_large", `Request body exceeds ${MAX_INTAKE_BODY_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "");
  } catch {
    return reject(400, "malformed_body", "Body is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return reject(400, "malformed_body", "Body must be a JSON object.");
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/** A client naming a variant is always a refusal, on every learning route. */
export function assertNoVariantIdentity(body: Record<string, unknown>): IntakeRejection | null {
  for (const key of Object.keys(body)) {
    if (VARIANT_IDENTITY_KEYS.includes(key.toLowerCase())) {
      return reject(
        403,
        "variant_identity_forbidden",
        `"${key}" is chosen by the server. A client that can name the variant it judged has unblinded the experiment.`
      );
    }
  }
  return null;
}

function validateMetadata(raw: unknown, rule: SignalIntakeRule): { ok: true; metadata: Record<string, unknown> | null } | IntakeRejection {
  if (raw === undefined || raw === null) return { ok: true, metadata: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return reject(400, "invalid_metadata", "metadata must be a JSON object.");
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) {
    return reject(413, "metadata_too_large", `metadata may carry at most ${MAX_METADATA_KEYS} keys; got ${entries.length}.`);
  }
  if (byteLength(JSON.stringify(raw)) > MAX_METADATA_BYTES) {
    return reject(413, "metadata_too_large", `metadata may be at most ${MAX_METADATA_BYTES} bytes.`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!rule.metadataKeys.includes(key)) {
      return reject(400, "unexpected_metadata_key", `"${key}" is not an accepted metadata key for this signal (allowed: ${rule.metadataKeys.join(", ") || "none"}).`);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return reject(400, "invalid_metadata", `metadata."${key}" must be a finite number.`);
      out[key] = value;
    } else if (typeof value === "boolean") {
      out[key] = value;
    } else if (typeof value === "string") {
      if (value.length > MAX_METADATA_VALUE_CHARS || !SAFE_STRING_PATTERN.test(value)) {
        return reject(400, "invalid_metadata", `metadata."${key}" must be a short, plain string.`);
      }
      out[key] = value;
    } else {
      return reject(400, "invalid_metadata", `metadata."${key}" must be a number, boolean or short string.`);
    }
  }
  return { ok: true, metadata: Object.keys(out).length ? out : null };
}

export interface ValidatedSignalSubmission {
  signalKey: LearningSignalKey;
  value: number;
  listenerId: string;
  cohort: string | null;
  metadata: Record<string, unknown> | null;
  context: string;
  /** Echoed episode id, if the client sent one. Must match the signed context. */
  claimedEpisodeId: string | null;
}

const SIGNAL_BODY_KEYS = ["context", "signalKey", "value", "consent", "listenerId", "cohort", "metadata", "episodeId"];

/** STRICT validation of one public signal submission. Rejects, never coerces. */
export function validateSignalSubmission(rawBody: string): { ok: true; submission: ValidatedSignalSubmission } | IntakeRejection {
  const parsed = parseIntakeBody(rawBody);
  if (!parsed.ok) return parsed;
  const body = parsed.body;

  const variant = assertNoVariantIdentity(body);
  if (variant) return variant;

  for (const key of Object.keys(body)) {
    if (!SIGNAL_BODY_KEYS.includes(key)) {
      return reject(400, "unexpected_field", `"${key}" is not an accepted field.`);
    }
  }

  if (body.consent !== true) return reject(403, "consent_required", "Collection requires an explicit consent: true.");

  const signalKey = body.signalKey;
  if (!isLearningSignalKey(signalKey)) return reject(400, "unknown_signal", `"${String(signalKey)}" is not a known signal.`);
  const rule = SIGNAL_INTAKE_RULES[signalKey];
  if (!rule.clientSubmittable) {
    return reject(400, "signal_not_client_submittable", `"${signalKey}" is measured server-side and is never accepted from a client.`);
  }

  const value = body.value;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return reject(400, "invalid_value", `value must be a finite number; got ${JSON.stringify(value)}.`);
  }
  if (value < rule.min || value > rule.max) {
    return reject(400, "value_out_of_range", `value for "${signalKey}" must be within [${rule.min}, ${rule.max}]; got ${value}.`);
  }
  if (rule.allowedValues && !rule.allowedValues.includes(value)) {
    return reject(400, "value_out_of_range", `"${signalKey}" accepts only ${rule.allowedValues.join(" or ")}; got ${value}.`);
  }

  const listenerId = body.listenerId;
  if (typeof listenerId !== "string" || listenerId.length < MIN_LISTENER_ID_CHARS || listenerId.length > MAX_LISTENER_ID_CHARS || !ID_PATTERN.test(listenerId)) {
    return reject(400, "invalid_listener_id", `listenerId must be ${MIN_LISTENER_ID_CHARS}-${MAX_LISTENER_ID_CHARS} url-safe characters. It is hashed and never stored.`);
  }

  let cohort: string | null = null;
  if (body.cohort !== undefined && body.cohort !== null) {
    if (typeof body.cohort !== "string" || !COHORT_PATTERN.test(body.cohort)) {
      return reject(400, "invalid_cohort", "cohort must be a short label.");
    }
    cohort = body.cohort;
  }

  const metadata = validateMetadata(body.metadata, rule);
  if (!metadata.ok) return metadata;

  let claimedEpisodeId: string | null = null;
  if (body.episodeId !== undefined && body.episodeId !== null) {
    if (typeof body.episodeId !== "string" || !ID_PATTERN.test(body.episodeId)) {
      return reject(400, "invalid_episode_id", "episodeId must be an id.");
    }
    claimedEpisodeId = body.episodeId;
  }

  if (typeof body.context !== "string" || !body.context) {
    return reject(400, "context_missing", "A server-issued context token is required.");
  }

  return {
    ok: true,
    submission: { signalKey, value, listenerId, cohort, metadata: metadata.metadata, context: body.context, claimedEpisodeId },
  };
}

/* ---------------- 8.8 The intake itself ---------------- */

/** Attribution the SERVER resolved. A client never supplies any of it. */
export interface EpisodeAttribution {
  episodeId: string;
  podcastId: string | null;
  formatId: string | null;
  openingVariant: string | null;
  hostPairKey: string | null;
  voicePolicyVersion: number | null;
  productionPolicyVersion: number | null;
  coldOpenVariants: ColdOpenVariantInput[];
}

export interface LearningIntakeDeps {
  store: LearningStore;
  rateLimiter: RateLimitStore;
  loadEpisode: (episodeId: string) => Promise<EpisodeAttribution | null>;
  /** null => fail closed (production without LEARNING_SIGNAL_SECRET). */
  secret: string | null;
  now: Date;
  hashEpoch?: string;
  sourceEpochOverride?: string;
}

export interface IntakeRequest {
  rawBody: string;
  sourceIp: string | null;
  country: string | null;
}

function secretOrRefusal(deps: LearningIntakeDeps): IntakeRejection | null {
  if (deps.secret) return null;
  return reject(
    503,
    "signing_secret_unset",
    "LEARNING_SIGNAL_SECRET is not configured. Learning intake fails closed rather than accepting unsigned attribution."
  );
}

async function limit(deps: LearningIntakeDeps, kind: LearningRateLimitKind, identity: string): Promise<IntakeRejection | null> {
  let verdict: RateLimitVerdict;
  try {
    verdict = await consumeLearningRateLimit(deps.rateLimiter, kind, identity, deps.now);
  } catch {
    // Fail CLOSED: an abuse boundary that cannot be consulted is not a boundary.
    return reject(503, "limiter_unavailable", "Rate limiter is unavailable; submission refused.");
  }
  if (verdict.allowed) return null;
  return reject(429, "rate_limited", `Too many submissions. Retry in ${verdict.retryAfterSeconds}s.`);
}

/**
 * Issue a signed context for one episode. This is the ONLY way a client obtains
 * permission to report a signal, and the token names the episode — so a client
 * can never attribute a signal to a show it was not served.
 */
export async function intakeIssueSignalContext(
  deps: LearningIntakeDeps,
  req: { episodeId: string; sourceIp: string | null }
): Promise<IntakeResult<{ context: string; episodeId: string; expiresInSeconds: number }>> {
  const refusal = secretOrRefusal(deps);
  if (refusal) return refusal;
  if (typeof req.episodeId !== "string" || !ID_PATTERN.test(req.episodeId)) {
    return reject(400, "invalid_episode_id", "episodeId is required.");
  }
  const sourceKey = req.sourceIp ? hashSourceIp(req.sourceIp, { epoch: deps.sourceEpochOverride }) : null;
  const limited = await limit(deps, "signal_per_source", sourceKey ?? "unknown");
  if (limited) return limited;

  const episode = await deps.loadEpisode(req.episodeId);
  if (!episode) return reject(404, "unknown_episode", "No such episode.");

  const context = signLearningContext(
    {
      kind: "signal",
      episodeId: episode.episodeId,
      podcastId: episode.podcastId,
      trialId: crypto.randomBytes(12).toString("hex"),
      issuedAt: Math.floor(deps.now.getTime() / 1000),
      src: sourceKey,
    },
    deps.secret!
  );
  return { ok: true, status: 200, body: { context, episodeId: episode.episodeId, expiresInSeconds: LEARNING_CONTEXT_TTL_SECONDS } };
}

/**
 * Accept one listener/panel signal. Order is deliberate:
 * source limiter -> strict validation -> signed context -> cross-show check ->
 * listener limiter -> dedupe -> write.
 */
export async function intakeListenerSignal(
  deps: LearningIntakeDeps,
  req: IntakeRequest
): Promise<IntakeResult<{ recorded: number; credible: boolean }>> {
  const refusal = secretOrRefusal(deps);
  if (refusal) return refusal;

  const sourceKey = req.sourceIp ? hashSourceIp(req.sourceIp, { epoch: deps.sourceEpochOverride }) : null;
  const sourceLimited = await limit(deps, "signal_per_source", sourceKey ?? "unknown");
  if (sourceLimited) return sourceLimited;

  const validated = validateSignalSubmission(req.rawBody);
  if (!validated.ok) return validated;
  const s = validated.submission;

  const verified = verifyLearningContext(s.context, deps.secret!, deps.now, { kind: "signal" });
  if (!verified.ok) return reject(verified.code === "context_expired" ? 401 : 403, verified.code, verified.reason);

  // CROSS-SHOW ATTRIBUTION: the episode comes from the SIGNED token. An echoed
  // episodeId is only ever allowed to agree with it.
  if (s.claimedEpisodeId && s.claimedEpisodeId !== verified.claims.episodeId) {
    return reject(403, "context_mismatch", "This signal was issued for a different episode.");
  }

  const listenerHash = hashListenerId(s.listenerId, { epoch: deps.hashEpoch });
  const listenerLimited = await limit(deps, "signal_per_listener", listenerHash);
  if (listenerLimited) return listenerLimited;

  const episode = await deps.loadEpisode(verified.claims.episodeId);
  if (!episode) return reject(404, "unknown_episode", "No such episode.");

  // DEDUPE — (listenerHash, episodeId, signalKey) for every client signal.
  const existing = await deps.store.countEvents({ signalKey: s.signalKey, listenerHash, episodeId: episode.episodeId });
  if (existing > 0) {
    return reject(409, "duplicate_signal", `"${s.signalKey}" is already recorded for this listener and episode. ${SIGNAL_INTAKE_RULES[s.signalKey].dedupeKey}`);
  }

  const credible = !!sourceKey;
  const { recorded, rejected } = await recordLearningEvents(deps.store, [
    {
      signalKey: s.signalKey,
      value: s.value,
      episodeId: episode.episodeId,
      podcastId: episode.podcastId,
      formatId: episode.formatId,
      openingVariant: episode.openingVariant,
      hostPairKey: episode.hostPairKey,
      voicePolicyVersion: episode.voicePolicyVersion,
      productionPolicyVersion: episode.productionPolicyVersion,
      listenerHash,
      cohort: s.cohort,
      consented: true,
      country: req.country,
      occurredAt: deps.now,
      metadata: s.metadata,
      attestation: { credible, sourceKey },
    },
  ]);

  if (!recorded.length) {
    const first = rejected[0];
    return reject(400, first?.code ?? "rejected", first?.reason ?? "Refused.");
  }
  return { ok: true, status: 200, body: { recorded: recorded.length, credible } };
}

/** Serve a blind cold-open trial and the signed context that resolves it. */
export async function intakeIssueColdOpenTrial(
  deps: LearningIntakeDeps,
  req: { episodeId: string; listenerId: string | null; consent: boolean; sourceIp: string | null; country: string | null }
): Promise<IntakeResult<{ trial: ColdOpenBlindPayload; context: string; expiresInSeconds: number }>> {
  const refusal = secretOrRefusal(deps);
  if (refusal) return refusal;
  if (typeof req.episodeId !== "string" || !ID_PATTERN.test(req.episodeId)) {
    return reject(400, "invalid_episode_id", "episodeId is required.");
  }
  if (req.consent !== true) return reject(403, "consent_required", "Collection requires explicit consent.");
  if (req.listenerId !== null && (typeof req.listenerId !== "string" || req.listenerId.length < MIN_LISTENER_ID_CHARS || !ID_PATTERN.test(req.listenerId))) {
    return reject(400, "invalid_listener_id", "listenerId must be url-safe. It is hashed and never stored.");
  }

  const sourceKey = req.sourceIp ? hashSourceIp(req.sourceIp, { epoch: deps.sourceEpochOverride }) : null;
  const limited = await limit(deps, "trial_issue_per_source", sourceKey ?? "unknown");
  if (limited) return limited;

  const episode = await deps.loadEpisode(req.episodeId);
  if (!episode) return reject(404, "unknown_episode", "No such episode.");
  if (episode.coldOpenVariants.length < 2) {
    return reject(409, "insufficient_variants", "This episode has fewer than two cold-open variants to compare.");
  }

  const served = await serveColdOpenTrial(deps.store, {
    episodeId: episode.episodeId,
    podcastId: episode.podcastId,
    variants: [episode.coldOpenVariants[0], episode.coldOpenVariants[1]],
    listenerId: req.listenerId,
    hashEpoch: deps.hashEpoch,
    consented: true,
    country: req.country,
    now: deps.now,
  });
  if (!served.ok) return reject(400, served.error, served.error);

  const context = signLearningContext(
    {
      kind: "cold_open",
      episodeId: episode.episodeId,
      podcastId: episode.podcastId,
      trialId: served.payload.trialToken,
      issuedAt: Math.floor(deps.now.getTime() / 1000),
      src: sourceKey,
    },
    deps.secret!
  );
  return { ok: true, status: 200, body: { trial: served.payload, context, expiresInSeconds: LEARNING_CONTEXT_TTL_SECONDS } };
}

const COLD_OPEN_BODY_KEYS = ["context", "winnerSlot", "cohort", "trialToken"];

/**
 * Resolve a trial. The client sends the signed context and a SIDE — never a
 * variant identity, and never a trial it was not issued.
 */
export async function intakeResolveColdOpenTrial(
  deps: LearningIntakeDeps,
  req: IntakeRequest
): Promise<IntakeResult<{ recorded: true }>> {
  const refusal = secretOrRefusal(deps);
  if (refusal) return refusal;

  const sourceKeyFromRequest = req.sourceIp ? hashSourceIp(req.sourceIp, { epoch: deps.sourceEpochOverride }) : null;
  const limited = await limit(deps, "trial_resolve_per_source", sourceKeyFromRequest ?? "unknown");
  if (limited) return limited;

  const parsed = parseIntakeBody(req.rawBody);
  if (!parsed.ok) return parsed;
  const body = parsed.body;

  const variant = assertNoVariantIdentity(body);
  if (variant) return variant;
  for (const key of Object.keys(body)) {
    if (!COLD_OPEN_BODY_KEYS.includes(key)) return reject(400, "unexpected_field", `"${key}" is not an accepted field.`);
  }
  if (body.winnerSlot !== "A" && body.winnerSlot !== "B") {
    return reject(400, "invalid_slot", "winnerSlot must be exactly \"A\" or \"B\".");
  }
  let cohort: string | null = null;
  if (body.cohort !== undefined && body.cohort !== null) {
    if (typeof body.cohort !== "string" || !COHORT_PATTERN.test(body.cohort)) return reject(400, "invalid_cohort", "cohort must be a short label.");
    cohort = body.cohort;
  }

  const verified = verifyLearningContext(body.context, deps.secret!, deps.now, { kind: "cold_open" });
  if (!verified.ok) return reject(verified.code === "context_expired" ? 401 : 403, verified.code, verified.reason);
  if (typeof body.trialToken === "string" && body.trialToken !== verified.claims.trialId) {
    return reject(403, "context_mismatch", "This context was issued for a different trial.");
  }

  const episode = verified.claims.episodeId ? await deps.loadEpisode(verified.claims.episodeId) : null;
  const result = await recordColdOpenChoice(deps.store, {
    trialToken: verified.claims.trialId,
    winnerSlot: body.winnerSlot as ColdOpenSlot,
    formatId: episode?.formatId ?? null,
    hostPairKey: episode?.hostPairKey ?? null,
    voicePolicyVersion: episode?.voicePolicyVersion ?? null,
    productionPolicyVersion: episode?.productionPolicyVersion ?? null,
    cohort,
    // Signed at issue time, so a replay from a different machine still counts
    // against the source that was actually served the trial.
    sourceKey: verified.claims.src,
    now: deps.now,
  });

  if (!result.ok) {
    if (result.error === "already_decided") {
      return reject(409, "replayed_trial", "This trial has already been resolved. A trial resolves exactly once.");
    }
    return reject(result.error === "unknown_trial" ? 404 : 400, result.error, result.error);
  }
  // Deliberately does NOT echo the winning variant: the listener may still be
  // inside the experiment.
  return { ok: true, status: 200, body: { recorded: true } };
}
