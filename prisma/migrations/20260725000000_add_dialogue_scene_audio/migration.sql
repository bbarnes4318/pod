-- Scene-mode spoken audio (native multi-speaker TTS).
--
-- ADDITIVE and NON-DESTRUCTIVE. Existing AudioSegment rows (legacy per-line
-- audio) are untouched and remain the source for legacy episodes. New:
--   1. Episode.ttsRenderMode — persists HOW an episode's speech was generated
--      ("legacy_line" | "scene" | "mixed_fallback" | "performance_conversion");
--      NULL for pre-scene episodes. Recorded at generation time, never
--      inferred later from environment variables.
--   2. DialogueSceneAudio — one row per scene generation CANDIDATE, with the
--      full audit trail (provider, exact model, render unit, voice map,
--      request fingerprint, seed, timing map status). At most one selected
--      candidate per scene feeds the final stitch.

ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "ttsRenderMode" TEXT;

-- Optional versioned host performance profile (validated by Zod at read time;
-- NULL derives safely from the existing role/speakingStyle/intensityLevel).
ALTER TABLE "AiHost" ADD COLUMN IF NOT EXISTS "performanceProfile" JSONB;

CREATE TABLE IF NOT EXISTS "DialogueSceneAudio" (
    "id" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "sceneIndex" INTEGER NOT NULL,
    "sceneType" TEXT NOT NULL,
    "firstLineIndex" INTEGER NOT NULL,
    "lastLineIndex" INTEGER NOT NULL,
    "lineIndexes" JSONB NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "renderUnit" TEXT NOT NULL,
    "voiceMap" JSONB NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "candidateIndex" INTEGER NOT NULL DEFAULT 0,
    "seed" INTEGER,
    "status" TEXT NOT NULL,
    "audioUrl" TEXT,
    "durationMs" INTEGER,
    "contentType" TEXT,
    "providerMetadata" JSONB,
    "timingStatus" TEXT NOT NULL DEFAULT 'timing_unavailable',
    "timingMap" JSONB,
    "errorCategory" TEXT,
    "selected" BOOLEAN NOT NULL DEFAULT false,
    "continuationRef" TEXT,
    "plannerVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DialogueSceneAudio_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DialogueSceneAudio_episodeId_idx" ON "DialogueSceneAudio"("episodeId");
CREATE INDEX IF NOT EXISTS "DialogueSceneAudio_scriptId_sceneIndex_idx" ON "DialogueSceneAudio"("scriptId", "sceneIndex");
CREATE INDEX IF NOT EXISTS "DialogueSceneAudio_requestFingerprint_idx" ON "DialogueSceneAudio"("requestFingerprint");

ALTER TABLE "DialogueSceneAudio"
    ADD CONSTRAINT "DialogueSceneAudio_episodeId_fkey"
    FOREIGN KEY ("episodeId") REFERENCES "Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DialogueSceneAudio"
    ADD CONSTRAINT "DialogueSceneAudio_scriptId_fkey"
    FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;
