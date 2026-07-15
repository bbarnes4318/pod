// REAL production-path concurrency test. Run: npm run test:concurrency-prod-path
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: dynamic
   seed payloads + raw ids. */
//
// Boots a throwaway embedded Postgres, applies the FULL Prisma schema via
// `prisma db push`, and drives the ACTUAL production path end to end:
//
//   createEpisodeDraft -> createEpisodeRecord -> advisory-lock reservation
//     -> Episode/EpisodeTopic writes -> structured result
//
// with two simultaneous builds for the same podcast under exclude_podcast. It
// asserts the data-consistency invariant that motivated this fix: for EVERY
// successful result, `finalOrder` (and `selectedTopics`) exactly equals the
// ordered Topic ids actually written as EpisodeTopic rows — the structured
// result can never claim a topic with no matching row — and concurrency-dropped
// topics are surfaced as `recently_used_concurrently`.

import path from "path";
import { execSync } from "child_process";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");
import { PrismaClient } from "@prisma/client";
import { createEpisodeDraft } from "../lib/services/episodeCreation";
import { stopEmbeddedPgScoped } from "../../tests/e2e/runtime";

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function ok(name: string) { passed++; console.log(`  ✓ ${name}`); }
function bad(name: string, e: unknown) { failed++; console.error(`  ✗ ${name}\n      ${(e as Error)?.message || e}`); }

const PORT = Number(process.env.PG_TEST_PORT) || 55444;
const URL = `postgresql://postgres:postgres@localhost:${PORT}/prodpath`;

let seq = 0;
function topicData(over: Partial<any> = {}) {
  const id = over.id || `topic-${++seq}`;
  return {
    id,
    title: `Topic ${id}`,
    sport: "NFL",
    leagueId: null, // no League row seeded; auto-selection here isn't league-filtered
    summary: "A genuinely hot debate about last night's game and the season ahead.",
    controversyScore: 80,
    starPowerScore: 70,
    bettingRelevanceScore: 40,
    recencyScore: 80,
    debateScore: 90,
    evidenceIds: [{ type: "news", id: "n1" }],
    status: "approved" as const,
    researchBrief: {
      create: {
        facts: [{ text: "A real grounded fact.", evidenceRefs: [{ id: "n1" }] }],
        stats: [],
        argumentForHostA: "A side",
        argumentForHostB: "B side",
        counterArguments: [],
        unsafeClaims: [],
        sourceIds: [{ type: "news", id: "n1" }],
        mainAngle: "angle",
        contrarianAngle: "contra",
        onAirTalkingPoints: ["p1"],
      },
    },
    ...over,
  };
}

async function seedHosts(prisma: PrismaClient) {
  for (const n of ["A", "B"]) {
    await prisma.aiHost.create({
      data: {
        name: `Host ${n}`, slug: `host-${n.toLowerCase()}`, role: "analyst", worldview: "w",
        speakingStyle: "s", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [],
        bannedPhrases: [], ttsProvider: "stub", ttsVoiceId: "v", intensityLevel: 7, isActive: true,
      },
    });
  }
}

/** Clear per-scenario data so each sub-test has an ISOLATED approved-topic pool
 *  (auto-selection ranks over ALL approved topics, not per-podcast). Keeps the
 *  seeded User + AiHosts. */
async function resetData(prisma: PrismaClient) {
  await prisma.episodeTopic.deleteMany();
  await prisma.episode.deleteMany();
  await prisma.researchBrief.deleteMany();
  await prisma.topicCandidate.deleteMany();
  await prisma.podcast.deleteMany();
}

/** The ordered topic ids actually written for an episode. */
async function writtenOrder(prisma: PrismaClient, episodeId: string): Promise<string[]> {
  const rows = await prisma.episodeTopic.findMany({
    where: { episodeId }, orderBy: { orderIndex: "asc" }, select: { topicId: true },
  });
  return rows.map((r) => r.topicId);
}

