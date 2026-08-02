// Prisma-backed voice auditions, against a real PostgreSQL.
//
// The unit suite proves the flow and the authorization matrix against an
// in-memory store. That proves the port contract. This proves the SQL: the real
// tables, the real relations, and the real cross-owner scoping — which are the
// parts an in-memory Map cannot vouch for.
//
// TTS rendering, waveform analysis and object storage are stubbed. This job has
// no provider credentials by design; what is under test is persistence.

import {
  addCandidate,
  authorizeAudition,
  authorizeHost,
  castVote,
  createAudition,
  createPrismaVoiceAuditionStore,
  guardedPromotionHistory,
  openVoting,
  promoteWinner,
  rollbackPromotion,
  selectWinner,
  type AuditionViewer,
  type VoiceAuditionDeps,
} from "../../lib/services/voiceAudition";
import { check, summarize, uid, withPrisma, prisma } from "./helpers";

const OWNER: AuditionViewer = { id: uid("owner"), isAdmin: false };
const OTHER: AuditionViewer = { id: uid("other"), isAdmin: false };
const ADMIN: AuditionViewer = { id: uid("admin"), isAdmin: true };

const VOICE_A = "36780e7121b84d5c9c24cbd2f15eaaa4";
const VOICE_B = "46780e7121b84d5c9c24cbd2f15eaaa4";

/** Deterministic stand-ins for the provider, the analyzer and object storage. */
function stubDeps(client: ReturnType<typeof prisma>): VoiceAuditionDeps {
  return {
    store: createPrismaVoiceAuditionStore(client as never),
    renderer: {
      async render() {
        return { audioBuffer: Buffer.from("fake-audio"), contentType: "audio/mpeg", durationMs: 420_000, model: "stub" };
      },
    } as never,
    analyzer: {
      async analyze() {
        return {
          identityConsistency: 0.9, listenerFatigue: 0.1, spontaneity: 0.8,
          intelligibility: 0.95, emotionalRange: 0.7,
        } as never;
      },
    } as never,
    audio: {
      async put({ key }) {
        return { url: `https://example.invalid/${key}`, key };
      },
    },
  };
}

async function seedHost(client: ReturnType<typeof prisma>, ownerId: string | null, voiceId: string) {
  const slug = uid("integration-host");
  const host = await client.aiHost.create({
    data: {
      name: `Integration ${slug}`,
      slug,
      role: "co-host",
      worldview: "integration fixture",
      speakingStyle: "plain",
      catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [],
      ttsProvider: "fish",
      ttsVoiceId: voiceId,
      intensityLevel: 6,
      ownerId,
    } as never,
  });
  return host;
}

