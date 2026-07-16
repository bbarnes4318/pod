// The ONE contract for evidence references.
//
// An evidence reference is a claim that some row in this database backs a
// statement we are about to put in a podcast's mouth. Before this module the
// rules lived in four places — an if/else chain in the worker, a length check
// in the eligibility gate, and implicit assumptions in the script generator and
// fact-checker — so "is this evidence?" had four different answers.
//
// TWO THINGS THIS FIXES, both of which were real:
//
//  1. CARDINALITY WAS MISTAKEN FOR INTEGRITY. The gates asked
//     `Array.isArray(x) && x.length > 0` and nothing else, so `evidenceIds:
//     [null]`, `["garbage"]`, or a ref to a NewsItem deleted months ago all
//     passed as "has evidence". Validity was checked once at write time and
//     never again.
//  2. A TOPIC COULD CITE ITSELF. The brief builder fell back to
//     `[{ type: "topic", id: topicId }]` when nothing matched, manufacturing a
//     citation out of the thing being cited — and the length check couldn't
//     tell that apart from real sourcing.
//
// So: references are PARSED (never trusted because they have `type` and `id`),
// RESOLVED against real rows, and — for topicSource — checked to belong to the
// topic making the claim.

import type { PrismaClient } from "@prisma/client";

/**
 * Every supported reference type.
 *
 * `research` is deliberately included but is NOT durable — see
 * RESEARCH_IS_TRANSIENT below.
 */
export const EVIDENCE_TYPES = [
  "game",
  "newsItem",
  "injury",
  "oddsSnapshot",
  "teamStat",
  "playerStat",
  "topicSource",
  "research",
] as const;

export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export interface EvidenceReference {
  type: EvidenceType;
  id: string;
}

/**
 * Routed external research (Exa) is handed synthetic ids — `research-1`,
 * `research-2` — that exist only for the length of one job. Nothing stores
 * them, so a persisted `research-3` can never be resolved, verified, or shown
 * to a reader: it is a made-up string wearing a citation's clothes.
 *
 * The honest options were (a) persist routed results in a real model and cite
 * real row ids, or (b) treat routed research as transient enrichment and keep
 * it out of persistence. We take (b): it needs no new storage system, and (a)
 * would mean standing up a durable model for data we currently have no
 * retention policy for. Consequence, stated plainly: routed research can
 * INFORM a brief but can never be the thing that makes a topic eligible.
 */
export const RESEARCH_IS_TRANSIENT = true;

/** Types that may be written to evidenceIds / sourceIds. */
export const DURABLE_EVIDENCE_TYPES = EVIDENCE_TYPES.filter((t) => t !== "research");

export type EvidenceRefErrorCode =
  | "malformed"
  | "unsupported_type"
  | "missing_id"
  | "topic_self"
  | "not_found"
  | "cross_topic"
  | "unusable_source"
  | "not_in_packet"
  | "transient_research";

export interface EvidenceRefError {
  code: EvidenceRefErrorCode;
  message: string;
  /** The offending value, stringified and truncated — safe to log. */
  ref?: string;
}

/** A parsed-but-not-yet-resolved reference. */
export function parseEvidenceRef(value: unknown): { ok: true; ref: EvidenceReference } | { ok: false; error: EvidenceRefError } {
  const show = (() => {
    try { return JSON.stringify(value)?.slice(0, 120) ?? String(value); } catch { return "(unserializable)"; }
  })();

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: { code: "malformed", message: "Evidence reference is not an object.", ref: show } };
  }
  const v = value as Record<string, unknown>;
  if (typeof v.type !== "string" || v.type === "") {
    return { ok: false, error: { code: "malformed", message: "Evidence reference has no type.", ref: show } };
  }
  // `topic` was never a real type — it only ever appeared via the self-citation
  // fallback. Name it explicitly so the repair tooling can report it precisely
  // instead of lumping it in with typos.
  if (v.type === "topic") {
    return { ok: false, error: { code: "topic_self", message: "A topic cannot be its own source.", ref: show } };
  }
  if (!(EVIDENCE_TYPES as readonly string[]).includes(v.type)) {
    return { ok: false, error: { code: "unsupported_type", message: `Unsupported evidence type '${v.type}'.`, ref: show } };
  }
  if (typeof v.id !== "string" || v.id.trim() === "") {
    return { ok: false, error: { code: "missing_id", message: "Evidence reference has no id.", ref: show } };
  }
  return { ok: true, ref: { type: v.type as EvidenceType, id: v.id.trim() } };
}

