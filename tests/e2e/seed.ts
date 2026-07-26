/* eslint-disable @typescript-eslint/no-explicit-any -- e2e seed uses dynamic payloads */
// Deterministic seed for the Studio rundown E2E harness. NO external LLM/TTS/
// research/payment calls — pure DB rows. Seeds two users (A owns everything; B
// owns a private host used to prove hosts are hidden), a saved podcast with
// host + segment-count settings, approved topics with research briefs, one
// pending + one out-of-vertical topic, and one prior use so "used by this show"
// shows.

import type { PrismaClient } from "@prisma/client";

/** Titles/names for the owner-isolation fixtures. Exported so specs assert on
 *  the exact string a leak would render, not on a row count. */
export const FOREIGN_PODCAST_NAME = "Someone Else's Show (must stay hidden)";
export const LEGACY_PODCAST_NAME = "Legacy Unowned Show (must stay hidden)";
export const FOREIGN_EPISODE_TITLE = "Someone Else's Episode (must stay hidden)";
export const LEGACY_EPISODE_TITLE = "Legacy Unowned Episode (must stay hidden)";

export const E2E = {
  userA: { id: "e2e-user-a", email: "e2e@studio.test", password: "test1234" },
  userB: { id: "e2e-user-b", email: "e2e-b@studio.test", password: "test1234" },
  /** Podcast A: full defaults (NFL vertical, 2 teams, 2 hosts, 4 segments). */
  podcastId: "e2e-pod",
  /** Podcast B: deliberately EMPTY verticals/teams/hosts + different count. */
  podcastBId: "e2e-pod-b",
  /** Owner-isolation fixtures — never visible to userA. */
  podcastForeignId: "e2e-pod-foreign",
  podcastLegacyId: "e2e-pod-legacy",
  episodeForeignId: "e2e-ep-foreign",
  episodeLegacyId: "e2e-ep-legacy",
  /** Parked at the human checkpoint: script_draft, awaiting approval. */
  episodeAwaitingApprovalId: "e2e-ep-awaiting",
  hostAce: "e2e-host-ace",
  hostBlaze: "e2e-host-blaze",
  hostCoach: "e2e-host-coach",
  hostPrivB: "e2e-host-privb",
  teamChiefsId: "E2EKC",
  teamChiefsName: "Kansas City Chiefs",
  teamEaglesId: "E2EPHI",
  teamEaglesName: "Philadelphia Eagles",
  topics: {
    lead: "e2e-t-lead", two: "e2e-t-two", three: "e2e-t-three", four: "e2e-t-four",
    nba: "e2e-t-nba", pending: "e2e-t-pending",
    /** Approved + fully researched, but scored BELOW the automatic debate floor.
     *  The auto-picker skips it; a producer must still SEE and be able to pick
     *  it manually. Scored under the floor on purpose so it can never enter
     *  automatic selection and perturb the automatic/hybrid expectations. */
    lowScore: "e2e-t-lowscore",
    /** Approved with a brief but NO evidence — must be blocked with the precise
     *  evidence reason, never a vague or score-shaped one. */
    noEvidence: "e2e-t-noevidence",
    /** Approved, awaiting research (no brief) — the admin "start research" path. */
    needsResearch: "e2e-t-needsresearch",
  },
  admin: { username: "e2e-admin", password: "e2e-admin-password-000" },
};

