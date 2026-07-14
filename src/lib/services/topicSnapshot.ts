// Immutable, versioned episode-topic snapshots.
//
// An episode records the topic + research brief AS SELECTED (including the
// selection-time talkability report) so EVERY downstream decision — content
// gate, quality metadata, evidence, prompt, self-verify, fact-check — is
// reproducible even if the source TopicCandidate/ResearchBrief is later edited,
// re-researched, or archived. Live data is used only for legacy rows that
// predate snapshots (or when a snapshot is unreadable — see corrupt policy).

import crypto from "crypto";
import { z } from "zod";
import { scoreTopicTalkability } from "./talkabilityService";

export const EPISODE_TOPIC_SNAPSHOT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Versioned schema (V1)
// ---------------------------------------------------------------------------

const isoString = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 timestamp");

/** SHA-256 (64 hex) for snapshots created now; MD5 (32 hex) accepted as a
 *  legacy V1 fingerprint for rows backfilled by the migration. */
const fingerprint = z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{64}$/i, "hex md5/sha256 fingerprint");

const talkabilitySchema = z
  .object({ total: z.number() })
  .passthrough()
  .nullable()
  .optional();

export const EpisodeTopicSnapshotV1Schema = z
  .object({
    version: z.literal(1),
    source: z.enum(["creation", "backfill"]),
    title: z.string().min(1),
    summary: z.string().nullable(),
    sport: z.string().nullable(),
    leagueId: z.string().nullable(),
    evidenceIds: z.unknown(),
    facts: z.unknown(),
    sourceIds: z.unknown(),
    stats: z.unknown().optional(),
    mainAngle: z.string().nullable(),
    contrarianAngle: z.string().nullable(),
    argumentForHostA: z.string().nullable(),
    argumentForHostB: z.string().nullable(),
    counterArguments: z.unknown().optional(),
    unsafeClaims: z.unknown().optional(),
    onAirTalkingPoints: z.unknown().optional(),
    whyMattersNow: z.string().nullable().optional(),
    keyFactsContext: z.unknown().optional(),
    debateScore: z.number().nullable(),
    strongestDebateQuestion: z.string().nullable().optional(),
    suggestedHostTake: z.string().nullable().optional(),
    injuryContext: z.string().nullable().optional(),
    oddsContext: z.string().nullable().optional(),
    // Reproducibility inputs for the content/quality gate.
    topicCreatedAt: isoString,
    selectionTimestamp: isoString,
    talkability: talkabilitySchema,
    evidenceFingerprint: fingerprint,
    fingerprintAlgo: z.enum(["md5", "sha256"]).optional(),
  })
  .passthrough();

export type EpisodeTopicSnapshot = z.infer<typeof EpisodeTopicSnapshotV1Schema>;

/** Outcome of inspecting a stored snapshot value. */
export type SnapshotStatus = "valid" | "missing" | "unsupported_version" | "corrupt";

export interface SnapshotParse {
  status: SnapshotStatus;
  snapshot?: EpisodeTopicSnapshot;
  /** Human-readable reason for a non-valid result (unsupported/corrupt). */
  reason?: string;
}

/**
 * Strictly classify a stored snapshot. NEVER treats a corrupt object as valid.
 *  - missing: null/undefined (legacy row).
 *  - unsupported_version: an object with a version we don't understand.
 *  - corrupt: present but fails validation (malformed/partial JSON).
 *  - valid: a fully-validated V1 snapshot.
 */
