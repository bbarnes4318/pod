// EXECUTED proof for the blind long-form voice audition.
//
// No network and no database. The TTS render, the acoustic analyzer and the
// object store are stubbed; persistence runs against the in-memory
// implementation of `VoiceAuditionStore` (the same port the Prisma store
// implements, including the blind projection). Postgres in this environment is
// a Coolify-internal host that is unreachable from here, which is precisely
// why the persistence layer is a port rather than a hard dependency.
//
// What must never regress:
//   1. A voter cannot reach provider / voiceId / model — not through the object
//      they are handed, not through its JSON, not through the audio URL.
//   2. The pack is the eight standard scenes and is long enough to expose
//      fatigue and identity drift.
//   3. Candidate settings, metrics, votes and the winner round-trip.
//   4. Choosing a winner does NOT change the production voice. Only an explicit,
//      attributed promotion does.
//   5. Rollback restores the previous voice, records the reversal, and is safe
//      to run twice.
//   6. The ordinary flow completes with no violations.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  AUDITION_DIMENSIONS,
  BALLOT_FORBIDDEN_KEYS,
  VOICE_AUDITION_POLICY_VERSION,
  VoiceAuditionError,
  addCandidate,
  assertBallotIsBlind,
  blindLabelFor,
  castVote,
  createAudition,
  createInMemoryVoiceAuditionStore,
  getBallots,
  listPromotionHistory,
  openVoting,
  promoteWinner,
  revealAudition,
  rollbackPromotion,
  selectWinner,
  tallyAudition,
  validateScores,
  type AuditionMetrics,
  type AuditionMetricsAnalyzer,
  type AuditionAudioStore,
  type AuditionRenderer,
  type AuditionScores,
  type HostVoiceRecord,
  type VoiceAuditionDeps,
} from "../lib/services/voiceAudition";
import {
  AUDITION_SCENES,
  AUDITION_SCENE_IDS,
  AUDITION_PACK_VERSION,
  MIN_AUDITION_CANDIDATE_WORDS,
  MIN_AUDITION_DURATION_SEC,
  MIN_AUDITION_TOTAL_WORDS,
  auditionWordCount,
  estimateAuditionDurationSec,
  validateAuditionPack,
} from "../lib/services/voiceAuditionScenes";

let failures = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL  ${name}\n        ${(error as Error).message}`);
    }
  })();
}

// ---------------------------------------------------------------------------
// Fixtures — no network, no ffmpeg, no storage.
// ---------------------------------------------------------------------------

const HOST_ID = "host-zabala";
const INCUMBENT = { provider: "fish", voiceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const CHALLENGER_A = { provider: "fish", voiceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
const CHALLENGER_B = { provider: "boson", voiceId: "cccccccccccccccccccccccccccccccc" };
const PARTNER = { provider: "fish", voiceId: "dddddddddddddddddddddddddddddddd" };

const ALL_SECRETS = [
  INCUMBENT.voiceId,
  CHALLENGER_A.voiceId,
  CHALLENGER_B.voiceId,
  PARTNER.voiceId,
  "boson",
];

function stubMetrics(seed: number): AuditionMetrics {
  return {
    performanceScore: 70 + seed,
    passed: true,
    failures: [],
    warnings: [],
    durationSec: 402 + seed,
    integratedLufs: -16.1,
    loudnessRangeLu: 5.4 + seed / 10,
    pauseStdDevSec: 0.31,
    longestPauseSec: 1.4,
    terminalFallRatio: 0.42,
    medianPhrasePitchRangeSemitones: 3.1,
    phraseEnergyCoefficientOfVariation: 0.37,
  };
}

let analyzeCalls = 0;
const stubRenderer: AuditionRenderer = {
  async render(input) {
    // Deterministic bytes that encode nothing about the voice — the render path
    // is exercised for its contract, not its audio.
    assert.equal(input.scenes.length, 8, "renderer must be handed the whole pack");
    assert.ok(input.partner.voiceId, "renderer must be handed the fixed partner voice");
    return {
      audioBuffer: Buffer.from(`audition:${input.scenes.length}:${input.candidate.provider}`),
      contentType: "audio/mpeg",
      model: input.candidate.model ?? "stub-model-v1",
      durationMs: 402_000,
    };
  },
};

const stubAnalyzer: AuditionMetricsAnalyzer = {
  async analyze(buffer, context) {
    analyzeCalls += 1;
    assert.ok(buffer.length > 0);
    assert.ok(context.turnCount > 0);
    return stubMetrics(analyzeCalls);
  },
};

function stubAudioStore(): AuditionAudioStore & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async put({ key }) {
      keys.push(key);
      return { url: `https://cdn.test.local/${key}`, key };
    },
  };
}

