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

  return out;
}
