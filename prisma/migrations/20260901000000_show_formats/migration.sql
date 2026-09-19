-- Show formats as first-class data.
--
-- Before this migration a show was defined by little more than its host count:
-- the only structural knob was PodcastEditorialConfig.format, a seat/role
-- registry id (two_host_debate, solo_commentary, ...) that says WHO is in the
-- chairs and nothing about what they do with the hour. There was no model of a
-- rundown at all — no segments, no per-segment timing, floor split, turn
-- profile, evidence density, or structural device.
--
-- ShowFormat + FormatSegment add that model as DATA rather than code, because
-- producers change a rundown far more often than they change the pipeline.
--
-- DATA EFFECTS THIS MIGRATION PERFORMS (schema equality cannot see these):
--   1. Creates the "classic-debate" ShowFormat + its three segments.
--   2. Points every existing Podcast at it.
-- Both are idempotent — re-running finds the slug and changes nothing.

CREATE TYPE "FormatTopicMode" AS ENUM ('SINGLE', 'MULTI', 'CARRYOVER');
CREATE TYPE "FormatStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');
CREATE TYPE "FormatSegmentDevice" AS ENUM ('NONE', 'VERDICT', 'PICK', 'SCORE', 'CALLER', 'RETRACTION', 'STEELMAN_TRANSFER');

CREATE TABLE "ShowFormat" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "topicMode" "FormatTopicMode" NOT NULL,
    "totalSeconds" INTEGER NOT NULL,
    "coldOpenStyle" TEXT NOT NULL,
    "signOffStyle" TEXT NOT NULL,
    "intensityCurve" JSONB NOT NULL,
    "status" "FormatStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShowFormat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShowFormat_slug_key" ON "ShowFormat"("slug");
CREATE INDEX "ShowFormat_status_idx" ON "ShowFormat"("status");

CREATE TABLE "FormatSegment" (
    "id" TEXT NOT NULL,
    "formatId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "seconds" INTEGER NOT NULL,
    "floorSplit" JSONB NOT NULL,
    "turnProfile" JSONB NOT NULL,
    "evidenceDensity" DOUBLE PRECISION NOT NULL,
    "device" "FormatSegmentDevice" NOT NULL DEFAULT 'NONE',
    "deviceConfig" JSONB,
    "exitCondition" TEXT NOT NULL,
    "producerNote" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormatSegment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FormatSegment_formatId_idx" ON "FormatSegment"("formatId");
CREATE UNIQUE INDEX "FormatSegment_formatId_order_key" ON "FormatSegment"("formatId", "order");
CREATE UNIQUE INDEX "FormatSegment_formatId_key_key" ON "FormatSegment"("formatId", "key");

ALTER TABLE "FormatSegment" ADD CONSTRAINT "FormatSegment_formatId_fkey"
    FOREIGN KEY ("formatId") REFERENCES "ShowFormat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable in the DATABASE only. Every existing row is backfilled below, and
-- the show-creation path requires a format for new shows. Kept nullable so a
-- missing format row can never be the thing that makes a show unreadable, and
-- so ON DELETE RESTRICT is about retiring formats rather than orphaning shows.
ALTER TABLE "Podcast" ADD COLUMN "formatId" TEXT;
CREATE INDEX "Podcast_formatId_idx" ON "Podcast"("formatId");
ALTER TABLE "Podcast" ADD CONSTRAINT "Podcast_formatId_fkey"
    FOREIGN KEY ("formatId") REFERENCES "ShowFormat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The resolved rundown, frozen at generation time. An episode must never
-- re-read a mutable ShowFormat after the fact.
ALTER TABLE "Episode" ADD COLUMN "formatSnapshot" JSONB;
ALTER TABLE "Episode" ADD COLUMN "formatSlug" TEXT;
ALTER TABLE "Episode" ADD COLUMN "formatVersion" INTEGER;

-- ---------------------------------------------------------------------------
-- BACKFILL: the two-host generic format every existing show has actually been
-- running. Seeded HERE rather than in the seed script because the backfill is
-- part of the migration's contract: `npm run seed:formats` is deliberate and
-- is NOT run on deploy, so a deploy that only ran migrations must still leave
-- every Podcast with a format.
--
-- classic-debate is deliberately plain. It describes what the pipeline does
-- today (open, argue the topics, sign off) and claims nothing it cannot back.
INSERT INTO "ShowFormat" (
    "id", "slug", "name", "tagline", "topicMode", "totalSeconds",
    "coldOpenStyle", "signOffStyle", "intensityCurve", "status", "version",
    "createdAt", "updatedAt"
) VALUES (
    gen_random_uuid()::text,
    'classic-debate',
    'Classic Debate',
    'Two chairs, a stack of topics, and no agreement.',
    'MULTI',
    1200,
    'cold_take',
    'plain_handoff',
    '{"cold_open": 5, "debate_block": 7, "sign_off": 4}'::jsonb,
    'ACTIVE',
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "FormatSegment" (
    "id", "formatId", "order", "key", "displayName", "seconds",
    "floorSplit", "turnProfile", "evidenceDensity", "device", "deviceConfig",
    "exitCondition", "producerNote", "createdAt", "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    f."id",
    s."order",
    s."key",
    s."displayName",
    s."seconds",
    s."floorSplit"::jsonb,
    s."turnProfile"::jsonb,
    s."evidenceDensity",
    'NONE'::"FormatSegmentDevice",
    NULL,
    s."exitCondition",
    s."producerNote",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "ShowFormat" f
CROSS JOIN (VALUES
    (0, 'cold_open', 'Cold Open', 60,
     '{"seatA": 0.5, "seatB": 0.5}',
     '{"interruptionRate": 0.1, "backchannelRate": 0.2, "targetTurnWords": 45, "allowConsecutiveTurns": false}',
     0.0,
     'Both hosts have staked a position on the lead topic.',
     'Open on the disagreement, not on a greeting. No recap of the show name.'),
    (1, 'debate_block', 'Debate Block', 1020,
     '{"seatA": 0.5, "seatB": 0.5}',
     '{"interruptionRate": 0.25, "backchannelRate": 0.35, "targetTurnWords": 70, "allowConsecutiveTurns": true}',
     2.0,
     'Every selected topic has been argued to a stated disagreement or a concession.',
     'One topic at a time. Each topic gets evidence before opinion.'),
    (2, 'sign_off', 'Sign Off', 120,
     '{"seatA": 0.5, "seatB": 0.5}',
     '{"interruptionRate": 0.05, "backchannelRate": 0.15, "targetTurnWords": 40, "allowConsecutiveTurns": false}',
     0.0,
     'Both hosts have signed off and the next episode is teased.',
     'Short. No new argument in the sign off.')
) AS s("order", "key", "displayName", "seconds", "floorSplit", "turnProfile", "evidenceDensity", "exitCondition", "producerNote")
WHERE f."slug" = 'classic-debate'
ON CONFLICT ("formatId", "key") DO NOTHING;

-- Every existing show gets the format it has in fact been running.
UPDATE "Podcast"
SET "formatId" = (SELECT "id" FROM "ShowFormat" WHERE "slug" = 'classic-debate')
WHERE "formatId" IS NULL;