function makeDeps(hosts: HostVoiceRecord[] = [
  { id: HOST_ID, name: "Bernadette Zabala", provider: INCUMBENT.provider, voiceId: INCUMBENT.voiceId },
]) {
  const store = createInMemoryVoiceAuditionStore(hosts);
  const audio = stubAudioStore();
  let counter = 0;
  const deps: VoiceAuditionDeps = {
    store,
    renderer: stubRenderer,
    analyzer: stubAnalyzer,
    audio,
    newId: () => `id-${String(++counter).padStart(4, "0")}`,
  };
  return { deps, store, audio };
}

function scoresOf(value: number, overrides: Partial<AuditionScores> = {}): AuditionScores {
  const scores = {} as AuditionScores;
  for (const dimension of AUDITION_DIMENSIONS) scores[dimension] = value;
  return { ...scores, ...overrides };
}

/** Build a draft audition with three candidates and open voting on it. */
async function seedAudition(deps: VoiceAuditionDeps, ownerId = "user-producer") {
  const audition = await createAudition(deps, {
    ownerId,
    hostId: HOST_ID,
    title: "Zabala voice recast",
    notes: "Incumbent versus two challengers.",
  });
  const incumbent = await addCandidate(deps, {
    auditionId: audition.id,
    ...INCUMBENT,
    model: "s2.1-pro",
    privateLabel: "incumbent",
    settings: { temperature: 0.78, topP: 0.82, speed: 1, voiceDirection: "dry, exact, unimpressed" },
    partner: PARTNER,
  });
  const challengerA = await addCandidate(deps, {
    auditionId: audition.id,
    ...CHALLENGER_A,
    model: "s2.1-pro",
    privateLabel: "fish redesign",
    settings: { temperature: 0.84, topP: 0.88 },
    partner: PARTNER,
  });
  const challengerB = await addCandidate(deps, {
    auditionId: audition.id,
    ...CHALLENGER_B,
    model: "higgs-audio-v2",
    privateLabel: "boson alternative",
    settings: { temperature: 0.7 },
    partner: PARTNER,
  });
  const opened = await openVoting(deps, audition.id);
  return { audition: opened, incumbent, challengerA, challengerB };
}

// ---------------------------------------------------------------------------
// 1. BLINDNESS
// ---------------------------------------------------------------------------

async function testBlindness(): Promise<void> {
  console.log("\nBLINDNESS — identity is unreachable from the voting path");

  await check("the ballot object carries no provider, voice id or model", async () => {
    const { deps } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    assert.equal(ballots.length, 3);
    for (const ballot of ballots) {
      const keys = Object.keys(ballot);
      for (const forbidden of BALLOT_FORBIDDEN_KEYS) {
        assert.ok(!keys.includes(forbidden), `ballot exposes '${forbidden}'`);
      }
      assert.ok(ballot.ballotId && ballot.blindLabel && ballot.audioUrl);
    }
  });

  await check("JSON.stringify(ballot) contains no candidate voice id", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    const serialized = JSON.stringify(ballots);
    for (const secret of ALL_SECRETS) {
      assert.ok(!serialized.includes(secret), `serialized ballot leaks '${secret}'`);
    }
    // And the identities really are in the store — the test is not passing
    // because nothing was persisted.
    const candidates = await store.listCandidates(audition.id);
    assert.equal(candidates.length, 3);
    assert.ok(candidates.some((candidate) => candidate.voiceId === CHALLENGER_B.voiceId));
    assert.ok(candidates.some((candidate) => candidate.model === "higgs-audio-v2"));
  });

  await check("the blind store projection never reads the identity columns", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const rows = await store.listBallotProjections(audition.id);
    assert.equal(rows.length, 3);
    const serialized = JSON.stringify(rows);
    for (const secret of ALL_SECRETS) assert.ok(!serialized.includes(secret));
    for (const row of rows) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ["audioAssetUrl", "auditionId", "ballotId", "blindPosition", "durationMs", "renderError"]
      );
    }
  });

  await check("the audio URL is keyed by ballot id, not by voice id", async () => {
    const { deps, audio } = makeDeps();
    const { audition } = await seedAudition(deps);
    assert.equal(audio.keys.length, 3);
    for (const key of audio.keys) {
      for (const secret of ALL_SECRETS) assert.ok(!key.includes(secret), `object key leaks '${secret}'`);
      assert.ok(key.startsWith(`voice-auditions/${audition.id}/`));
    }
  });

  await check("the live tally stays blind while voting is open", async () => {
    const { deps } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    await castVote(deps, {
      auditionId: audition.id,
      ballotId: ballots[0].ballotId,
      voterId: "user-producer",
      scores: scoresOf(4),
      overall: 4,
    });
    const tally = await tallyAudition(deps, audition.id);
    const serialized = JSON.stringify(tally);
    for (const secret of ALL_SECRETS) assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes("candidateId"));
    assert.equal(tally.find((row) => row.ballotId === ballots[0].ballotId)?.voteCount, 1);
  });

  await check("ballot order is a seeded shuffle, not insertion order", async () => {
    // Over many auditions the first-entered candidate must not always be Voice A.
    let firstIsIncumbent = 0;
    const runs = 24;
    for (let run = 0; run < runs; run++) {
      const { deps, store } = makeDeps();
      const { audition, incumbent } = await seedAudition(deps);
      const candidates = await store.listCandidates(audition.id);
      const positioned = candidates.find((candidate) => candidate.id === incumbent.id);
      if (positioned?.blindPosition === 0) firstIsIncumbent += 1;
    }
    assert.ok(
      firstIsIncumbent > 0 && firstIsIncumbent < runs,
      `insertion order leaked: incumbent was Voice A ${firstIsIncumbent}/${runs} times`
    );
  });

  await check("the blindness guard rejects a payload that leaks identity", () => {
    assert.throws(
      () => assertBallotIsBlind([{ ballotId: "x", provider: "fish" }]),
      /Blindness violation/
    );
    assert.throws(
      () => assertBallotIsBlind([{ ballotId: "x", audioUrl: `https://cdn/${CHALLENGER_A.voiceId}.mp3` }], ALL_SECRETS),
      /Blindness violation/
    );
    assert.throws(
      () => assertBallotIsBlind({ nested: { deep: [{ voiceId: "leak" }] } }),
      /Blindness violation/
    );
  });

  await check("blind labels are stable and human-readable", () => {
    assert.equal(blindLabelFor(0), "Voice A");
    assert.equal(blindLabelFor(2), "Voice C");
    assert.equal(blindLabelFor(25), "Voice Z");
    assert.equal(blindLabelFor(26), "Voice AA");
  });
}

