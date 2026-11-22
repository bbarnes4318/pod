-- Additive only: six new business research tables. No sports table, column
-- or row is changed; Podcast/Episode gain only reverse relations (no columns).

-- CreateTable
CREATE TABLE "BusinessResearchRun" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "ownerId" TEXT,
    "kind" TEXT NOT NULL,
    "depth" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL,
    "opportunityId" TEXT,
    "progress" JSONB NOT NULL DEFAULT '{}',
    "budget" JSONB NOT NULL,
    "usage" JSONB NOT NULL DEFAULT '{}',
    "limitations" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessResearchRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessResearchSource" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "ownerId" TEXT,
    "sourceType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "title" TEXT,
    "publisher" TEXT,
    "publishedAt" TIMESTAMP(3),
    "retrievedAt" TIMESTAMP(3) NOT NULL,
    "excerpt" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "originKey" TEXT NOT NULL,
    "fetchStatus" TEXT NOT NULL DEFAULT 'ok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessResearchSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemandObservation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "ownerId" TEXT,
    "sourceId" TEXT,
    "adapter" TEXT NOT NULL,
    "sourceFamily" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "observedMetric" TEXT NOT NULL,
    "metricKind" TEXT NOT NULL,
    "metricValue" DOUBLE PRECISION,
    "measurementWindow" TEXT NOT NULL,
    "audienceRelevance" DOUBLE PRECISION NOT NULL,
    "geographicRelevance" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "originKey" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "limitations" TEXT NOT NULL,
    "title" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessTopicOpportunity" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "ownerId" TEXT,
    "runId" TEXT,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "businessNiche" TEXT NOT NULL,
    "targetListener" TEXT NOT NULL,
    "coreQuestion" TEXT NOT NULL,
    "listenerProblem" TEXT NOT NULL,
    "whyItMatters" TEXT NOT NULL,
    "whyNow" TEXT,
    "undercoveredInformation" TEXT,
    "potentialOriginalAnalysis" TEXT,
    "practicalValue" TEXT,
    "demandEvidence" JSONB NOT NULL DEFAULT '{}',
    "citedSourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keyClaims" JSONB NOT NULL DEFAULT '[]',
    "researchLimitations" JSONB NOT NULL DEFAULT '[]',
    "scores" JSONB NOT NULL DEFAULT '{}',
    "opportunityScore" INTEGER NOT NULL DEFAULT 0,
    "potentialIas" INTEGER NOT NULL DEFAULT 0,
    "achievedIas" INTEGER,
    "demandConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "demandStrength" TEXT NOT NULL DEFAULT 'UNMEASURED',
    "evidenceQuality" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "editorialStatus" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "holdReasons" JSONB NOT NULL DEFAULT '[]',
    "review" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessTopicOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessResearchDossier" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "ownerId" TEXT,
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RESEARCHING',
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" JSONB NOT NULL DEFAULT '{}',
    "sourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verifiedClaimCount" INTEGER NOT NULL DEFAULT 0,
    "unsupportedClaimCount" INTEGER NOT NULL DEFAULT 0,
    "holdReasons" JSONB NOT NULL DEFAULT '[]',
    "additionalResearch" JSONB NOT NULL DEFAULT '[]',
    "fingerprint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessResearchDossier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessEpisodeTopic" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "dossierId" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "snapshot" JSONB NOT NULL,
    "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessEpisodeTopic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessResearchRun_idempotencyKey_key" ON "BusinessResearchRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "BusinessResearchRun_podcastId_createdAt_idx" ON "BusinessResearchRun"("podcastId", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessResearchRun_status_idx" ON "BusinessResearchRun"("status");

-- CreateIndex
CREATE INDEX "BusinessResearchSource_podcastId_contentHash_idx" ON "BusinessResearchSource"("podcastId", "contentHash");

-- CreateIndex
CREATE INDEX "BusinessResearchSource_podcastId_canonicalUrl_idx" ON "BusinessResearchSource"("podcastId", "canonicalUrl");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessResearchSource_runId_canonicalUrl_key" ON "BusinessResearchSource"("runId", "canonicalUrl");

-- CreateIndex
CREATE INDEX "DemandObservation_runId_idx" ON "DemandObservation"("runId");

-- CreateIndex
CREATE INDEX "DemandObservation_podcastId_idx" ON "DemandObservation"("podcastId");

-- CreateIndex
CREATE INDEX "BusinessTopicOpportunity_podcastId_editorialStatus_idx" ON "BusinessTopicOpportunity"("podcastId", "editorialStatus");

-- CreateIndex
CREATE INDEX "BusinessTopicOpportunity_podcastId_normalizedTitle_idx" ON "BusinessTopicOpportunity"("podcastId", "normalizedTitle");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessResearchDossier_opportunityId_key" ON "BusinessResearchDossier"("opportunityId");

-- CreateIndex
CREATE INDEX "BusinessEpisodeTopic_opportunityId_idx" ON "BusinessEpisodeTopic"("opportunityId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessEpisodeTopic_episodeId_opportunityId_key" ON "BusinessEpisodeTopic"("episodeId", "opportunityId");

-- AddForeignKey
ALTER TABLE "BusinessResearchRun" ADD CONSTRAINT "BusinessResearchRun_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessResearchSource" ADD CONSTRAINT "BusinessResearchSource_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BusinessResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandObservation" ADD CONSTRAINT "DemandObservation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BusinessResearchRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandObservation" ADD CONSTRAINT "DemandObservation_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "BusinessResearchSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessTopicOpportunity" ADD CONSTRAINT "BusinessTopicOpportunity_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessResearchDossier" ADD CONSTRAINT "BusinessResearchDossier_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "BusinessTopicOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessEpisodeTopic" ADD CONSTRAINT "BusinessEpisodeTopic_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessEpisodeTopic" ADD CONSTRAINT "BusinessEpisodeTopic_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "BusinessTopicOpportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

