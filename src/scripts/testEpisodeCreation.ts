// Unified episode-creation service tests. Run: npm run test:episode-creation
//
// Uses an in-memory fake `db` (injected via the createEpisodeDraft deps seam)
// so the full manual/automatic/hybrid flows run with real logic and zero
// external database. Pure validation cases also exercise the Zod schema and the
// exported helpers directly.
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: the
   in-memory fake DB doubles are intentionally loosely typed. */

import {
  createEpisodeDraft,
  dedupePreserveOrder,
  MAX_TOPICS_PER_EPISODE,
} from "../lib/services/episodeCreation";
import { evaluateTopicEligibility, normalizeEpisodeSettings } from "../lib/services/episodeService";

// Isolate SELECTION logic from the talkability-score gate: the fixtures below
// are deliberately minimal, so drop the talkability floor for auto-ranking.
// (selectAutoTopics reads `Number(env) || 35`, so 0 would be treated as 35 —
// use 1.)
process.env.TOPIC_MIN_TALKABILITY = "1";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${(err as Error).message}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// In-memory fake db (only the surface createEpisodeDraft touches).
// ---------------------------------------------------------------------------
type Topic = {
  id: string; title: string; status: string; sport: string; leagueId: string | null;
  summary: string | null; debateScore: number; bettingRelevanceScore: number;
  evidenceIds: unknown; createdAt: Date;
  researchBrief: { facts: unknown; sourceIds: unknown; argumentForHostA: string | null; argumentForHostB: string | null } | null;
};

function goodTopic(id: string, over: Partial<Topic> = {}): Topic {
  return {
    id, title: `Topic ${id}`, status: "approved", sport: "NFL", leagueId: "NFL",
    summary: "A hot debate about last night's game and what it means.",
    debateScore: 90, bettingRelevanceScore: 40, evidenceIds: [{ type: "news", id: "n1" }],
    createdAt: new Date("2026-07-10T00:00:00Z"),
    researchBrief: { facts: [{ f: "x" }], sourceIds: [{ type: "news", id: "n1" }], argumentForHostA: "A side", argumentForHostB: "B side" },
    ...over,
  };
}

