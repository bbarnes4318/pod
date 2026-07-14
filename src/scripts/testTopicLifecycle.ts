// Topic lifecycle + snapshot tests. Run: npm run test:topic-lifecycle
//
// Covers: reuse (same topic → many episodes / owners / podcasts), immutable
// snapshot preservation after the source topic is edited, snapshot-first
// resolution for script-gen/fact-check, no status mutation on create, derived
// usage, and the reuse policies (allow / warn / exclude_podcast). In-memory
// fake db via the injectable seam — no external database.

process.env.TOPIC_MIN_TALKABILITY = "1";

import {
  buildTopicSnapshot,
  resolveEpisodeTopicContent,
  briefLikeFromContent,
} from "../lib/services/topicSnapshot";
import {
  getTopicUsage,
  resolveTopicReusePolicy,
  getReuseExcludedTopicIds,
  reuseWarnings,
} from "../lib/services/topicUsageService";
import { createEpisodeDraft } from "../lib/services/episodeCreation";

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

function goodTopic(id: string, over: any = {}) {
  return {
    id, title: `Topic ${id}`, status: "approved", sport: "NFL", leagueId: "NFL",
    summary: "A hot debate.", debateScore: 90, bettingRelevanceScore: 40,
    evidenceIds: [{ type: "news", id: "n1" }], createdAt: new Date("2026-07-10T00:00:00Z"),
    researchBrief: { facts: [{ f: "x" }], sourceIds: [{ type: "news", id: "n1" }], argumentForHostA: "A", argumentForHostB: "B", mainAngle: "angle", contrarianAngle: "contra", onAirTalkingPoints: ["p1"] },
    ...over,
  };
}

