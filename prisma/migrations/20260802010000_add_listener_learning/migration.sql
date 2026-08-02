-- Closed listener-learning loop: collect -> aggregate -> evaluate ->
-- promote/reject -> rollback.
--
-- PURELY ADDITIVE. Five new tables. No existing table, column, index or
-- constraint is altered or dropped, and no data is moved. There are NO foreign
-- keys into existing tables — episodeId / podcastId are deliberately plain ids
-- so this block can be added or removed without touching "Episode", "Podcast"
-- or the pre-existing "ListenerSignal" table (which is left exactly as-is).
--
-- ROLLBACK (exact, safe to run in one transaction):
--   DROP TABLE IF EXISTS "ProductionPolicyDecision";
--   DROP TABLE IF EXISTS "ProductionPolicyVersion";
--   DROP TABLE IF EXISTS "ColdOpenPairwiseTrial";
--   DROP TABLE IF EXISTS "ListenerLearningAggregate";
--   DROP TABLE IF EXISTS "ListenerLearningEvent";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260802010000_add_listener_learning';
-- (Indexes and constraints are owned by these tables and drop with them. The
--  pre-existing "ListenerSignal" table and its data are untouched either way.)

-- RAW, attributable, append-only. THE RECORD.
CREATE TABLE "ListenerLearningEvent" (
  "id"                      TEXT NOT NULL,
  "signalKey"               TEXT NOT NULL,
  "source"                  TEXT NOT NULL,
  "episodeId"               TEXT,
  "podcastId"               TEXT,
  "formatId"                TEXT,
  "openingVariant"          TEXT,
  "hostPairKey"             TEXT,
  "voicePolicyVersion"      INTEGER,
  "productionPolicyVersion" INTEGER,
  "listenerHash"            TEXT,
  "cohort"                  TEXT,
  "consented"               BOOLEAN NOT NULL DEFAULT false,
  "country"                 TEXT,
  "value"                   DOUBLE PRECISION NOT NULL,
  "unit"                    TEXT NOT NULL,
  "occurredAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"               TIMESTAMP(3) NOT NULL,
  "metadata"                JSONB,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ListenerLearningEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ListenerLearningEvent_podcastId_signalKey_occurredAt_idx" ON "ListenerLearningEvent"("podcastId", "signalKey", "occurredAt");
CREATE INDEX "ListenerLearningEvent_episodeId_signalKey_idx" ON "ListenerLearningEvent"("episodeId", "signalKey");
CREATE INDEX "ListenerLearningEvent_expiresAt_idx" ON "ListenerLearningEvent"("expiresAt");
CREATE INDEX "ListenerLearningEvent_listenerHash_idx" ON "ListenerLearningEvent"("listenerHash");

-- DERIVED rollups. Fully recomputable from "ListenerLearningEvent".
CREATE TABLE "ListenerLearningAggregate" (
  "id"            TEXT NOT NULL,
  "podcastId"     TEXT NOT NULL,
  "scopeKind"     TEXT NOT NULL,
  "scopeKey"      TEXT NOT NULL,
  "signalKey"     TEXT NOT NULL,
  "sampleSize"    INTEGER NOT NULL,
  "mean"          DOUBLE PRECISION NOT NULL,
  "sum"           DOUBLE PRECISION NOT NULL,
  "minValue"      DOUBLE PRECISION NOT NULL,
  "maxValue"      DOUBLE PRECISION NOT NULL,
  "stdDev"        DOUBLE PRECISION NOT NULL,
  "marginOfError" DOUBLE PRECISION NOT NULL,
  "confidence"    TEXT NOT NULL,
  "windowStart"   TIMESTAMP(3) NOT NULL,
  "windowEnd"     TIMESTAMP(3) NOT NULL,
  "computedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ListenerLearningAggregate_pkey" PRIMARY KEY ("id")
);

-- Name matches Prisma's own 63-character truncation for this constraint.
CREATE UNIQUE INDEX "ListenerLearningAggregate_podcastId_scopeKind_scopeKey_sign_key" ON "ListenerLearningAggregate"("podcastId", "scopeKind", "scopeKey", "signalKey");
CREATE INDEX "ListenerLearningAggregate_podcastId_signalKey_idx" ON "ListenerLearningAggregate"("podcastId", "signalKey");

-- Blind cold-open head-to-head. Variant identity lives ONLY in this table.
CREATE TABLE "ColdOpenPairwiseTrial" (
  "id"              TEXT NOT NULL,
  "trialToken"      TEXT NOT NULL,
  "episodeId"       TEXT,
  "podcastId"       TEXT,
  "slotAVariantId"  TEXT NOT NULL,
  "slotBVariantId"  TEXT NOT NULL,
  "listenerHash"    TEXT,
  "consented"       BOOLEAN NOT NULL DEFAULT false,
  "country"         TEXT,
  "winnerSlot"      TEXT,
  "winnerVariantId" TEXT,
  "decidedAt"       TIMESTAMP(3),
  "servedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ColdOpenPairwiseTrial_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ColdOpenPairwiseTrial_trialToken_key" ON "ColdOpenPairwiseTrial"("trialToken");
CREATE INDEX "ColdOpenPairwiseTrial_podcastId_servedAt_idx" ON "ColdOpenPairwiseTrial"("podcastId", "servedAt");
CREATE INDEX "ColdOpenPairwiseTrial_episodeId_idx" ON "ColdOpenPairwiseTrial"("episodeId");

-- Versioned, PER-SHOW production policy (scoped by podcastId, never global).
CREATE TABLE "ProductionPolicyVersion" (
  "id"                  TEXT NOT NULL,
  "podcastId"           TEXT NOT NULL,
  "version"             INTEGER NOT NULL,
  "status"              TEXT NOT NULL DEFAULT 'active',
  "preferences"         JSONB NOT NULL,
  "immutableRules"      JSONB NOT NULL,
  "rationale"           TEXT NOT NULL,
  "evidence"            JSONB NOT NULL,
  "promotedFromVersion" INTEGER,
  "promotedBy"          TEXT,
  "promotedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rolledBackAt"        TIMESTAMP(3),
  "rolledBackBy"        TEXT,
  "rolledBackReason"    TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductionPolicyVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductionPolicyVersion_podcastId_version_key" ON "ProductionPolicyVersion"("podcastId", "version");
CREATE INDEX "ProductionPolicyVersion_podcastId_status_idx" ON "ProductionPolicyVersion"("podcastId", "status");

-- Every promotion ATTEMPT, including the refusals and their reasons.
CREATE TABLE "ProductionPolicyDecision" (
  "id"               TEXT NOT NULL,
  "podcastId"        TEXT NOT NULL,
  "outcome"          TEXT NOT NULL,
  "code"             TEXT NOT NULL,
  "reason"           TEXT NOT NULL,
  "resultingVersion" INTEGER,
  "detail"           JSONB,
  "actor"            TEXT,
  "decidedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProductionPolicyDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductionPolicyDecision_podcastId_decidedAt_idx" ON "ProductionPolicyDecision"("podcastId", "decidedAt");