function makeFakeDb(seed: { topics?: Topic[]; hosts?: { id: string; ownerId: string | null }[]; podcasts?: { id: string; ownerId: string | null }[] }) {
  const topics = new Map((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const hosts = seed.hosts || [];
  const podcasts = seed.podcasts || [];
  const episodes: any[] = [];
  const episodeTopics: any[] = [];

  const matchIn = (v: any, arr?: { in: string[] }) => (arr ? arr.in.includes(v) : true);

  return {
    _episodes: episodes,
    _episodeTopics: episodeTopics,
    _topics: topics,
    topicCandidate: {
      findUnique: async ({ where }: any) => topics.get(where.id) ?? null,
      findMany: async ({ where }: any) =>
        [...topics.values()].filter((t) => (where?.status ? t.status === where.status : true)),
      update: async ({ where, data }: any) => {
        const t = topics.get(where.id);
        if (t) Object.assign(t, data);
        return t;
      },
    },
    aiHost: {
      findMany: async ({ where }: any) => {
        return hosts.filter((h) => {
          if (!matchIn(h.id, where.id)) return false;
          if (where.OR) return where.OR.some((c: any) => ("ownerId" in c ? h.ownerId === c.ownerId : true));
          return true;
        }).map((h) => ({ id: h.id }));
      },
    },
    podcast: {
      findUnique: async ({ where }: any) => podcasts.find((p) => p.id === where.id) ?? null,
    },
    episode: {
      findUnique: async ({ where }: any) => episodes.find((e) => e.slug === where.slug) ?? null,
      create: async ({ data }: any) => { const e = { id: `ep-${episodes.length + 1}`, ...data }; episodes.push(e); return e; },
    },
    episodeTopic: {
      create: async ({ data }: any) => { episodeTopics.push(data); return data; },
    },
    $transaction: async (fn: any) => fn({
      episode: { create: async ({ data }: any) => { const e = { id: `ep-${episodes.length + 1}`, ...data }; episodes.push(e); return e; } },
      episodeTopic: { create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
      topicCandidate: { update: async ({ where, data }: any) => { const t = topics.get(where.id); if (t) Object.assign(t, data); return t; } },
    }),
  };
}

const HOSTS = [{ id: "host-a", ownerId: "user-1" }, { id: "host-b", ownerId: null }];

async function run() {
  console.log("Unified episode creation:");

  // ---- Pure helpers ----
  await check("dedupePreserveOrder keeps first-seen order, drops dups + blanks", () => {
    assert(JSON.stringify(dedupePreserveOrder(["b", "a", "b", " ", "c", "a"])) === JSON.stringify(["b", "a", "c"]), "order/dedupe wrong");
  });
  await check("evaluateTopicEligibility flags each failure category", () => {
    assert(evaluateTopicEligibility(null as any, "x").category === "not_found", "null");
    assert(evaluateTopicEligibility(goodTopic("t", { status: "pending" }) as any).category === "not_approved", "status");
    assert(evaluateTopicEligibility(goodTopic("t", { evidenceIds: [] }) as any).category === "weak_evidence", "evidence");
    assert(evaluateTopicEligibility(goodTopic("t", { researchBrief: null }) as any).category === "missing_brief", "brief");
    assert(evaluateTopicEligibility(goodTopic("t") as any).ok === true, "good topic must pass");
  });
  await check("invalid TTS provider / style / density reject before any DB work", () => {
    let threw = false; try { normalizeEpisodeSettings({ ttsProvider: "not-a-provider" }); } catch { threw = true; }
    assert(threw, "bad tts provider must throw");
    threw = false; try { normalizeEpisodeSettings({ productionStyle: "nope" }); } catch { threw = true; }
    assert(threw, "bad style must throw");
  });

  // ---- Schema-level rejections (no DB needed) ----
  await check("manual mode requires at least one selected topic", async () => {
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: [] });
    assert(!r.ok && /at least one/.test(r.error!), r.error || "should fail");
  });
  await check("too many topics is rejected (max 6)", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `t${i}`);
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ids });
    assert(!r.ok && /No more than 6/.test(r.error!), r.error || "should cap at 6");
    assert(MAX_TOPICS_PER_EPISODE === 6, "default cap is 6");
  });
  await check("hybrid pinned count cannot exceed target", async () => {
    const r = await createEpisodeDraft({ mode: "hybrid", selectedTopicIds: ["a", "b", "c"], targetTopicCount: 2 });
    assert(!r.ok && /cannot exceed/.test(r.error!), r.error || "should reject");
  });
  await check("invalid targetTopicCount is rejected", async () => {
    const r = await createEpisodeDraft({ mode: "automatic", targetTopicCount: 99 });
    assert(!r.ok, "99 > max should fail");
  });

  // ---- Full flows on the in-memory db ----
  await check("manual creation with one topic", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "user-1", hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok && r.episodeId !== null, r.error || "should create");
    assert(r.finalOrder.length === 1 && r.finalOrder[0] === "t1", "one topic");
    assert(db._topics.get("t1")!.status === "approved", "topic status NOT mutated to used");
    assert(db._episodeTopics[0]?.snapshot?.title === "Topic t1", "snapshot written on the join");
  });
  await check("manual creation with multiple ordered topics (order preserved)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2"), goodTopic("t3")], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t3", "t1", "t2"], hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok, r.error || "should create");
    assert(JSON.stringify(r.finalOrder) === JSON.stringify(["t3", "t1", "t2"]), `order not preserved: ${r.finalOrder}`);
    const joins = db._episodeTopics.sort((a, b) => a.orderIndex - b.orderIndex).map((j) => j.topicId);
    assert(JSON.stringify(joins) === JSON.stringify(["t3", "t1", "t2"]), "join orderIndex wrong");
  });
  await check("duplicate topic ids are deduped, order preserved", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2")], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1", "t2", "t1"], hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok && JSON.stringify(r.finalOrder) === JSON.stringify(["t1", "t2"]), `dedupe failed: ${r.finalOrder}`);
  });
  await check("manual rejects an invalid topic WITHOUT silently dropping it", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2", { status: "pending" })], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1", "t2"], hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok, r.error || "builds from the valid one");
    assert(r.finalOrder.length === 1 && r.finalOrder[0] === "t1", "kept valid");
    assert(r.rejectedTopics.length === 1 && r.rejectedTopics[0].id === "t2" && r.rejectedTopics[0].category === "not_approved", "rejection surfaced");
  });
  await check("strictSelection fails atomically (no episode) when a pin is invalid", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2", { status: "pending" })], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1", "t2"], strictSelection: true, hostIds: ["host-a", "host-b"] }, { db });
    assert(!r.ok, "strict must fail on any invalid pin");
    assert(r.rejectedTopics.length === 1 && r.rejectedTopics[0].id === "t2", "rejection surfaced");
    assert(db._episodes.length === 0, "no episode created under strict failure");
  });
  await check("missing topic (all invalid) fails with structured rejection", async () => {
    const db = makeFakeDb({ topics: [], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["ghost"], hostIds: ["host-a", "host-b"] }, { db });
    assert(!r.ok && r.rejectedTopics.length === 1 && r.rejectedTopics[0].category === "not_found", "should reject ghost");
  });
  await check("automatic creation selects top-ranked topics", async () => {
    const db = makeFakeDb({ topics: [goodTopic("a", { debateScore: 80 }), goodTopic("b", { debateScore: 95 }), goodTopic("c", { debateScore: 70 })], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "automatic", targetTopicCount: 2, hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok && r.finalOrder.length === 2, r.error || "auto should pick 2");
    assert(r.autoSelectedTopicIds.length === 2 && r.selectedTopics.every((s) => !s.pinned), "all auto-selected");
  });
  await check("hybrid: pinned first, then auto-fills the rest (no dup of pinned)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("pin", { debateScore: 60 }), goodTopic("auto1", { debateScore: 99 }), goodTopic("auto2", { debateScore: 98 })], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "hybrid", selectedTopicIds: ["pin"], targetTopicCount: 3, hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok, r.error || "hybrid should create");
    assert(r.finalOrder[0] === "pin", "pinned first");
    assert(r.finalOrder.length === 3 && !r.autoSelectedTopicIds.includes("pin"), "auto fill excludes pinned");
    assert(r.selectedTopics[0].pinned === true && r.selectedTopics[1].pinned === false, "pinned flag correct");
  });
  await check("invalid host is rejected", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], hostIds: ["host-a", "ghost-host"] }, { db });
    assert(!r.ok && /host/i.test(r.error!), r.error || "should reject unknown host");
  });
  await check("another user's private host is not castable (owner scoping)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], hosts: [{ id: "priv", ownerId: "someone-else" }] });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "user-1", hostIds: ["priv"] }, { db });
    assert(!r.ok && /host/i.test(r.error!), "must not cast another user's host");
  });
  await check("invalid podcast access is rejected", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], hosts: HOSTS, podcasts: [{ id: "pod-1", ownerId: "someone-else" }] });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "user-1", podcastId: "pod-1", hostIds: ["host-a", "host-b"] }, { db });
    assert(!r.ok && /another account/.test(r.error!), r.error || "should reject cross-owner podcast");
  });
  await check("invalid TTS provider rejected in full flow", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ttsProvider: "bogus", hostIds: ["host-a", "host-b"] }, { db });
    assert(!r.ok && /TTS provider/.test(r.error!), r.error || "should reject provider");
  });
  await check("backwards-compat: single-topic manual call mirrors the legacy one-topic path", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], hosts: HOSTS });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "user-1", hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok && r.finalOrder.length === 1 && db._episodes.length === 1, "one episode, one topic");
  });
  await check("recurring-style creation (automatic + podcast + verticals) uses the shared service", async () => {
    const db = makeFakeDb({
      topics: [goodTopic("nfl1"), goodTopic("nba1", { sport: "NBA", leagueId: "NBA" })],
      hosts: HOSTS, podcasts: [{ id: "pod-1", ownerId: "user-1" }],
    });
    const r = await createEpisodeDraft({ mode: "automatic", targetTopicCount: 1, ownerId: "user-1", podcastId: "pod-1", verticals: ["NFL"], hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok && r.finalOrder.length === 1 && r.finalOrder[0] === "nfl1", r.error || "vertical-filtered auto pick");
    assert(db._episodes[0].podcastId === "pod-1" && db._episodes[0].ownerId === "user-1", "podcast + owner stamped");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error("FATAL", e); process.exit(1); });
