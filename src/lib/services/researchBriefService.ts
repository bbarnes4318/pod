// Research-brief generation: the parts worth testing, lifted out of the queue
// worker so they can run without BullMQ, a worker, an LLM, a research provider,
// or the internet.
//
// The worker keeps orchestration (job log, LLM call, retries). Everything here
// is either pure or takes an injected db, and this is the ONLY implementation —
// the worker does not keep a second copy of these rules.
//
// WHAT THIS FIXES
//
// A custom topic could never become episode-eligible, and the reason was
// structural rather than a missing feature:
//
//   • Imported TopicSource rows were never shown to research, so a brief for a
//     hand-made topic had nothing real to stand on.
//   • `hasEvidence = topicEvidenceMap.size > 0` — with an empty packet the ref
//     checks were SKIPPED ENTIRELY and every claim was accepted with no refs.
//   • When nothing matched, sourceIds fell back to `[{type:"topic", id:topicId}]`
//     — the topic citing itself — and the gate, being a length check, called
//     that "sourced".
//
// So an ungrounded brief looked exactly like a grounded one. The fix is to make
// grounding the thing we check: no packet means no brief, refs are validated
// against what was actually supplied, and evidence is PROMOTED only from
// sources a validated claim actually cited.

import {
  parseEvidenceRef, dedupeRefs, sortRefs, refKey, resolveEvidenceRefs,
  parseEvidenceRefList, RESEARCH_IS_TRANSIENT,
  type EvidenceReference, type EvidenceDb,
} from "./evidenceRefs";

/** The evidence-type union shown to the model. One constant — it used to be
 *  repeated verbatim seven times in the prompt, which is how `topicSource`
 *  would have been forgotten in six of them. */
export const PROMPT_EVIDENCE_TYPES =
  `"game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat" | "topicSource" | "research"`;

export interface PacketTopicSource {
  id: string;
  canonicalUrl: string;
  title: string | null;
  publisher: string | null;
  author: string | null;
  publishedAt: Date | string | null;
  excerpt: string | null;
  contentHash: string | null;
  retrievedAt: Date | string | null;
  fetchStatus: string;
  topicId: string;
}

/** A claim the model returned, before validation. */
interface RawClaim {
  text?: string;
  claim?: string;
  evidenceRefs?: unknown;
  confidence?: string;
  host?: string;
}

export interface ValidatedClaim {
  text: string;
  evidenceRefs: EvidenceReference[];
  confidence?: string;
  host?: string;
}

export interface UnsafeClaim {
  claim: string;
  reason: string;
}

/**
 * Select the TopicSource rows that may be shown to research.
 *
 * A fetched URL is not automatically usable material: a failed import has no
 * text, and a row belonging to another topic is not this topic's evidence no
 * matter how relevant it looks.
 */
