// Known migration checkpoints + the data invariants schema comparison cannot see.
//
// THE PROBLEM THIS SOLVES
// This project's production database was created with `prisma db push`, so it
// may have the right TABLES while `_prisma_migrations` is empty or partial.
// The tempting move is then to `migrate resolve --applied` everything so Prisma
// stops complaining. That is exactly the move that loses data, because SOME
// MIGRATIONS DO THINGS NO SCHEMA COMPARISON CAN SEE:
//
//   20260714120000 rewrites every TopicCandidate whose status is the legacy
//   'used', backfills EpisodeTopic.selectedAt, and backfills snapshots. A
//   database can have a perfectly matching schema and still be full of rows
//   those steps never touched. Marking that migration "applied" would freeze
//   the corruption in place and tell everyone it was fine.
//
// So: schema equality is necessary, never sufficient. Every migration that
// carries data effects declares invariants here, and adoption is only ever
// proposed when the invariants actually pass on the live rows.

/** A read-only query surface. Deliberately narrow — the auditor cannot write. */
export interface InvariantDb {
  $queryRawUnsafe: <T = unknown>(sql: string, ...values: unknown[]) => Promise<T>;
}

export interface InvariantResult {
  name: string;
  ok: boolean;
  detail: string;
  /** True when the check itself could not run (e.g. the table doesn't exist). */
  inconclusive?: boolean;
}

export interface MigrationCheckpoint {
  name: string;
  /** Does this migration change DATA, not just shape? */
  hasDataTransform: boolean;
  /** Can schema equality alone prove this migration ran? */
  schemaEqualitySufficient: boolean;
  /** What must be true of the rows if it really ran. */
  invariants: string[];
  note?: string;
}

/**
 * Every migration in order, annotated with whether schema equality proves it.
 *
 * `schemaEqualitySufficient: false` is the important column. It means: even if
 * this database's schema matches perfectly, you cannot conclude this migration
 * ran, because its real work was on rows.
 */
