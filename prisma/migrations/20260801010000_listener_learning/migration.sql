ALTER TABLE "PodcastEditorialConfig"
ADD COLUMN "learningPolicy" JSONB,
ADD COLUMN "learningPolicyVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "learningPolicyUpdatedAt" TIMESTAMP(3);

CREATE TABLE "ListenerSignal" (
  "id" TEXT NOT NULL,
  "episodeId" TEXT NOT NULL,
  "ownerId" TEXT,
  "sessionHash" TEXT NOT NULL,
  "milestone" TEXT NOT NULL,
  "positionSeconds" INTEGER,
  "durationSeconds" INTEGER,
  "value" DOUBLE PRECISION,
  "coldOpenVariant" TEXT,
  "metadata" JSONB,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ListenerSignal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ListenerSignal_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ListenerSignal_episodeId_sessionHash_milestone_key" ON "ListenerSignal"("episodeId", "sessionHash", "milestone");
CREATE INDEX "ListenerSignal_episodeId_milestone_idx" ON "ListenerSignal"("episodeId", "milestone");
CREATE INDEX "ListenerSignal_ownerId_at_idx" ON "ListenerSignal"("ownerId", "at");
CREATE INDEX "ListenerSignal_coldOpenVariant_milestone_idx" ON "ListenerSignal"("coldOpenVariant", "milestone");
