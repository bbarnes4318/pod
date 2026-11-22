-- Additive only. Every existing podcast resolves to SPORTS via the column
-- default (the creation path has only ever accepted sports verticals), so no
-- existing row changes behaviour. No sports table is touched.

CREATE TYPE "PodcastIntelligenceType" AS ENUM ('SPORTS', 'BUSINESS');

ALTER TABLE "Podcast" ADD COLUMN "intelligenceType" "PodcastIntelligenceType" NOT NULL DEFAULT 'SPORTS';

CREATE INDEX "Podcast_intelligenceType_idx" ON "Podcast"("intelligenceType");

CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "podcastId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "websiteUrl" TEXT,
    "description" TEXT,
    "industry" TEXT NOT NULL,
    "subIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetAudiences" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "primaryGoal" TEXT NOT NULL,
    "geographicMarkets" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "language" TEXT NOT NULL DEFAULT 'en',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "discoveryStatus" TEXT NOT NULL DEFAULT 'not_started',
    "discoveryError" TEXT,
    "discoveredAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BusinessProfile_podcastId_key" ON "BusinessProfile"("podcastId");

ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_podcastId_fkey" FOREIGN KEY ("podcastId") REFERENCES "Podcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;