export const MIGRATION_CHECKPOINTS: MigrationCheckpoint[] = [
  { name: "20260704000000_baseline", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [],
    note: "Reconstructed from the pre-first-migration schema (commit cc8fd491). Creates 20 tables, no enums." },
  { name: "20260705000000_add_episode_tts_provider", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260705150000_add_episode_tts_voice_overrides", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260705200000_add_sound_design", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260706000000_add_sound_cue_usage", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260706150000_add_podcast_and_seed_teams", hasDataTransform: true, schemaEqualitySufficient: false,
    invariants: ["leagues_seeded"], note: "INSERTs seed Leagues/Teams. Rows can be absent with the schema intact." },
  { name: "20260706210000_add_episode_host_ids_and_nonsport_leagues", hasDataTransform: true, schemaEqualitySufficient: false,
    invariants: ["nonsport_leagues_seeded"], note: "INSERTs GAMBLING/FANTASY/POKER leagues." },
  { name: "20260707000000_add_user_auth", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260707120000_add_ownership", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260707130000_add_aihost_voice_provenance", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260707140000_add_aihost_isarchived", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260707150000_add_aihost_owner", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260708120000_add_social_clip", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260708130000_add_play_event", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  { name: "20260708140000_add_user_plan", hasDataTransform: false, schemaEqualitySufficient: true, invariants: [] },
  {
    name: "20260714120000_topic_lifecycle_and_snapshots",
    hasDataTransform: true,
    schemaEqualitySufficient: false,
    invariants: ["no_legacy_used_status", "status_enum_values_only", "selectedAt_backfilled", "snapshots_backfilled"],
    note: "THE ONE THAT MATTERS. Converts legacy 'used' status, backfills EpisodeTopic.selectedAt and snapshots, and RAISEs on unexpected status values. A matching schema proves none of it.",
  },
  { name: "20260715120000_add_studio_draft", hasDataTransform: false, schemaEqualitySufficient: true, invariants: ["studio_draft_owner_fk"] },
  { name: "20260715140000_add_admin_draft", hasDataTransform: false, schemaEqualitySufficient: true, invariants: ["admin_draft_present"] },
  { name: "20260715160000_add_topic_source", hasDataTransform: false, schemaEqualitySufficient: true, invariants: ["topic_source_present"] },
  { name: "20260715170000_reconcile_aihost_owner", hasDataTransform: false, schemaEqualitySufficient: true, invariants: ["aihost_owner_fk"] },
  {
    name: "20260716000000_add_podcast_configuration",
    hasDataTransform: true,
    schemaEqualitySufficient: false,
    invariants: [
      "podcast_config_tables_present",
      "every_podcast_has_editorial_config",
      "every_podcast_has_production_config",
      "every_podcast_has_publishing_config",
      "every_podcast_has_unique_slug",
      "podcast_config_no_orphans",
      "episodes_have_configuration_source",
    ],
    note: "Prompt 5. BACKFILLS a slug + one editorial/production/publishing row for EVERY Podcast, mirroring the legacy verticals/teams/segmentCount/hostIds columns. A matching schema does NOT prove the backfill ran: a Podcast could exist with no config rows and a NULL slug while the tables are present.",
  },
  {
    name: "20260717000000_add_audio_asset_ownership",
    hasDataTransform: true,
    schemaEqualitySufficient: false,
    invariants: [
      "audio_asset_scopes_valid",
      "shared_system_assets_unowned",
      "owner_private_assets_owned",
      "podcast_private_assets_consistent",
      "seed_assets_shared_system",
      "seed_assets_rights_confirmed",
      "legacy_assets_flagged_for_review",
    ],
    note: "Prompt 6 PR1. BACKFILLS ownership scope onto every AudioAsset (seed -> shared_system with confirmed rights; everything else -> legacy_global with review required), adds the media-immutability trigger + scope CHECK constraints. A matching schema does NOT prove the classification ran: an asset could sit at the fail-closed default with the tables intact.",
  },
];

export const EXPECTED_MIGRATION_COUNT = MIGRATION_CHECKPOINTS.length;
export const BASELINE_MIGRATION = MIGRATION_CHECKPOINTS[0].name;

/** Migrations whose effects cannot be inferred from shape alone. */
export const DATA_BEARING_MIGRATIONS = MIGRATION_CHECKPOINTS.filter((m) => !m.schemaEqualitySufficient);

const one = async (db: InvariantDb, sql: string): Promise<number> => {
  const rows = await db.$queryRawUnsafe<Array<{ n: bigint | number }>>(sql);
  return Number(rows?.[0]?.n ?? 0);
};

/** True when the table exists — lets an invariant say "inconclusive" instead of exploding. */
async function tableExists(db: InvariantDb, table: string): Promise<boolean> {
  const n = await one(db, `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='${table}'`);
  return n > 0;
}

/**
 * Run every data invariant. READ ONLY — nothing here writes, and it must stay
 * that way: this runs against databases whose state we do not yet trust.
 */
export async function runDataInvariants(db: InvariantDb): Promise<InvariantResult[]> {
  const out: InvariantResult[] = [];
  const add = (name: string, ok: boolean, detail: string, inconclusive = false) => out.push({ name, ok, detail, inconclusive });

  // --- 20260714120000: the legacy 'used' status ---------------------------
  if (await tableExists(db, "TopicCandidate")) {
    const isEnum = await one(db, `
      SELECT COUNT(*)::int AS n FROM information_schema.columns
      WHERE table_name='TopicCandidate' AND column_name='status' AND udt_name='TopicEditorialStatus'`);
    if (isEnum > 0) {
      // Once the column IS the enum, 'used' cannot physically be stored — the
      // type system carries the guarantee.
      const labels = await db.$queryRawUnsafe<Array<{ enumlabel: string }>>(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='TopicEditorialStatus'`
      );
      const set = labels.map((l) => l.enumlabel).sort();
      add("no_legacy_used_status", !set.includes("used"),
        set.includes("used") ? "the enum still contains 'used'" : "status is the enum; 'used' is unrepresentable");
      add("status_enum_values_only", JSON.stringify(set) === JSON.stringify(["approved", "archived", "pending", "rejected"]),
        `enum labels: ${set.join(", ")}`);
    } else {
      // Still TEXT: the conversion never ran, so look at the rows themselves.
      const used = await one(db, `SELECT COUNT(*)::int AS n FROM "TopicCandidate" WHERE "status"::text='used'`);
      const weird = await one(db, `SELECT COUNT(*)::int AS n FROM "TopicCandidate" WHERE "status"::text NOT IN ('pending','approved','rejected','archived')`);
      add("no_legacy_used_status", used === 0, used > 0
        ? `${used} row(s) still carry the legacy 'used' status — the conversion never ran`
        : "no legacy 'used' rows");
      add("status_enum_values_only", weird === 0, weird > 0
        ? `${weird} row(s) hold a status outside the editorial set — the migration would RAISE on these`
        : "every status is an editorial value (column is still TEXT)");
    }
  } else {
    add("no_legacy_used_status", false, "TopicCandidate does not exist", true);
    add("status_enum_values_only", false, "TopicCandidate does not exist", true);
  }

  // --- 20260714120000: selectedAt backfill --------------------------------
  if (await tableExists(db, "EpisodeTopic")) {
    const hasCol = await one(db, `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='EpisodeTopic' AND column_name='selectedAt'`);
    if (hasCol === 0) {
      add("selectedAt_backfilled", false, "EpisodeTopic.selectedAt does not exist — the migration never ran", true);
    } else {
      const nulls = await one(db, `SELECT COUNT(*)::int AS n FROM "EpisodeTopic" WHERE "selectedAt" IS NULL`);
      const notNull = await one(db, `
        SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name='EpisodeTopic' AND column_name='selectedAt' AND is_nullable='NO'`);
      add("selectedAt_backfilled", nulls === 0 && notNull > 0,
        nulls > 0 ? `${nulls} EpisodeTopic row(s) have a NULL selectedAt — the backfill did not complete`
                  : notNull === 0 ? "selectedAt exists but is still nullable — the migration stopped before enforcing NOT NULL"
                  : "every EpisodeTopic has selectedAt and the column is NOT NULL");
    }
  } else {
    add("selectedAt_backfilled", false, "EpisodeTopic does not exist", true);
  }

  // --- 20260714120000: snapshot backfill ----------------------------------
  if (await tableExists(db, "EpisodeTopic")) {
    const hasCol = await one(db, `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='EpisodeTopic' AND column_name='snapshot'`);
    if (hasCol === 0) {
      add("snapshots_backfilled", false, "EpisodeTopic.snapshot does not exist — the migration never ran", true);
    } else {
      // snapshot is nullable by design (legacy rows fall back to live data), so
      // this is reported honestly rather than as a hard failure.
      const total = await one(db, `SELECT COUNT(*)::int AS n FROM "EpisodeTopic"`);
      const missing = await one(db, `SELECT COUNT(*)::int AS n FROM "EpisodeTopic" WHERE "snapshot" IS NULL`);
      add("snapshots_backfilled", missing === 0,
        total === 0 ? "no EpisodeTopic rows to snapshot"
        : missing > 0 ? `${missing}/${total} EpisodeTopic row(s) have no snapshot — the backfill did not cover them`
        : `all ${total} EpisodeTopic row(s) carry a snapshot`);
    }
  } else {
    add("snapshots_backfilled", false, "EpisodeTopic does not exist", true);
  }

  // --- Seed data ----------------------------------------------------------
  if (await tableExists(db, "League")) {
    const leagues = await one(db, `SELECT COUNT(*)::int AS n FROM "League"`);
    add("leagues_seeded", leagues > 0, leagues > 0 ? `${leagues} league(s) present` : "no leagues — the seeding migration did not run");
    const nonsport = await one(db, `SELECT COUNT(*)::int AS n FROM "League" WHERE "id" IN ('GAMBLING','FANTASY','POKER')`);
    add("nonsport_leagues_seeded", nonsport === 3, `${nonsport}/3 non-sport leagues present`);
  } else {
    add("leagues_seeded", false, "League does not exist", true);
    add("nonsport_leagues_seeded", false, "League does not exist", true);
  }

  // --- Later structural migrations ----------------------------------------
  for (const [name, table] of [["admin_draft_present", "AdminDraft"], ["topic_source_present", "TopicSource"]] as const) {
    const ok = await tableExists(db, table);
    add(name, ok, ok ? `${table} exists` : `${table} is missing — a later migration did not run`);
  }

  const fk = async (name: string, constraint: string, table: string) => {
    const n = await one(db, `
      SELECT COUNT(*)::int AS n FROM information_schema.table_constraints
      WHERE constraint_type='FOREIGN KEY' AND table_name='${table}' AND constraint_name='${constraint}'`);
    add(name, n > 0, n > 0 ? `${constraint} present` : `${constraint} missing on ${table}`);
  };
  if (await tableExists(db, "StudioDraft")) await fk("studio_draft_owner_fk", "StudioDraft_ownerId_fkey", "StudioDraft");
  else add("studio_draft_owner_fk", false, "StudioDraft does not exist", true);
  if (await tableExists(db, "AiHost")) await fk("aihost_owner_fk", "AiHost_ownerId_fkey", "AiHost");
  else add("aihost_owner_fk", false, "AiHost does not exist", true);

  // --- 20260716000000: Podcast configuration backfill ---------------------
  // Schema equality is deliberately NOT sufficient here: the three config
  // tables can all exist while a Podcast has no rows in them and a NULL slug.
  const cfgTables = ["PodcastEditorialConfig", "PodcastProductionConfig", "PodcastPublishingConfig"];
  const cfgTablesPresent = (await Promise.all(cfgTables.map((t) => tableExists(db, t)))).every(Boolean);
  add("podcast_config_tables_present", cfgTablesPresent,
    cfgTablesPresent ? "all three podcast config tables exist" : "a podcast config table is missing — the migration did not run");

  if (await tableExists(db, "Podcast") && cfgTablesPresent) {
    const totalPods = await one(db, `SELECT COUNT(*)::int AS n FROM "Podcast"`);
    for (const [name, table] of [
      ["every_podcast_has_editorial_config", "PodcastEditorialConfig"],
      ["every_podcast_has_production_config", "PodcastProductionConfig"],
      ["every_podcast_has_publishing_config", "PodcastPublishingConfig"],
    ] as const) {
      const missing = await one(db, `SELECT COUNT(*)::int AS n FROM "Podcast" p WHERE NOT EXISTS (SELECT 1 FROM "${table}" c WHERE c."podcastId" = p."id")`);
      add(name, missing === 0,
        totalPods === 0 ? "no podcasts to back-fill"
        : missing > 0 ? `${missing}/${totalPods} podcast(s) have no ${table} row — the backfill did not complete`
        : `all ${totalPods} podcast(s) have a ${table} row`);
      // Orphan check: a config row whose podcast is gone (the FK is ON DELETE
      // CASCADE, so this must be zero).
      const orphans = await one(db, `SELECT COUNT(*)::int AS n FROM "${table}" c WHERE NOT EXISTS (SELECT 1 FROM "Podcast" p WHERE p."id" = c."podcastId")`);
      if (orphans > 0) add("podcast_config_no_orphans", false, `${orphans} orphaned ${table} row(s)`);
    }
    // If none of the three reported an orphan, record the pass once.
    if (!out.some((r) => r.name === "podcast_config_no_orphans")) {
      add("podcast_config_no_orphans", true, "no orphaned podcast config rows");
    }

    const nullSlugs = await one(db, `SELECT COUNT(*)::int AS n FROM "Podcast" WHERE "slug" IS NULL`);
    const dupeSlugs = await one(db, `SELECT COUNT(*)::int AS n FROM (SELECT "slug" FROM "Podcast" WHERE "slug" IS NOT NULL GROUP BY "slug" HAVING COUNT(*) > 1) d`);
    add("every_podcast_has_unique_slug", nullSlugs === 0 && dupeSlugs === 0,
      totalPods === 0 ? "no podcasts"
      : nullSlugs > 0 ? `${nullSlugs} podcast(s) still have a NULL slug — the backfill did not complete`
      : dupeSlugs > 0 ? `${dupeSlugs} slug value(s) are duplicated`
      : `all ${totalPods} podcast(s) have a unique, non-null slug`);
  } else {
    for (const name of ["every_podcast_has_editorial_config", "every_podcast_has_production_config", "every_podcast_has_publishing_config", "every_podcast_has_unique_slug", "podcast_config_no_orphans"]) {
      add(name, false, "Podcast or a config table is missing", true);
    }
  }

  // --- 20260717000000: audio-asset ownership backfill ----------------------
  // Schema equality is NOT sufficient: every asset could sit unclassified at
  // the fail-closed default while the columns exist.
  if (await tableExists(db, "AudioAsset")) {
    const hasScope = await one(db, `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='AudioAsset' AND column_name='scope'`);
    if (hasScope === 0) {
      for (const name of ["audio_asset_scopes_valid", "shared_system_assets_unowned", "owner_private_assets_owned", "podcast_private_assets_consistent", "seed_assets_shared_system", "seed_assets_rights_confirmed", "legacy_assets_flagged_for_review"]) {
        add(name, false, "AudioAsset.scope does not exist — the migration never ran", true);
      }
    } else {
      const total = await one(db, `SELECT COUNT(*)::int AS n FROM "AudioAsset"`);
      const badScope = await one(db, `SELECT COUNT(*)::int AS n FROM "AudioAsset" WHERE "scope" NOT IN ('shared_system','owner_private','podcast_private','legacy_global')`);
      add("audio_asset_scopes_valid", badScope === 0,
        badScope > 0 ? `${badScope} asset(s) carry an invalid scope` : `all ${total} asset scopes valid`);

      const ownedShared = await one(db, `SELECT COUNT(*)::int AS n FROM "AudioAsset" WHERE "scope"='shared_system' AND ("ownerId" IS NOT NULL OR "podcastId" IS NOT NULL)`);
      add("shared_system_assets_unowned", ownedShared === 0,
        ownedShared > 0 ? `${ownedShared} shared_system asset(s) carry an owner/podcast` : "every shared_system asset is unowned");

      const orphanOwner = await one(db, `SELECT COUNT(*)::int AS n FROM "AudioAsset" WHERE "scope"='owner_private' AND "ownerId" IS NULL`);
      add("owner_private_assets_owned", orphanOwner === 0,
        orphanOwner > 0 ? `${orphanOwner} owner_private asset(s) have no owner (orphaned by user deletion — fail-closed, needs admin review)` : "every owner_private asset has an owner");

      const badPodcastPrivate = await one(db, `
        SELECT COUNT(*)::int AS n FROM "AudioAsset" a
        WHERE a."scope"='podcast_private' AND (
          a."ownerId" IS NULL OR a."podcastId" IS NULL
          OR EXISTS (SELECT 1 FROM "Podcast" p WHERE p."id" = a."podcastId" AND p."ownerId" IS DISTINCT FROM a."ownerId")
        )`);
      add("podcast_private_assets_consistent", badPodcastPrivate === 0,
        badPodcastPrivate > 0 ? `${badPodcastPrivate} podcast_private asset(s) violate owner/podcast consistency` : "every podcast_private asset matches its podcast's owner");

      // CURRENT (non-superseded) seed assets must be shared_system + confirmed.
      const hasSuperseded = await one(db, `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='AudioAsset' AND column_name='supersededByAssetId'`);
      const supersededClause = hasSuperseded > 0 ? `AND "supersededByAssetId" IS NULL` : "";
      const badSeeds = await one(db, `SELECT COUNT(*)::int AS n FROM "AudioAsset" WHERE "source"='seed' ${supersededClause} AND "scope" <> 'shared_system'`);
      add("seed_assets_shared_system", badSeeds === 0,
        badSeeds > 0 ? `${badSeeds} current seed asset(s) are not shared_system` : "every current seed asset is shared_system");
      const seedRights = await one(db, `SELECT COUNT(*)::int AS n FROM "AudioAsset" WHERE "source"='seed' ${supersededClause} AND "rightsStatus" <> 'confirmed'`);
      add("seed_assets_rights_confirmed", seedRights === 0,
        seedRights > 0 ? `${seedRights} current seed asset(s) lack confirmed rights` : "every current seed asset has confirmed rights");

      const unflaggedLegacy = await one(db, `SELECT COUNT(*)::int AS n FROM "AudioAsset" WHERE "scope"='legacy_global' AND "legacyScopeReviewRequired" = false`);
      add("legacy_assets_flagged_for_review", unflaggedLegacy === 0,
        unflaggedLegacy > 0 ? `${unflaggedLegacy} legacy_global asset(s) are not flagged for ownership review` : "every legacy_global asset is flagged for review");
    }
  } else {
    for (const name of ["audio_asset_scopes_valid", "shared_system_assets_unowned", "owner_private_assets_owned", "podcast_private_assets_consistent", "seed_assets_shared_system", "seed_assets_rights_confirmed", "legacy_assets_flagged_for_review"]) {
      add(name, false, "AudioAsset does not exist", true);
    }
  }

  // Episode.configurationSource must exist and never be NULL (it has a default).
  if (await tableExists(db, "Episode")) {
    const hasCol = await one(db, `SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_name='Episode' AND column_name='configurationSource'`);
    if (hasCol === 0) {
      add("episodes_have_configuration_source", false, "Episode.configurationSource does not exist — the migration never ran", true);
    } else {
      const nulls = await one(db, `SELECT COUNT(*)::int AS n FROM "Episode" WHERE "configurationSource" IS NULL`);
      add("episodes_have_configuration_source", nulls === 0,
        nulls > 0 ? `${nulls} episode(s) have a NULL configurationSource` : "every episode has a configurationSource (legacy episodes correctly read 'legacy')");
    }
  } else {
    add("episodes_have_configuration_source", false, "Episode does not exist", true);
  }

  return out;
}