function brief(over: any = {}) {
  return {
    facts: [{ text: "A grounded, sourced fact about the matchup." }],
    stats: [{ text: "42% conversion on 3rd down." }],
    sourceIds: [{ type: "newsItem", id: "n1" }],
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
      debateScore: over.debateScore ?? 90,
      evidenceIds: over.evidenceIds ?? [{ type: "newsItem", id: "n1" }],
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

  // ---- Admin-board fixtures --------------------------------------------------
  // Both are scored BELOW the automatic debate floor (70) on purpose: the
  // automatic picker can never choose them, so they cannot disturb the existing
  // automatic/hybrid expectations, while still proving what Admin must show.
  await topic(prisma, E2E.topics.lowScore, "Low-scoring but genuinely worth arguing", { debateScore: 40 });
  await topic(prisma, E2E.topics.noEvidence, "Hot take with nothing behind it", { debateScore: 45, evidenceIds: [] });
  await topic(prisma, E2E.topics.needsResearch, "Approved, not yet researched", { debateScore: 42, withBrief: false });

  // One prior use by the podcast so "used by this show" surfaces on a card.
  const ep = await prisma.episode.create({ data: { title: "Prior show", slug: "e2e-prior", status: "published", rssGuid: "e2e-guid", ownerId: E2E.userA.id, podcastId: E2E.podcastId, hostIds: [E2E.hostAce, E2E.hostBlaze] } as any });
  await prisma.episodeTopic.create({ data: { episodeId: ep.id, topicId: E2E.topics.four, orderIndex: 0, selectedAt: new Date() } as any });

  // ---- Owner-isolation fixtures (D-02) --------------------------------------
  // Rows the signed-in user (A) must NEVER see or reach: one owned by another
  // account, and one LEGACY row with ownerId=null. The legacy case is the one
  // that actually leaked in production — every surface OR'd `{ownerId: null}`
  // into its filter, so a brand-new signup was shown (and could edit) the
  // operator's entire back catalogue. Titles are distinctive so a test can
  // assert on exact text rather than counts.
  await prisma.podcast.create({
    data: {
      id: E2E.podcastForeignId, name: FOREIGN_PODCAST_NAME, cadence: "one_time", ownerId: E2E.userB.id,
      verticals: ["NFL"], teams: [], segmentCount: 2, hostIds: [],
    } as any,
  });
  await prisma.podcast.create({
    data: {
      id: E2E.podcastLegacyId, name: LEGACY_PODCAST_NAME, cadence: "one_time", ownerId: null,
      verticals: ["NFL"], teams: [], segmentCount: 2, hostIds: [],
    } as any,
  });
  await prisma.episode.create({
    data: { id: E2E.episodeForeignId, title: FOREIGN_EPISODE_TITLE, slug: "e2e-foreign", status: "audio_ready", audioUrl: "https://example.invalid/foreign.mp3", durationSeconds: 120, ownerId: E2E.userB.id, hostIds: [] } as any,
  });
  await prisma.episode.create({
    data: { id: E2E.episodeLegacyId, title: LEGACY_EPISODE_TITLE, slug: "e2e-legacy", status: "audio_ready", audioUrl: "https://example.invalid/legacy.mp3", durationSeconds: 120, ownerId: null, hostIds: [] } as any,
  });

  // ---- Approval-checkpoint fixture (D-01) -----------------------------------
  // An episode parked at exactly the point the customer run died: script_draft,
  // waiting on the human checkpoint. The script is deliberately built to PASS
  // the approval gates (>= 40 lines, both chairs above the 25% floor, every
  // speakerName/speakerHostId resolving to the cast) so the test exercises the
  // success path rather than a validation refusal.
  await prisma.episode.create({
    data: {
      id: E2E.episodeAwaitingApprovalId, title: "Awaiting your read", slug: "e2e-awaiting-approval",
      status: "script_draft", ownerId: E2E.userA.id, podcastId: E2E.podcastId,
      hostIds: [E2E.hostAce, E2E.hostBlaze],
    } as any,
  });
  const lines = Array.from({ length: 48 }, (_, i) => {
    const ace = i % 2 === 0;
    return {
      lineIndex: i,
      speakerName: ace ? "Ace" : "Blaze",
      speakerHostId: ace ? E2E.hostAce : E2E.hostBlaze,
      text: `Approvable line ${i + 1}. This is ordinary opinion, not a factual claim.`,
      tone: "neutral",
      isFactualClaim: false,
      needsHumanReview: false,
      evidenceRefs: [] as string[],
    };
  });
  await prisma.script.create({
    data: {
      episodeId: E2E.episodeAwaitingApprovalId,
      version: 1,
      status: "draft",
      content: { segments: [{ type: "debate", title: "The argument", lines }] } as any,
      plainText: lines.map((l) => `${l.speakerName}:\n${l.text}`).join("\n\n"),
    } as any,
  });
}
