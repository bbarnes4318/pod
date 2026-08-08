-- Editorial-gate rollout: durable legacy release.
--
-- Additive only. One new table, no foreign key into any existing table, so it
-- is drop-safe and does not alter Script, Episode, or anything else.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS "ScriptLegacyRelease";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260802020000_add_script_legacy_release';

CREATE TABLE "ScriptLegacyRelease" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "scriptCreatedAt" TIMESTAMP(3) NOT NULL,
    "cutoverAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL DEFAULT 'system',
    "actorId" TEXT,
    "permittedStages" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "revokedReason" TEXT,

    CONSTRAINT "ScriptLegacyRelease_pkey" PRIMARY KEY ("id")
);

-- The invariant: at most ONE release per script, enforced by the database.
CREATE UNIQUE INDEX "ScriptLegacyRelease_scriptId_key" ON "ScriptLegacyRelease"("scriptId");
CREATE INDEX "ScriptLegacyRelease_createdAt_idx" ON "ScriptLegacyRelease"("createdAt");
CREATE INDEX "ScriptLegacyRelease_revokedAt_idx" ON "ScriptLegacyRelease"("revokedAt");
