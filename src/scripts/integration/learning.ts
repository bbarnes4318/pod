// Prisma-backed listener learning, against a real PostgreSQL.
//
// Raw events, derived aggregates, versioned per-show policy, promotion,
// rollback and the retention purge — all through the real Prisma store rather
// than the in-memory fake the unit suite uses.

import {
  buildLearningEvent,
  createPrismaLearningStore,
  purgeExpiredLearningEvents,
  recomputeAggregates,
  recordLearningEvents,
} from "../../lib/services/listenerLearning";
import {
  getActivePolicyVersion,
  rollbackProductionPolicy,
  validatePolicyProposal,
} from "../../lib/services/productionPolicy";
import { check, summarize, uid, prisma } from "./helpers";

const SHOW_A = uid("integration-show-a");
const SHOW_B = uid("integration-show-b");
const EPISODE = uid("integration-ep");
const NOW = new Date();

async function main() {
  console.log("\nListener learning (real PostgreSQL)\n");
  const client = prisma();
  const store = createPrismaLearningStore(client);

  try {
    await check("raw events persist through the Prisma store", async () => {
      const inputs = Array.from({ length: 8 }, (_, i) => ({
        signalKey: "retention_15s" as const,
        value: i % 2 === 0 ? 1 : 0,
        episodeId: EPISODE,
        podcastId: SHOW_A,
        listenerId: `integration-listener-${i}`,
        consented: true,
        occurredAt: NOW,
      }));
      const { recorded, rejected } = await recordLearningEvents(store, inputs);
      if (rejected.length) throw new Error(`unexpected rejections: ${JSON.stringify(rejected)}`);
      if (recorded.length !== 8) throw new Error(`expected 8 rows, got ${recorded.length}`);

      const rows = await client.listenerLearningEvent.findMany({ where: { podcastId: SHOW_A } });
      if (rows.length !== 8) throw new Error(`expected 8 persisted rows, found ${rows.length}`);
      // Privacy: the raw identifier must never reach the table.
      const leaked = rows.filter((r) => JSON.stringify(r).includes("integration-listener-"));
      if (leaked.length) throw new Error("the RAW listener id reached the database");
    });

    await check("DEDUPE is enforced by the database, not just in memory", async () => {
      const dup = {
        signalKey: "retention_15s" as const,
        value: 1,
        episodeId: EPISODE,
        podcastId: SHOW_A,
        listenerId: "integration-listener-0",
        consented: true,
        occurredAt: NOW,
      };
      const before = await client.listenerLearningEvent.count({ where: { podcastId: SHOW_A } });
      await recordLearningEvents(store, [dup, dup, dup]);
      const after = await client.listenerLearningEvent.count({ where: { podcastId: SHOW_A } });
      if (after !== before) {
        throw new Error(`a repeated (listener, episode, signal) added ${after - before} row(s)`);
      }
    });

    await check("aggregates are DERIVED and round-trip through Postgres", async () => {
      const computed = await recomputeAggregates(store, SHOW_A);
      if (!computed.length) throw new Error("recompute produced no aggregate rows");
      const stored = await store.listAggregates(SHOW_A);
      if (stored.length !== computed.length) {
        throw new Error(`aggregate count mismatch: computed ${computed.length}, stored ${stored.length}`);
      }
      // Recomputing must be idempotent, not additive.
      const again = await recomputeAggregates(store, SHOW_A);
      if (again.length !== computed.length) throw new Error("recompute is not idempotent");
    });

    await check("each show gets its own baseline policy version", async () => {
      const a = await getActivePolicyVersion(store, SHOW_A, NOW);
      const b = await getActivePolicyVersion(store, SHOW_B, NOW);
      if (a.podcastId !== SHOW_A || b.podcastId !== SHOW_B) throw new Error("policy versions are not per-show");
      const rows = await client.productionPolicyVersion.findMany({ where: { podcastId: { in: [SHOW_A, SHOW_B] } } });
      if (rows.length < 2) throw new Error(`expected a baseline row per show, found ${rows.length}`);
    });

    await check("an immutable-field proposal is refused before it can be written", async () => {
      const active = await getActivePolicyVersion(store, SHOW_A, NOW);
      const verdict = validatePolicyProposal({ gamblingDisclaimerRequired: false } as never, active.preferences);
      if (verdict.ok) throw new Error("a safety rule must not be proposable");
      const versions = await client.productionPolicyVersion.count({ where: { podcastId: SHOW_A } });
      if (versions !== 1) throw new Error("a refused proposal must not create a version row");
    });

    await check("rollback on a show with only a baseline is safe", async () => {
      const r = await rollbackProductionPolicy(store, {
        podcastId: SHOW_A, actor: "integration", reason: "nothing to undo", now: NOW,
      } as never);
      // Either it reports there is nothing to roll back, or it is a no-op. What
      // it must NOT do is throw or invent a version.
      const versions = await client.productionPolicyVersion.count({ where: { podcastId: SHOW_A } });
      if (versions > 1) throw new Error(`rollback created ${versions} versions from a baseline`);
      void r;
    });

    await check("the retention purge deletes expired rows from the real table", async () => {
      const old = buildLearningEvent({
        signalKey: "retention_15s",
        value: 1,
        episodeId: EPISODE,
        podcastId: SHOW_B,
        listenerId: "integration-expired-listener",
        consented: true,
        occurredAt: new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000),
        retentionDays: 1,
      });
      if (!old.ok) throw new Error(`fixture failed to build: ${old.reason}`);
      await store.insertEvents([old.event]);
      const before = await client.listenerLearningEvent.count({ where: { podcastId: SHOW_B } });
      const purged = await purgeExpiredLearningEvents(store, NOW);
      const after = await client.listenerLearningEvent.count({ where: { podcastId: SHOW_B } });
      if (purged < 1) throw new Error("the purge reported nothing removed");
      if (after >= before) throw new Error("the purge did not delete the expired row");
    });

    await check("show isolation: show A's data never appears under show B", async () => {
      const aRows = await client.listenerLearningEvent.findMany({ where: { podcastId: SHOW_A } });
      const bLeak = aRows.filter((r) => r.podcastId === SHOW_B);
      if (bLeak.length) throw new Error("cross-show contamination");
      const aggB = await store.listAggregates(SHOW_B);
      if (aggB.some((r) => r.scopeKey === SHOW_A)) throw new Error("show B aggregates reference show A");
    });

    // Clean up.
    await client.listenerLearningAggregate.deleteMany({ where: { podcastId: { in: [SHOW_A, SHOW_B] } } });
    await client.listenerLearningEvent.deleteMany({ where: { podcastId: { in: [SHOW_A, SHOW_B] } } });
    await client.productionPolicyDecision.deleteMany({ where: { podcastId: { in: [SHOW_A, SHOW_B] } } });
    await client.productionPolicyVersion.deleteMany({ where: { podcastId: { in: [SHOW_A, SHOW_B] } } });
  } finally {
    await client.$disconnect();
  }

  summarize("Listener learning");
}

main();
