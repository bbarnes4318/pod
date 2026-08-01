-- Repair podcast configuration rows that were created after the original
-- 20260716000000 backfill had already run.
--
-- ADDITIVE AND IDEMPOTENT:
--   * existing slugs and configuration rows are never changed;
--   * only NULL slugs and missing one-to-one configuration rows are filled;
--   * legacy editorial/production values are copied verbatim;
--   * re-running every statement is a no-op.

UPDATE "Podcast" p
SET "slug" = COALESCE(
      NULLIF(trim(BOTH '-' FROM regexp_replace(lower(p."name"), '[^a-z0-9]+', '-', 'g')), ''),
      'show'
    ) || '-' || substr(md5(p."id"), 1, 8)
WHERE p."slug" IS NULL;

INSERT INTO "PodcastEditorialConfig" (
  "id", "podcastId", "verticals", "teams", "segmentCount", "format", "updatedAt"
)
SELECT
  md5(p."id" || ':editorial'), p."id", p."verticals", p."teams",
  p."segmentCount", 'two_host_debate', CURRENT_TIMESTAMP
FROM "Podcast" p
WHERE NOT EXISTS (
  SELECT 1 FROM "PodcastEditorialConfig" e WHERE e."podcastId" = p."id"
);

INSERT INTO "PodcastProductionConfig" (
  "id", "podcastId", "hostIds", "updatedAt"
)
SELECT
  md5(p."id" || ':production'), p."id", p."hostIds", CURRENT_TIMESTAMP
FROM "Podcast" p
WHERE NOT EXISTS (
  SELECT 1 FROM "PodcastProductionConfig" pr WHERE pr."podcastId" = p."id"
);

INSERT INTO "PodcastPublishingConfig" (
  "id", "podcastId", "updatedAt"
)
SELECT
  md5(p."id" || ':publishing'), p."id", CURRENT_TIMESTAMP
FROM "Podcast" p
WHERE NOT EXISTS (
  SELECT 1 FROM "PodcastPublishingConfig" pu WHERE pu."podcastId" = p."id"
);
