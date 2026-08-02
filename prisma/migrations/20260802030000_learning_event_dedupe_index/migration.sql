-- Make listener-event dedupe a DATABASE invariant.
--
-- Dedupe was enforced only at the public intake boundary. That covered the
-- actual threat — the boundary is the only route a listener can reach — but any
-- other writer could still insert duplicates, and the integration suite proved
-- it: three identical (listener, episode, signal) rows landed through
-- recordLearningEvents.
--
-- Production-side measurements deliberately carry NO listenerHash, because
-- attaching a person to an episode-level measurement would create an
-- identifiability surface for no benefit. A partial index was the first
-- instinct, but PostgreSQL already treats NULLs as DISTINCT in a unique index,
-- so a plain unique index leaves those rows entirely unconstrained — the same
-- outcome, and expressible in schema.prisma, so the migration and the schema
-- cannot drift.
--
-- Additive. No column added or dropped, no row rewritten.
--
-- ROLLBACK:
--   DROP INDEX IF EXISTS "ListenerLearningEvent_listener_episode_signal_key";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20260802030000_learning_event_dedupe_index';

CREATE UNIQUE INDEX "ListenerLearningEvent_listener_episode_signal_key"
  ON "ListenerLearningEvent" ("listenerHash", "episodeId", "signalKey");
