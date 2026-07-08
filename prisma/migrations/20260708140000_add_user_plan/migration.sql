-- Additive monetization tier. Nullable-safe with a default so every existing
-- row becomes "free" with no backfill. No processor / billing table is added —
-- this column is the single entitlement source of truth a future payment
-- webhook would write.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "plan" TEXT NOT NULL DEFAULT 'free';
