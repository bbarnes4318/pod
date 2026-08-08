// The DURABLE legacy release, against a real PostgreSQL.
//
// The unit test proves this against a Map. That is not the guarantee: the
// guarantee is UNIQUE(scriptId), which only the database can enforce. This
// drives the real Prisma path, including a CONCURRENT race that a Map cannot
// meaningfully simulate.

import {
  DEFAULT_LEGACY_RELEASE_STAGES,
  prismaLegacyReleaseStore,
  __setLegacyReleaseStoreForTests,
} from "../../lib/queue/legacyRelease";
import {
  assertScriptReleasableForProduction,
  ProductionHoldError,
  __setScriptContentLoaderForTests,
} from "../../lib/queue/productionGuard";
import { check, summarize, uid, withPrisma } from "./helpers";

const CUTOVER = "2026-08-02T00:00:00.000Z";
const PROD = {
  NODE_ENV: "production",
  SCRIPT_EDITORIAL_GATE_MODE: "hold",
  SCRIPT_GATE_ENFORCEMENT_FROM: CUTOVER,
} as unknown as NodeJS.ProcessEnv;

/** A pre-cutover script that was never evaluated. */
const LEGACY_CONTENT = { segments: [] };
const CREATED = "2026-07-01T00:00:00.000Z";

async function main() {
  console.log("\nDurable legacy release (real PostgreSQL)\n");

  // The real Prisma store, not the in-memory one.
  __setLegacyReleaseStoreForTests(prismaLegacyReleaseStore);

  const scriptId = uid("integration-legacy");
  __setScriptContentLoaderForTests(async () => ({ content: LEGACY_CONTENT, createdAt: CREATED }));

  await check("crossing every production stage twice creates exactly ONE row", async () => {
    for (let round = 0; round < 2; round++) {
      for (const stage of DEFAULT_LEGACY_RELEASE_STAGES) {
        await assertScriptReleasableForProduction(scriptId, stage, PROD);
      }
    }
    await withPrisma(async (db) => {
      const rows = await db.scriptLegacyRelease.findMany({ where: { scriptId } });
      if (rows.length !== 1) throw new Error(`expected exactly 1 release row, found ${rows.length}`);
    });
  });

  await check("CONCURRENT boundaries race to one row, not many", async () => {
    // This is the case a Map cannot test. Six simultaneous callers, one row.
    const racy = uid("integration-legacy-race");
    __setScriptContentLoaderForTests(async () => ({ content: LEGACY_CONTENT, createdAt: CREATED }));
    await Promise.all(
      DEFAULT_LEGACY_RELEASE_STAGES.flatMap((stage) => [
        assertScriptReleasableForProduction(racy, stage, PROD),
        assertScriptReleasableForProduction(racy, stage, PROD),
      ])
    );
    await withPrisma(async (db) => {
      const rows = await db.scriptLegacyRelease.findMany({ where: { scriptId: racy } });
      if (rows.length !== 1) throw new Error(`a concurrent race minted ${rows.length} releases`);
    });
  });

  await check("the row records actor, cutover, creation time and SCOPE", async () => {
    await withPrisma(async (db) => {
      const row = await db.scriptLegacyRelease.findUnique({ where: { scriptId } });
      if (!row) throw new Error("no release row");
      if (row.actorKind !== "system") throw new Error(`actorKind should be system, got ${row.actorKind}`);
      if (!row.actorId?.startsWith("system:")) throw new Error(`actorId should be a system actor, got ${row.actorId}`);
      if (row.scriptCreatedAt.toISOString() !== CREATED) throw new Error("scriptCreatedAt not recorded");
      if (row.cutoverAt.toISOString() !== CUTOVER) throw new Error("cutoverAt not recorded");
      const scope = [...row.permittedStages].sort();
      const want = [...DEFAULT_LEGACY_RELEASE_STAGES].sort();
      if (JSON.stringify(scope) !== JSON.stringify(want)) {
        throw new Error(`scope not persisted: ${JSON.stringify(row.permittedStages)}`);
      }
    });
  });

  await check("a SIMULATED RESTART reuses the row rather than minting another", async () => {
    // Nothing in this process remembers the earlier decision; only the table
    // does. Re-running the guard must find it.
    __setLegacyReleaseStoreForTests(prismaLegacyReleaseStore);
    __setScriptContentLoaderForTests(async () => ({ content: LEGACY_CONTENT, createdAt: CREATED }));
    const verdict = await assertScriptReleasableForProduction(scriptId, "tts:generate-segments", PROD);
    if (verdict.blocked) throw new Error("an existing release must keep permitting its scoped stages");
    await withPrisma(async (db) => {
      const count = await db.scriptLegacyRelease.count({ where: { scriptId } });
      if (count !== 1) throw new Error(`a restart minted a second release (${count})`);
    });
  });

  await check("a stage OUTSIDE the recorded scope is refused", async () => {
    let threw = false;
    try {
      await assertScriptReleasableForProduction(scriptId, "social-clip:generate", PROD);
    } catch (err) {
      threw = err instanceof ProductionHoldError;
    }
    if (!threw) throw new Error("an out-of-scope stage must be refused");
  });

  await check("a REVOKED release stops working and keeps its audit trail", async () => {
    await withPrisma(async (db) => {
      await db.scriptLegacyRelease.update({
        where: { scriptId },
        data: { revokedAt: new Date(), revokedBy: "integration", revokedReason: "superseded" },
      });
    });
    let threw = false;
    try {
      await assertScriptReleasableForProduction(scriptId, "tts:generate-segments", PROD);
    } catch (err) {
      threw = err instanceof ProductionHoldError && /revoked/i.test((err as Error).message);
    }
    if (!threw) throw new Error("a revoked release must stop permitting production");
    await withPrisma(async (db) => {
      const count = await db.scriptLegacyRelease.count({ where: { scriptId } });
      if (count !== 1) throw new Error("revoking must not delete the record");
    });
  });

  await check("a MEASURED-and-failed script never gets a row", async () => {
    const held = uid("integration-held");
    __setScriptContentLoaderForTests(async () => ({
      content: { editorialGate: { decision: "hold", reasons: ["x"], failedCriticalAxes: [] } },
      createdAt: CREATED,
    }));
    let threw = false;
    try {
      await assertScriptReleasableForProduction(held, "tts:generate-segments", PROD);
    } catch (err) {
      threw = err instanceof ProductionHoldError;
    }
    if (!threw) throw new Error("a measured failure must still be blocked");
    await withPrisma(async (db) => {
      const count = await db.scriptLegacyRelease.count({ where: { scriptId: held } });
      if (count !== 0) throw new Error("a measured failure must never create a compatibility release");
    });
  });

  // Leave the table as we found it.
  await withPrisma(async (db) => {
    await db.scriptLegacyRelease.deleteMany({ where: { scriptId: { startsWith: "integration-legacy" } } });
  });
  __setScriptContentLoaderForTests(null);
  __setLegacyReleaseStoreForTests(null);

  summarize("Durable legacy release");
}

main();