/** The core invariant: a successful result matches the DB exactly. */
async function assertResultMatchesDb(prisma: PrismaClient, res: any) {
  assert(res.ok && res.episodeId, "result should be ok with an episodeId");
  const dbOrder = await writtenOrder(prisma, res.episodeId);
  assert(JSON.stringify(res.finalOrder) === JSON.stringify(dbOrder), `finalOrder ${JSON.stringify(res.finalOrder)} must equal DB rows ${JSON.stringify(dbOrder)}`);
  assert(JSON.stringify(res.selectedTopics.map((s: any) => s.id)) === JSON.stringify(dbOrder), "selectedTopics ids must equal DB rows");
  const writtenSet = new Set(dbOrder);
  for (const id of res.autoSelectedTopicIds) assert(writtenSet.has(id), `autoSelectedTopicIds must not include an unwritten topic (${id})`);
}

async function main() {
  process.env.TOPIC_REUSE_MODE = "exclude_podcast";
  process.env.TOPIC_MIN_TALKABILITY = "1";

  const dir = path.join(process.env.TEMP || "/tmp", `pgprod-${Date.now()}`);
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("prodpath");

  console.log("Episode creation concurrency — REAL production path:");
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: URL }, stdio: "ignore",
  });

  const prisma = new PrismaClient({ datasourceUrl: URL } as any);
  await prisma.$connect();

  try {
    // Podcast.ownerId / Episode.ownerId FK to User.
    await prisma.user.create({ data: { id: "o1", email: "o1@example.com" } });
    await seedHosts(prisma);

    // ---- Hybrid partial-drop: shorter episode + reported drop ----
    // Each build pins its OWN topic and both auto-fill the SAME hotter topic TC.
    // The advisory lock serializes: one writes [pin, TC], the other drops TC and
    // writes a SHORTER [pin] — reported, never silently counted as full.
    try {
      await resetData(prisma);
      const pod = await prisma.podcast.create({ data: { name: "P-hybrid", cadence: "one_time", ownerId: "o1" } });
      await prisma.topicCandidate.create({ data: topicData({ id: "H-PA", debateScore: 80 }) as any });
      await prisma.topicCandidate.create({ data: topicData({ id: "H-PB", debateScore: 80 }) as any });
      await prisma.topicCandidate.create({ data: topicData({ id: "H-TC", debateScore: 99 }) as any });

      const [rA, rB] = await Promise.all([
        createEpisodeDraft({ mode: "hybrid", title: "Hybrid A", selectedTopicIds: ["H-PA"], targetTopicCount: 2, ownerId: "o1", podcastId: pod.id }, { db: prisma }),
        createEpisodeDraft({ mode: "hybrid", title: "Hybrid B", selectedTopicIds: ["H-PB"], targetTopicCount: 2, ownerId: "o1", podcastId: pod.id }, { db: prisma }),
      ]);

      assert(rA.ok && rB.ok, `both hybrid builds should create (shorter) episodes (${rA.error || ""} ${rB.error || ""})`);
      await assertResultMatchesDb(prisma, rA);
      await assertResultMatchesDb(prisma, rB);

      const withTc = [rA, rB].filter((r) => r.finalOrder.includes("H-TC"));
      const without = [rA, rB].filter((r) => !r.finalOrder.includes("H-TC"));
      assert(withTc.length === 1 && without.length === 1, "exactly one episode won the contested topic H-TC");

      // The loser dropped H-TC: it must be reported as a structured
      // recently_used_concurrently rejection, absent from autoSelectedTopicIds,
      // and the episode built shorter with the reduced count reported.
      const loser = without[0] as any;
      assert(loser.rejectedTopics.some((r: any) => r.id === "H-TC" && r.category === "recently_used_concurrently"), "loser surfaces recently_used_concurrently rejection for the dropped topic");
      assert(!loser.autoSelectedTopicIds.includes("H-TC"), "dropped topic not in loser autoSelectedTopicIds");
      assert(loser.finalOrder.length === 1, "loser built a SHORTER episode (its pin only)");
      assert(loser.reasons.some((r: string) => /requested 2/.test(r)), "loser reports the reduced count vs requested");

      // Topic used at most once for this podcast (the exclude_podcast guarantee).
      const tcUses = await prisma.episodeTopic.count({ where: { topicId: "H-TC", episode: { podcastId: pod.id } } });
      assert(tcUses === 1, `H-TC used exactly once for this podcast, got ${tcUses}`);
      ok("hybrid: contested auto topic written once; loser builds shorter episode + reports the drop");
    } catch (e) { bad("hybrid: contested auto topic written once; loser builds shorter episode + reports the drop", e); }

    // ---- Automatic single contested topic: exactly one succeeds ----
    try {
      await resetData(prisma);
      const pod = await prisma.podcast.create({ data: { name: "P-auto", cadence: "one_time", ownerId: "o1" } });
      await prisma.topicCandidate.create({ data: topicData({ id: "A-T1", debateScore: 99 }) as any });

      const [rA, rB] = await Promise.all([
        createEpisodeDraft({ mode: "automatic", title: "Auto A", targetTopicCount: 1, ownerId: "o1", podcastId: pod.id }, { db: prisma }),
        createEpisodeDraft({ mode: "automatic", title: "Auto B", targetTopicCount: 1, ownerId: "o1", podcastId: pod.id }, { db: prisma }),
      ]);
      const okers = [rA, rB].filter((r) => r.ok);
      assert(okers.length === 1, `exactly one automatic build succeeds for a single contested topic (got ${okers.length}: ${JSON.stringify([rA.error, rB.error])})`);
      await assertResultMatchesDb(prisma, okers[0]);
      const uses = await prisma.episodeTopic.count({ where: { topicId: "A-T1" } });
      assert(uses === 1, `A-T1 written exactly once, got ${uses}`);
      ok("automatic: two builds contend for one topic → exactly one succeeds, result matches DB");
    } catch (e) { bad("automatic: two builds contend for one topic → exactly one succeeds, result matches DB", e); }

    // ---- Different podcasts remain independent ----
    try {
      await resetData(prisma);
      const px = await prisma.podcast.create({ data: { name: "P-X", cadence: "one_time", ownerId: "o1" } });
      const py = await prisma.podcast.create({ data: { name: "P-Y", cadence: "one_time", ownerId: "o1" } });
      await prisma.topicCandidate.create({ data: topicData({ id: "Z-T", debateScore: 99 }) as any });

      const [rX, rY] = await Promise.all([
        createEpisodeDraft({ mode: "automatic", title: "PX Ep", targetTopicCount: 1, ownerId: "o1", podcastId: px.id }, { db: prisma }),
        createEpisodeDraft({ mode: "automatic", title: "PY Ep", targetTopicCount: 1, ownerId: "o1", podcastId: py.id }, { db: prisma }),
      ]);
      assert(rX.ok && rY.ok, "different podcasts both succeed with the same topic");
      await assertResultMatchesDb(prisma, rX);
      await assertResultMatchesDb(prisma, rY);
      assert(rX.finalOrder.includes("Z-T") && rY.finalOrder.includes("Z-T"), "same topic used by both independent podcasts");
      ok("different podcasts remain independent (same topic, no blocking)");
    } catch (e) { bad("different podcasts remain independent (same topic, no blocking)", e); }

    // ---- Manual concurrency still correct (pin, no override) ----
    try {
      await resetData(prisma);
      const pod = await prisma.podcast.create({ data: { name: "P-manual", cadence: "one_time", ownerId: "o1" } });
      await prisma.topicCandidate.create({ data: topicData({ id: "M-T", debateScore: 99 }) as any });

      const [rA, rB] = await Promise.all([
        createEpisodeDraft({ mode: "manual", title: "Manual A", selectedTopicIds: ["M-T"], strictSelection: true, ownerId: "o1", podcastId: pod.id }, { db: prisma }),
        createEpisodeDraft({ mode: "manual", title: "Manual B", selectedTopicIds: ["M-T"], strictSelection: true, ownerId: "o1", podcastId: pod.id }, { db: prisma }),
      ]);
      const okers = [rA, rB].filter((r) => r.ok);
      assert(okers.length === 1, `exactly one manual pin build succeeds (got ${okers.length})`);
      await assertResultMatchesDb(prisma, okers[0]);
      const uses = await prisma.episodeTopic.count({ where: { topicId: "M-T" } });
      assert(uses === 1, `pinned M-T written exactly once, got ${uses}`);
      ok("manual concurrency unchanged: pinned reuse under exclude_podcast → exactly one succeeds");
    } catch (e) { bad("manual concurrency unchanged: pinned reuse under exclude_podcast → exactly one succeeds", e); }
  } finally {
    await prisma.$disconnect().catch(() => {});
    // Scoped stop: this instance only, reaping its own leftover children.
    await stopEmbeddedPgScoped(pg, dir).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
