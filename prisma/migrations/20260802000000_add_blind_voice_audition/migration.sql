-- Blind long-form voice audition.
--
-- PURELY ADDITIVE. Four new tables. No existing table, column, index or
-- constraint is altered or dropped, and no data is moved. The only foreign
-- keys are between the new tables themselves — hostId / ownerId / actorId /
-- voterId are deliberately plain ids so this block can be added or removed
-- without touching "AiHost" or "User".
--
-- Rollback: DROP TABLE "VoiceAuditionVote", "VoiceAuditionCandidate",
--           "VoicePromotion", "VoiceAudition"; (in that order)

CREATE TABLE "VoiceAudition" (
  "id"                 TEXT NOT NULL,
  "ownerId"            TEXT,
  "hostId"             TEXT,
  "title"              TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'draft',
  "packVersion"        TEXT NOT NULL,
  "packSceneIds"       TEXT[] DEFAULT ARRAY[]::TEXT[],
  "policyVersion"      INTEGER NOT NULL DEFAULT 1,
  "blindSeed"          TEXT NOT NULL,
  "winnerCandidateId"  TEXT,
  "winnerSelectedAt"   TIMESTAMP(3),
  "winnerSelectedById" TEXT,
  "unblindedAt"        TIMESTAMP(3),
  "unblindedById"      TEXT,
  "notes"              TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VoiceAudition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "VoiceAudition_ownerId_createdAt_idx" ON "VoiceAudition"("ownerId", "createdAt");
CREATE INDEX "VoiceAudition_hostId_idx" ON "VoiceAudition"("hostId");

-- The identity columns (provider, voiceId, model, generationSettings) live
-- here. The blind ballot query never selects them; see BALLOT_SELECT in
-- src/lib/services/voiceAudition.ts.
CREATE TABLE "VoiceAuditionCandidate" (
  "id"                 TEXT NOT NULL,
  "auditionId"         TEXT NOT NULL,
  "ballotId"           TEXT NOT NULL,
  "blindPosition"      INTEGER NOT NULL,
  "privateLabel"       TEXT,
  "provider"           TEXT NOT NULL,
  "voiceId"            TEXT NOT NULL,
  "model"              TEXT,
  "generationSettings" JSONB,
  "audioAssetKey"      TEXT,
  "audioAssetUrl"      TEXT,
  "audioContentType"   TEXT,
  "audioBytes"         INTEGER,
  "durationMs"         INTEGER,
  "renderedAt"         TIMESTAMP(3),
  "renderError"        TEXT,
  "metrics"            JSONB,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoiceAuditionCandidate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoiceAuditionCandidate_auditionId_fkey" FOREIGN KEY ("auditionId")
    REFERENCES "VoiceAudition"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "VoiceAuditionCandidate_ballotId_key" ON "VoiceAuditionCandidate"("ballotId");
CREATE UNIQUE INDEX "VoiceAuditionCandidate_auditionId_blindPosition_key" ON "VoiceAuditionCandidate"("auditionId", "blindPosition");
CREATE INDEX "VoiceAuditionCandidate_auditionId_idx" ON "VoiceAuditionCandidate"("auditionId");

CREATE TABLE "VoiceAuditionVote" (
  "id"                  TEXT NOT NULL,
  "auditionId"          TEXT NOT NULL,
  "candidateId"         TEXT NOT NULL,
  "voterId"             TEXT NOT NULL,
  "voterLabel"          TEXT,
  "characterFit"        INTEGER NOT NULL,
  "identityConsistency" INTEGER NOT NULL,
  "listenerFatigue"     INTEGER NOT NULL,
  "spontaneity"         INTEGER NOT NULL,
  "intelligibility"     INTEGER NOT NULL,
  "emotionalRange"      INTEGER NOT NULL,
  "interruptionQuality" INTEGER NOT NULL,
  "pairChemistry"       INTEGER NOT NULL,
  "overall"             INTEGER NOT NULL,
  "notes"               TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VoiceAuditionVote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoiceAuditionVote_auditionId_fkey" FOREIGN KEY ("auditionId")
    REFERENCES "VoiceAudition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "VoiceAuditionVote_candidateId_fkey" FOREIGN KEY ("candidateId")
    REFERENCES "VoiceAuditionCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "VoiceAuditionVote_candidateId_voterId_key" ON "VoiceAuditionVote"("candidateId", "voterId");
CREATE INDEX "VoiceAuditionVote_auditionId_idx" ON "VoiceAuditionVote"("auditionId");

-- Voice-change audit trail. kind='promotion' rows record a deliberate change
-- and the voice it replaced; kind='rollback' rows are the reversals.
CREATE TABLE "VoicePromotion" (
  "id"                 TEXT NOT NULL,
  "hostId"             TEXT NOT NULL,
  "kind"               TEXT NOT NULL DEFAULT 'promotion',
  "auditionId"         TEXT,
  "candidateId"        TEXT,
  "fromProvider"       TEXT,
  "fromVoiceId"        TEXT,
  "fromModel"          TEXT,
  "toProvider"         TEXT NOT NULL,
  "toVoiceId"          TEXT NOT NULL,
  "toModel"            TEXT,
  "actorId"            TEXT NOT NULL,
  "actorLabel"         TEXT,
  "reason"             TEXT,
  "policyVersion"      INTEGER NOT NULL DEFAULT 1,
  "status"             TEXT NOT NULL DEFAULT 'active',
  "revertsPromotionId" TEXT,
  "rolledBackAt"       TIMESTAMP(3),
  "rolledBackById"     TEXT,
  "rolledBackReason"   TEXT,
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoicePromotion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "VoicePromotion_auditionId_fkey" FOREIGN KEY ("auditionId")
    REFERENCES "VoiceAudition"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "VoicePromotion_hostId_createdAt_idx" ON "VoicePromotion"("hostId", "createdAt");
CREATE INDEX "VoicePromotion_auditionId_idx" ON "VoicePromotion"("auditionId");
CREATE INDEX "VoicePromotion_revertsPromotionId_idx" ON "VoicePromotion"("revertsPromotionId");
