// Studio multi-topic rundown tests. Run: npm run test:studio-rundown
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: in-memory
   fake DB doubles + dynamic seed payloads are intentionally loosely typed. */
//
// Covers the Studio building blocks with an in-memory fake db (no external
// database): topic-pool VM (scoped usage, readiness, eligibility, unsafe-claim
// withholding), resume-draft persistence (round-trip, validation, fail-open),
// rundown estimates, rundown rules, and the SHARED createEpisodeDraft path the
// Studio action routes through (manual order, automatic backend selection,
// hybrid pinned-first, and that a Studio-style call — no reuseOverride — is
// blocked under exclude_podcast).

process.env.TOPIC_MIN_TALKABILITY = "1";

import { buildStudioTopicVMs } from "../lib/services/studioTopicPool";
import { getTopicUsage, resolveTopicReusePolicy } from "../lib/services/topicUsageService";
import { loadStudioDraft, saveStudioDraft, clearStudioDraft } from "../lib/services/studioDraft";
import { estimateRundown } from "../lib/services/episodeEstimate";
import { validateRundownDraft, leadFirst, dedupeIds } from "../lib/studio/rundownRules";
import { createEpisodeDraft } from "../lib/services/episodeCreation";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

function goodTopic(id: string, over: any = {}) {
  return {
    id, title: `Topic ${id}`, status: "approved", sport: "NFL", leagueId: "NFL",
    summary: "A genuinely hot debate about last night's game and what it means for the season.",
    debateScore: 90, controversyScore: 80, starPowerScore: 70, bettingRelevanceScore: 40, recencyScore: 80,
    evidenceIds: [{ type: "news", id: "n1" }], createdAt: new Date("2026-07-10T00:00:00Z"),
    researchBrief: {
      facts: [{ text: "A real grounded fact." }], sourceIds: [{ type: "news", id: "n1" }], stats: [],
      argumentForHostA: "A side", argumentForHostB: "B side", mainAngle: "angle", contrarianAngle: "contra",
      whyMattersNow: "it matters", onAirTalkingPoints: ["point one"], keyFactsContext: [{ text: "key fact" }],
      unsafeClaims: [{ claim: "SECRET flagged claim" }, { claim: "another" }],
    },
    ...over,
  };
}

