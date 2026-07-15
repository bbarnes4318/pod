// Shared editorial-selection tests. Run: npm run test:shared-eligibility
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: fake DB doubles */
//
// PR 4A: proves Admin and Studio can share ONE eligibility contract.
//
// The load-bearing rule under test:
//   HARD GATES (approval + real evidence) block every context.
//   AUTOMATIC THRESHOLDS (talkability / debate score / filters) gate ONLY the
//   platform's own picks — they never hide a manually relevant topic, and an
//   evidence failure is never disguised as a low-score failure.

process.env.TOPIC_MIN_TALKABILITY = "1";

import {
  evaluateTopicSelection,
  evaluateHardGates,
  isSelectableIn,
  type EligibilityActor,
  type EligibilityTopic,
  type SelectionContext,
} from "../lib/services/topicEligibility";
import { evaluateTopicEligibility } from "../lib/services/episodeService";
import { buildStudioTopicVMs } from "../lib/services/studioTopicPool";
import { createEpisodeDraft } from "../lib/services/episodeCreation";
import { getTopicUsage, type TopicReusePolicy } from "../lib/services/topicUsageService";
import { dedupeIds, leadFirst, validateRundownDraft } from "../lib/studio/rundownRules";
import { PLATFORM_MAX_TOPICS, DEFAULT_MIN_DEBATE_SCORE } from "../lib/episodeLimits";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  + ${name}`); }
  catch (err) { failed++; console.error(`  x ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const ADMIN: EligibilityActor = { kind: "admin", adminId: "admin" };
const OWNER: EligibilityActor = { kind: "owner", ownerId: "oA" };
const ALLOW: TopicReusePolicy = { mode: "allow", cooldownDays: 7 };
const EXCLUDE: TopicReusePolicy = { mode: "exclude_podcast", cooldownDays: 7 };
const WARN: TopicReusePolicy = { mode: "warn", cooldownDays: 7 };

function topic(id: string, over: any = {}): EligibilityTopic & Record<string, any> {
  return {
    id, title: `Topic ${id}`, status: "approved", sport: "NFL", leagueId: "NFL",
    summary: "A genuinely hot debate about last night's game and what it means.",
    debateScore: 90, controversyScore: 80, starPowerScore: 70, bettingRelevanceScore: 40, recencyScore: 80,
    evidenceIds: [{ type: "news", id: "n1" }], createdAt: new Date("2026-07-10T00:00:00Z"),
    researchBrief: {
      facts: [{ text: "A real grounded fact." }], sourceIds: [{ type: "news", id: "n1" }], stats: [],
      argumentForHostA: "A side", argumentForHostB: "B side", mainAngle: "angle", contrarianAngle: "contra",
    },
    ...over,
  };
}
const ev = (t: any, ctx: any = {}) => evaluateTopicSelection(t, { actor: OWNER, policy: ALLOW, ...ctx });
const codes = (rs: { code: string }[]) => rs.map((r) => r.code);