// Richer fake db: episodeTopic.findMany resolves the joined episode + supports
// the where shapes getTopicUsage / getReuseExcludedTopicIds use.
function makeFakeDb(seed: { topics?: any[]; hosts?: any[]; podcasts?: any[] }) {
  const topics = new Map((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const hosts = seed.hosts || [{ id: "host-a", ownerId: null }, { id: "host-b", ownerId: null }];
  const podcasts = seed.podcasts || [];
  const episodes = new Map<string, any>();
  const episodeTopics: any[] = [];

  const inMatch = (v: any, arr?: { in: string[] }) => (arr ? arr.in.includes(v) : true);

  const etFindMany = async ({ where, select }: any) => {
    let rows = episodeTopics.filter((et) => {
      if (where?.topicId?.in && !where.topicId.in.includes(et.topicId)) return false;
      if (where?.selectedAt?.gte && !(new Date(et.selectedAt) >= new Date(where.selectedAt.gte))) return false;
      if (where?.episode?.podcastId) {
        const ep = episodes.get(et.episodeId);
        if (!ep || ep.podcastId !== where.episode.podcastId) return false;
      }
      return true;
    });
    return rows.map((et) => {
      const ep = episodes.get(et.episodeId);
      const out: any = { topicId: et.topicId, selectedAt: et.selectedAt, snapshot: et.snapshot };
      if (select?.episode) out.episode = { ownerId: ep?.ownerId ?? null, podcastId: ep?.podcastId ?? null };
      return out;
    });
  };

  const makeEpisode = (data: any) => { const e = { id: `ep-${episodes.size + 1}`, ...data }; episodes.set(e.id, e); return e; };

  return {
    _episodes: episodes, _episodeTopics: episodeTopics, _topics: topics,
    topicCandidate: {
      findUnique: async ({ where }: any) => topics.get(where.id) ?? null,
      findMany: async ({ where }: any) => [...topics.values()].filter((t) => (where?.status ? t.status === where.status : true)),
      update: async ({ where, data }: any) => { const t = topics.get(where.id); if (t) Object.assign(t, data); return t; },
    },
    aiHost: { findMany: async ({ where }: any) => hosts.filter((h) => inMatch(h.id, where.id)).map((h) => ({ id: h.id })) },
    podcast: { findUnique: async ({ where }: any) => podcasts.find((p) => p.id === where.id) ?? null },
    episode: { findUnique: async ({ where }: any) => [...episodes.values()].find((e) => e.slug === where.slug) ?? null, create: async ({ data }: any) => makeEpisode(data) },
    episodeTopic: { findMany: etFindMany, create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    $transaction: async (fn: any) => fn({
      episode: { create: async ({ data }: any) => makeEpisode(data) },
      episodeTopic: { create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
      topicCandidate: { update: async ({ where, data }: any) => { const t = topics.get(where.id); if (t) Object.assign(t, data); return t; } },
    }),
  };
}

async function run() {
  console.log("Topic lifecycle + snapshots:");

  await check("snapshot preserves content AFTER the source topic is edited", () => {
    const topic = goodTopic("t");
    const snap = buildTopicSnapshot(topic as any, topic.researchBrief as any);
    // Edit the live source.
    topic.title = "EDITED";
    (topic.researchBrief as any).argumentForHostA = "CHANGED";
    const content = resolveEpisodeTopicContent({ snapshot: snap, topic: topic as any });
    assert(content.fromSnapshot === true, "must read snapshot");
    assert(content.title === "Topic t", `snapshot title frozen, got ${content.title}`);
    assert(content.argumentForHostA === "A", "snapshot arg frozen");
    assert(typeof snap.evidenceFingerprint === "string" && snap.evidenceFingerprint.length > 0, "fingerprint present");
    assert(typeof snap.selectionTimestamp === "string", "selection timestamp present");
  });

  await check("resolver falls back to LIVE data for legacy rows (no snapshot)", () => {
    const topic = goodTopic("t");
    const content = resolveEpisodeTopicContent({ snapshot: null, topic: topic as any });
    assert(content.fromSnapshot === false && content.title === "Topic t", "live fallback");
  });

  await check("script/fact-check brief adapter carries snapshot content", () => {
    const topic = goodTopic("t");
    const snap = buildTopicSnapshot(topic as any, topic.researchBrief as any);
    const b = briefLikeFromContent(resolveEpisodeTopicContent({ snapshot: snap, topic: null }));
    assert((b.facts as any[]).length === 1 && b.argumentForHostA === "A" && b.mainAngle === "angle", "brief adapter fields");
  });

  await check("creating an episode does NOT mutate topic status + writes a snapshot", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "u1", hostIds: ["host-a", "host-b"] }, { db });
    assert(r.ok, r.error || "create");
    assert(db._topics.get("t1")!.status === "approved", "status stays approved");
    assert(db._episodeTopics[0].snapshot?.title === "Topic t1", "snapshot on the join");
    assert(db._episodeTopics[0].selectedAt instanceof Date, "selectedAt stamped");
  });

  await check("one topic reused in TWO episodes (usage.totalUseCount = 2)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    const r1 = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "u1", hostIds: ["host-a", "host-b"] }, { db });
    const r2 = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "u1", hostIds: ["host-a", "host-b"] }, { db });
    assert(r1.ok && r2.ok, "both create");
    const usage = await getTopicUsage(["t1"], { ownerId: "u1" }, db);
    assert(usage.get("t1")!.totalUseCount === 2, `expected 2, got ${usage.get("t1")!.totalUseCount}`);
    assert(usage.get("t1")!.usedByCurrentUser === true, "used by u1");
  });

  await check("one topic reused across TWO owners", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "owner-A", hostIds: ["host-a", "host-b"] }, { db });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "owner-B", hostIds: ["host-a", "host-b"] }, { db });
    const forA = await getTopicUsage(["t1"], { ownerId: "owner-A" }, db);
    const forB = await getTopicUsage(["t1"], { ownerId: "owner-B" }, db);
    assert(forA.get("t1")!.totalUseCount === 2 && forA.get("t1")!.usedByCurrentUser === true, "A sees 2, used-by-A");
    assert(forB.get("t1")!.usedByCurrentUser === true, "B also used it");
  });

  await check("usedByPodcast is derived per podcast", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pod-1", ownerId: "u1" }] });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "u1", podcastId: "pod-1", hostIds: ["host-a", "host-b"] }, { db });
    const u = await getTopicUsage(["t1"], { podcastId: "pod-1" }, db);
    assert(u.get("t1")!.usedByPodcast === true, "pod-1 used it");
    const u2 = await getTopicUsage(["t1"], { podcastId: "pod-OTHER" }, db);
    assert(u2.get("t1")!.usedByPodcast === false, "other podcast has not");
  });

  await check("reuse policy resolves from env (default allow)", () => {
    assert(resolveTopicReusePolicy({}).mode === "allow", "default allow");
    assert(resolveTopicReusePolicy({ TOPIC_REUSE_MODE: "exclude_podcast", TOPIC_REUSE_COOLDOWN_DAYS: "14" }).cooldownDays === 14, "cooldown parse");
    assert(resolveTopicReusePolicy({ TOPIC_REUSE_MODE: "garbage" }).mode === "allow", "unknown → allow");
  });

  await check("exclude_podcast policy removes a recently-used topic from THIS podcast's auto pool", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2")], podcasts: [{ id: "pod-1", ownerId: "u1" }] });
    // pod-1 already used t1 today.
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "u1", podcastId: "pod-1", hostIds: ["host-a", "host-b"] }, { db });
    const policy = { mode: "exclude_podcast" as const, cooldownDays: 7 };
    const excluded = await getReuseExcludedTopicIds(policy, { podcastId: "pod-1" }, db);
    assert(excluded.includes("t1"), "t1 excluded for pod-1");
    const excludedOther = await getReuseExcludedTopicIds(policy, { podcastId: "pod-2" }, db);
    assert(!excludedOther.includes("t1"), "not excluded for a different podcast");
  });

  await check("warn policy surfaces a recent-use warning without blocking", () => {
    const usage = new Map([["t1", { topicId: "t1", totalUseCount: 3, lastUsedAt: new Date(), usedByCurrentUser: true, usedByPodcast: true, recentUseCount: 2 }]]);
    const w = reuseWarnings({ mode: "warn", cooldownDays: 7 }, usage as any, ["t1"]);
    assert(w.length === 1 && /2 time/.test(w[0]), "warning surfaced");
    const none = reuseWarnings({ mode: "allow", cooldownDays: 7 }, usage as any, ["t1"]);
    assert(none.length === 0, "allow policy warns nothing");
  });

  await check("deleting usage (EpisodeTopic removal) drops derived count — no status change", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "u1", hostIds: ["host-a", "host-b"] }, { db });
    // Simulate the new episode-delete: remove EpisodeTopic rows, touch NO topic.
    db._episodeTopics.length = 0;
    const usage = await getTopicUsage(["t1"], {}, db);
    assert(usage.get("t1")!.totalUseCount === 0, "usage derived to 0 after delete");
    assert(db._topics.get("t1")!.status === "approved", "topic editorial status untouched by delete");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => { console.error("FATAL", e); process.exit(1); });