// ---------------------------------------------------------------------------
// 2. THE PACK
// ---------------------------------------------------------------------------

async function testScenePack(): Promise<void> {
  console.log("\nPACK — the eight standard scenes, long enough to expose fatigue");

  await check("exactly the eight named scenes, in order", () => {
    assert.deepEqual(
      AUDITION_SCENES.map((scene) => scene.id),
      [
        "cold_accusation",
        "amused_disbelief",
        "interruption",
        "restrained_concession",
        "factual_explanation",
        "genuine_anger",
        "quiet_kill_shot",
        "closing_reflection",
      ]
    );
    assert.equal(AUDITION_SCENES.length, 8);
    assert.equal(AUDITION_SCENE_IDS.length, 8);
  });

  await check("the pack validates and is fatigue-exposing", () => {
    const report = validateAuditionPack();
    assert.deepEqual(report.problems, []);
    assert.equal(report.ok, true);
    assert.ok(
      report.totalWords >= MIN_AUDITION_TOTAL_WORDS,
      `pack is only ${report.totalWords} words`
    );
    assert.ok(
      report.candidateWords >= MIN_AUDITION_CANDIDATE_WORDS,
      `candidate carries only ${report.candidateWords} words`
    );
    assert.ok(
      report.estimatedDurationSec >= MIN_AUDITION_DURATION_SEC,
      `pack is only ${report.estimatedDurationSec.toFixed(0)}s`
    );
    assert.ok(report.interruptionCount >= 1, "no interruption to score");
    console.log(
      `        ${report.totalWords} words total / ${report.candidateWords} candidate / ` +
      `~${(report.estimatedDurationSec / 60).toFixed(1)} min / ${report.turnCount} turns`
    );
  });

  await check("every scene gives the candidate something to perform", () => {
    for (const scene of AUDITION_SCENES) {
      assert.ok(scene.turns.some((turn) => turn.role === "candidate"), `${scene.id} has no candidate turn`);
      assert.ok(scene.turns.length >= 2, `${scene.id} is not a scene`);
      assert.ok(scene.direction.length > 20, `${scene.id} has no usable direction`);
      assert.ok(scene.listenFor.length > 20, `${scene.id} does not tell the listener what to judge`);
    }
    assert.ok(auditionWordCount("partner") > 100, "the partner must actually be in the room");
  });

  await check("a truncated pack is rejected", () => {
    const short = AUDITION_SCENES.slice(0, 3);
    const report = validateAuditionPack(short);
    assert.equal(report.ok, false);
    assert.ok(report.problems.some((problem) => /scenes/i.test(problem)));
    assert.ok(report.problems.some((problem) => /floor/i.test(problem)));
    assert.ok(estimateAuditionDurationSec(short) < MIN_AUDITION_DURATION_SEC);
  });

  await check("creating an audition on a bad pack fails loudly", async () => {
    const { deps, store } = makeDeps();
    await assert.rejects(
      () =>
        createAudition(
          { ...deps, scenes: AUDITION_SCENES.slice(0, 2) },
          { ownerId: "u", hostId: HOST_ID, title: "bad pack" }
        ),
      VoiceAuditionError
    );
    assert.equal((await store.listAuditions(null)).length, 0);
  });
}

// ---------------------------------------------------------------------------
// 3. PERSISTENCE
// ---------------------------------------------------------------------------

