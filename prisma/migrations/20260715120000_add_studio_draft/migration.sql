-- Durable, cross-session resume state for the Studio multi-topic rundown builder.
-- Additive only: a new table + its FK/unique index. No existing row is touched.

CREATE TABLE "StudioDraft" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StudioDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StudioDraft_ownerId_key" ON "StudioDraft"("ownerId");

ALTER TABLE "StudioDraft"
    ADD CONSTRAINT "StudioDraft_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