/** Stable key for dedupe + ordering. */
export const refKey = (r: EvidenceReference): string => `${r.type}:${r.id}`;

/**
 * Deduplicate, preserving FIRST-SEEN order.
 *
 * Order is part of the contract: evidenceIds feeds an immutable episode
 * snapshot and its fingerprint, so a set that reshuffles between runs would
 * make identical evidence hash differently and look like a change.
 */
export function dedupeRefs(refs: EvidenceReference[]): EvidenceReference[] {
  const seen = new Set<string>();
  const out: EvidenceReference[] = [];
  for (const r of refs) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** Canonical ordering for persistence: by type (declaration order), then id. */
export function sortRefs(refs: EvidenceReference[]): EvidenceReference[] {
  const rank = (t: EvidenceType) => EVIDENCE_TYPES.indexOf(t);
  return [...refs].sort((a, b) => rank(a.type) - rank(b.type) || a.id.localeCompare(b.id));
}

/** Parse a whole JSON array, keeping the good and reporting the bad. */
export function parseEvidenceRefList(value: unknown): { refs: EvidenceReference[]; errors: EvidenceRefError[] } {
  if (!Array.isArray(value)) {
    return { refs: [], errors: value == null ? [] : [{ code: "malformed", message: "Evidence list is not an array." }] };
  }
  const refs: EvidenceReference[] = [];
  const errors: EvidenceRefError[] = [];
  for (const item of value) {
    const parsed = parseEvidenceRef(item);
    if (parsed.ok) refs.push(parsed.ref);
    else errors.push(parsed.error);
  }
  return { refs: dedupeRefs(refs), errors };
}

/** The DB surface resolution needs — satisfied by PrismaClient and test doubles. */
export interface EvidenceDb {
  game: { findMany: (args: unknown) => Promise<Array<{ id: string }>> };
  newsItem: { findMany: (args: unknown) => Promise<Array<{ id: string }>> };
  injury: { findMany: (args: unknown) => Promise<Array<{ id: string }>> };
  oddsSnapshot: { findMany: (args: unknown) => Promise<Array<{ id: string }>> };
  teamStat: { findMany: (args: unknown) => Promise<Array<{ id: string }>> };
  playerStat: { findMany: (args: unknown) => Promise<Array<{ id: string }>> };
  topicSource: {
    findMany: (args: unknown) => Promise<Array<{
      id: string; topicId: string; fetchStatus: string; canonicalUrl: string;
      excerpt: string | null; contentHash: string | null;
    }>>;
  };
}

export interface ResolveContext {
  db: EvidenceDb | PrismaClient;
  /** The topic making the claim. Required to catch cross-topic sources. */
  topicId: string;
  /**
   * When present, a reference must ALSO be in this packet. This is what stops a
   * model citing a real row that was never shown to it.
   */
  allowedKeys?: Set<string>;
}

export interface ResolveResult {
  valid: EvidenceReference[];
  invalid: Array<{ ref: EvidenceReference; error: EvidenceRefError }>;
}

/** A TopicSource is usable evidence only if it is genuinely a fetched article. */
export function topicSourceIsUsable(row: {
  fetchStatus: string; canonicalUrl: string | null; excerpt: string | null; contentHash: string | null;
}): { ok: true } | { ok: false; reason: string } {
  if (row.fetchStatus !== "imported") return { ok: false, reason: `its import did not succeed (${row.fetchStatus})` };
  if (!row.canonicalUrl || row.canonicalUrl.trim() === "") return { ok: false, reason: "it has no canonical URL" };
  if (!row.excerpt || row.excerpt.trim().length < 40) return { ok: false, reason: "it has no usable extracted text" };
  if (!row.contentHash || row.contentHash.trim() === "") return { ok: false, reason: "it has no content hash" };
  return { ok: true };
}

/**
 * Resolve references against real rows.
 *
 * Every id is checked to EXIST. topicSource additionally must belong to
 * `ctx.topicId` and be a genuinely usable import — a fetched URL is not
 * automatically verified evidence.
 */
export async function resolveEvidenceRefs(refs: EvidenceReference[], ctx: ResolveContext): Promise<ResolveResult> {
  const db = ctx.db as EvidenceDb;
  const valid: EvidenceReference[] = [];
  const invalid: ResolveResult["invalid"] = [];

  const unique = dedupeRefs(refs);
  const byType = new Map<EvidenceType, string[]>();
  for (const r of unique) {
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r.id);
  }

  const reject = (ref: EvidenceReference, code: EvidenceRefErrorCode, message: string) =>
    invalid.push({ ref, error: { code, message, ref: refKey(ref) } });

  // Existence, one query per type rather than per ref.
  const existing = new Map<EvidenceType, Set<string>>();
  const simpleTables: Array<[EvidenceType, keyof EvidenceDb]> = [
    ["game", "game"], ["newsItem", "newsItem"], ["injury", "injury"],
    ["oddsSnapshot", "oddsSnapshot"], ["teamStat", "teamStat"], ["playerStat", "playerStat"],
  ];
  for (const [type, table] of simpleTables) {
    const ids = byType.get(type);
    if (!ids?.length) continue;
    const rows = await (db[table] as { findMany: (a: unknown) => Promise<Array<{ id: string }>> }).findMany({
      where: { id: { in: ids } }, select: { id: true },
    });
    existing.set(type, new Set(rows.map((r) => r.id)));
  }

  // topicSource carries ownership + usability rules the others don't.
  const sourceRows = new Map<string, { id: string; topicId: string; fetchStatus: string; canonicalUrl: string; excerpt: string | null; contentHash: string | null }>();
  const sourceIds = byType.get("topicSource");
  if (sourceIds?.length) {
    const rows = await db.topicSource.findMany({
      where: { id: { in: sourceIds } },
      select: { id: true, topicId: true, fetchStatus: true, canonicalUrl: true, excerpt: true, contentHash: true },
    });
    for (const r of rows) sourceRows.set(r.id, r);
  }

  for (const ref of unique) {
    // Transient research can never be persisted or satisfy a gate.
    if (ref.type === "research" && RESEARCH_IS_TRANSIENT) {
      reject(ref, "transient_research", "Routed research is transient enrichment and cannot be a durable source.");
      continue;
    }
    // A packet, when supplied, is an allowlist: citing a real row we never
    // showed the model means the model invented the connection.
    if (ctx.allowedKeys && !ctx.allowedKeys.has(refKey(ref))) {
      reject(ref, "not_in_packet", "That reference was not part of the evidence supplied for this run.");
      continue;
    }
    // The topic can never be its own source, however the id arrives.
    if (ref.id === ctx.topicId) {
      reject(ref, "topic_self", "A topic cannot be its own source.");
      continue;
    }

    if (ref.type === "topicSource") {
      const row = sourceRows.get(ref.id);
      if (!row) { reject(ref, "not_found", "That source no longer exists."); continue; }
      if (row.topicId !== ctx.topicId) {
        reject(ref, "cross_topic", "That source belongs to a different topic.");
        continue;
      }
      const usable = topicSourceIsUsable(row);
      if (!usable.ok) { reject(ref, "unusable_source", `That source can't be used as evidence: ${usable.reason}.`); continue; }
      valid.push(ref);
      continue;
    }

    if (!existing.get(ref.type)?.has(ref.id)) {
      reject(ref, "not_found", `That ${ref.type} record no longer exists.`);
      continue;
    }
    valid.push(ref);
  }

  return { valid, invalid };
}

/**
 * Validate a persisted list (evidenceIds / sourceIds) for a gate.
 * Parse errors and resolution errors are reported together, because a caller
 * asking "is this evidence real?" doesn't care which layer said no.
 */
export async function validatePersistedRefs(
  value: unknown,
  ctx: ResolveContext
): Promise<{ valid: EvidenceReference[]; errors: EvidenceRefError[] }> {
  const { refs, errors } = parseEvidenceRefList(value);
  if (refs.length === 0) return { valid: [], errors };
  const resolved = await resolveEvidenceRefs(refs, ctx);
  return { valid: resolved.valid, errors: [...errors, ...resolved.invalid.map((i) => i.error)] };
}