async function testPersistence(): Promise<void> {
  console.log("\nPERSISTENCE — settings, metrics, votes and the winner round-trip");

  await check("candidate identity, settings and metrics survive a round-trip", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const candidates = await store.listCandidates(audition.id);
    const boson = candidates.find((candidate) => candidate.provider === "boson");
    assert.ok(boson, "boson candidate missing");
    assert.equal(boson.voiceId, CHALLENGER_B.voiceId);
    assert.equal(boson.model, "higgs-audio-v2");
    assert.equal(boson.generationSettings?.temperature, 0.7);
    assert.equal(boson.privateLabel, "boson alternative");
    assert.equal(boson.audioContentType, "audio/mpeg");
    assert.equal(boson.audioBytes, Buffer.from("audition:8:boson").length);
    assert.equal(boson.durationMs, 402_000);
    assert.ok(boson.renderedAt instanceof Date);
    assert.equal(boson.renderError, null);
    assert.ok((boson.metrics?.performanceScore ?? 0) > 0);
    assert.equal(boson.metrics?.passed, true);
    assert.equal(typeof boson.metrics?.loudnessRangeLu, "number");

    const fish = candidates.find((candidate) => candidate.voiceId === INCUMBENT.voiceId);
    assert.equal(fish?.generationSettings?.voiceDirection, "dry, exact, unimpressed");
    assert.equal(audition.packVersion, AUDITION_PACK_VERSION);
    assert.equal(audition.policyVersion, VOICE_AUDITION_POLICY_VERSION);
    assert.equal(audition.packSceneIds.length, 8);
  });

  await check("votes round-trip on all eight dimensions plus overall", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    const cast = await castVote(deps, {
      auditionId: audition.id,
      ballotId: ballots[1].ballotId,
      voterId: "user-producer",
      voterLabel: "Producer",
      scores: scoresOf(3, { listenerFatigue: 5, interruptionQuality: 2, pairChemistry: 4 }),
      overall: 4,
      notes: "Tires less than the others but the cut-in is polite.",
    });
    const stored = (await store.listVotes(audition.id)).find((vote) => vote.id === cast.id);
    assert.ok(stored);
    for (const dimension of AUDITION_DIMENSIONS) {
      assert.equal(typeof stored.scores[dimension], "number", `${dimension} did not persist`);
    }
    assert.equal(stored.scores.listenerFatigue, 5);
    assert.equal(stored.scores.interruptionQuality, 2);
    assert.equal(stored.overall, 4);
    assert.equal(stored.voterLabel, "Producer");
    assert.equal(stored.notes, "Tires less than the others but the cut-in is polite.");
  });

  await check("re-voting replaces rather than duplicates", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    await castVote(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, voterId: "v1", scores: scoresOf(2), overall: 2 });
    await castVote(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, voterId: "v1", scores: scoresOf(5), overall: 5 });
    const votes = await store.listVotes(audition.id);
    assert.equal(votes.length, 1);
    assert.equal(votes[0].overall, 5);
  });

  await check("the tally averages every dimension across voters", async () => {
    const { deps } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    await castVote(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, voterId: "v1", scores: scoresOf(2), overall: 2 });
    await castVote(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, voterId: "v2", scores: scoresOf(4), overall: 4 });
    const row = (await tallyAudition(deps, audition.id)).find((entry) => entry.ballotId === ballots[0].ballotId);
    assert.ok(row);
    assert.equal(row.voteCount, 2);
    assert.equal(row.overallMean, 3);
    assert.equal(row.compositeMean, 3);
    assert.equal(row.dimensionMeans.characterFit, 3);
  });

  await check("the winner round-trips with who chose it and when", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    await selectWinner(deps, { auditionId: audition.id, ballotId: ballots[2].ballotId, actorId: "user-producer" });
    const reloaded = await store.getAudition(audition.id);
    assert.equal(reloaded?.status, "decided");
    assert.equal(reloaded?.winnerSelectedById, "user-producer");
    assert.ok(reloaded?.winnerSelectedAt instanceof Date);
    const winner = (await store.listCandidates(audition.id)).find((c) => c.id === reloaded?.winnerCandidateId);
    assert.equal(winner?.ballotId, ballots[2].ballotId);
  });

  await check("out-of-range and missing scores are refused", () => {
    assert.throws(() => validateScores({ ...scoresOf(3), characterFit: 9 }), /must be 1-5/);
    const partial = { ...scoresOf(3) } as Partial<AuditionScores>;
    delete partial.pairChemistry;
    assert.throws(() => validateScores(partial), /pairChemistry/);
  });

  await check("a foreign ballot id cannot be voted on", async () => {
    const { deps } = makeDeps();
    const { audition } = await seedAudition(deps);
    await assert.rejects(
      () => castVote(deps, { auditionId: audition.id, ballotId: crypto.randomBytes(16).toString("hex"), voterId: "v1", scores: scoresOf(3), overall: 3 }),
      /does not belong/
    );
  });
}

