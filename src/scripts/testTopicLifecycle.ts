// Topic lifecycle + snapshot + reuse-policy tests. Run: npm run test:topic-lifecycle
//
// In-memory fake db via the injectable seam — no external database.

process.env.TOPIC_MIN_TALKABILITY = "1";

import {
  buildTopicSnapshot,
  resolveEpisodeTopicContent,
  parseSnapshot,
  EPISODE_TOPIC_SNAPSHOT_VERSION,
} from "../lib/services/topicSnapshot";
import {
  getTopicUsage,
  getGlobalTopicUsageStatsAdmin,
  resolveTopicReusePolicy,
  getReuseExcludedTopicIds,
} from "../lib/services/topicUsageService";
import { createEpisodeDraft, buildEpisodeFromTopics } from "../lib/services/episodeCreation";
import { evaluateEpisodeTopicsForScript } from "../lib/services/scriptTopicGate";

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
    debateScore: 90, bettingRelevanceScore: 40, evidenceIds: [{ type: "news", id: "n1" }],
    createdAt: new Date("2026-07-10T00:00:00Z"),
    researchBrief: { facts: [{ text: "A real grounded fact.", evidenceRefs: [{ id: "n1" }] }], sourceIds: [{ type: "news", id: "n1" }], stats: [], argumentForHostA: "A side", argumentForHostB: "B side", mainAngle: "angle", contrarianAngle: "contra", onAirTalkingPoints: ["p1"] },
    ...over,
  };
}

