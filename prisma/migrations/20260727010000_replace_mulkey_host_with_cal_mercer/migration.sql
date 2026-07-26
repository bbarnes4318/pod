-- Retire Dutch "Attendance" Mulkey and put Cal "Red Eye" Mercer in seat B.
--
-- WHY THIS IS AN IDENTITY MOVE AND NOT A NEW ROW
--
-- Every relation to a host is by AiHost.id: Episode.hostIds (TEXT[]),
-- PodcastProductionConfig.hostIds (TEXT[]), and EpisodeCastMember.hostId. So
-- inserting a new Cal row and archiving the Mulkey row would leave every
-- existing podcast still cast with a retired host, and every operator would
-- have to recast by hand. Renaming the EXISTING row keeps its id, and every
-- podcast and episode follows automatically with nothing to recast.
--
-- WHAT THIS MIGRATION DOES AND DOES NOT DO
--
-- It moves IDENTITY only: slug, name, and the seat-B marker fields whose old
-- values are actively wrong for the new character (role/worldview/speakingStyle
-- and the four list fields). It deliberately does NOT author the character
-- here. prisma/seed.ts is the single source of truth for host content, upserts
-- on the new slug, and therefore lands on THIS row. Duplicating a character
-- bible into SQL would guarantee it drifts from the seed within one release.
--
-- RELEASE ORDER (documented in docs/DEPLOYMENT_RUNBOOK.md):
--     npm run prisma:migrate:deploy   <- this file
--     npx prisma db seed              <- authors Cal onto the migrated row
--
-- Between those two steps seat B is a host named Cal Mercer carrying an
-- explicitly-marked stub. That window is why the stub text says so out loud
-- instead of leaving Mulkey's bible attached to Cal's name.
--
-- IDEMPOTENT: every branch is existence-guarded, so a re-run is a no-op. Safe
-- to run after the seed, too — the seed's content is never overwritten because
-- the rename branch only fires while a 'dutch-attendance' row still exists.

DO $$
DECLARE
  mulkey_id TEXT;
  cal_id    TEXT;
BEGIN
  SELECT "id" INTO mulkey_id FROM "AiHost" WHERE "slug" = 'dutch-attendance';
  SELECT "id" INTO cal_id    FROM "AiHost" WHERE "slug" = 'cal-red-eye-mercer';

  IF mulkey_id IS NULL THEN
    RAISE NOTICE 'No dutch-attendance host row; nothing to migrate.';

  ELSIF cal_id IS NULL THEN
    -- The normal path. Same row, new identity: every relation follows.
    UPDATE "AiHost" SET
      "slug"             = 'cal-red-eye-mercer',
      "name"             = 'Cal "Red Eye" Mercer',
      "role"             = 'Former advance scout and player liaison; seventeen years in the hallways where organizations decide what they will say',
      "worldview"        = 'PENDING SEED — run `npx prisma db seed` to author this host. Placeholder written by migration 20260727010000.',
      "speakingStyle"    = 'PENDING SEED — run `npx prisma db seed` to author this host. Placeholder written by migration 20260727010000.',
      "catchphrases"     = '[]'::JSONB,
      "likes"            = '[]'::JSONB,
      "dislikes"         = '[]'::JSONB,
      "argumentPatterns" = '[]'::JSONB,
      "bannedPhrases"    = '[]'::JSONB,
      -- The retired performance profile is a trained-projection, opens-at-full-
      -- volume character. Leaving it attached would make Cal perform as Mulkey
      -- until the seed runs. NULL derives a safe profile from the fields above
      -- in the meantime; the seed then writes the authored one.
      "performanceProfile" = NULL,
      -- Seat B stays below Zabala's 8 (hostCasting sorts by intensityLevel DESC
      -- and swaps the higher into chair A). Cal is calmer than Mulkey was.
      "intensityLevel"   = 5,
      "isActive"         = TRUE,
      "isArchived"       = FALSE,
      "voiceProvenanceNote" = 'Voice inherited from the retired seat-B host. NOT yet auditioned for this character — see docs/PRODUCTION_ENV.md (FISH_HOST_B_VOICE_ID).'
      -- ttsProvider and ttsVoiceId are deliberately UNTOUCHED: the seat-B voice
      -- is preserved until a Cal-specific voice is configured.
    WHERE "id" = mulkey_id;
    RAISE NOTICE 'Migrated host % from dutch-attendance to cal-red-eye-mercer (relations preserved).', mulkey_id;

  ELSE
    -- Defensive path: a Cal row already exists (someone seeded before
    -- migrating). Repoint every relation onto the Cal row, then archive the
    -- Mulkey row. isActive stays TRUE so any pin this repointing missed still
    -- resolves a host rather than falling through to auto-casting.
    UPDATE "Episode"
      SET "hostIds" = array_replace("hostIds", mulkey_id, cal_id)
      WHERE mulkey_id = ANY("hostIds");
    UPDATE "PodcastProductionConfig"
      SET "hostIds" = array_replace("hostIds", mulkey_id, cal_id)
      WHERE mulkey_id = ANY("hostIds");
    -- Skip rows whose episode already has a Cal cast member: @@unique([episodeId, hostId]).
    UPDATE "EpisodeCastMember" AS m
      SET "hostId" = cal_id
      WHERE m."hostId" = mulkey_id
        AND NOT EXISTS (
          SELECT 1 FROM "EpisodeCastMember" o
          WHERE o."episodeId" = m."episodeId" AND o."hostId" = cal_id
        );
    UPDATE "AiHost" SET "isArchived" = TRUE, "isActive" = TRUE WHERE "id" = mulkey_id;
    RAISE NOTICE 'Cal row already existed; repointed relations from % to % and archived the Mulkey row.', mulkey_id, cal_id;
  END IF;
END $$;
