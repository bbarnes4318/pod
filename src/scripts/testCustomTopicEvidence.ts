// Custom-topic evidence pipeline. Run: npm run test:custom-topic-evidence
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness doubles are intentionally loose. */
//
// The claim under test: a custom topic can now reach an episode, but ONLY by
// being genuinely grounded — and every shortcut that used to fake grounding is
// closed. So this asserts the negatives as hard as the positive:
//
//   • an imported source promotes NOTHING by itself;
//   • a topic can never cite itself, however the id arrives;
//   • cardinality never substitutes for integrity;
//   • one valid ref does not launder the invalid ones beside it;
//   • a transient research-N id can inform a brief but never ground it.
//
// Nothing here touches an LLM, a research provider, a queue, or a network: the
// generator's output is a literal object and the db is in-memory.

process.env.TOPIC_MIN_TALKABILITY = "1";

import {
  parseEvidenceRef, parseEvidenceRefList, dedupeRefs, sortRefs, resolveEvidenceRefs,
  topicSourceIsUsable, EVIDENCE_TYPES, type EvidenceReference,
} from "../lib/services/evidenceRefs";
import {
  selectUsableSources, serializeSourceForPacket, buildAllowedKeys, validateClaimRefs,
  validateBriefResult, promoteCitedSources, sourceRulesBlock, PROMPT_EVIDENCE_TYPES,
} from "../lib/services/researchBriefService";
import { evaluateHardGates, evaluateEvidenceIntegrity } from "../lib/services/topicEligibility";
import { createAdminEpisodeFor, getAdminTopicsFor, type AdminCtx } from "../lib/services/adminRundown";
import { EpisodeTopicSnapshotV1Schema } from "../lib/services/topicSnapshot";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const H = ["host-a", "host-b"];
const TOPIC = "t-custom";
const OTHER = "t-other";

function source(id: string, over: any = {}) {
  return {
    id, topicId: TOPIC, originalUrl: `https://wire.test/${id}`, canonicalUrl: `https://wire.test/${id}`,
    title: `Article ${id}`, publisher: "Wire", author: "Pat", publishedAt: new Date("2026-07-10T00:00:00Z"),
    excerpt: "A genuine sanitized excerpt long enough to be usable as research material for a claim.",
    contentHash: "a".repeat(64), fetchStatus: "imported", retrievedAt: new Date("2026-07-11T00:00:00Z"),
    createdByAdminIdentity: "admin", ...over,
  };
}