export function parseSnapshot(raw: unknown): SnapshotParse {
  if (raw === null || raw === undefined) return { status: "missing" };
  if (typeof raw !== "object") return { status: "corrupt", reason: "snapshot is not an object" };
  const version = (raw as any).version;
  if (version !== undefined && version !== EPISODE_TOPIC_SNAPSHOT_VERSION) {
    return { status: "unsupported_version", reason: `snapshot version ${String(version)} is not supported` };
  }
  const parsed = EpisodeTopicSnapshotV1Schema.safeParse(raw);
  if (!parsed.success) {
    return { status: "corrupt", reason: parsed.error.issues[0]?.message || "snapshot failed validation" };
  }
  return { status: "valid", snapshot: parsed.data };
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

type LiveTopic = {
  title: string;
  summary?: string | null;
  sport?: string | null;
  leagueId?: string | null;
  evidenceIds?: unknown;
  debateScore?: number | null;
  createdAt?: Date | string | null;
  researchBrief?: LiveBrief | null;
};

type LiveBrief =
  | {
      facts?: unknown;
      sourceIds?: unknown;
      stats?: unknown;
      mainAngle?: string | null;
      contrarianAngle?: string | null;
      argumentForHostA?: string | null;
      argumentForHostB?: string | null;
      counterArguments?: unknown;
      unsafeClaims?: unknown;
      onAirTalkingPoints?: unknown;
      whyMattersNow?: string | null;
      keyFactsContext?: unknown;
      strongestDebateQuestion?: string | null;
      suggestedHostTake?: string | null;
      injuryContext?: string | null;
      oddsContext?: string | null;
    }
  | null;

/** SHA-256 evidence fingerprint for snapshots created now. */
export function evidenceFingerprintSha256(facts: unknown, sourceIds: unknown, evidenceIds: unknown): string {
  const material = `${JSON.stringify(facts ?? null)}|${JSON.stringify(sourceIds ?? null)}|${JSON.stringify(evidenceIds ?? null)}`;
  return crypto.createHash("sha256").update(material).digest("hex");
}

function toIso(d: Date | string | null | undefined): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string" && !Number.isNaN(Date.parse(d))) return new Date(d).toISOString();
  return new Date().toISOString();
}

/** Freeze a topic + its brief into a V1 snapshot at selection time, including
 *  the selection-time talkability report so the content gate is reproducible. */
export function buildTopicSnapshot(
  topic: LiveTopic,
  brief: LiveBrief,
  selectionTimestamp: Date = new Date()
): EpisodeTopicSnapshot {
  const talk = scoreTopicTalkability({
    title: topic.title,
    summary: topic.summary ?? null,
    createdAt: (topic.createdAt instanceof Date ? topic.createdAt : new Date()) as any,
    brief: brief as any,
  });
  return {
    version: EPISODE_TOPIC_SNAPSHOT_VERSION,
    source: "creation",
    title: topic.title,
    summary: topic.summary ?? null,
    sport: topic.sport ?? null,
    leagueId: topic.leagueId ?? null,
    evidenceIds: topic.evidenceIds ?? [],
    facts: brief?.facts ?? [],
    sourceIds: brief?.sourceIds ?? [],
    stats: brief?.stats,
    mainAngle: brief?.mainAngle ?? null,
    contrarianAngle: brief?.contrarianAngle ?? null,
    argumentForHostA: brief?.argumentForHostA ?? null,
    argumentForHostB: brief?.argumentForHostB ?? null,
    counterArguments: brief?.counterArguments,
    unsafeClaims: brief?.unsafeClaims,
    onAirTalkingPoints: brief?.onAirTalkingPoints,
    whyMattersNow: brief?.whyMattersNow ?? null,
    keyFactsContext: brief?.keyFactsContext,
    debateScore: topic.debateScore ?? null,
    strongestDebateQuestion: brief?.strongestDebateQuestion ?? null,
    suggestedHostTake: brief?.suggestedHostTake ?? null,
    injuryContext: brief?.injuryContext ?? null,
    oddsContext: brief?.oddsContext ?? null,
    topicCreatedAt: toIso(topic.createdAt ?? new Date()),
    selectionTimestamp: toIso(selectionTimestamp),
    talkability: talk as any,
    evidenceFingerprint: evidenceFingerprintSha256(brief?.facts, brief?.sourceIds, topic.evidenceIds),
    fingerprintAlgo: "sha256",
  } as EpisodeTopicSnapshot;
}

// ---------------------------------------------------------------------------
// Resolve (snapshot-first)
// ---------------------------------------------------------------------------

export interface ResolvedTopicContent {
  /** Where the content came from + how the snapshot was classified. */
  fromSnapshot: boolean;
  snapshotStatus: SnapshotStatus;
  title: string;
  summary: string | null;
  sport: string | null;
  leagueId: string | null;
  evidenceIds: unknown;
  facts: unknown;
  sourceIds: unknown;
  stats?: unknown;
  mainAngle: string | null;
  contrarianAngle: string | null;
  argumentForHostA: string | null;
  argumentForHostB: string | null;
  counterArguments?: unknown;
  unsafeClaims?: unknown;
  onAirTalkingPoints?: unknown;
  whyMattersNow?: string | null;
  keyFactsContext?: unknown;
  debateScore: number | null;
  strongestDebateQuestion?: string | null;
  suggestedHostTake?: string | null;
  injuryContext?: string | null;
  oddsContext?: string | null;
  topicCreatedAt: string | null;
  selectionTimestamp: string | null;
  /** Selection-time talkability report (snapshot) — the content gate reads it. */
  talkability?: { total: number } | null;
}

