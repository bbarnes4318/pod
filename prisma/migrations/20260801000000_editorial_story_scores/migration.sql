ALTER TABLE "TopicCandidate"
ADD COLUMN "editorialScores" JSONB,
ADD COLUMN "editorialScore" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE INDEX "TopicCandidate_editorialScore_idx" ON "TopicCandidate"("editorialScore");
