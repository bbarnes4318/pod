/* eslint-disable @typescript-eslint/no-explicit-any -- e2e seed uses dynamic payloads */
// Deterministic seed for the Studio rundown E2E harness. NO external LLM/TTS/
// research/payment calls — pure DB rows. Seeds two users (A owns everything; B
// owns a private host used to prove hosts are hidden), a saved podcast with
// host + segment-count settings, approved topics with research briefs, one
// pending + one out-of-vertical topic, and one prior use so "used by this show"
// shows.

import type { PrismaClient } from "@prisma/client";

export const E2E = {
  userA: { id: "e2e-user-a", email: "e2e@studio.test", password: "test1234" },
  userB: { id: "e2e-user-b", email: "e2e-b@studio.test", password: "test1234" },
  /** Podcast A: full defaults (NFL vertical, 2 teams, 2 hosts, 4 segments). */
  podcastId: "e2e-pod",
  /** Podcast B: deliberately EMPTY verticals/teams/hosts + different count. */
  podcastBId: "e2e-pod-b",
  hostAce: "e2e-host-ace",
  hostBlaze: "e2e-host-blaze",
  hostCoach: "e2e-host-coach",
  hostPrivB: "e2e-host-privb",
  teamChiefsId: "E2EKC",
  teamChiefsName: "Kansas City Chiefs",
  teamEaglesId: "E2EPHI",
  teamEaglesName: "Philadelphia Eagles",
  topics: { lead: "e2e-t-lead", two: "e2e-t-two", three: "e2e-t-three", four: "e2e-t-four", nba: "e2e-t-nba", pending: "e2e-t-pending" },
};

function brief(over: any = {}) {
  return {
    facts: [{ text: "A grounded, sourced fact about the matchup." }],
    stats: [{ text: "42% conversion on 3rd down." }],
    sourceIds: [{ type: "news", id: "n1" }],
    argumentForHostA: "The offense carried the day.",
    argumentForHostB: "No — the defense won it.",
    counterArguments: [], unsafeClaims: [],
    mainAngle: "Who really decided the game?",
    contrarianAngle: "It was special teams all along.",
    whyMattersNow: "Playoff seeding is on the line this week.",
    onAirTalkingPoints: ["The 4th-quarter collapse", "The coaching decision"],
    keyFactsContext: [{ text: "Down 10 with 5 minutes left." }],
    strongestDebateQuestion: "Was it the QB or the play-calling?",
    ...over,
  };
}

async function topic(prisma: PrismaClient, id: string, title: string, over: any = {}) {
  const withBrief = over.withBrief !== false;
  delete over.withBrief;
  await prisma.topicCandidate.create({
    data: {
      id, title, sport: over.sport ?? "NFL", leagueId: null,
      summary: over.summary ?? "A genuinely argue-worthy debate from last night's game.",
      controversyScore: 80, starPowerScore: 70, bettingRelevanceScore: 40, recencyScore: 85,
      debateScore: over.debateScore ?? 90, evidenceIds: [{ type: "news", id: "n1" }],
      status: over.status ?? "approved",
      ...(withBrief ? { researchBrief: { create: brief(over.brief) } } : {}),
    } as any,
  });
}

export async function seed(prisma: PrismaClient, bcrypt: { hashSync: (s: string, n: number) => string }) {
  const hash = bcrypt.hashSync("test1234", 8);
  for (const u of [E2E.userA, E2E.userB]) {
    await prisma.user.create({ data: { id: u.id, email: u.email, name: u.email.split("@")[0], passwordHash: hash, role: "USER", plan: "pro" } });
  }
  const mkHost = (id: string, name: string, ownerId: string | null) => ({
    id, name, slug: id, role: "analyst", worldview: "data-driven", speakingStyle: "punchy",
    catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [],
    ttsProvider: "stub", ttsVoiceId: "v", intensityLevel: 8, isActive: true, ownerId,
  });
  await prisma.aiHost.create({ data: mkHost(E2E.hostAce, "Ace", E2E.userA.id) as any });
  await prisma.aiHost.create({ data: mkHost(E2E.hostBlaze, "Blaze", E2E.userA.id) as any });
  await prisma.aiHost.create({ data: mkHost(E2E.hostCoach, "Coach", E2E.userA.id) as any });
  await prisma.aiHost.create({ data: mkHost(E2E.hostPrivB, "Zed (B private)", E2E.userB.id) as any });

  // League + Teams so Podcast.teams (IDs) can resolve to real NAMES.
  await prisma.league.create({ data: { id: "E2ENFL", name: "E2E Football", sport: "NFL", slug: "e2e-nfl" } as any });
  await prisma.team.create({ data: { id: E2E.teamChiefsId, leagueId: "E2ENFL", name: E2E.teamChiefsName, city: "Kansas City", abbreviation: "KC", slug: "e2e-kc" } as any });
  await prisma.team.create({ data: { id: E2E.teamEaglesId, leagueId: "E2ENFL", name: E2E.teamEaglesName, city: "Philadelphia", abbreviation: "PHI", slug: "e2e-phi" } as any });

  // Podcast A — full defaults.
  await prisma.podcast.create({
    data: {
      id: E2E.podcastId, name: "The Overtime Show", cadence: "recurring", ownerId: E2E.userA.id,
      verticals: ["NFL"], teams: [E2E.teamChiefsId, E2E.teamEaglesId], segmentCount: 4,
      hostIds: [E2E.hostAce, E2E.hostBlaze],
    } as any,
  });
  // Podcast B — deliberately EMPTY verticals/teams/hosts, different count. Used
  // to prove a switch clears stale inherited values.
  await prisma.podcast.create({
    data: {
      id: E2E.podcastBId, name: "Bare Bones Pod", cadence: "one_time", ownerId: E2E.userA.id,
      verticals: [], teams: [], segmentCount: 2, hostIds: [],
    } as any,
  });

  await topic(prisma, E2E.topics.lead, "Did the refs decide the title game?", { debateScore: 99 });
  await topic(prisma, E2E.topics.two, "Is the MVP race already over?", { debateScore: 95 });
  await topic(prisma, E2E.topics.three, "Trade deadline: buyers or sellers?", { debateScore: 92 });
  await topic(prisma, E2E.topics.four, "Rookie of the year: lock or upset?", { debateScore: 88 });
  await topic(prisma, E2E.topics.nba, "NBA: superteam or bust?", { sport: "NBA", debateScore: 96 });
  await topic(prisma, E2E.topics.pending, "Unvetted rumor (pending review)", { status: "pending" });

  // One prior use by the podcast so "used by this show" surfaces on a card.
  const ep = await prisma.episode.create({ data: { title: "Prior show", slug: "e2e-prior", status: "published", rssGuid: "e2e-guid", ownerId: E2E.userA.id, podcastId: E2E.podcastId, hostIds: [E2E.hostAce, E2E.hostBlaze] } as any });
  await prisma.episodeTopic.create({ data: { episodeId: ep.id, topicId: E2E.topics.four, orderIndex: 0, selectedAt: new Date() } as any });
}