/**
 * Resolve one EpisodeTopic to content, preferring a VALID snapshot. Corrupt or
 * unsupported-version snapshots FAIL OPEN to live data (an already-produced
 * episode must still render), but never silently: the returned snapshotStatus
 * surfaces the problem so callers can log/alert. Legacy rows (missing) use live.
 */
export function resolveEpisodeTopicContent(et: {
  snapshot?: unknown;
  topic?: LiveTopic | null;
}): ResolvedTopicContent {
  const parse = parseSnapshot(et.snapshot);
  if (parse.status === "valid" && parse.snapshot) {
    const s = parse.snapshot;
    return {
      fromSnapshot: true,
      snapshotStatus: "valid",
      title: s.title,
      summary: s.summary ?? null,
      sport: s.sport ?? null,
      leagueId: s.leagueId ?? null,
      evidenceIds: s.evidenceIds ?? [],
      facts: s.facts ?? [],
      sourceIds: s.sourceIds ?? [],
      stats: s.stats,
      mainAngle: s.mainAngle ?? null,
      contrarianAngle: s.contrarianAngle ?? null,
      argumentForHostA: s.argumentForHostA ?? null,
      argumentForHostB: s.argumentForHostB ?? null,
      counterArguments: s.counterArguments,
      unsafeClaims: s.unsafeClaims,
      onAirTalkingPoints: s.onAirTalkingPoints,
      whyMattersNow: s.whyMattersNow ?? null,
      keyFactsContext: s.keyFactsContext,
      debateScore: s.debateScore ?? null,
      strongestDebateQuestion: s.strongestDebateQuestion ?? null,
      suggestedHostTake: s.suggestedHostTake ?? null,
      injuryContext: s.injuryContext ?? null,
      oddsContext: s.oddsContext ?? null,
      topicCreatedAt: s.topicCreatedAt ?? null,
      selectionTimestamp: s.selectionTimestamp ?? null,
      talkability: (s.talkability as any) ?? null,
    };
  }

  // Fall back to live (missing/corrupt/unsupported).
  const t = et.topic || ({} as LiveTopic);
  const b = t.researchBrief || null;
  return {
    fromSnapshot: false,
    snapshotStatus: parse.status,
    title: t.title,
    summary: t.summary ?? null,
    sport: t.sport ?? null,
    leagueId: t.leagueId ?? null,
    evidenceIds: t.evidenceIds ?? [],
    facts: b?.facts ?? [],
    sourceIds: b?.sourceIds ?? [],
    stats: b?.stats,
    mainAngle: b?.mainAngle ?? null,
    contrarianAngle: b?.contrarianAngle ?? null,
    argumentForHostA: b?.argumentForHostA ?? null,
    argumentForHostB: b?.argumentForHostB ?? null,
    counterArguments: b?.counterArguments,
    unsafeClaims: b?.unsafeClaims,
    onAirTalkingPoints: b?.onAirTalkingPoints,
    whyMattersNow: b?.whyMattersNow ?? null,
    keyFactsContext: b?.keyFactsContext,
    debateScore: t.debateScore ?? null,
    strongestDebateQuestion: b?.strongestDebateQuestion ?? null,
    suggestedHostTake: b?.suggestedHostTake ?? null,
    injuryContext: b?.injuryContext ?? null,
    oddsContext: b?.oddsContext ?? null,
    topicCreatedAt: t.createdAt ? toIso(t.createdAt) : null,
    selectionTimestamp: null,
    talkability: null,
  };
}

/** Shape resolved content back into a ResearchBrief-like object so existing
 *  brief consumers (prompt builder, collectReviewerEvidence) work unchanged. */
export function briefLikeFromContent(c: ResolvedTopicContent) {
  return {
    facts: c.facts,
    stats: c.stats,
    sourceIds: c.sourceIds,
    keyFactsContext: c.keyFactsContext,
    argumentForHostA: c.argumentForHostA,
    argumentForHostB: c.argumentForHostB,
    mainAngle: c.mainAngle,
    contrarianAngle: c.contrarianAngle,
    whyMattersNow: c.whyMattersNow,
    onAirTalkingPoints: c.onAirTalkingPoints,
    counterArguments: c.counterArguments,
    unsafeClaims: c.unsafeClaims,
    injuryContext: c.injuryContext ?? null,
    oddsContext: c.oddsContext ?? null,
    strongestDebateQuestion: c.strongestDebateQuestion ?? null,
    suggestedHostTake: c.suggestedHostTake ?? null,
  };
}