// ---------------------------------------------------------------------------
// 4. PROMOTION
// ---------------------------------------------------------------------------

async function testPromotion(): Promise<void> {
  console.log("\nPROMOTION — never implicit, always attributed");

  await check("selecting a winner does NOT change the production voice", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    await castVote(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, voterId: "v1", scores: scoresOf(5), overall: 5 });
    await selectWinner(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, actorId: "user-producer" });

    const host = await store.getHostVoice(HOST_ID);
    assert.equal(host?.voiceId, INCUMBENT.voiceId, "the winner was applied implicitly");
    assert.equal(host?.provider, INCUMBENT.provider);
    assert.equal(store.__hostWrites.length, 0, "something wrote to the host voice without a promotion");
    assert.equal((await store.listPromotions(HOST_ID)).length, 0);
  });

  await check("nothing in the flow up to reveal touches the host voice", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    for (const ballot of ballots) {
      await castVote(deps, { auditionId: audition.id, ballotId: ballot.ballotId, voterId: "v1", scores: scoresOf(4), overall: 4 });
    }
    await tallyAudition(deps, audition.id);
    await selectWinner(deps, { auditionId: audition.id, ballotId: ballots[1].ballotId, actorId: "user-producer" });
    await revealAudition(deps, { auditionId: audition.id, actorId: "user-producer" });
    assert.equal(store.__hostWrites.length, 0);
  });

  await check("promotion records who, when, from which audition, and the previous voice", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    // Pick whichever ballot is not the incumbent.
    const candidates = await store.listCandidates(audition.id);
    const challenger = candidates.find((candidate) => candidate.voiceId === CHALLENGER_A.voiceId)!;
    const ballot = ballots.find((entry) => entry.ballotId === challenger.ballotId)!;
    await selectWinner(deps, { auditionId: audition.id, ballotId: ballot.ballotId, actorId: "user-producer" });

    const { promotion, audition: after } = await promoteWinner(deps, {
      auditionId: audition.id,
      hostId: HOST_ID,
      acknowledgedBallotId: ballot.ballotId,
      actorId: "user-producer",
      actorLabel: "Braden (exec producer)",
      reason: "Won 3-0 on stamina and chemistry.",
    });

    assert.equal(promotion.kind, "promotion");
    assert.equal(promotion.hostId, HOST_ID);
    assert.equal(promotion.auditionId, audition.id);
    assert.equal(promotion.candidateId, challenger.id);
    assert.equal(promotion.actorId, "user-producer");
    assert.equal(promotion.actorLabel, "Braden (exec producer)");
    assert.ok(promotion.createdAt instanceof Date);
    assert.equal(promotion.fromVoiceId, INCUMBENT.voiceId, "previous voice not recorded — rollback would be impossible");
    assert.equal(promotion.fromProvider, INCUMBENT.provider);
    assert.equal(promotion.toVoiceId, CHALLENGER_A.voiceId);
    assert.equal(promotion.toModel, "s2.1-pro");
    assert.equal(promotion.status, "active");
    assert.equal(promotion.policyVersion, VOICE_AUDITION_POLICY_VERSION);
    assert.equal(after.status, "promoted");
    assert.ok(after.unblindedAt instanceof Date);

    const host = await store.getHostVoice(HOST_ID);
    assert.equal(host?.voiceId, CHALLENGER_A.voiceId);
    assert.equal(store.__hostWrites.length, 1);
  });

  await check("promotion refuses an unconfirmed or mismatched ballot", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    await selectWinner(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, actorId: "user-producer" });
    await assert.rejects(
      () => promoteWinner(deps, {
        auditionId: audition.id,
        acknowledgedBallotId: ballots[1].ballotId,
        actorId: "user-producer",
      }),
      /does not match the winning ballot/
    );
    assert.equal(store.__hostWrites.length, 0);
  });

  await check("promotion refuses an anonymous actor and a winnerless audition", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const ballots = await getBallots(deps, audition.id);
    await assert.rejects(
      () => promoteWinner(deps, { auditionId: audition.id, acknowledgedBallotId: ballots[0].ballotId, actorId: "x" }),
      /Nothing has won/
    );
    await selectWinner(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, actorId: "user-producer" });
    await assert.rejects(
      () => promoteWinner(deps, { auditionId: audition.id, acknowledgedBallotId: ballots[0].ballotId, actorId: "" }),
      /who performed it/
    );
    assert.equal(store.__hostWrites.length, 0);
  });

  await check("promoting the voice a host already uses is refused", async () => {
    const { deps, store } = makeDeps();
    const { audition } = await seedAudition(deps);
    const candidates = await store.listCandidates(audition.id);
    const incumbent = candidates.find((candidate) => candidate.voiceId === INCUMBENT.voiceId)!;
    await selectWinner(deps, { auditionId: audition.id, ballotId: incumbent.ballotId, actorId: "user-producer" });
    await assert.rejects(
      () => promoteWinner(deps, {
        auditionId: audition.id,
        acknowledgedBallotId: incumbent.ballotId,
        actorId: "user-producer",
      }),
      /already using this voice/
    );
    assert.equal(store.__hostWrites.length, 0);
  });

  await check("unblinding before a winner exists is refused", async () => {
    const { deps } = makeDeps();
    const { audition } = await seedAudition(deps);
    await assert.rejects(
      () => revealAudition(deps, { auditionId: audition.id, actorId: "user-producer" }),
      /Choose a winner before unblinding/
    );
  });
}