export function selectUsableSources(rows: PacketTopicSource[], topicId: string): PacketTopicSource[] {
  return rows
    .filter((r) => r.topicId === topicId)
    .filter((r) => r.fetchStatus === "imported")
    .filter((r) => !!r.canonicalUrl && !!r.contentHash)
    .filter((r) => !!r.excerpt && r.excerpt.trim().length >= 40)
    // Deterministic order → a stable packet → a stable prompt.
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The sanitized shape a TopicSource takes inside the evidence packet. */
export function serializeSourceForPacket(s: PacketTopicSource) {
  return {
    id: s.id,
    canonicalUrl: s.canonicalUrl,
    title: s.title,
    publisher: s.publisher,
    author: s.author,
    publishedAt: s.publishedAt ? new Date(s.publishedAt).toISOString() : null,
    // Already sanitized plain text at ingest. No raw HTML has ever been stored,
    // so none can reach a prompt, a brief, or a snapshot from here.
    excerpt: s.excerpt,
    contentHash: s.contentHash,
    retrievedAt: s.retrievedAt ? new Date(s.retrievedAt).toISOString() : null,
  };
}

/**
 * The set of refs a model is allowed to cite in this run.
 *
 * Transient `research-N` ids ARE included: routed research may legitimately
 * inform a brief. They are excluded from PERSISTENCE later, because a
 * `research-3` that resolves to nothing after the job ends is not a citation a
 * reader could ever check.
 */
export function buildAllowedKeys(opts: {
  evidenceIds: EvidenceReference[];
  sources: PacketTopicSource[];
  researchCount: number;
}): Set<string> {
  const keys = new Set<string>();
  for (const r of opts.evidenceIds) keys.add(refKey(r));
  for (const s of opts.sources) keys.add(`topicSource:${s.id}`);
  for (let i = 0; i < opts.researchCount; i++) keys.add(`research:research-${i + 1}`);
  return keys;
}

/** Instructions about sources. Separated so the rules are readable + testable. */
export function sourceRulesBlock(): string {
  return [
    "EVIDENCE RULES (these are hard constraints, not style guidance):",
    `- Allowed evidence types: ${PROMPT_EVIDENCE_TYPES}.`,
    '- A "topicSource" is a published article an editor imported for THIS topic. Its supplied excerpt is the only part of it you may rely on.',
    "- Cite a topicSource ONLY when the supplied excerpt itself supports the claim. Do not infer what the rest of the article probably says.",
    "- NEVER cite a topicSource id that is not in the evidence packet below.",
    "- NEVER cite the topic itself as a source. The topic is the thing being researched, not evidence for it.",
    '- NEVER invent a "research-N" id. Only use ones present in the packet.',
    "- The topic's title, summary, angle and editorial notes are an EDITOR'S OPINION about what to look into. They are NOT facts and NOT evidence. Never restate them as verified, and never cite them.",
    "- Every factual item needs evidenceRefs. If the packet does not support a claim, put it in unsafeClaims rather than asserting it.",
  ].join("\n");
}

/**
 * Validate one claim against the packet.
 *
 * A claim is accepted only if EVERY ref it carries is allowed — one good ref
 * does not license the bad ones beside it. That mattered: a model that cites
 * one real article and three imaginary ones is not "mostly right", it is
 * fabricating, and keeping the claim would launder the fabrication.
 */
export function validateClaimRefs(
  raw: unknown,
  allowedKeys: Set<string>,
  topicId: string
): { ok: true; refs: EvidenceReference[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, reason: "no evidence references" };
  }
  const refs: EvidenceReference[] = [];
  for (const item of raw) {
    const parsed = parseEvidenceRef(item);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.error.code === "topic_self" ? "cites the topic itself" : parsed.error.message };
    }
    if (parsed.ref.id === topicId) return { ok: false, reason: "cites the topic itself" };
    if (!allowedKeys.has(refKey(parsed.ref))) {
      return { ok: false, reason: `references ${refKey(parsed.ref)}, which was not supplied for this run` };
    }
    refs.push(parsed.ref);
  }
  return { ok: true, refs: dedupeRefs(refs) };
}

export interface ValidateBriefInput {
  llmResult: Record<string, unknown>;
  allowedKeys: Set<string>;
  topicId: string;
  hostAName: string;
  hostBName: string;
  /** Rejects claims that read as rumor regardless of refs. */
  rumorKeywords?: RegExp;
}

export interface ValidateBriefOutput {
  ok: boolean;
  /** Why the brief is not usable. Structured, for the job log + eligibility. */
  failure?: "no_packet" | "no_grounded_facts" | "no_valid_sources" | "missing_host_arguments" | "ungrounded_host_arguments";
  facts: ValidatedClaim[];
  stats: ValidatedClaim[];
  counterArguments: ValidatedClaim[];
  unsafeClaims: UnsafeClaim[];
  argumentForHostA: string;
  argumentForHostB: string;
  hostARefs: EvidenceReference[];
  hostBRefs: EvidenceReference[];
  /** DURABLE refs actually cited by accepted content. Transient research excluded. */
  sourceIds: EvidenceReference[];
  /** The topicSource refs eligible for promotion into TopicCandidate.evidenceIds. */
  citedTopicSourceRefs: EvidenceReference[];
}

