-- Per-host voice picks pinned on the episode, keyed by host slug:
-- { "max-voltage": { "provider": "boson", "voiceId": "...", "voiceName": "..." }, ... }
-- IF NOT EXISTS keeps it idempotent for local dbs that picked the column up
-- via `prisma db push`.
ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "ttsVoiceOverrides" JSONB;
