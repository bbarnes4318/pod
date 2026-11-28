-- Additive: the approved AI Executive Producer brief for an episode.
-- Nullable JSON; no existing row or column is touched.
ALTER TABLE "Episode" ADD COLUMN "editorialBrief" JSONB;
