-- Wire podcast host selection into episodes, and give the non-sport
-- verticals (Gambling/Point Spread, Fantasy Sports, Poker) League rows so
-- the topic engine's league validation can accept topics for them.
-- Purely additive + idempotent: existing episodes get an empty hostIds
-- (script generation falls back to the default duo), and the League
-- inserts are ON CONFLICT DO NOTHING.

ALTER TABLE "Episode" ADD COLUMN IF NOT EXISTS "hostIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

INSERT INTO "League" ("id", "name", "sport", "slug", "isActive") VALUES ('GAMBLING', 'Gambling / Point Spread', 'Betting', 'gambling-point-spread', true) ON CONFLICT DO NOTHING;
INSERT INTO "League" ("id", "name", "sport", "slug", "isActive") VALUES ('FANTASY', 'Fantasy Sports', 'Fantasy Sports', 'fantasy-sports', true) ON CONFLICT DO NOTHING;
INSERT INTO "League" ("id", "name", "sport", "slug", "isActive") VALUES ('POKER', 'Poker', 'Poker', 'poker', true) ON CONFLICT DO NOTHING;
