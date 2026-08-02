-- Make listener-event dedupe a DATABASE invariant.
--
-- Dedupe was enforced only at the public intake boundary. That is the only
-- route a listener can reach, so it covered the threat — but any other writer
-- (a worker backfill, an admin script, a future endpoint) could still insert
-- duplicates, and the integration suite proved it: three identical
-- (listener, episode, signal) rows landed through recordLearningEvents.
--
-- A PARTIAL unique index is the right shape here. Production-side measurements
-- deliberately carry no listenerHash (attaching a person to an episode-level
-- measurement would create an identifiability surface for no benefit), so they
-- are excluded rather than forced to collide with each other.
--
-- Additive. No column is added or dropped, and no row is rewritten.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS "ListenerLearningEvent_listener_episode_signal_key";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260802030000_learning_event_dedupe_index';

CREATE UNIQUE INDEX IF NOT EXISTS "ListenerLearningEvent_listener_episode_signal_key"
  ON "ListenerLearningEvent" ("listenerHash", "episodeId", "signalKey")
  WHERE "listenerHash" IS NOT NULL;