// ---------------------------------------------------------------------------
// 5. ROLLBACK
// ---------------------------------------------------------------------------

async function promoteChallenger(deps: VoiceAuditionDeps, store: ReturnType<typeof makeDeps>["store"]) {
  const { audition } = await seedAudition(deps);
  const candidates = await store.listCandidates(audition.id);
  const challenger = candidates.find((candidate) => candidate.voiceId === CHALLENGER_A.voiceId)!;
  await selectWinner(deps, { auditionId: audition.id, ballotId: challenger.ballotId, actorId: "user-producer" });
  const { promotion } = await promoteWinner(deps, {
    auditionId: audition.id,
    acknowledgedBallotId: challenger.ballotId,
    actorId: "user-producer",
    actorLabel: "Producer",
    reason: "Panel decision.",
  });
  return { audition, promotion };
}

async function testRollback(): Promise<void> {
  console.log("\nROLLBACK — the previous voice comes back, and the reversal is on the record");

  await check("rollback restores the previous voice", async () => {
    const { deps, store } = makeDeps();
    const { promotion } = await promoteChallenger(deps, store);
    assert.equal((await store.getHostVoice(HOST_ID))?.voiceId, CHALLENGER_A.voiceId);

    const result = await rollbackPromotion(deps, {
      promotionId: promotion.id,
      actorId: "user-producer",
      actorLabel: "Producer",
      reason: "Listeners hated it.",
    });
    assert.equal(result.alreadyRolledBack, false);
    assert.equal(result.restored?.voiceId, INCUMBENT.voiceId);
    assert.equal(result.restored?.provider, INCUMBENT.provider);
    const host = await store.getHostVoice(HOST_ID);
    assert.equal(host?.voiceId, INCUMBENT.voiceId);
    assert.equal(host?.provider, INCUMBENT.provider);
  });

  await check("the reversal is recorded and linked to the promotion it undoes", async () => {
    const { deps, store } = makeDeps();
    const { promotion } = await promoteChallenger(deps, store);
    const result = await rollbackPromotion(deps, {
      promotionId: promotion.id,
      actorId: "user-ops",
      actorLabel: "Ops",
      reason: "Emergency revert.",
    });

    assert.equal(result.promotion.status, "rolled_back");
    assert.equal(result.promotion.rolledBackById, "user-ops");
    assert.ok(result.promotion.rolledBackAt instanceof Date);
    assert.equal(result.promotion.rolledBackReason, "Emergency revert.");

    const reversal = result.reversal!;
    assert.equal(reversal.kind, "rollback");
    assert.equal(reversal.status, "reversal");
    assert.equal(reversal.revertsPromotionId, promotion.id);
    assert.equal(reversal.fromVoiceId, CHALLENGER_A.voiceId);
    assert.equal(reversal.toVoiceId, INCUMBENT.voiceId);
    assert.equal(reversal.actorId, "user-ops");
    assert.equal(reversal.auditionId, promotion.auditionId);

    const history = await listPromotionHistory(deps, HOST_ID);
    assert.equal(history.length, 2, "history must keep both the promotion and its reversal");
    assert.deepEqual(new Set(history.map((row) => row.kind)), new Set(["promotion", "rollback"]));
  });

  await check("rolling back twice is safe", async () => {
    const { deps, store } = makeDeps();
    const { promotion } = await promoteChallenger(deps, store);
    await rollbackPromotion(deps, { promotionId: promotion.id, actorId: "user-ops" });
    const writesAfterFirst = store.__hostWrites.length;
    const historyAfterFirst = (await store.listPromotions(HOST_ID)).length;

    const second = await rollbackPromotion(deps, { promotionId: promotion.id, actorId: "user-ops" });
    assert.equal(second.alreadyRolledBack, true);
    assert.equal(second.reversal, null);
    assert.equal(second.restored, null);
    assert.equal(store.__hostWrites.length, writesAfterFirst, "second rollback wrote to the host voice");
    assert.equal((await store.listPromotions(HOST_ID)).length, historyAfterFirst, "second rollback duplicated history");
    assert.equal((await store.getHostVoice(HOST_ID))?.voiceId, INCUMBENT.voiceId);
  });

  await check("a reversal row cannot itself be rolled back", async () => {
    const { deps, store } = makeDeps();
    const { promotion } = await promoteChallenger(deps, store);
    const result = await rollbackPromotion(deps, { promotionId: promotion.id, actorId: "user-ops" });
    await assert.rejects(
      () => rollbackPromotion(deps, { promotionId: result.reversal!.id, actorId: "user-ops" }),
      /itself a reversal/
    );
  });

  await check("an older promotion cannot be unwound past a newer live one", async () => {
    const { deps, store } = makeDeps();
    const first = await promoteChallenger(deps, store);

    // A second audition promotes a different voice on the same host.
    const second = await createAudition(deps, { ownerId: "user-producer", hostId: HOST_ID, title: "Second pass" });
    await addCandidate(deps, { auditionId: second.id, ...CHALLENGER_B, partner: PARTNER });
    await addCandidate(deps, { auditionId: second.id, ...INCUMBENT, partner: PARTNER });
    await openVoting(deps, second.id);
    const secondCandidates = await store.listCandidates(second.id);
    const target = secondCandidates.find((candidate) => candidate.voiceId === CHALLENGER_B.voiceId)!;
    await selectWinner(deps, { auditionId: second.id, ballotId: target.ballotId, actorId: "user-producer" });
    await promoteWinner(deps, {
      auditionId: second.id,
      acknowledgedBallotId: target.ballotId,
      actorId: "user-producer",
    });

    await assert.rejects(
      () => rollbackPromotion(deps, { promotionId: first.promotion.id, actorId: "user-ops" }),
      /newer promotion is live/
    );
    assert.equal((await store.getHostVoice(HOST_ID))?.voiceId, CHALLENGER_B.voiceId);
  });

  await check("rollback requires an actor", async () => {
    const { deps, store } = makeDeps();
    const { promotion } = await promoteChallenger(deps, store);
    await assert.rejects(
      () => rollbackPromotion(deps, { promotionId: promotion.id, actorId: "" }),
      /who performed it/
    );
    assert.equal((await store.getHostVoice(HOST_ID))?.voiceId, CHALLENGER_A.voiceId);
  });
}