function makeDb(seed: { topics?: any[]; sources?: any[]; news?: any[]; games?: any[] } = {}) {
  const topics = new Map<string, any>((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const sources: any[] = (seed.sources || []).map((s) => ({ ...s }));
  const news: any[] = seed.news || [];
  const games: any[] = seed.games || [];
  const briefs = new Map<string, any>();
  const episodes = new Map<string, any>();
  const episodeTopics: any[] = [];
  let seq = 0;
  const findMany = (rows: any[]) => async ({ where }: any) =>
    rows.filter((r) => (where?.id?.in ? where.id.in.includes(r.id) : where?.topicId ? r.topicId === where.topicId : true));

  const api: any = {
    _topics: topics, _sources: sources, _briefs: briefs, _episodeTopics: episodeTopics, _episodes: episodes,
    topicCandidate: {
      findUnique: async ({ where }: any) => { const t = topics.get(where.id); return t ? { ...t, researchBrief: briefs.get(where.id) ?? null } : null; },
      findMany: async ({ where }: any) => [...topics.values()]
        .filter((t) => (where?.status?.in ? where.status.in.includes(t.status) : true))
        .map((t) => ({ ...t, researchBrief: briefs.get(t.id) ?? null })),
      update: async ({ where, data }: any) => { const t = topics.get(where.id); Object.assign(t, data); return t; },
    },
    topicSource: { findMany: findMany(sources) },
    newsItem: { findMany: findMany(news) },
    game: { findMany: findMany(games) },
    injury: { findMany: async () => [] },
    oddsSnapshot: { findMany: async () => [] },
    teamStat: { findMany: async () => [] },
    playerStat: { findMany: async () => [] },
    researchBrief: {
      findUnique: async ({ where }: any) => briefs.get(where.topicId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const ex = briefs.get(where.topicId);
        briefs.set(where.topicId, ex ? { ...ex, ...update } : create);
        return briefs.get(where.topicId);
      },
    },
    aiHost: { findMany: async () => [{ id: "host-a" }, { id: "host-b" }] },
    team: { findMany: async () => [] },
    podcast: { findUnique: async () => null, findMany: async () => [] },
    episode: { findUnique: async () => null, create: async ({ data }: any) => { const e = { id: `ep-${++seq}`, ...data }; episodes.set(e.id, e); return e; } },
    episodeTopic: { findMany: async () => [], create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    jobLog: { findMany: async () => [], create: async () => ({}) },
    adminDraft: { findUnique: async () => null, upsert: async () => ({}), deleteMany: async () => ({}) },
    $transaction: async (fn: any) => fn(api),
  };
  return api;
}

const adminCtx = (db: any): AdminCtx => ({ admin: { id: "admin" }, db });
const ref = (type: string, id: string): any => ({ type, id });
const claim = (text: string, refs: any[]) => ({ text, evidenceRefs: refs });

/** A generator result that is grounded in `srcId`. */
const groundedResult = (srcId: string) => ({
  keyFactsContext: [claim("The team has won 7 of 9 since the change, per the wire.", [ref("topicSource", srcId)])],
  onAirTalkingPoints: [claim("That is the best stretch in the division this season.", [ref("topicSource", srcId)])],
  counterArguments: [{ claim: "The schedule was soft over that stretch.", evidenceRefs: [ref("topicSource", srcId)], host: "A" }],
  argumentForHostA: "The turnaround is real and the record backs it.",
  argumentForHostAEvidenceRefs: [ref("topicSource", srcId)],
  argumentForHostB: "The sample is small and the opponents were weak.",
  argumentForHostBEvidenceRefs: [ref("topicSource", srcId)],
  unsafeClaims: [],
  sourceIds: [ref("topicSource", srcId)],
  mainAngle: "angle", whyMattersNow: "now", contrarianAngle: "contra",
  strongestDebateQuestion: "q", suggestedHostTake: "take",
});

async function main() {
  console.log("\nCustom-topic evidence pipeline\n");

  // =====================================================================
  console.log("Evidence schema + resolver");
  // =====================================================================

  await check("every supported reference type parses", () => {
    for (const t of EVIDENCE_TYPES) {
      const r = parseEvidenceRef({ type: t, id: "x1" });
      assert(r.ok, `${t} should parse`);
    }
  });

  await check("unsupported, malformed and id-less references are refused", () => {
    const cases: Array<[unknown, string]> = [
      [{ type: "podcast", id: "x" }, "unsupported_type"],
      [{ type: "newsItem" }, "missing_id"],
      [{ type: "newsItem", id: "   " }, "missing_id"],
      [{ id: "x" }, "malformed"],
      ["newsItem:x", "malformed"],
      [null, "malformed"],
      [["newsItem", "x"], "malformed"],
    ];
    for (const [input, code] of cases) {
      const r = parseEvidenceRef(input);
      assert(!r.ok && r.error.code === code, `${JSON.stringify(input)} -> expected ${code}, got ${r.ok ? "ok" : r.error.code}`);
    }
  });

  await check("CORE: the pseudo-type 'topic' is refused by name", () => {
    // This is what the removed fallback wrote. It gets its own code so the
    // repair tool can report it precisely rather than as a generic typo.
    const r = parseEvidenceRef({ type: "topic", id: TOPIC });
    assert(!r.ok && r.error.code === "topic_self", `expected topic_self, got ${r.ok ? "ok" : r.error.code}`);
  });

  await check("references are deduplicated with first-seen order preserved", () => {
    const out = dedupeRefs([ref("newsItem", "b"), ref("game", "a"), ref("newsItem", "b"), ref("game", "a")]);
    assert(out.length === 2, `expected 2, got ${out.length}`);
    assert(out[0].id === "b" && out[1].id === "a", "first-seen order must survive dedupe");
  });

  await check("persisted ordering is deterministic", () => {
    const a = sortRefs([ref("topicSource", "z"), ref("game", "b"), ref("newsItem", "a")]);
    const b = sortRefs([ref("newsItem", "a"), ref("topicSource", "z"), ref("game", "b")]);
    assert(JSON.stringify(a) === JSON.stringify(b), "the same set must always serialize identically");
    // evidenceIds feeds an immutable snapshot fingerprint — a reshuffle would
    // make identical evidence hash differently and look like a change.
    assert(a[0].type === "game", `expected declaration-order ranking, got ${a[0].type}`);
  });

  await check("a valid TopicSource resolves", async () => {
    const db = makeDb({ sources: [source("s1")] });
    const r = await resolveEvidenceRefs([ref("topicSource", "s1")], { db, topicId: TOPIC });
    assert(r.valid.length === 1, `expected valid, got ${JSON.stringify(r.invalid)}`);
  });

  await check("a nonexistent record is refused", async () => {
    const db = makeDb({ sources: [] });
    const r = await resolveEvidenceRefs([ref("topicSource", "ghost"), ref("newsItem", "ghost")], { db, topicId: TOPIC });
    assert(r.valid.length === 0, "nothing should resolve");
    assert(r.invalid.every((i) => i.error.code === "not_found"), `expected not_found, got ${r.invalid.map((i) => i.error.code)}`);
  });

  await check("CORE: a CROSS-TOPIC source is refused", async () => {
    const db = makeDb({ sources: [source("s-other", { topicId: OTHER })] });
    const r = await resolveEvidenceRefs([ref("topicSource", "s-other")], { db, topicId: TOPIC });
    assert(r.valid.length === 0, "another topic's source is not this topic's evidence");
    assert(r.invalid[0].error.code === "cross_topic", `expected cross_topic, got ${r.invalid[0].error.code}`);
  });

  await check("a FAILED / unusable source is refused", async () => {
    const db = makeDb({ sources: [
      source("s-failed", { fetchStatus: "timeout" }),
      source("s-noexcerpt", { excerpt: null }),
      source("s-shortexcerpt", { excerpt: "too short" }),
      source("s-nohash", { contentHash: null }),
      source("s-nourl", { canonicalUrl: "" }),
    ] });
    for (const id of ["s-failed", "s-noexcerpt", "s-shortexcerpt", "s-nohash", "s-nourl"]) {
      const r = await resolveEvidenceRefs([ref("topicSource", id)], { db, topicId: TOPIC });
      assert(r.valid.length === 0, `${id} must not resolve as evidence`);
      assert(r.invalid[0].error.code === "unusable_source", `${id} -> ${r.invalid[0].error.code}`);
    }
  });

  await check("usability is judged on real content, not on the fetch having happened", () => {
    assert(topicSourceIsUsable(source("s")).ok, "a complete import is usable");
    assert(!topicSourceIsUsable(source("s", { fetchStatus: "imported", excerpt: "" })).ok, "no text = not usable");
  });

  await check("a reference outside the supplied packet is refused", async () => {
    const db = makeDb({ sources: [source("s1")], news: [{ id: "n-real" }] });
    // n-real EXISTS but was never shown to the model.
    const r = await resolveEvidenceRefs([ref("newsItem", "n-real")], {
      db, topicId: TOPIC, allowedKeys: new Set(["topicSource:s1"]),
    });
    assert(r.valid.length === 0, "a real row that wasn't supplied is still not citable");
    assert(r.invalid[0].error.code === "not_in_packet", `expected not_in_packet, got ${r.invalid[0].error.code}`);
  });

  await check("CORE: transient research is never durable evidence", async () => {
    const db = makeDb();
    const r = await resolveEvidenceRefs([ref("research", "research-1")], { db, topicId: TOPIC });
    assert(r.valid.length === 0, "a research-N id resolves to nothing after its job ends");
    assert(r.invalid[0].error.code === "transient_research", `expected transient_research, got ${r.invalid[0].error.code}`);
  });

  // =====================================================================
  console.log("\nResearch packet");
  // =====================================================================

  await check("only usable, own-topic sources reach the packet", () => {
    const rows = [
      source("s-ok"), source("s-fail", { fetchStatus: "timeout" }),
      source("s-cross", { topicId: OTHER }), source("s-empty", { excerpt: null }),
    ];
    const usable = selectUsableSources(rows as any, TOPIC);
    assert(usable.length === 1 && usable[0].id === "s-ok", `expected only s-ok, got ${usable.map((u) => u.id)}`);
  });

  await check("the packet carries the fields research needs and no raw HTML", () => {
    const p = serializeSourceForPacket(source("s1") as any);
    for (const f of ["id", "canonicalUrl", "title", "publisher", "author", "publishedAt", "excerpt", "contentHash", "retrievedAt"]) {
      assert(f in p, `packet is missing ${f}`);
    }
    assert(!/[<>]/.test(JSON.stringify(p)), "no markup may reach a prompt");
  });

  await check("the prompt names topicSource and forbids the shortcuts", () => {
    assert(PROMPT_EVIDENCE_TYPES.includes("topicSource"), "the model must be told topicSource exists");
    const rules = sourceRulesBlock();
    assert(/never cite the topic itself/i.test(rules), "the model must be told not to cite the topic");
    assert(/not in the evidence packet/i.test(rules), "the model must be told not to invent source ids");
    assert(/opinion/i.test(rules) && /not facts/i.test(rules), "the model must be told editorial notes are not facts");
  });

  await check("allowed keys cover evidence, sources and transient research", () => {
    const keys = buildAllowedKeys({ evidenceIds: [ref("newsItem", "n1")], sources: [source("s1") as any], researchCount: 2 });
    assert(keys.has("newsItem:n1") && keys.has("topicSource:s1"), "evidence + sources must be citable");
    assert(keys.has("research:research-1") && keys.has("research:research-2"), "routed research may inform the brief");
    assert(!keys.has("research:research-3"), "an id beyond the packet must not be citable");
  });

  // =====================================================================
  console.log("\nClaim validation");
  // =====================================================================

  const allowed = new Set(["topicSource:s1", "newsItem:n1", "research:research-1"]);

  await check("a claim with no references is rejected", () => {
    const r = validateClaimRefs([], allowed, TOPIC);
    assert(!r.ok && /no evidence/.test(r.reason), `got ${JSON.stringify(r)}`);
  });

  await check("a claim citing the TOPIC ITSELF is rejected", () => {
    const byType = validateClaimRefs([{ type: "topic", id: TOPIC }], allowed, TOPIC);
    assert(!byType.ok && /itself/.test(byType.reason), `by type -> ${JSON.stringify(byType)}`);
    // …and also when the id is smuggled in under a legitimate type.
    const byId = validateClaimRefs([{ type: "topicSource", id: TOPIC }], allowed, TOPIC);
    assert(!byId.ok && /itself/.test(byId.reason), `by id -> ${JSON.stringify(byId)}`);
  });

  await check("CORE: one valid ref does NOT launder an invalid one beside it", () => {
    const r = validateClaimRefs([{ type: "topicSource", id: "s1" }, { type: "topicSource", id: "made-up" }], allowed, TOPIC);
    assert(!r.ok, "a claim citing one real and one imaginary source is fabricating, not mostly right");
    assert(!r.ok && /made-up/.test(r.reason), `the reason should name the bad ref, got: ${!r.ok ? r.reason : ""}`);
  });

  await check("an unsupported type on a claim is rejected", () => {
    const r = validateClaimRefs([{ type: "vibes", id: "s1" }], allowed, TOPIC);
    assert(!r.ok, "unsupported types must not pass");
  });

  await check("a valid TopicSource-backed claim is accepted", () => {
    const r = validateClaimRefs([{ type: "topicSource", id: "s1" }], allowed, TOPIC);
    assert(r.ok && r.refs.length === 1, `expected acceptance, got ${JSON.stringify(r)}`);
  });

  // =====================================================================
  console.log("\nBrief validation");
  // =====================================================================

  const keysFor = (srcId: string) => new Set([`topicSource:${srcId}`]);

  await check("CORE: an EMPTY packet fails the run instead of accepting everything", () => {
    // The old code set hasEvidence=false and SKIPPED every ref check, which is
    // how ungrounded briefs got written.
    const out = validateBriefResult({ llmResult: groundedResult("s1") as any, allowedKeys: new Set(), topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(!out.ok && out.failure === "no_packet", `expected no_packet, got ${out.failure}`);
  });

  await check("a grounded brief is accepted and cites its source", () => {
    const out = validateBriefResult({ llmResult: groundedResult("s1") as any, allowedKeys: keysFor("s1"), topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(out.ok, `expected acceptance, got ${out.failure}`);
    assert(out.facts.length === 1 && out.stats.length === 1, "grounded content should survive");
    assert(out.sourceIds.length === 1 && out.sourceIds[0].id === "s1", `sourceIds: ${JSON.stringify(out.sourceIds)}`);
    assert(out.citedTopicSourceRefs.length === 1, "the cited source should be eligible for promotion");
  });

  await check("ungrounded claims are moved to unsafeClaims, not accepted", () => {
    const bad: any = groundedResult("s1");
    bad.keyFactsContext = [
      claim("A grounded fact.", [ref("topicSource", "s1")]),
      claim("An invented fact with no backing.", []),
      claim("A fact citing an imaginary source.", [ref("topicSource", "nope")]),
    ];
    const out = validateBriefResult({ llmResult: bad, allowedKeys: keysFor("s1"), topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(out.ok, `expected the grounded fact to carry the brief, got ${out.failure}`);
    assert(out.facts.length === 1, `only the grounded fact should be accepted, got ${out.facts.length}`);
    assert(out.unsafeClaims.length >= 2, `both bad claims should be preserved as unsafe, got ${out.unsafeClaims.length}`);
  });

  await check("zero grounded facts fails the run", () => {
    const bad: any = groundedResult("s1");
    bad.keyFactsContext = [claim("Unbacked.", [])];
    const out = validateBriefResult({ llmResult: bad, allowedKeys: keysFor("s1"), topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(!out.ok && out.failure === "no_grounded_facts", `expected no_grounded_facts, got ${out.failure}`);
  });

  await check("CORE: a brief grounded ONLY in transient research is not durably sourced", () => {
    const r: any = groundedResult("s1");
    for (const f of ["keyFactsContext", "onAirTalkingPoints"]) r[f] = [claim("From the web.", [ref("research", "research-1")])];
    r.counterArguments = [];
    r.argumentForHostAEvidenceRefs = [ref("research", "research-1")];
    r.argumentForHostBEvidenceRefs = [ref("research", "research-1")];
    r.sourceIds = [ref("research", "research-1")];
    const out = validateBriefResult({ llmResult: r, allowedKeys: new Set(["research:research-1"]), topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(!out.ok && out.failure === "no_valid_sources", `expected no_valid_sources, got ${out.failure}`);
  });

  await check("the model's own top-level sourceIds cannot smuggle in extras", () => {
    const r: any = groundedResult("s1");
    r.sourceIds = [ref("topicSource", "s1"), ref("topicSource", "never-supplied"), ref("topic", TOPIC)];
    const out = validateBriefResult({ llmResult: r, allowedKeys: keysFor("s1"), topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(out.ok, "the grounded content should still carry it");
    assert(out.sourceIds.length === 1 && out.sourceIds[0].id === "s1", `unverified self-report leaked in: ${JSON.stringify(out.sourceIds)}`);
  });

  await check("host arguments must be grounded too", () => {
    const r: any = groundedResult("s1");
    r.argumentForHostAEvidenceRefs = [];
    const out = validateBriefResult({ llmResult: r, allowedKeys: keysFor("s1"), topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(!out.ok && out.failure === "ungrounded_host_arguments", `expected ungrounded_host_arguments, got ${out.failure}`);
  });

  // =====================================================================
  console.log("\nPromotion");
  // =====================================================================

  await check("CORE: an imported source promotes NOTHING by itself", async () => {
    const db = makeDb({ topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [] }], sources: [source("s1")] });
    // No research has cited it — nothing was validated, so nothing is promoted.
    const p = await promoteCitedSources({ db } as any, TOPIC, [], []);
    assert(p.promoted.length === 0 && p.evidenceIds.length === 0, "fetching a URL is not evidence that it supports anything");
  });

  await check("a cited source is promoted", async () => {
    const db = makeDb({ topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [] }], sources: [source("s1")] });
    const p = await promoteCitedSources({ db } as any, TOPIC, [ref("topicSource", "s1")], []);
    assert(p.promoted.length === 1 && p.evidenceIds[0].id === "s1", `expected promotion, got ${JSON.stringify(p)}`);
  });

  await check("an UNUSED source is not promoted alongside a used one", async () => {
    const db = makeDb({ topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [] }], sources: [source("s1"), source("s2")] });
    const p = await promoteCitedSources({ db } as any, TOPIC, [ref("topicSource", "s1")], []);
    assert(p.promoted.length === 1, `only the cited source may be promoted, got ${p.promoted.length}`);
    assert(!p.evidenceIds.some((r) => r.id === "s2"), "an uncited source must stay a source");
  });

  await check("a FAILED or CROSS-TOPIC source is not promoted even if cited", async () => {
    const db = makeDb({
      topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [] }],
      sources: [source("s-fail", { fetchStatus: "timeout" }), source("s-cross", { topicId: OTHER })],
    });
    const p = await promoteCitedSources({ db } as any, TOPIC, [ref("topicSource", "s-fail"), ref("topicSource", "s-cross")], []);
    assert(p.promoted.length === 0, `nothing should be promoted, got ${JSON.stringify(p.promoted)}`);
    assert(p.dropped.length === 2, `both should be reported as dropped, got ${p.dropped.length}`);
  });

  await check("existing valid evidence is preserved when a source is promoted", async () => {
    const db = makeDb({
      topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [ref("newsItem", "n1")] }],
      sources: [source("s1")], news: [{ id: "n1" }],
    });
    const p = await promoteCitedSources({ db } as any, TOPIC, [ref("topicSource", "s1")], [ref("newsItem", "n1")]);
    assert(p.evidenceIds.length === 2, `a generated topic must keep its evidence, got ${JSON.stringify(p.evidenceIds)}`);
    assert(p.evidenceIds.some((r) => r.type === "newsItem") && p.evidenceIds.some((r) => r.type === "topicSource"), "both kinds should survive");
  });

  await check("stale existing evidence is dropped rather than carried forward", async () => {
    const db = makeDb({ topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [] }], sources: [source("s1")], news: [] });
    // n-gone no longer exists.
    const p = await promoteCitedSources({ db } as any, TOPIC, [ref("topicSource", "s1")], [ref("newsItem", "n-gone")]);
    assert(!p.evidenceIds.some((r) => r.id === "n-gone"), "a dangling ref must not be re-persisted");
  });

  // =====================================================================
  console.log("\nEligibility integrity");
  // =====================================================================

  const briefFor = (srcId: string) => ({
    facts: [{ text: "f", evidenceRefs: [ref("topicSource", srcId)] }],
    sourceIds: [ref("topicSource", srcId)],
    argumentForHostA: "A", argumentForHostB: "B",
  });

  await check("CORE: nonempty but INVALID evidenceIds does not pass", () => {
    const selfCited = evaluateHardGates({ id: TOPIC, title: "T", status: "approved", evidenceIds: [{ type: "topic", id: TOPIC }], researchBrief: briefFor("s1") } as any);
    assert(selfCited[0]?.code === "invalid_evidence", `self-citation must be caught, got ${selfCited[0]?.code}`);
    const garbage = evaluateHardGates({ id: TOPIC, title: "T", status: "approved", evidenceIds: [null, "junk", { id: "x" }], researchBrief: briefFor("s1") } as any);
    assert(garbage[0]?.code === "invalid_evidence", `garbage must be caught, got ${garbage[0]?.code}`);
    const transientOnly = evaluateHardGates({ id: TOPIC, title: "T", status: "approved", evidenceIds: [ref("research", "research-1")], researchBrief: briefFor("s1") } as any);
    assert(transientOnly[0]?.code === "invalid_evidence", `transient-only must be caught, got ${transientOnly[0]?.code}`);
  });

  await check("CORE: nonempty but INVALID sourceIds does not pass", () => {
    const base = { id: TOPIC, title: "T", status: "approved", evidenceIds: [ref("topicSource", "s1")] };
    const selfSourced = evaluateHardGates({ ...base, researchBrief: { ...briefFor("s1"), sourceIds: [{ type: "topic", id: TOPIC }] } } as any);
    assert(selfSourced[0]?.code === "invalid_sources", `self-sourcing must be caught, got ${selfSourced[0]?.code}`);
    const transient = evaluateHardGates({ ...base, researchBrief: { ...briefFor("s1"), sourceIds: [ref("research", "research-1")] } } as any);
    assert(transient[0]?.code === "invalid_sources", `transient-only sourcing must be caught, got ${transient[0]?.code}`);
  });

  await check("valid TopicSource evidence passes the structural gates", () => {
    const reasons = evaluateHardGates({ id: TOPIC, title: "T", status: "approved", evidenceIds: [ref("topicSource", "s1")], researchBrief: briefFor("s1") } as any);
    assert(reasons.length === 0, `expected eligible, got ${JSON.stringify(reasons)}`);
  });

  await check("the MISSING vs INVALID distinction stays precise", () => {
    const missingEv = evaluateHardGates({ id: TOPIC, title: "T", status: "approved", evidenceIds: [], researchBrief: briefFor("s1") } as any);
    assert(missingEv[0].code === "insufficient_evidence", `empty -> ${missingEv[0].code}`);
    const missingSrc = evaluateHardGates({ id: TOPIC, title: "T", status: "approved", evidenceIds: [ref("topicSource", "s1")], researchBrief: { ...briefFor("s1"), sourceIds: [] } } as any);
    assert(missingSrc[0].code === "missing_sources", `empty sources -> ${missingSrc[0].code}`);
    // "you have none" and "yours aren't real" are different problems.
    assert(missingEv[0].code !== "invalid_evidence" && missingSrc[0].code !== "invalid_sources", "the codes must stay distinct");
  });

  await check("existing GENERATED topics keep their eligibility", () => {
    const reasons = evaluateHardGates({
      id: "t-gen", title: "Generated", status: "approved",
      evidenceIds: [ref("newsItem", "n1"), ref("game", "g1")],
      researchBrief: { facts: [{ text: "f" }], sourceIds: [ref("newsItem", "n1")], argumentForHostA: "A", argumentForHostB: "B" },
    } as any);
    assert(reasons.length === 0, `a generated topic must not regress: ${JSON.stringify(reasons)}`);
  });

  await check("the DB-backed gate catches a well-formed ref to a DELETED row", async () => {
    const db = makeDb({ news: [] }); // n-gone doesn't exist
    const reasons = await evaluateEvidenceIntegrity(
      { id: TOPIC, title: "T", status: "approved", evidenceIds: [ref("newsItem", "n-gone")], researchBrief: null } as any,
      { db }
    );
    assert(reasons[0]?.code === "invalid_evidence", `expected invalid_evidence, got ${reasons[0]?.code}`);
  });

  await check("the DB-backed gate catches a CROSS-TOPIC source", async () => {
    const db = makeDb({ sources: [source("s-cross", { topicId: OTHER })] });
    const reasons = await evaluateEvidenceIntegrity(
      { id: TOPIC, title: "T", status: "approved", evidenceIds: [ref("topicSource", "s-cross")], researchBrief: null } as any,
      { db }
    );
    assert(reasons[0]?.code === "cross_topic_source", `expected cross_topic_source, got ${reasons[0]?.code}`);
  });

  await check("the DB-backed gate passes real evidence", async () => {
    const db = makeDb({ sources: [source("s1")] });
    const reasons = await evaluateEvidenceIntegrity(
      { id: TOPIC, title: "T", status: "approved", evidenceIds: [ref("topicSource", "s1")], researchBrief: briefFor("s1") } as any,
      { db }
    );
    assert(reasons.length === 0, `expected pass, got ${JSON.stringify(reasons)}`);
  });

  // =====================================================================
  console.log("\nEnd to end: custom topic → grounded research → episode");
  // =====================================================================

  await check("CORE: the full journey — pending → approved → grounded → eligible → episode", async () => {
    const db = makeDb({
      topics: [{ id: TOPIC, title: "Custom take", status: "pending", sport: "NFL", leagueId: "NFL",
        summary: "An editor's angle.", debateScore: 0, controversyScore: 0, starPowerScore: 0,
        bettingRelevanceScore: 0, recencyScore: 0, evidenceIds: [], createdAt: new Date("2026-07-12T00:00:00Z") }],
      sources: [source("s1")],
    });

    // 1. Pending, with an imported source: still blocked, and blocked on APPROVAL.
    let pool: any = await getAdminTopicsFor(adminCtx(db));
    let vm = pool.topics.find((t: any) => t.id === TOPIC);
    assert(vm.eligibility.blockingReasons[0].code === "pending_approval", `expected pending_approval, got ${vm.eligibility.blockingReasons[0].code}`);

    // 2. Approved but unresearched: now blocked on EVIDENCE — the honest reason.
    await db.topicCandidate.update({ where: { id: TOPIC }, data: { status: "approved" } });
    pool = await getAdminTopicsFor(adminCtx(db));
    vm = pool.topics.find((t: any) => t.id === TOPIC);
    assert(!vm.eligible, "an approved but unresearched topic must stay blocked");
    assert(vm.eligibility.blockingReasons[0].code === "insufficient_evidence", `expected insufficient_evidence, got ${vm.eligibility.blockingReasons[0].code}`);

    // 3. Research runs against the real packet and cites the real source.
    const topicRow = await db.topicCandidate.findUnique({ where: { id: TOPIC } });
    const usable = selectUsableSources(db._sources, TOPIC);
    const allowedKeys = buildAllowedKeys({ evidenceIds: [], sources: usable as any, researchCount: 0 });
    const validated = validateBriefResult({ llmResult: groundedResult("s1") as any, allowedKeys, topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(validated.ok, `research should be accepted, got ${validated.failure}`);

    // 4. Persist + promote, exactly as the worker does.
    const promotion = await promoteCitedSources({ db } as any, TOPIC, validated.citedTopicSourceRefs, topicRow.evidenceIds);
    await db.$transaction(async (tx: any) => {
      await tx.researchBrief.upsert({
        where: { topicId: TOPIC },
        create: { topicId: TOPIC, facts: validated.facts, stats: validated.stats, sourceIds: validated.sourceIds,
          argumentForHostA: validated.argumentForHostA, argumentForHostB: validated.argumentForHostB,
          counterArguments: validated.counterArguments, unsafeClaims: validated.unsafeClaims,
          keyFactsContext: validated.facts, onAirTalkingPoints: validated.stats },
        update: {},
      });
      await tx.topicCandidate.update({ where: { id: TOPIC }, data: { evidenceIds: promotion.evidenceIds } });
    });
    assert(promotion.promoted.length === 1, "the cited source should be promoted");

    // 5. NOW eligible — and never before.
    pool = await getAdminTopicsFor(adminCtx(db));
    vm = pool.topics.find((t: any) => t.id === TOPIC);
    assert(vm.eligible, `the grounded custom topic should be selectable: ${JSON.stringify(vm.eligibility.blockingReasons)}`);

    // 6. It can be manually selected and become an episode.
    const res: any = await createAdminEpisodeFor(adminCtx(db), { mode: "manual", selectedTopicIds: [TOPIC], hostIds: H });
    assert(res.success, `episode creation failed: ${res.error}`);
    assert(res.finalOrder[0] === TOPIC, `expected the topic in the rundown, got ${res.finalOrder}`);

    // 7. The EpisodeTopic snapshot froze the grounded sourcing.
    const row = db._episodeTopics.find((e: any) => e.topicId === TOPIC);
    const snap = EpisodeTopicSnapshotV1Schema.safeParse(row.snapshot);
    assert(snap.success, `snapshot must satisfy the V1 schema: ${snap.success ? "" : snap.error.issues[0]?.message}`);
    if (!snap.success) return;
    assert(JSON.stringify(snap.data.sourceIds).includes("s1"), "the snapshot must carry the grounded source");
    assert(JSON.stringify(snap.data.evidenceIds).includes("s1"), "the snapshot must carry the promoted evidence");
    assert(typeof snap.data.evidenceFingerprint === "string" && snap.data.evidenceFingerprint.length === 64, "the snapshot needs an evidence fingerprint");
  });

  await check("CORE: research with NO valid source leaves the topic blocked", async () => {
    const db = makeDb({
      topics: [{ id: TOPIC, title: "Ungrounded", status: "approved", sport: "NFL", leagueId: null, summary: "s",
        debateScore: 0, controversyScore: 0, starPowerScore: 0, bettingRelevanceScore: 0, recencyScore: 0,
        evidenceIds: [], createdAt: new Date() }],
      sources: [source("s1")],
    });
    const usable = selectUsableSources(db._sources, TOPIC);
    const allowedKeys = buildAllowedKeys({ evidenceIds: [], sources: usable as any, researchCount: 0 });
    // The model returns claims with no refs — the old code would have accepted
    // these and invented a topic-self source.
    const bad: any = groundedResult("s1");
    bad.keyFactsContext = [claim("Unbacked assertion.", [])];
    const out = validateBriefResult({ llmResult: bad, allowedKeys, topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(!out.ok, "an ungrounded brief must fail");

    const pool: any = await getAdminTopicsFor(adminCtx(db));
    const vm = pool.topics.find((t: any) => t.id === TOPIC);
    assert(!vm.eligible, "the topic must stay ineligible");
    assert(!db._briefs.get(TOPIC), "no brief may be persisted from a failed run");
  });

  await check("CORE: a source cannot be smuggled in from another topic's research", async () => {
    const db = makeDb({
      topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [] }],
      sources: [source("s-other", { topicId: OTHER })],
    });
    // The packet is built from THIS topic's sources, so the foreign id isn't
    // allowed — and even if it were, promotion re-checks ownership.
    const usable = selectUsableSources(db._sources, TOPIC);
    assert(usable.length === 0, "a foreign source must never enter the packet");
    const allowedKeys = buildAllowedKeys({ evidenceIds: [], sources: usable as any, researchCount: 0 });
    const out = validateBriefResult({ llmResult: groundedResult("s-other") as any, allowedKeys, topicId: TOPIC, hostAName: "A", hostBName: "B" });
    assert(!out.ok && out.failure === "no_packet", `expected no_packet, got ${out.failure}`);
    const p = await promoteCitedSources({ db } as any, TOPIC, [ref("topicSource", "s-other")], []);
    assert(p.promoted.length === 0, "cross-topic promotion must be impossible even if reached directly");
  });

  await check("promotion is derived server-side — a forged list cannot escalate", async () => {
    const db = makeDb({ topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [] }], sources: [source("s1")] });
    // Even handed a list naming real-looking ids, promotion resolves each one
    // against the database rather than trusting the caller.
    const forged = [ref("topicSource", "s1"), ref("topicSource", "forged"), ref("newsItem", "forged-news"), { type: "topic", id: TOPIC }] as any;
    const p = await promoteCitedSources({ db } as any, TOPIC, forged, []);
    assert(p.promoted.length === 1 && p.promoted[0].id === "s1", `only the real source may survive: ${JSON.stringify(p.promoted)}`);
  });

  await check("no raw HTML can enter evidence or a snapshot", async () => {
    const db = makeDb({
      topics: [{ id: TOPIC, title: "T", status: "approved", evidenceIds: [] }],
      sources: [source("s1", { excerpt: "Clean sanitized text with no markup at all, long enough to be usable." })],
    });
    const usable = selectUsableSources(db._sources, TOPIC);
    const packet = usable.map(serializeSourceForPacket);
    assert(!/[<>]/.test(JSON.stringify(packet)), "the packet must carry no markup");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
