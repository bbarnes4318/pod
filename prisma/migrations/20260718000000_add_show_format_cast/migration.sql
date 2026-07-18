-- Prompt 7 (PR 1): show format + normalized episode cast.
--
-- ADDITIVE and NON-DESTRUCTIVE. two_host_debate stops being the architecture
-- and becomes registered format #1; every existing Episode is backfilled with
-- formatId 'two_host_debate' (the column default) because that is EXACTLY the
-- format that built it -- no invention. Pinned casts are mirrored from the
-- legacy Episode.hostIds array into normalized EpisodeCastMember rows in seat
-- order (seat 0 = chair_a, seat 1 = chair_b, the two chairs of the debate
-- format). Episodes with an empty hostIds pin (cast auto-resolved at build
-- time) honestly get NO cast rows. Episode.hostIds stays as a legacy mirror.
-- ASCII only (WIN1252 deployment-contract rule). No fetches, no ffprobe.

-- AlterTable
ALTER TABLE "Episode" ADD COLUMN     "formatId" TEXT NOT NULL DEFAULT 'two_host_debate';

-- CreateTable
CREATE TABLE "EpisodeCastMember" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "hostId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EpisodeCastMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EpisodeCastMember_hostId_idx" ON "EpisodeCastMember"("hostId");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeCastMember_episodeId_orderIndex_key" ON "EpisodeCastMember"("episodeId", "orderIndex");

-- CreateIndex
CREATE UNIQUE INDEX "EpisodeCastMember_episodeId_hostId_key" ON "EpisodeCastMember"("episodeId", "hostId");

-- AddForeignKey
ALTER TABLE "EpisodeCastMember" ADD CONSTRAINT "EpisodeCastMember_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpisodeCastMember" ADD CONSTRAINT "EpisodeCastMember_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "AiHost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 2. Backfill: mirror pinned legacy casts into normalized rows.
-- ---------------------------------------------------------------------------
INSERT INTO "EpisodeCastMember" ("id", "episodeId", "hostId", "role", "orderIndex")
SELECT
  md5(e."id" || ':cast:' || (x.ord - 1)::text),
  e."id",
  x."hostId",
  CASE WHEN x.ord = 1 THEN 'chair_a' ELSE 'chair_b' END,
  (x.ord - 1)::int
FROM "Episode" e
CROSS JOIN LATERAL unnest(e."hostIds") WITH ORDINALITY AS x("hostId", ord)
JOIN "AiHost" h ON h."id" = x."hostId"
WHERE x.ord <= 2
ON CONFLICT DO NOTHING;
