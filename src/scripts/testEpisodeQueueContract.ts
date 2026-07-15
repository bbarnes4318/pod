// Queue-payload contract test (item 2). Run: npm run test:queue-contract
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: the queue
   boundary is monkeypatched and a sample voice-overrides literal is loosely
   typed. */
//
// Proves the EpisodeBuildInput -> EpisodeBuildJobData mapper forwards EVERY
// supported field (nothing hand-dropped), and that an actual admin-style
// enqueue carries podcastId / ownerId / verticals / leagues / teams /
// reuseOverride through to the queued job. Redis is mocked at the queue
// boundary (podcastQueue.add) — the creation service is NOT faked.

process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

import {
  toEpisodeBuildJobData,
  queueEpisodeBuildJob,
  EPISODE_BUILD_JOB_FIELDS,
  podcastQueue,
  type EpisodeBuildJobData,
} from "../lib/queue/podcastQueue";
import type { EpisodeBuildInput } from "../lib/services/episodeService";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

// A fully-populated input — one sentinel value per supported field.
const FULL_INPUT: EpisodeBuildInput = {
  title: "T",
  description: "D",
  topicIds: ["t1", "t2"],
  leagueId: "NFL",
  sport: "football",
  targetTopicCount: 3,
  minDebateScore: 55,
  podcastId: "pod-1",
  ownerId: "owner-1",
  leagueIds: ["NFL", "NBA"],
  verticals: ["NFL", "Gambling"],
  teamNames: ["Chiefs", "Eagles"],
  hostIds: ["h1", "h2"],
  ttsProvider: "elevenlabs",
  ttsVoiceOverrides: { "max-voltage": { provider: "elevenlabs", voiceId: "v1" } } as any,
  productionStyle: "full",
  sfxDensity: "hype",
  reuseOverride: true,
};

async function run() {
  console.log("Episode queue-payload contract:");

  await check("mapper forwards EVERY supported field with the exact value", () => {
    const out = toEpisodeBuildJobData(FULL_INPUT) as Record<string, unknown>;
    for (const field of EPISODE_BUILD_JOB_FIELDS) {
      assert(field in out, `mapper dropped supported field '${field}'`);
      assert(
        JSON.stringify(out[field]) === JSON.stringify((FULL_INPUT as Record<string, unknown>)[field]),
        `field '${field}' value changed in mapping`
      );
    }
    // The accepted input's keys and the mapped keys agree — no silent omission.
    const inputKeys = Object.keys(FULL_INPUT).sort();
    const outKeys = Object.keys(out).sort();
    assert(JSON.stringify(inputKeys) === JSON.stringify(outKeys), `key sets differ: in=${inputKeys} out=${outKeys}`);
  });

  await check("mapper omits undefined fields (stable payload)", () => {
    const out = toEpisodeBuildJobData({ ownerId: "o", podcastId: "p" }) as Record<string, unknown>;
    assert(Object.keys(out).sort().join(",") === "ownerId,podcastId", `only defined fields kept; got ${Object.keys(out)}`);
  });

  await check("actual admin-style enqueue carries podcastId/ownerId/verticals/leagues/teams/reuseOverride", async () => {
    // Mock ONLY the queue boundary — capture what would be enqueued.
    let captured: EpisodeBuildJobData | null = null;
    const realAdd = podcastQueue.add.bind(podcastQueue);
    (podcastQueue as any).add = async (_name: string, data: EpisodeBuildJobData) => {
      captured = data;
      return { id: "job-test" };
    };
    try {
      // The exact call triggerEpisodeBuild makes.
      await queueEpisodeBuildJob(toEpisodeBuildJobData(FULL_INPUT));
    } finally {
      (podcastQueue as any).add = realAdd;
    }
    assert(captured !== null, "job was enqueued");
    const c = captured! as EpisodeBuildJobData;
    assert(c.podcastId === "pod-1", "podcastId forwarded");
    assert(c.ownerId === "owner-1", "ownerId forwarded");
    assert(JSON.stringify(c.verticals) === JSON.stringify(["NFL", "Gambling"]), "verticals forwarded");
    assert(JSON.stringify(c.leagueIds) === JSON.stringify(["NFL", "NBA"]), "leagueIds forwarded");
    assert(JSON.stringify(c.teamNames) === JSON.stringify(["Chiefs", "Eagles"]), "teamNames forwarded");
    assert(c.reuseOverride === true, "reuseOverride forwarded");
    // exclude_podcast will key off THIS podcastId downstream.
    assert(c.podcastId === FULL_INPUT.podcastId, "exclude_podcast will use the correct podcast");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  // The BullMQ/ioredis client holds the event loop open; exit explicitly.
  process.exit(failed > 0 ? 1 : 0);
}
run().catch((e) => { console.error("FATAL", e); process.exit(1); });