const DEFAULT_RUMOR = /\b(rumor|rumour|reportedly|sources say|expected to|could be|might be|allegedly)\b/i;

/**
 * Validate a model's brief against the packet. PURE — no I/O, no LLM, no db.
 * The db-backed re-check happens in persistBriefWithPromotion.
 */
export function validateBriefResult(input: ValidateBriefInput): ValidateBriefOutput {
  const { llmResult, allowedKeys, topicId, hostAName, hostBName } = input;
  const rumor = input.rumorKeywords ?? DEFAULT_RUMOR;
  const unsafeClaims: UnsafeClaim[] = [];

  const base: ValidateBriefOutput = {
    ok: false, facts: [], stats: [], counterArguments: [], unsafeClaims,
    argumentForHostA: "", argumentForHostB: "", hostARefs: [], hostBRefs: [],
    sourceIds: [], citedTopicSourceRefs: [],
  };

  // An empty packet used to SKIP validation and accept everything. It now ends
  // the run: with nothing supplied, any "fact" is invention by definition.
  if (allowedKeys.size === 0) {
    return { ...base, failure: "no_packet" };
  }

  const takeClaims = (value: unknown, textKey: "text" | "claim"): ValidatedClaim[] => {
    const out: ValidatedClaim[] = [];
    if (!Array.isArray(value)) return out;
    for (const item of value as RawClaim[]) {
      const text = String((item?.[textKey] ?? "") as string).trim();
      if (!text) continue;
      if (rumor.test(text)) {
        unsafeClaims.push({ claim: text, reason: "reads as rumor or speculation rather than a verified fact" });
        continue;
      }
      const checked = validateClaimRefs(item?.evidenceRefs, allowedKeys, topicId);
      if (!checked.ok) {
        unsafeClaims.push({ claim: text, reason: checked.reason });
        continue;
      }
      out.push({
        text,
        evidenceRefs: checked.refs,
        ...(item.confidence ? { confidence: String(item.confidence) } : {}),
        ...(textKey === "claim" ? { host: item.host === hostBName ? hostBName : hostAName } : {}),
      });
    }
    return out;
  };

  const facts = takeClaims(llmResult.keyFactsContext, "text");
  const stats = takeClaims(llmResult.onAirTalkingPoints, "text");
  const counterArguments = takeClaims(llmResult.counterArguments, "claim");

  // Carry over anything the model itself flagged.
  if (Array.isArray(llmResult.unsafeClaims)) {
    for (const u of llmResult.unsafeClaims as Array<{ claim?: string; reason?: string }>) {
      if (u?.claim) unsafeClaims.push({ claim: String(u.claim), reason: String(u.reason ?? "flagged by the generator") });
    }
  }

  const argumentForHostA = String((llmResult.argumentForHostA ?? "") as string).trim();
  const argumentForHostB = String((llmResult.argumentForHostB ?? "") as string).trim();
  if (!argumentForHostA || !argumentForHostB) {
    return { ...base, facts, stats, counterArguments, failure: "missing_host_arguments" };
  }
  if (rumor.test(argumentForHostA) || rumor.test(argumentForHostB)) {
    return { ...base, facts, stats, counterArguments, failure: "ungrounded_host_arguments" };
  }

  const refsA = validateClaimRefs(llmResult.argumentForHostAEvidenceRefs, allowedKeys, topicId);
  const refsB = validateClaimRefs(llmResult.argumentForHostBEvidenceRefs, allowedKeys, topicId);
  if (!refsA.ok || !refsB.ok) {
    return { ...base, facts, stats, counterArguments, argumentForHostA, argumentForHostB, failure: "ungrounded_host_arguments" };
  }

  if (facts.length === 0) {
    return { ...base, facts, stats, counterArguments, argumentForHostA, argumentForHostB, failure: "no_grounded_facts" };
  }

  // sourceIds are built from what accepted content ACTUALLY cited — never from
  // the model's own top-level sourceIds, which are unverified self-report. The
  // model's list is intersected in only if it survives the same checks.
  const cited: EvidenceReference[] = [];
  for (const c of [...facts, ...stats, ...counterArguments]) cited.push(...c.evidenceRefs);
  cited.push(...refsA.refs, ...refsB.refs);

  const claimedTop = parseEvidenceRefList(llmResult.sourceIds).refs.filter((r) => allowedKeys.has(refKey(r)) && r.id !== topicId);
  const all = dedupeRefs([...cited, ...claimedTop]);

  // Transient research informs the brief but is never persisted as a source.
  const durable = all.filter((r) => !(r.type === "research" && RESEARCH_IS_TRANSIENT));
  if (durable.length === 0) {
    // Grounded only by transient research (or nothing) → not durably sourced.
    return { ...base, facts, stats, counterArguments, argumentForHostA, argumentForHostB, failure: "no_valid_sources" };
  }

  return {
    ok: true,
    facts, stats, counterArguments, unsafeClaims,
    argumentForHostA, argumentForHostB,
    hostARefs: refsA.refs, hostBRefs: refsB.refs,
    sourceIds: sortRefs(durable),
    citedTopicSourceRefs: sortRefs(dedupeRefs(cited.filter((r) => r.type === "topicSource"))),
  };
}

