-- Additive, non-null-with-default archive flag on AiHost. Soft-archive keeps a
-- host out of active pickers while preserving its association with every
-- episode that already references it (Episode.hostIds / AudioSegment.hostId /
-- Script.content speakerHostId are untouched). No backfill needed — existing
-- rows default to false (not archived).
ALTER TABLE "AiHost" ADD COLUMN IF NOT EXISTS "isArchived" BOOLEAN NOT NULL DEFAULT false;