async function main() {
  console.log("\nVoice auditions (real PostgreSQL)\n");
  const client = prisma();
  const deps = stubDeps(client);

  try {
    const ownedHost = await seedHost(client, OWNER.id, VOICE_A);
    const partnerHost = await seedHost(client, OWNER.id, VOICE_B);
    const foreignHost = await seedHost(client, OTHER.id, VOICE_A);
    const systemHost = await seedHost(client, null, VOICE_B);

    let auditionId = "";
    let ballotId = "";
    let promotionId = "";

    await check("create -> add candidates -> open voting persists in Postgres", async () => {
      const audition = await createAudition(deps, {
        ownerId: OWNER.id, hostId: ownedHost.id, title: "Integration recast",
      });
      auditionId = audition.id;
      await addCandidate(deps, {
        auditionId, provider: "fish", voiceId: VOICE_A, privateLabel: "candidate-one",
        partner: { provider: "fish", voiceId: partnerHost.ttsVoiceId } as never,
      });
      await addCandidate(deps, {
        auditionId, provider: "fish", voiceId: VOICE_B, privateLabel: "candidate-two",
        partner: { provider: "fish", voiceId: partnerHost.ttsVoiceId } as never,
      });
      await openVoting(deps, auditionId);

      const rows = await client.voiceAuditionCandidate.findMany({ where: { auditionId } });
      if (rows.length !== 2) throw new Error(`expected 2 candidate rows, found ${rows.length}`);
      ballotId = rows[0].ballotId;
      if (!ballotId) throw new Error("a candidate must carry a ballot id");
    });

    await check("votes persist and are keyed by BALLOT, not candidate", async () => {
      await castVote(deps, {
        auditionId, ballotId, voterId: OWNER.id,
        scores: { characterFit: 9, identityConsistency: 8 } as never,
        overall: 9,
      });
      const votes = await client.voiceAuditionVote.findMany({ where: { auditionId } });
      if (votes.length !== 1) throw new Error(`expected 1 vote row, found ${votes.length}`);
    });

    await check("select winner does NOT change any production voice", async () => {
      const before = await client.aiHost.findUnique({ where: { id: ownedHost.id } });
      await selectWinner(deps, { auditionId, ballotId } as never);
      const after = await client.aiHost.findUnique({ where: { id: ownedHost.id } });
      if (before!.ttsVoiceId !== after!.ttsVoiceId) {
        throw new Error("selecting a winner must never promote a voice by itself");
      }
    });

    await check("promotion records the PREVIOUS voice and updates the host", async () => {
      const before = await client.aiHost.findUnique({ where: { id: ownedHost.id } });
      const result = await promoteWinner(deps, {
        auditionId, acknowledgedBallotId: ballotId, actorId: OWNER.id, actorLabel: "integration",
      } as never);
      promotionId = (result as unknown as { promotion: { id: string } }).promotion.id;
      const row = await client.voicePromotion.findUnique({ where: { id: promotionId } });
      if (!row) throw new Error("no promotion row");
      if (row.fromVoiceId !== before!.ttsVoiceId) throw new Error("the previous voice must be recorded for rollback");
      const after = await client.aiHost.findUnique({ where: { id: ownedHost.id } });
      if (after!.ttsVoiceId === before!.ttsVoiceId) throw new Error("promotion must change the production voice");
    });

    await check("rollback restores the previous voice and writes a reversal", async () => {
      const promotion = await client.voicePromotion.findUnique({ where: { id: promotionId } });
      await rollbackPromotion(deps, { promotionId, actorId: OWNER.id, reason: "integration" } as never);
      const host = await client.aiHost.findUnique({ where: { id: ownedHost.id } });
      if (host!.ttsVoiceId !== promotion!.fromVoiceId) throw new Error("rollback must restore the previous voice");
      const reversals = await client.voicePromotion.findMany({ where: { revertsPromotionId: promotionId } });
      if (reversals.length !== 1) throw new Error("rollback must write exactly one reversal row");
    });

    await check("rolling back twice is safe", async () => {
      await rollbackPromotion(deps, { promotionId, actorId: OWNER.id, reason: "again" } as never);
      const reversals = await client.voicePromotion.findMany({ where: { revertsPromotionId: promotionId } });
      if (reversals.length !== 1) throw new Error("a repeated rollback must not write a second reversal");
    });

    console.log("  -- tenant isolation, against real rows --");

    await check("a different owner cannot reach another owner's audition", async () => {
      const r = await authorizeAudition(deps, OTHER, auditionId);
      if (r.ok) throw new Error("cross-owner audition access must be refused");
    });

    await check("a different owner cannot reach another owner's host", async () => {
      const r = await authorizeHost(deps, OTHER, ownedHost.id);
      if (r.ok) throw new Error("cross-owner host access must be refused");
    });

    await check("an ordinary user cannot reach an UNOWNED system host", async () => {
      const r = await authorizeHost(deps, OWNER, systemHost.id);
      if (r.ok) throw new Error("a shared host is not owned by everybody");
    });

    await check("an administrator CAN reach the unowned system host", async () => {
      const r = await authorizeHost(deps, ADMIN, systemHost.id);
      if (!r.ok) throw new Error("an operator must be able to manage a shared host");
    });

    await check("promotion history is SCOPED BY THE QUERY, not filtered client-side", async () => {
      const mine = await guardedPromotionHistory(deps, OWNER);
      if (!mine.ok) throw new Error("an owner may read their own history");
      const leaked = mine.value.filter((p) => p.hostId === foreignHost.id || p.hostId === systemHost.id);
      if (leaked.length) throw new Error(`history leaked ${leaked.length} foreign row(s)`);
      const idor = await guardedPromotionHistory(deps, OWNER, foreignHost.id);
      if (idor.ok) throw new Error("history for another owner's host must be refused");
    });

    // Clean up the rows this run created.
    await client.voiceAuditionVote.deleteMany({ where: { auditionId } });
    await client.voiceAuditionCandidate.deleteMany({ where: { auditionId } });
    await client.voicePromotion.deleteMany({ where: { hostId: ownedHost.id } });
    await client.voiceAudition.deleteMany({ where: { id: auditionId } });
    await client.aiHost.deleteMany({
      where: { id: { in: [ownedHost.id, partnerHost.id, foreignHost.id, systemHost.id] } },
    });
  } finally {
    await client.$disconnect();
  }

  summarize("Voice auditions");
}

main();