export interface PersistDeps {
  db: EvidenceDb & {
    $transaction: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>;
    researchBrief: { findUnique: (a: unknown) => Promise<unknown>; upsert: (a: unknown) => Promise<unknown> };
    topicCandidate: { findUnique: (a: unknown) => Promise<unknown>; update: (a: unknown) => Promise<unknown> };
  };
}

export interface PromotionResult {
  promoted: EvidenceReference[];
  /** evidenceIds as written (existing valid + newly promoted). */
  evidenceIds: EvidenceReference[];
  dropped: Array<{ ref: EvidenceReference; reason: string }>;
}

/**
 * Write the brief and promote cited sources into evidence, in ONE transaction.
 *
 * Promotion rules, all of which exist because the opposite was tempting:
 *   • Only topicSource refs a VALIDATED claim actually cited. A successful
 *     import promotes nothing by itself — fetching a URL proves the URL
 *     resolved, not that it supports anything.
 *   • Re-checked against the database here, not trusted from the pure pass.
 *   • Existing valid evidence is preserved; a generated topic keeps its game /
 *     newsItem refs and simply gains sources.
 *   • Deduped and deterministically ordered, because evidenceIds feeds an
 *     immutable snapshot fingerprint.
 */
export async function promoteCitedSources(
  deps: PersistDeps,
  topicId: string,
  citedTopicSourceRefs: EvidenceReference[],
  existingEvidenceIds: unknown,
  tx?: unknown
): Promise<PromotionResult> {
  const db = (tx ?? deps.db) as EvidenceDb;

  // Re-validate against real rows: the pure pass only proved the model cited
  // something we showed it, not that the row is still there and still usable.
  const check = await resolveEvidenceRefs(citedTopicSourceRefs, { db, topicId });
  const promoted = check.valid;
  const dropped = check.invalid.map((i) => ({ ref: i.ref, reason: i.error.message }));

  // Keep whatever the topic already had that still resolves.
  const existing = parseEvidenceRefList(existingEvidenceIds).refs;
  const existingCheck = existing.length ? await resolveEvidenceRefs(existing, { db, topicId }) : { valid: [], invalid: [] };

  const evidenceIds = sortRefs(dedupeRefs([...existingCheck.valid, ...promoted]));
  return { promoted, evidenceIds, dropped };
}
