-- Operator-imported article sources for a topic.
--
-- ADDITIVE ONLY: creates one new table and its indexes. No existing table,
-- column, index, constraint or enum is altered or dropped, so this applies
-- cleanly after the 17 existing migrations and changes nothing about the rows
-- already there. Existing topics simply have zero sources.
--
-- DEPLOY NOTE: web and worker both run `prisma migrate deploy`; this migration
-- is safe in either order and requires no backfill, no downtime, and no
-- coordination beyond the usual "migrate before the code that reads it".
--
-- The FK to "TopicCandidate" cascades: a topic's imported sources are
-- meaningless once the topic is gone. There is deliberately NO user/admin FK —
-- the /admin surface authenticates via HTTP Basic Auth against env vars and has
-- no User row, so the importing operator is recorded as the audited identity
-- string (the same approach "AdminDraft" and "JobLog" already use).
--
-- NOT evidence: nothing in this table feeds TopicCandidate.evidenceIds. It is
-- unverified editorial starting material for the research pipeline.

CREATE TABLE "TopicSource" (
    "id"                     TEXT NOT NULL,
    "topicId"                TEXT NOT NULL,
    "originalUrl"            TEXT NOT NULL,
    "canonicalUrl"           TEXT NOT NULL,
    "title"                  TEXT,
    "publisher"              TEXT,
    "author"                 TEXT,
    "publishedAt"            TIMESTAMP(3),
    "excerpt"                TEXT,
    "contentHash"            TEXT,
    "fetchStatus"            TEXT NOT NULL,
    "fetchErrorCategory"     TEXT,
    "retrievedAt"            TIMESTAMP(3),
    "createdByAdminIdentity" TEXT NOT NULL,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TopicSource_pkey" PRIMARY KEY ("id")
);

-- The same article cannot be imported onto the same topic twice. This is the
-- database-level guarantee behind duplicate detection, so a concurrent
-- double-submit cannot create two copies.
CREATE UNIQUE INDEX "TopicSource_topicId_canonicalUrl_key" ON "TopicSource"("topicId", "canonicalUrl");

CREATE INDEX "TopicSource_topicId_idx" ON "TopicSource"("topicId");

-- Supports "has this article already been imported anywhere?" lookups.
CREATE INDEX "TopicSource_canonicalUrl_idx" ON "TopicSource"("canonicalUrl");

ALTER TABLE "TopicSource"
    ADD CONSTRAINT "TopicSource_topicId_fkey"
    FOREIGN KEY ("topicId") REFERENCES "TopicCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