// ---------------------------------------------------------------------------
// 6. CONTROL
// ---------------------------------------------------------------------------

async function testControlFlow(): Promise<void> {
  console.log("\nCONTROL — an ordinary audition completes with no violations");

  await check("create → render → vote → decide → reveal → promote → roll back", async () => {
    const { deps, store, audio } = makeDeps();

    const audition = await createAudition(deps, {
      ownerId: "user-producer",
      hostId: HOST_ID,
      title: "Season 3 voice check",
      notes: "Routine recast review.",
    });
    assert.equal(audition.status, "draft");

    for (const voice of [INCUMBENT, CHALLENGER_A, CHALLENGER_B]) {
      await addCandidate(deps, { auditionId: audition.id, ...voice, partner: PARTNER });
    }
    assert.equal(audio.keys.length, 3);

    await openVoting(deps, audition.id);
    // A late entry after the field is locked must be refused.
    await assert.rejects(
      () => addCandidate(deps, { auditionId: audition.id, provider: "fish", voiceId: "ffffffffffffffffffffffffffffffff", partner: PARTNER }),
      /still a draft/
    );

    const ballots = await getBallots(deps, audition.id);
    assert.equal(ballots.length, 3);
    assert.ok(ballots.every((ballot) => ballot.ready));
    assert.deepEqual(ballots.map((ballot) => ballot.blindLabel), ["Voice A", "Voice B", "Voice C"]);

    // Two listeners, independently. The third ballot wins on stamina.
    for (const voter of ["user-producer", "user-editor"]) {
      await castVote(deps, { auditionId: audition.id, ballotId: ballots[0].ballotId, voterId: voter, scores: scoresOf(3), overall: 3 });
      await castVote(deps, { auditionId: audition.id, ballotId: ballots[1].ballotId, voterId: voter, scores: scoresOf(2), overall: 2 });
      await castVote(deps, { auditionId: audition.id, ballotId: ballots[2].ballotId, voterId: voter, scores: scoresOf(5), overall: 5 });
    }

    const tally = await tallyAudition(deps, audition.id);
    const leader = [...tally].sort((left, right) => (right.overallMean ?? 0) - (left.overallMean ?? 0))[0];
    assert.equal(leader.ballotId, ballots[2].ballotId);
    assert.equal(leader.voteCount, 2);
    assert.equal(store.__hostWrites.length, 0, "voting must not touch the production voice");

    await selectWinner(deps, { auditionId: audition.id, ballotId: leader.ballotId, actorId: "user-producer" });
    const revealed = await revealAudition(deps, { auditionId: audition.id, actorId: "user-producer" });
    const winner = revealed.candidates.find((candidate) => candidate.isWinner)!;
    assert.ok(winner.voiceId, "reveal must show the identity");
    assert.equal(revealed.candidates.filter((candidate) => candidate.isWinner).length, 1);
    assert.equal(store.__hostWrites.length, 0, "reveal must not touch the production voice");

    if (winner.voiceId === INCUMBENT.voiceId) {
      // The incumbent won. Nothing to promote, and the system must say so.
      await assert.rejects(
        () => promoteWinner(deps, { auditionId: audition.id, acknowledgedBallotId: winner.ballotId, actorId: "user-producer" }),
        /already using this voice/
      );
      assert.equal(store.__hostWrites.length, 0);
      return;
    }

    const { promotion } = await promoteWinner(deps, {
      auditionId: audition.id,
      acknowledgedBallotId: winner.ballotId,
      actorId: "user-producer",
      actorLabel: "Producer",
      reason: "Unanimous on stamina.",
    });
    assert.equal((await store.getHostVoice(HOST_ID))?.voiceId, winner.voiceId);

    const rolled = await rollbackPromotion(deps, { promotionId: promotion.id, actorId: "user-producer", reason: "Second thoughts." });
    assert.equal(rolled.restored?.voiceId, INCUMBENT.voiceId);
    assert.equal((await store.getHostVoice(HOST_ID))?.voiceId, INCUMBENT.voiceId);
    assert.equal((await listPromotionHistory(deps, HOST_ID)).length, 2);
  });

  await check("a render failure keeps the candidate out of the field without losing the record", async () => {
    const { deps, store } = makeDeps();
    const failing: AuditionRenderer = {
      async render(input) {
        if (input.candidate.voiceId === CHALLENGER_B.voiceId) throw new Error("provider timed out");
        return stubRenderer.render(input);
      },
    };
    const failDeps: VoiceAuditionDeps = { ...deps, renderer: failing };
    const audition = await createAudition(failDeps, { ownerId: "u", hostId: HOST_ID, title: "Flaky render" });
    for (const voice of [INCUMBENT, CHALLENGER_A, CHALLENGER_B]) {
      await addCandidate(failDeps, { auditionId: audition.id, ...voice, partner: PARTNER });
    }
    const broken = (await store.listCandidates(audition.id)).find((c) => c.voiceId === CHALLENGER_B.voiceId);
    assert.equal(broken?.renderError, "provider timed out");
    assert.equal(broken?.audioAssetUrl, null);

    await openVoting(failDeps, audition.id);
    const ballots = await getBallots(failDeps, audition.id);
    assert.equal(ballots.length, 3);
    assert.equal(ballots.filter((ballot) => ballot.ready).length, 2);
    assert.ok(ballots.some((ballot) => ballot.problem === "provider timed out"));
    assert.ok(!JSON.stringify(ballots).includes(CHALLENGER_B.voiceId));
  });

  await check("a one-candidate audition cannot open for voting", async () => {
    const { deps } = makeDeps();
    const audition = await createAudition(deps, { ownerId: "u", hostId: HOST_ID, title: "Solo" });
    await addCandidate(deps, { auditionId: audition.id, ...CHALLENGER_A, partner: PARTNER });
    await assert.rejects(() => openVoting(deps, audition.id), /at least two candidates/);
  });

  await check("every candidate must face the same scene partner", async () => {
    const { deps, store } = makeDeps();
    const audition = await createAudition(deps, { ownerId: "u", hostId: HOST_ID, title: "Partner drift" });
    await addCandidate(deps, { auditionId: audition.id, ...CHALLENGER_A, partner: PARTNER });
    await assert.rejects(
      () => addCandidate(deps, {
        auditionId: audition.id,
        ...CHALLENGER_B,
        partner: { provider: "fish", voiceId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" },
      }),
      /same scene partner/
    );
    // The partner actually used is recorded as provenance on the candidate.
    const stored = await store.listCandidates(audition.id);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].generationSettings?.partnerVoiceId, PARTNER.voiceId);
  });

  await check("a voice cannot audition against itself", async () => {
    const { deps } = makeDeps();
    const audition = await createAudition(deps, { ownerId: "u", hostId: HOST_ID, title: "Self" });
    await assert.rejects(
      () => addCandidate(deps, { auditionId: audition.id, ...PARTNER, partner: PARTNER }),
      /against itself/
    );
  });

  await check("the same voice cannot be entered twice", async () => {
    const { deps } = makeDeps();
    const audition = await createAudition(deps, { ownerId: "u", hostId: HOST_ID, title: "Dupes" });
    await addCandidate(deps, { auditionId: audition.id, ...CHALLENGER_A, partner: PARTNER });
    await assert.rejects(
      () => addCandidate(deps, { auditionId: audition.id, ...CHALLENGER_A, partner: PARTNER }),
      /already entered/
    );
  });
}

async function main(): Promise<void> {
  console.log("Blind long-form voice audition — executed proof (no network, no database)\n");
  await testBlindness();
  await testScenePack();
  await testPersistence();
  await testPromotion();
  await testRollback();
  await testControlFlow();

  console.log(`\n${failures === 0 ? "ALL VOICE AUDITION CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