function makeFakeDb(seed: { topics?: any[]; hosts?: any[]; podcasts?: any[] }) {
  const topics = new Map((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const hosts = seed.hosts || [{ id: "host-a", ownerId: null }, { id: "host-b", ownerId: null }];
  const podcasts = seed.podcasts || [];
  const episodes = new Map<string, any>();
  const episodeTopics: any[] = [];
  const inMatch = (v: any, arr?: { in: string[] }) => (arr ? arr.in.includes(v) : true);
  const makeEpisode = (data: any) => { const e = { id: `ep-${episodes.size + 1}`, ...data }; episodes.set(e.id, e); return e; };
  const etFindMany = async ({ where, select }: any) => {
    const rows = episodeTopics.filter((et) => {
      if (where?.topicId?.in && !where.topicId.in.includes(et.topicId)) return false;
      if (where?.episodeId?.not && et.episodeId === where.episodeId.not) return false;
      if (where?.selectedAt?.gte && !(new Date(et.selectedAt) >= new Date(where.selectedAt.gte))) return false;
      if (where?.episode?.podcastId) { const ep = episodes.get(et.episodeId); if (!ep || ep.podcastId !== where.episode.podcastId) return false; }
      return true;
    });
    return rows.map((et) => {
      const ep = episodes.get(et.episodeId);
      const out: any = { topicId: et.topicId, selectedAt: et.selectedAt, snapshot: et.snapshot };
      if (select?.episode) out.episode = { ownerId: ep?.ownerId ?? null, podcastId: ep?.podcastId ?? null };
      return out;
    });
  };
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
const HOSTS = [{ id: "host-a", ownerId: null }, { id: "host-b", ownerId: null }];
const H = ["host-a", "host-b"];
const warns = (r: any) => (r.reasons as string[]).filter((s) => /was used \d+ time/.test(s));

async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try { await fn(); } finally { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
}

async function run() {
  console.log("Topic lifecycle + snapshots + reuse policy:");

  // ---- Snapshot immutability + versioning (item 7) ----
  await check("snapshot preserves content + talkability AFTER the source is edited", () => {
    const topic = goodTopic("t");
    const snap = buildTopicSnapshot(topic as any, topic.researchBrief as any);
    assert(snap.fingerprintAlgo === "sha256" && snap.evidenceFingerprint.length === 64, "sha256 fingerprint");
    assert(!!snap.talkability && typeof snap.talkability.total === "number", "talkability frozen");
    topic.title = "EDITED"; (topic.researchBrief as any).facts = [];
    const c = resolveEpisodeTopicContent({ snapshot: snap, topic: topic as any });
    assert(c.fromSnapshot && c.title === "Topic t" && (c.facts as any[]).length === 1, "frozen content wins");
  });
  await check("parseSnapshot classifies valid / missing / unsupported / corrupt", () => {
    const good = buildTopicSnapshot(goodTopic("t") as any, goodTopic("t").researchBrief as any);
    assert(parseSnapshot(good).status === "valid", "valid");
    assert(parseSnapshot(null).status === "missing", "missing");
    assert(parseSnapshot({ ...good, version: 99 }).status === "unsupported_version", "unsupported");
    assert(parseSnapshot({ version: 1, title: 42 }).status === "corrupt", "corrupt");
  });
  await check("corrupt/unsupported snapshot FAILS OPEN to live (surfaced, not silent)", () => {
    const live = { snapshot: { version: 1, title: "broken" /* missing required fields */ }, topic: goodTopic("t") };
    const c = resolveEpisodeTopicContent(live as any);
    assert(!c.fromSnapshot && c.snapshotStatus === "corrupt" && c.title === "Topic t", "fell back to live, status surfaced");
  });

  // ---- Content gate is snapshot-first (item 4, integration-level) ----
  await check("content gate uses the FROZEN snapshot even when live topic is gutted", () => {
    const topic = goodTopic("t");
    const snap = buildTopicSnapshot(topic as any, topic.researchBrief as any);
    // Gut the live source: empty facts/sources/args + empty summary.
    const gutted = { ...topic, title: "", summary: "", researchBrief: { facts: [], sourceIds: [], argumentForHostA: "", argumentForHostB: "" } };
    const snapGate = evaluateEpisodeTopicsForScript([{ snapshot: snap, topic: gutted }]);
    const liveGate = evaluateEpisodeTopicsForScript([{ snapshot: null, topic: gutted }]);
    assert(snapGate.ok && snapGate.allFromSnapshot, "snapshot path passes validation");
    assert(!liveGate.ok, "live-only path fails on gutted content — proving the difference");
    assert(Math.round(snapGate.avgTalkability) === Math.round(snap.talkability!.total as number), "same talkability as snapshot");
  });

  // ---- No status mutation on create (items 6-adjacent) ----
  await check("creating an episode writes a snapshot + selectedAt, never mutates status", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "u1", hostIds: H }, { db });
    assert(r.ok, r.error || "create");
    assert(db._topics.get("t1")!.status === "approved", "status untouched");
    assert(db._episodeTopics[0].snapshot?.title === "Topic t1" && db._episodeTopics[0].selectedAt instanceof Date, "snapshot + selectedAt");
  });

  // ---- Scoped usage (item 2) ----
  await check("usage is scoped per owner + per podcast (no cross-customer leakage)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }, { id: "pB", ownerId: "oB" }] });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
    const uForB = await getTopicUsage(["t1"], { ownerId: "oB", podcastId: "pB" }, db);
    const uForA = await getTopicUsage(["t1"], { ownerId: "oA", podcastId: "pA" }, db);
    assert(uForA.get("t1")!.currentPodcastUseCount === 1 && uForA.get("t1")!.currentOwnerUseCount === 1, "A sees its own use");
    assert(uForB.get("t1")!.currentPodcastUseCount === 0 && uForB.get("t1")!.currentOwnerUseCount === 0, "B sees NONE of A's use");
    assert(uForB.get("t1")!.totalUseCount === 1, "platform total still visible (count only)");
  });
  await check("admin global stats expose platform-wide totals + distinct counts", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }, { id: "pB", ownerId: "oB" }] });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oB", podcastId: "pB", hostIds: H }, { db });
    const g = await getGlobalTopicUsageStatsAdmin(["t1"], {}, db);
    assert(g.get("t1")!.totalUseCount === 2 && g.get("t1")!.distinctOwners === 2 && g.get("t1")!.distinctPodcasts === 2, "global admin stats");
  });

  // ---- Warn policy: first use no warning, second use one, self-excluded (item 1) ----
  await check("warn: FIRST use of a topic produces ZERO warnings", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "warn" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
      const r = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      assert(r.ok && warns(r).length === 0, `first use must not warn; got ${JSON.stringify(warns(r))}`);
      assert(db._episodeTopics.length === 1, "episode created");
    });
  });
  await check("warn: SECOND use in the same podcast produces ONE warning (self-excluded)", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "warn" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      const r2 = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      assert(r2.ok && warns(r2).length === 1 && /1 time/.test(warns(r2)[0]), `second use warns once (excl. current): ${JSON.stringify(warns(r2))}`);
    });
  });
  await check("warn: cross-owner isolation (standalone) — Owner A use does NOT warn Owner B", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "warn" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", hostIds: H }, { db });
      const rB = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oB", hostIds: H }, { db });
      assert(rB.ok && warns(rB).length === 0, "owner B not warned by owner A");
    });
  });
  await check("warn: cross-podcast isolation — Podcast A use does NOT warn Podcast B", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "warn" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }, { id: "pB", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      const rB = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pB", hostIds: H }, { db });
      assert(rB.ok && warns(rB).length === 0, "podcast B not warned by podcast A");
    });
  });
  await check("warn: use OUTSIDE the cooldown window does not warn", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "warn", TOPIC_REUSE_COOLDOWN_DAYS: "7" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      // Age the recorded use to 30 days ago.
      db._episodeTopics[0].selectedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const r2 = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      assert(r2.ok && warns(r2).length === 0, "stale use is outside cooldown → no warning");
    });
  });

  // ---- exclude_podcast on manual/hybrid + authorized override (item 3) ----
  await check("exclude_podcast BLOCKS a manually-pinned recently-used topic (recently_used) without override", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      const r2 = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      assert(!r2.ok, "should not create — the only pin is blocked");
      assert(r2.rejectedTopics.some((x) => x.id === "t1" && x.category === "recently_used"), "structured recently_used rejection");
    });
  });
  await check("exclude_podcast: authorized reuseOverride permits the manual reuse", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      const r2 = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", reuseOverride: true, hostIds: H }, { db });
      assert(r2.ok && r2.finalOrder[0] === "t1", "override permits reuse");
    });
  });
  await check("exclude_podcast: another podcast's recent use does NOT block the pin", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }, { id: "pB", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      const rB = await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pB", hostIds: H }, { db });
      assert(rB.ok && rB.finalOrder[0] === "t1", "podcast B unaffected by podcast A's use");
    });
  });
  await check("exclude_podcast: HYBRID pinned topic follows the same block+override rule", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("pin"), goodTopic("a1", { debateScore: 99 })], podcasts: [{ id: "pA", ownerId: "oA" }] });
      await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["pin"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      const r = await createEpisodeDraft({ mode: "hybrid", selectedTopicIds: ["pin"], targetTopicCount: 2, ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
      assert(r.ok, "hybrid still builds from auto-fill");
      assert(r.rejectedTopics.some((x) => x.id === "pin" && x.category === "recently_used"), "pinned 'pin' blocked recently_used");
      assert(!r.finalOrder.includes("pin"), "blocked pin excluded from final order");
    });
  });

  // ---- Queue / recurring path shares the policy (item 8) ----
  await check("queue/recurring (buildEpisodeFromTopics adapter) honors exclude_podcast on auto-fill", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1", { debateScore: 99 }), goodTopic("t2", { debateScore: 98 })], podcasts: [{ id: "pA", ownerId: "oA" }] });
      // pA already used t1 today.
      await createEpisodeDraft({ mode: "automatic", targetTopicCount: 1, ownerId: "oA", podcastId: "pA", hostIds: H, verticals: ["NFL"] }, { db });
      // Recurring-style build via the deprecated adapter → createEpisodeDraft.
      const res = await (buildEpisodeFromTopics as any)({ podcastId: "pA", ownerId: "oA", verticals: ["NFL"], targetTopicCount: 1, hostIds: H }, { db });
      // adapter throws on failure; on success returns legacy shape.
      assert(res.episodeId && !res.selectedTopicIds.includes("t1"), "recurring auto-fill excluded the podcast's recent topic t1");
      assert(res.statusUpdateCount === 0, "adapter reports statusUpdateCount=0 (no status mutation)");
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("FATAL", e); process.exit(1); });
