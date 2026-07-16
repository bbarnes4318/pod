-- Reconcile AiHost.ownerId: the migration history and schema.prisma disagreed.
--
-- WHAT WAS WRONG (pre-existing; surfaced only once a database was rebuilt from
-- migrations, which was impossible before the baseline existed):
--
--   20260707150000_add_aihost_owner created the column AND an index, but no
--   foreign key:
--       ALTER TABLE "AiHost" ADD COLUMN IF NOT EXISTS "ownerId" TEXT;
--       CREATE INDEX IF NOT EXISTS "AiHost_ownerId_idx" ON "AiHost" ("ownerId");
--
--   schema.prisma declared a RELATION -- i.e. a foreign key with
--   `onDelete: SetNull` -- and no index.
--
-- So the two artifacts built different databases:
--   * rebuilt-from-migrations: index, NO foreign key -> `onDelete: SetNull` was
--     not enforced by the database at all, and deleting a User would leave
--     AiHost.ownerId pointing at a row that no longer exists.
--   * created-by-db-push (how production was built): foreign key, NO index.
--
-- Both authors were half right: the pickers filter hosts by owner, so the index
-- is genuinely wanted, and the relation is genuinely wanted. This migration
-- makes every database have both, and schema.prisma now declares the index so
-- the drift cannot silently return.
--
-- IDEMPOTENT ON PURPOSE. It must be a no-op on whichever half a given database
-- already has:
--   * a db-push-origin database already has the FK  -> the DO block swallows
--     duplicate_object;
--   * a migration-built database already has the index -> IF NOT EXISTS.
-- Nothing is dropped, no data is touched, and no row is rejected: the FK is
-- added as-is because ownerId is nullable and any pre-existing value either
-- references a real User or (on a db-push database) was already constrained.

-- Add the foreign key the relation always implied.
DO $$
BEGIN
  ALTER TABLE "AiHost"
    ADD CONSTRAINT "AiHost_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- already present (db-push-origin database)
END $$;

-- Keep/create the index the pickers rely on. On a db-push-origin database this
-- is the half that was missing.
CREATE INDEX IF NOT EXISTS "AiHost_ownerId_idx" ON "AiHost" ("ownerId");
