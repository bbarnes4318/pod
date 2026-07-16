-- Resumable ADMIN rundown draft.
--
-- ADDITIVE ONLY: creates one new table. No existing table, column, index, or
-- constraint is altered or dropped, so existing StudioDraft rows (and every
-- other table) are untouched and this migration is safe to replay forward.
--
-- NOTE ON THE DELIBERATE ABSENCE OF A FOREIGN KEY:
-- "StudioDraft"."ownerId" carries a REQUIRED FK to "User"("id"). The /admin
-- surface authenticates with HTTP Basic Auth against env vars and has NO User
-- row, so an admin identity could never satisfy that constraint. Rather than
-- weaken StudioDraft's FK (destructive to Studio's integrity guarantee) or
-- invent a synthetic User row, admin drafts get their own table keyed by the
-- audited admin identity string — the same shape JobLog already uses for
-- operator-authored, user-less state.

CREATE TABLE "AdminDraft" (
    "id"        TEXT NOT NULL,
    "adminId"   TEXT NOT NULL,
    "state"     JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminDraft_pkey" PRIMARY KEY ("id")
);

-- One resumable rundown per admin operator (mirrors StudioDraft's one-per-user).
CREATE UNIQUE INDEX "AdminDraft_adminId_key" ON "AdminDraft"("adminId");

CREATE INDEX "AdminDraft_updatedAt_idx" ON "AdminDraft"("updatedAt");
