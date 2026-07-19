-- Prompt 7.5 (PR 1): safe per-render diagnostics on the render record.
--
-- ADDITIVE and NON-DESTRUCTIVE. Adds a single nullable JSONB column that holds
-- the safe cue-sheet report for a render (selected cues + reasons + musical
-- fit, executed placement, cooldown result, skipped cues + safe reasons,
-- timing, and the post-render bookend verification result). Names and asset
-- ids only -- never URLs, storage keys, or signed tokens.
--
-- No backfill: historical renders keep diagnostics NULL (honest -- we did not
-- capture this report for them and do not fabricate one). Does NOT touch any
-- episode snapshot, fingerprint, master, or cue-usage row. IF NOT EXISTS makes
-- it idempotent for local db-push. ASCII only (WIN1252 deployment-contract
-- rule). No fetches, no ffprobe.

-- AlterTable
ALTER TABLE "EpisodeAudioRender" ADD COLUMN IF NOT EXISTS "diagnostics" JSONB;