function makeFakeDb(seed: { topics?: any[]; podcasts?: any[] }) {
  const topics = new Map((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const podcasts = seed.podcasts || [];
  const episodes = new Map<string, any>();
  const episodeTopics: any[] = [];
  const drafts = new Map<string, any>();
  const makeEpisode = (data: any) => { const e = { id: `ep-${episodes.size + 1}`, ...data }; episodes.set(e.id, e); return e; };
  const etFindMany = async ({ where, select }: any) => {
    const rows = episodeTopics.filter((et) => {
      if (where?.topicId?.in && !where.topicId.in.includes(et.topicId)) return false;
      if (where?.selectedAt?.gte && !(new Date(et.selectedAt) >= new Date(where.selectedAt.gte))) return false;
      if (where?.episode?.podcastId) { const ep = episodes.get(et.episodeId); if (!ep || ep.podcastId !== where.episode.podcastId) return false; }
      return true;
    });
    return rows.map((et) => {
      const ep = episodes.get(et.episodeId);
      const out: any = { topicId: et.topicId, selectedAt: et.selectedAt };
      if (select?.episode) out.episode = { ownerId: ep?.ownerId ?? null, podcastId: ep?.podcastId ?? null };
      return out;
    });
  };
  return {
    _episodeTopics: episodeTopics, _drafts: drafts,
    topicCandidate: {
      findUnique: async ({ where }: any) => topics.get(where.id) ?? null,
      findMany: async ({ where }: any) => [...topics.values()].filter((t) => (where?.status?.in ? where.status.in.includes(t.status) : true)),
    },
    aiHost: { findMany: async ({ where }: any) => [{ id: "host-a" }, { id: "host-b" }].filter((h) => (where?.id?.in ? where.id.in.includes(h.id) : true)) },
    podcast: { findUnique: async ({ where }: any) => podcasts.find((p) => p.id === where.id) ?? null },
    episode: { findUnique: async ({ where }: any) => [...episodes.values()].find((e) => e.slug === where.slug) ?? null, create: async ({ data }: any) => makeEpisode(data) },
    episodeTopic: { findMany: etFindMany, create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    $transaction: async (fn: any) => fn({
      episode: { create: async ({ data }: any) => makeEpisode(data) },
      episodeTopic: { create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    }),
    studioDraft: {
      findUnique: async ({ where }: any) => drafts.get(where.ownerId) ?? null,
      upsert: async ({ where, create, update }: any) => { const existing = drafts.get(where.ownerId); drafts.set(where.ownerId, existing ? { ...existing, ...update } : create); return drafts.get(where.ownerId); },
      deleteMany: async ({ where }: any) => { drafts.delete(where.ownerId); return { count: 1 }; },
    },
  };
}

const H = ["host-a", "host-b"];

async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try { await fn(); } finally { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
}

async function run() {
  console.log("Studio multi-topic rundown:");

  // ---- Topic-pool VM ----
  await check("VM: readiness, eligibility, evidence/source counts, and a research preview", () => {
    const topics = [goodTopic("t1"), goodTopic("t2", { status: "pending" }), goodTopic("t3", { researchBrief: null })];
    const usage = new Map();
    const vms = buildStudioTopicVMs(topics as any, { usage, policy: { mode: "allow", cooldownDays: 7 } });
    const t1 = vms.find((v) => v.id === "t1")!;
    assert(t1.readiness === "ready" && t1.eligible, "t1 ready + eligible");
    assert(t1.evidenceCount === 1 && t1.sourceCount === 1, "evidence/source counts surfaced");
    assert(!!t1.brief && t1.brief.keyFacts.length > 0 && t1.brief.mainAngle === "angle", "brief preview populated");
    const t2 = vms.find((v) => v.id === "t2")!;
    assert(!t2.eligible && t2.readiness === "not_approved" && !!t2.unavailableReason, "pending topic ineligible + reason shown");
    const t3 = vms.find((v) => v.id === "t3")!;
    assert(!t3.eligible && t3.readiness === "needs_research", "no-brief topic needs research");
  });
  await check("VM: moderated/unsafe claims are WITHHELD (count only, no raw text)", () => {
    const vms = buildStudioTopicVMs([goodTopic("t1")] as any, { usage: new Map(), policy: { mode: "allow", cooldownDays: 7 } });
    const b = vms[0].brief!;
    assert(b.flaggedClaimCount === 2, "flagged count surfaced");
    assert(!JSON.stringify(b).includes("SECRET"), "raw unsafe claim text is NOT exposed");
  });
  await check("VM: usage is owner/show-scoped — Owner B never sees Owner A's usage", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
    const usageB = await getTopicUsage(["t1"], { ownerId: "oB" }, db as any);
    const vmsB = buildStudioTopicVMs([goodTopic("t1")] as any, { usage: usageB, policy: { mode: "allow", cooldownDays: 7 } });
    assert(vmsB[0].usedByYouCount === 0, "owner B sees zero owner-usage");
    assert(vmsB[0].usedByShowCount === null, "no podcast scope → no show count");
    const usageA = await getTopicUsage(["t1"], { ownerId: "oA", podcastId: "pA" }, db as any);
    const vmsA = buildStudioTopicVMs([goodTopic("t1")] as any, { usage: usageA, policy: { mode: "allow", cooldownDays: 7 }, podcastId: "pA" });
    assert(vmsA[0].usedByYouCount === 1 && vmsA[0].usedByShowCount === 1, "owner A sees own owner + show usage");
  });
  await check("VM: exclude_podcast marks a recently-used topic ineligible with a clear reason", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      const usage = await getTopicUsage(["t1"], { ownerId: "oA", podcastId: "pA" }, db as any);
      const vms = buildStudioTopicVMs([goodTopic("t1")] as any, { usage, policy: resolveTopicReusePolicy(), podcastId: "pA" });
      assert(!vms[0].eligible && /recently used by this show/i.test(vms[0].unavailableReason || ""), "recently-used blocked with reason");
    });
  });

  // ---- Resume draft ----
  await check("resume: save → load round-trips the full rundown state (cross-session)", async () => {
    const db = makeFakeDb({ topics: [] });
    const state = { mode: "hybrid" as const, selectedTopicIds: ["t2", "t1"], leadTopicId: "t2", targetTopicCount: 4, podcastId: "pA", hostIds: H, productionStyle: "full", sfxDensity: "hype", title: "My show", description: null, activeStep: "topics" as const };
    const r = await saveStudioDraft("oA", state, db as any);
    assert(r.ok, "save ok");
    // A fresh load (simulating another browser session) sees the same state.
    const loaded = await loadStudioDraft("oA", db as any);
    assert(!!loaded && loaded.mode === "hybrid" && JSON.stringify(loaded.selectedTopicIds) === JSON.stringify(["t2", "t1"]) && loaded.leadTopicId === "t2" && loaded.targetTopicCount === 4 && loaded.activeStep === "topics", "state restored intact");
  });
  await check("resume: corrupt stored blob FAILS OPEN to no-draft (fresh builder)", async () => {
    const db = makeFakeDb({ topics: [] });
    db._drafts.set("oA", { state: { mode: "not-a-mode", garbage: true } });
    const loaded = await loadStudioDraft("oA", db as any);
    assert(loaded === null, "corrupt draft resolves to null, not a crash");
  });
  await check("resume: save REJECTS an invalid state before persisting", async () => {
    const db = makeFakeDb({ topics: [] });
    const r = await saveStudioDraft("oA", { mode: "bogus", selectedTopicIds: [] } as any, db as any);
    assert(!r.ok, "invalid state rejected");
    assert(!db._drafts.has("oA"), "nothing persisted");
  });
  await check("resume: clear removes the draft", async () => {
    const db = makeFakeDb({ topics: [] });
    await saveStudioDraft("oA", { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 3, hostIds: H, activeStep: "show" } as any, db as any);
    await clearStudioDraft("oA", db as any);
    assert((await loadStudioDraft("oA", db as any)) === null, "draft cleared");
  });

  // ---- Estimates (honest) ----
  await check("estimate: duration/words grounded; cost null without a configured rate", () => {
    const e = estimateRundown({ topicCount: 3 });
    assert(e.isEstimate && e.estimatedWords > 0 && e.estimatedDurationMinutes > 0 && e.estimatedTtsCharacters > 0, "estimates present");
    assert(e.estimatedCostUsd === null && /provider/i.test(e.costBasis), "no fake cost without a rate");
  });
  await check("estimate: a configured TTS rate yields a labeled dollar estimate", async () => {
    await withEnv({ TTS_COST_PER_1K_CHARS: "0.30" }, async () => {
      const e = estimateRundown({ topicCount: 3 });
      assert(e.estimatedCostUsd !== null && e.estimatedCostUsd > 0 && /Estimate/.test(e.costBasis), "cost computed + labeled estimate");
    });
  });

  // ---- Rundown rules (UX pre-check mirrors the schema) ----
  await check("rules: validation mirrors the mode rules", () => {
    assert(!validateRundownDraft({ mode: "manual", selectedTopicIds: [], targetTopicCount: 3, maxTopics: 6 }).ok, "manual 0 fails");
    assert(!validateRundownDraft({ mode: "automatic", selectedTopicIds: ["t1"], targetTopicCount: 3, maxTopics: 6 }).ok, "automatic + picks fails");
    assert(!validateRundownDraft({ mode: "hybrid", selectedTopicIds: [], targetTopicCount: 3, maxTopics: 6 }).ok, "hybrid 0 pins fails");
    assert(!validateRundownDraft({ mode: "hybrid", selectedTopicIds: ["a", "b", "c", "d"], targetTopicCount: 3, maxTopics: 6 }).ok, "hybrid pins>target fails");
    assert(!validateRundownDraft({ mode: "manual", selectedTopicIds: ["a", "b", "c", "d", "e", "f", "g"], targetTopicCount: 3, maxTopics: 6 }).ok, "over max fails");
    assert(validateRundownDraft({ mode: "manual", selectedTopicIds: ["a", "b"], targetTopicCount: 3, maxTopics: 6 }).ok, "valid manual passes");
  });
  await check("rules: dedupeIds preserves order; leadFirst moves the lead to front", () => {
    assert(JSON.stringify(dedupeIds(["a", "b", "a", "c", "b"])) === JSON.stringify(["a", "b", "c"]), "dedupe preserves first-seen order");
    assert(JSON.stringify(leadFirst(["a", "b", "c"], "c")) === JSON.stringify(["c", "a", "b"]), "lead moved to front");
    assert(JSON.stringify(leadFirst(["a", "b", "c"], "x")) === JSON.stringify(["a", "b", "c"]), "unknown lead leaves order untouched");
  });

  // ---- Shared createEpisodeDraft path (what the Studio action routes through) ----
  await check("manual: lead-first order is preserved and equals the written EpisodeTopic order", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2"), goodTopic("t3")], podcasts: [{ id: "pA", ownerId: "oA" }] });
    const ordered = leadFirst(["t1", "t2", "t3"], "t3"); // lead = t3
    const res = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ordered, strictSelection: true, ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
    assert(res.ok, res.error || "created");
    assert(JSON.stringify(res.finalOrder) === JSON.stringify(["t3", "t1", "t2"]), "finalOrder matches lead-first request order");
    const written = db._episodeTopics.sort((a: any, b: any) => a.orderIndex - b.orderIndex).map((e: any) => e.topicId);
    assert(JSON.stringify(res.finalOrder) === JSON.stringify(written), "finalOrder equals actual EpisodeTopic rows");
  });
  await check("automatic: returns the actual backend-selected topics (not a client guess)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1", { debateScore: 99 }), goodTopic("t2", { debateScore: 98 })], podcasts: [{ id: "pA", ownerId: "oA" }] });
    const res = await createEpisodeDraft({ mode: "automatic", targetTopicCount: 1, ownerId: "oA", podcastId: "pA", hostIds: H, verticals: ["NFL"] }, { db });
    assert(res.ok && res.autoSelectedTopicIds.length === 1 && res.finalOrder.length === 1, "auto-selected exactly the target count");
    assert(res.selectedTopics.every((s) => !s.pinned), "no topic is marked pinned in automatic mode");
  });
  await check("hybrid: pinned topics stay first, auto-fill follows", async () => {
    const db = makeFakeDb({ topics: [goodTopic("pin"), goodTopic("a1", { debateScore: 99 })], podcasts: [{ id: "pA", ownerId: "oA" }] });
    const res = await createEpisodeDraft({ mode: "hybrid", selectedTopicIds: ["pin"], targetTopicCount: 2, ownerId: "oA", podcastId: "pA", hostIds: H, verticals: ["NFL"] }, { db });
    assert(res.ok && res.finalOrder[0] === "pin", "pinned topic is first");
    assert(res.autoSelectedTopicIds.includes("a1"), "auto-fill added a1");
  });
  await check("privacy: a Studio-style call passes NO reuseOverride → recently-used pin is blocked", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      // Studio never sends reuseOverride, so the second manual build is blocked.
      const r2 = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], strictSelection: true, ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      assert(!r2.ok && r2.rejectedTopics.some((x) => x.category === "recently_used"), "no-override reuse blocked (Studio can't bypass)");
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("FATAL", e); process.exit(1); });