function makeFakeDb(seed: { topics?: any[]; podcasts?: any[] }) {
  const topics = new Map((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const podcasts = seed.podcasts || [];
  const episodes = new Map<string, any>();
  const episodeTopics: any[] = [];
  const makeEpisode = (d: any) => { const e = { id: `ep-${episodes.size + 1}`, ...d }; episodes.set(e.id, e); return e; };
  return {
    _episodes: episodes, _episodeTopics: episodeTopics,
    topicCandidate: {
      findUnique: async ({ where }: any) => topics.get(where.id) ?? null,
      findMany: async ({ where }: any) => [...topics.values()].filter((t) => (where?.status?.in ? where.status.in.includes(t.status) : where?.status ? t.status === where.status : true)),
    },
    aiHost: { findMany: async ({ where }: any) => [{ id: "host-a" }, { id: "host-b" }].filter((h) => (where?.id?.in ? where.id.in.includes(h.id) : true)) },
    podcast: { findUnique: async ({ where }: any) => podcasts.find((p) => p.id === where.id) ?? null },
    episode: { findUnique: async ({ where }: any) => [...episodes.values()].find((e) => e.slug === where.slug) ?? null, create: async ({ data }: any) => makeEpisode(data) },
    episodeTopic: {
      findMany: async ({ where, select }: any) => episodeTopics.filter((et) => {
        if (where?.topicId?.in && !where.topicId.in.includes(et.topicId)) return false;
        if (where?.selectedAt?.gte && !(new Date(et.selectedAt) >= new Date(where.selectedAt.gte))) return false;
        if (where?.episode?.podcastId) { const ep = episodes.get(et.episodeId); if (!ep || ep.podcastId !== where.episode.podcastId) return false; }
        return true;
      }).map((et) => {
        const ep = episodes.get(et.episodeId);
        const out: any = { topicId: et.topicId, selectedAt: et.selectedAt };
        if (select?.episode) out.episode = { ownerId: ep?.ownerId ?? null, podcastId: ep?.podcastId ?? null };
        return out;
      }),
      create: async ({ data }: any) => { episodeTopics.push(data); return data; },
    },
    $transaction: async (fn: any) => fn({
      episode: { create: async ({ data }: any) => makeEpisode(data) },
      episodeTopic: { create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    }),
  };
}
const H = ["host-a", "host-b"];

async function run() {
  console.log("Shared editorial selection (PR 4A):");

  // ---- Hard gates: precise reasons, never generic ----
  await check("hard gates: a fully-researched approved topic is selectable in every context", () => {
    const r = ev(topic("t1"));
    assert(r.manuallySelectable && r.automaticallySelectable && r.hybridPinnable, "selectable everywhere");
    assert(r.blockingReasons.length === 0, "no blocking reasons");
    (["manual", "automatic", "hybrid_pin"] as SelectionContext[]).forEach((c) => assert(isSelectableIn(r, c), `selectable in ${c}`));
  });
  await check("explanations: pending / rejected / archived each get their OWN code", () => {
    assert(codes(ev(topic("t", { status: "pending" })).blockingReasons)[0] === "pending_approval", "pending_approval");
    assert(codes(ev(topic("t", { status: "rejected" })).blockingReasons)[0] === "rejected", "rejected");
    assert(codes(ev(topic("t", { status: "archived" })).blockingReasons)[0] === "archived", "archived");
  });
  await check("explanations: missing brief / facts / sources / host args are distinct codes", () => {
    assert(codes(ev(topic("t", { researchBrief: null })).blockingReasons)[0] === "missing_brief", "missing_brief");
    assert(codes(ev(topic("t", { researchBrief: { ...topic("x").researchBrief, facts: [] } })).blockingReasons)[0] === "missing_facts", "missing_facts");
    assert(codes(ev(topic("t", { researchBrief: { ...topic("x").researchBrief, sourceIds: [] } })).blockingReasons)[0] === "missing_sources", "missing_sources");
    assert(codes(ev(topic("t", { researchBrief: { ...topic("x").researchBrief, argumentForHostA: "" } })).blockingReasons)[0] === "missing_host_arguments", "missing_host_arguments");
  });
  await check("explanations: an EVIDENCE failure is reported as evidence — never as a low score", () => {
    // Weak evidence AND below the automatic threshold at the same time.
    const r = ev(topic("t", { evidenceIds: [], debateScore: 10 }));
    assert(r.blockingReasons[0].code === "insufficient_evidence", `evidence reason first, got ${r.blockingReasons[0].code}`);
    assert(/evidenceIds/i.test(r.blockingReasons[0].message), "message names the real problem");
    assert(!r.blockingReasons.some((x) => x.code === "below_automatic_threshold"), "score never becomes a BLOCKING reason");
    assert(!r.manuallySelectable, "still hard-blocked (evidence gate)");
  });
  await check("a missing topic is not_found and not visible", () => {
    const r = evaluateTopicSelection(null, { actor: OWNER, policy: ALLOW, topicId: "ghost" });
    assert(r.blockingReasons[0].code === "not_found" && !r.visible && !r.manuallySelectable, "not_found");
  });

  // ---- THE core rule: automatic thresholds never gate manual ----
  await check("CORE: a topic below the automatic debate threshold stays MANUALLY selectable + visible", () => {
    const r = ev(topic("t", { debateScore: DEFAULT_MIN_DEBATE_SCORE - 20 }));
    assert(r.visible, "visible — never silently hidden");
    assert(r.manuallySelectable && r.hybridPinnable, "manual + hybrid pin still allowed");
    assert(!r.automaticallySelectable, "automatic selection skips it");
    assert(r.warnings.some((w) => w.code === "below_automatic_threshold"), "labelled below the automatic threshold");
    assert(r.blockingReasons.length === 0, "and it is NOT a blocking reason");
  });
  await check("CORE: below the automatic talkability floor is a warning, not a manual block", () => {
    const r = ev(topic("t"), { talkability: 5, automatic: { minTalkability: 35 } });
    assert(r.manuallySelectable && !r.automaticallySelectable, "manual yes, automatic no");
    assert(r.warnings.some((w) => w.code === "below_automatic_threshold" && w.field === "talkability"), "talkability warning");
  });
  await check("CORE: an automatic FILTER mismatch never blocks manual selection", () => {
    const r = ev(topic("t", { sport: "NBA" }), { automatic: { sport: "NFL" } });
    assert(r.manuallySelectable, "manual unaffected by the auto filter");
    assert(!r.automaticallySelectable, "auto excluded");
    assert(r.warnings.some((w) => w.code === "filter_mismatch"), "filter_mismatch surfaced");
  });

  // ---- Reuse policy + admin authority ----
  await check("reuse: warn policy adds a recently_used warning without blocking", async () => {
    const usage = new Map([["t", { topicId: "t", currentOwnerUseCount: 1, currentOwnerLastUsedAt: new Date(), currentOwnerRecentUseCount: 1, currentPodcastUseCount: 1, currentPodcastLastUsedAt: new Date(), currentPodcastRecentUseCount: 1 }]]);
    const r = ev(topic("t"), { policy: WARN, podcastId: "pA", usage });
    assert(r.manuallySelectable, "warn never blocks");
    assert(r.warnings.some((w) => w.code === "recently_used"), "recently_used warning");
  });
  await check("reuse: exclude_podcast BLOCKS an ordinary owner (Studio has no override authority)", () => {
    const usage = new Map([["t", { topicId: "t", currentOwnerUseCount: 1, currentOwnerLastUsedAt: new Date(), currentOwnerRecentUseCount: 1, currentPodcastUseCount: 1, currentPodcastLastUsedAt: new Date(), currentPodcastRecentUseCount: 1 }]]);
    const r = evaluateTopicSelection(topic("t"), { actor: OWNER, policy: EXCLUDE, podcastId: "pA", usage });
    assert(!r.manuallySelectable, "owner is blocked");
    assert(r.blockingReasons.some((b) => b.code === "reuse_policy_blocked"), "reuse_policy_blocked");
    assert(!r.actions.includes("reuse_override"), "owner is NOT offered the override");
  });
  await check("reuse: exclude_podcast offers ADMIN the audited override and keeps it selectable", () => {
    const usage = new Map([["t", { topicId: "t", currentOwnerUseCount: 1, currentOwnerLastUsedAt: new Date(), currentOwnerRecentUseCount: 1, currentPodcastUseCount: 1, currentPodcastLastUsedAt: new Date(), currentPodcastRecentUseCount: 1 }]]);
    const r = evaluateTopicSelection(topic("t"), { actor: ADMIN, policy: EXCLUDE, podcastId: "pA", usage });
    assert(r.manuallySelectable, "admin may still pick it");
    assert(r.actions.includes("reuse_override"), "override action offered to admin");
    assert(r.warnings.some((w) => w.code === "recently_used"), "warned, not silently allowed");
    assert(!r.automaticallySelectable, "auto-fill still never reuses inside the cooldown");
  });

  // ---- Actions: admin-only powers stay admin-only ----
  await check("actions: admin gets approve/research/regenerate; an owner gets none of them", () => {
    const pend = topic("t", { status: "pending", researchBrief: null });
    const asAdmin = evaluateTopicSelection(pend, { actor: ADMIN, policy: ALLOW });
    const asOwner = evaluateTopicSelection(pend, { actor: OWNER, policy: ALLOW });
    assert(asAdmin.actions.includes("approve") && asAdmin.actions.includes("research"), "admin may approve + research");
    assert(!asOwner.actions.includes("approve") && !asOwner.actions.includes("research"), "owner may not");
    const weak = evaluateTopicSelection(topic("t", { researchBrief: { ...topic("x").researchBrief, facts: [] } }), { actor: ADMIN, policy: ALLOW });
    assert(weak.actions.includes("regenerate_research"), "admin may regenerate weak research");
    assert(evaluateTopicSelection(topic("t"), { actor: OWNER, policy: ALLOW }).actions.includes("preview_research"), "anyone may preview an existing brief");
  });
  await check("actions: a supplied research state surfaces queued / in_progress / failed", () => {
    assert(ev(topic("t"), { researchState: "queued" }).warnings.some((w) => w.code === "research_queued"), "queued");
    assert(ev(topic("t"), { researchState: "in_progress" }).warnings.some((w) => w.code === "research_in_progress"), "in_progress");
    const f = evaluateTopicSelection(topic("t"), { actor: ADMIN, policy: ALLOW, researchState: "failed" });
    assert(f.warnings.some((w) => w.code === "research_failed") && f.actions.includes("regenerate_research"), "failed + retryable by admin");
  });
  await check("context: a topic already in the rundown is flagged", () => {
    assert(ev(topic("t"), { selectedTopicIds: ["t"] }).warnings.some((w) => w.code === "already_selected"), "already_selected");
  });

  // ---- PARITY: the creation path and the pickers cannot drift ----
  await check("PARITY: creation-path evaluateTopicEligibility agrees with the shared hard gates", () => {
    const matrix = [
      topic("ok"),
      topic("pending", { status: "pending" }),
      topic("rejected", { status: "rejected" }),
      topic("archived", { status: "archived" }),
      topic("noEvidence", { evidenceIds: [] }),
      topic("noBrief", { researchBrief: null }),
      topic("noFacts", { researchBrief: { ...topic("x").researchBrief, facts: [] } }),
      topic("noSources", { researchBrief: { ...topic("x").researchBrief, sourceIds: [] } }),
      topic("noArgs", { researchBrief: { ...topic("x").researchBrief, argumentForHostB: "  " } }),
    ];
    for (const t of matrix) {
      const legacy = evaluateTopicEligibility(t as any, t.id);
      const shared = evaluateHardGates(t, t.id);
      assert(legacy.ok === (shared.length === 0), `${t.id}: ok flag agrees`);
      if (!legacy.ok) assert(legacy.reason === shared[0].message, `${t.id}: identical message (creation path unchanged)`);
    }
    // And a not-found topic agrees too.
    assert(evaluateTopicEligibility(null, "ghost").reason === evaluateHardGates(null, "ghost")[0].message, "not_found message identical");
  });
  await check("PARITY: Admin and Studio actors get the SAME hard-gate decisions (authority differs, rules don't)", () => {
    const matrix = [topic("ok"), topic("pending", { status: "pending" }), topic("noEvidence", { evidenceIds: [] }), topic("lowScore", { debateScore: 10 })];
    for (const t of matrix) {
      const a = evaluateTopicSelection(t, { actor: ADMIN, policy: ALLOW });
      const o = evaluateTopicSelection(t, { actor: OWNER, policy: ALLOW });
      assert(JSON.stringify(codes(a.blockingReasons)) === JSON.stringify(codes(o.blockingReasons)), `${t.id}: same blocking codes`);
      assert(a.manuallySelectable === o.manuallySelectable, `${t.id}: same manual selectability`);
      assert(a.automaticallySelectable === o.automaticallySelectable, `${t.id}: same automatic selectability`);
    }
  });
  await check("PARITY: the Studio VM is driven by the shared contract (eligible === manuallySelectable)", () => {
    const vms = buildStudioTopicVMs(
      [topic("ok"), topic("pending", { status: "pending" }), topic("low", { debateScore: 10 })] as any,
      { usage: new Map(), policy: ALLOW }
    );
    for (const vm of vms) {
      assert(vm.eligible === vm.eligibility.manuallySelectable, `${vm.id}: VM eligible mirrors the shared result`);
      assert(vm.unavailableReason === (vm.eligibility.blockingReasons[0]?.message ?? null), `${vm.id}: reason comes from the shared result`);
    }
    // Studio behaviour preserved: a low-score topic is STILL selectable (Studio
    // never had a debate floor) and now carries the explicit label.
    const low = vms.find((v) => v.id === "low")!;
    assert(low.eligible && low.eligibility.warnings.some((w) => w.code === "below_automatic_threshold"), "low-score topic still eligible + labelled");
    const pend = vms.find((v) => v.id === "pending")!;
    assert(!pend.eligible && pend.readiness === "not_approved" && !!pend.unavailableReason, "pending still surfaced with a reason");
  });

  // ---- Ordering / dedupe / limits (shared rundown rules) ----
  await check("ordering: dedupe preserves first-seen order; lead moves to front", () => {
    assert(JSON.stringify(dedupeIds(["a", "b", "a", "c"])) === JSON.stringify(["a", "b", "c"]), "dedupe");
    assert(JSON.stringify(leadFirst(["a", "b", "c"], "c")) === JSON.stringify(["c", "a", "b"]), "leadFirst");
    assert(JSON.stringify(leadFirst(["a", "b"], "zz")) === JSON.stringify(["a", "b"]), "unknown lead is a no-op");
  });
  await check("limits: the ONE shared platform maximum is enforced", () => {
    const over = Array.from({ length: PLATFORM_MAX_TOPICS + 1 }, (_, i) => `t${i}`);
    assert(!validateRundownDraft({ mode: "manual", selectedTopicIds: over, targetTopicCount: 3, maxTopics: PLATFORM_MAX_TOPICS }).ok, "over the max is rejected");
    assert(validateRundownDraft({ mode: "manual", selectedTopicIds: over.slice(0, PLATFORM_MAX_TOPICS), targetTopicCount: 3, maxTopics: PLATFORM_MAX_TOPICS }).ok, "at the max is allowed");
  });

  // ---- Studio still routes through the shared creation service ----
  await check("Studio still creates through createEpisodeDraft: lead-first order == written rows", async () => {
    const db = makeFakeDb({ topics: [topic("t1"), topic("t2"), topic("t3")] });
    const res = await createEpisodeDraft(
      { mode: "manual", selectedTopicIds: leadFirst(["t1", "t2", "t3"], "t3"), strictSelection: true, ownerId: "oA", hostIds: H },
      { db }
    );
    assert(res.ok, res.error || "created");
    const written = db._episodeTopics.sort((a: any, b: any) => a.orderIndex - b.orderIndex).map((e: any) => e.topicId);
    assert(JSON.stringify(res.finalOrder) === JSON.stringify(["t3", "t1", "t2"]), "finalOrder is lead-first");
    assert(JSON.stringify(res.finalOrder) === JSON.stringify(written), "finalOrder == EpisodeTopic rows");
  });
  await check("Studio still enforces reuse without an override (no admin authority leaked)", async () => {
    const prev = process.env.TOPIC_REUSE_MODE;
    process.env.TOPIC_REUSE_MODE = "exclude_podcast";
    try {
      const db = makeFakeDb({ topics: [topic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      const r2 = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], strictSelection: true, ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      assert(!r2.ok && r2.rejectedTopics.some((x) => x.category === "recently_used"), "owner reuse still blocked");
      // The shared contract agrees with what the creation path just did.
      const usage = await getTopicUsage(["t1"], { ownerId: "oA", podcastId: "pA" }, db as any);
      const shared = evaluateTopicSelection(topic("t1"), { actor: OWNER, policy: EXCLUDE, podcastId: "pA", usage });
      assert(!shared.manuallySelectable, "shared contract blocks it too — picker and creation agree");
    } finally {
      if (prev === undefined) delete process.env.TOPIC_REUSE_MODE; else process.env.TOPIC_REUSE_MODE = prev;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("FATAL", e); process.exit(1); });
