-- Additive per-account host ownership. Nullable: existing rows stay ownerId=NULL
-- = "system / shared" hosts, visible (read-only) to every account so nothing
-- existing breaks and no picker is ever empty. New Character Studio hosts stamp
-- ownerId = the creator. Ownership is enforced at SELECTION (the pickers only
-- surface own + shared hosts) and on every mutation; the host RESOLVER stays
-- owner-agnostic so existing episodes referencing shared hosts render identically.
ALTER TABLE "AiHost" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;
CREATE INDEX IF NOT EXISTS "AiHost_ownerId_idx" ON "AiHost" ("ownerId");
