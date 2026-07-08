-- Additive, nullable voice-provenance columns on AiHost. No backfill, no
-- default, no impact on existing rows or queries. See Greene v. Google — hosts
-- must be able to document whether a voice is owned / licensed / synthetic.
ALTER TABLE "AiHost" ADD COLUMN IF NOT EXISTS "voiceSource" TEXT;
ALTER TABLE "AiHost" ADD COLUMN IF NOT EXISTS "voiceProvenanceNote" TEXT;
