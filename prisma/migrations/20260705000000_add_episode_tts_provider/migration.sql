-- First migration in this repo: the prod schema predates the migrations
-- folder (it was created with `prisma db push`), so this must apply cleanly
-- to a database that already has every table. IF NOT EXISTS keeps it
-- idempotent for local dbs that already picked the column up via db push.
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "ttsProvider" TEXT;
