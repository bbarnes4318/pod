// READ-ONLY migration-adoption auditor. Run: npm run audit:migration-adoption
//
// Answers one question about the database in DATABASE_URL: can Prisma safely
// take over its migration history, and if so, exactly how?
//
// WHY IT IS NEEDED
// This project's databases were created with `prisma db push`, which builds the
// schema without recording anything in `_prisma_migrations`. Prisma then sees a
// database it has no history for, and the tempting fix is
// `migrate resolve --applied` on everything until it stops complaining. That is
// how you lose data: some migrations do work no schema comparison can see (the
// legacy 'used' status conversion, the selectedAt/snapshot backfills), so a
// database can have a perfect schema and still have never had those steps run.
// Marking them applied freezes the corruption and certifies it as fine.
//
// SO THIS TOOL NEVER ACTS. It has no write path at all: no migrate resolve, no
// migrate deploy, no DDL, no UPDATE. It reads, it reasons, and it prints a plan
// a human executes after taking a backup. Every proposed command is labelled
// PROPOSED ONLY -- NOT EXECUTED.

import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import {
  MIGRATION_CHECKPOINTS, EXPECTED_MIGRATION_COUNT, BASELINE_MIGRATION,
  DATA_BEARING_MIGRATIONS, runDataInvariants, type InvariantResult,
} from "../lib/services/migrationCheckpoints";

type Verdict = "READY FOR MIGRATE DEPLOY" | "ADOPTION POSSIBLE" | "ADOPTION BLOCKED" | "MANUAL DATABASE REVIEW REQUIRED";

interface MigrationRow {
  migration_name: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  applied_steps_count: number;
}

/** Host/database only. NEVER the user, password, or query string. */
function sanitizedTarget(raw: string | undefined): string {
  if (!raw) return "(DATABASE_URL is not set)";
  try {
    const u = new URL(raw);
    const db = u.pathname.replace(/^\//, "") || "(none)";
    return `${u.hostname}:${u.port || "5432"}/${db}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

const line = (s = "") => console.log(s);
const h = (s: string) => { line(); line(s); line("-".repeat(s.length)); };

async function main() {
  const url = process.env.DATABASE_URL;
  line();
  line("Migration adoption audit -- READ ONLY. Nothing is modified.");
  line(`Target: ${sanitizedTarget(url)}`);

  if (!url) {
    line("\nDATABASE_URL is not set. Nothing to audit.");
    process.exit(1);
  }

  const db = new PrismaClient({ datasources: { db: { url } } });
  const q = <T,>(sql: string) => db.$queryRawUnsafe<T>(sql);

  const blockers: string[] = [];
  let verdict: Verdict = "MANUAL DATABASE REVIEW REQUIRED";

  try {
    // ---- Server identity, sanitized ------------------------------------
    const server = await q<Array<{ version: string; db: string; usr: string }>>(
      `SELECT version() AS version, current_database() AS db, current_user AS usr`
    );
    h("Server");
    line(`  engine ......... ${server[0].version.split(" ").slice(0, 2).join(" ")}`);
    line(`  database ....... ${server[0].db}`);
    // The ROLE is operationally useful and is not a secret; the password never
    // appears anywhere in this output.
    line(`  role ........... ${server[0].usr}`);

    // ---- _prisma_migrations --------------------------------------------
    const hasTable = await q<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='_prisma_migrations'`
    );
    const historyExists = hasTable[0].n > 0;

    let rows: MigrationRow[] = [];
    if (historyExists) {
      rows = await q<MigrationRow[]>(
        `SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
           FROM "_prisma_migrations" ORDER BY started_at ASC`
      );
    }

    const applied = rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
    const failed = rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
    const rolledBack = rows.filter((r) => r.rolled_back_at).map((r) => r.migration_name);
    const expected = MIGRATION_CHECKPOINTS.map((m) => m.name);
    const missing = expected.filter((m) => !applied.includes(m));
    const unknown = applied.filter((m) => !expected.includes(m));

    h("Migration history");
    line(`  _prisma_migrations ... ${historyExists ? "present" : "ABSENT (this database was almost certainly built with `db push`)"}`);
    line(`  applied .............. ${applied.length}`);
    line(`  expected ............. ${EXPECTED_MIGRATION_COUNT}`);
    line(`  missing records ...... ${missing.length}${missing.length ? ` (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""})` : ""}`);
    line(`  failed ............... ${failed.length}${failed.length ? ` (${failed.join(", ")})` : ""}`);
    line(`  rolled back .......... ${rolledBack.length}${rolledBack.length ? ` (${rolledBack.join(", ")})` : ""}`);
    if (unknown.length) line(`  UNKNOWN to this repo .. ${unknown.join(", ")}`);

    // ---- Schema drift ---------------------------------------------------
    // migrate diff is read-only: it inspects and prints, it never applies.
    let driftScript = "";
    let drifted = false;
    try {
      execSync(`npx prisma migrate diff --from-url "${url}" --to-schema-datamodel prisma/schema.prisma --exit-code`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      drifted = true;
      try {
        driftScript = execSync(`npx prisma migrate diff --from-url "${url}" --to-schema-datamodel prisma/schema.prisma --script`,
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      } catch { driftScript = "(could not render the drift script)"; }
    }

    // ---- Which checkpoint does the schema match? ------------------------
    const tables = await q<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name NOT LIKE '\\_prisma%'`
    );
    const tableCount = tables[0].n;
    const emptyDb = tableCount === 0;

    let checkpoint: string;
    if (emptyDb) checkpoint = "EMPTY DATABASE";
    else if (!drifted) checkpoint = "CURRENT SCHEMA (prisma/schema.prisma)";
    else {
      // Is it the baseline exactly? Compare against the baseline's own tables.
      const hasLater = await q<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables
          WHERE table_schema='public' AND table_name IN ('Podcast','StudioDraft','AdminDraft','TopicSource','SocialClip','PlayEvent')`
      );
      checkpoint = hasLater[0].n === 0 ? `BASELINE (${BASELINE_MIGRATION}) or near it` : "AN INTERMEDIATE / UNKNOWN POINT";
    }

    h("Schema");
    line(`  tables ............... ${tableCount}`);
    line(`  drift vs schema.prisma ${drifted ? "YES" : "none"}`);
    line(`  matches .............. ${checkpoint}`);
    if (drifted && driftScript.trim()) {
      line();
      line("  Drift (what would have to change to reach prisma/schema.prisma):");
      for (const l of driftScript.trim().split("\n").slice(0, 24)) line(`    ${l}`);
    }

    // ---- Data invariants -------------------------------------------------
    // The crux: schema equality is necessary, never sufficient.
    const invariants: InvariantResult[] = emptyDb ? [] : await runDataInvariants(db);
    const failedInv = invariants.filter((i) => !i.ok && !i.inconclusive);
    const inconclusive = invariants.filter((i) => i.inconclusive);

    h("Data invariants (what schema comparison CANNOT prove)");
    if (emptyDb) {
      line("  (skipped -- the database is empty)");
    } else {
      for (const i of invariants) {
        const mark = i.inconclusive ? "?" : i.ok ? "ok  " : "FAIL";
        line(`  [${mark}] ${i.name.padEnd(26)} ${i.detail}`);
      }
      line();
      line(`  ${DATA_BEARING_MIGRATIONS.length} migration(s) carry data effects a matching schema does NOT prove:`);
      for (const m of DATA_BEARING_MIGRATIONS) line(`    - ${m.name}`);
    }

    // ---- Verdict ---------------------------------------------------------
    if (failed.length > 0) {
      verdict = "MANUAL DATABASE REVIEW REQUIRED";
      blockers.push(`${failed.length} migration(s) are recorded as FAILED. A failed record means a migration stopped part-way; the database may be half-changed. Resolve the underlying failure, never the record.`);
    } else if (rolledBack.length > 0) {
      verdict = "MANUAL DATABASE REVIEW REQUIRED";
      blockers.push(`${rolledBack.length} migration(s) are recorded as ROLLED BACK. Establish what was undone before adopting.`);
    } else if (unknown.length > 0) {
      verdict = "MANUAL DATABASE REVIEW REQUIRED";
      blockers.push(`The database records migration(s) this repository does not contain (${unknown.join(", ")}). It may belong to a different or newer deployment.`);
    } else if (emptyDb) {
      verdict = "READY FOR MIGRATE DEPLOY";
    } else if (historyExists && missing.length === 0 && !drifted) {
      // Scenario A
      verdict = "READY FOR MIGRATE DEPLOY";
    } else if (drifted && checkpoint === "AN INTERMEDIATE / UNKNOWN POINT") {
      // Scenario E
      verdict = "MANUAL DATABASE REVIEW REQUIRED";
      blockers.push("The schema matches no known checkpoint. Adoption cannot be reasoned about safely from here.");
    } else if (!drifted && missing.length > 0) {
      // Scenario C: schema matches current, history absent/partial.
      if (failedInv.length > 0) {
        verdict = "ADOPTION BLOCKED";
        blockers.push(
          `The schema matches, but ${failedInv.length} data invariant(s) FAIL: ${failedInv.map((i) => i.name).join(", ")}. ` +
          `This is exactly the case marking migrations applied would hide -- the tables look right while the row-level work never happened.`
        );
      } else if (inconclusive.length > 0) {
        verdict = "ADOPTION BLOCKED";
        blockers.push(`${inconclusive.length} invariant(s) could not be evaluated (${inconclusive.map((i) => i.name).join(", ")}). Adoption requires a definite answer, not an absent one.`);
      } else {
        verdict = "ADOPTION POSSIBLE";
      }
    } else if (drifted && checkpoint.startsWith("BASELINE")) {
      // Scenario B
      verdict = "ADOPTION POSSIBLE";
    } else if (historyExists && missing.length > 0 && drifted) {
      // Scenario D
      verdict = "ADOPTION BLOCKED";
      blockers.push("Partial history AND schema drift. The recorded history and the actual schema disagree; reconcile them by hand before adopting.");
    }

    h("VERDICT");
    line(`  ${verdict}`);
    for (const b of blockers) line(`\n  BLOCKER: ${b}`);

    // ---- Plan (never executed) ------------------------------------------
    if (verdict === "ADOPTION POSSIBLE") {
      h("PROPOSED ADOPTION PLAN -- PROPOSED ONLY -- NOT EXECUTED");
      line("  Preconditions (all mandatory, in this order):");
      line("    1. Take a full database backup and VERIFY it restores. There is no undo.");
      line("    2. Put the application in maintenance mode.");
      line("    3. Pause the queue workers and every scheduler, so nothing writes mid-adoption.");
      line("    4. Confirm one person owns this migration run (the single migration owner).");
      line();
      line(`  Schema checkpoint detected: ${checkpoint}`);
      line(`  Data invariants checked: ${invariants.length} (${invariants.filter((i) => i.ok).length} passing)`);
      line();
      if (checkpoint.startsWith("BASELINE")) {
        line("  This database matches the BASELINE. Mark ONLY the baseline applied, then let");
        line("  every later migration actually RUN -- they still have real work to do here:");
        line();
        line(`    npx prisma migrate resolve --applied ${BASELINE_MIGRATION}`);
        line("    npx prisma migrate deploy");
        line();
        line("  Migrations that must genuinely run: all of them after the baseline.");
      } else {
        line("  This database already matches the CURRENT schema and every data invariant");
        line("  passes, so each migration's effects are demonstrably already present.");
        line("  Mark them applied so Prisma's history matches reality:");
        line();
        for (const m of MIGRATION_CHECKPOINTS) line(`    npx prisma migrate resolve --applied ${m.name}`);
        line();
        line("  Migrations that must genuinely run: none.");
        line("  Every one above was verified present by schema AND invariant, not assumed.");
      }
      line();
      line("  Post-adoption verification:");
      line("    npx prisma migrate status                 # expect: no pending, no failed");
      line("    npm run audit:migration-adoption          # expect: READY FOR MIGRATE DEPLOY");
      line("    npx prisma migrate diff --from-url \"$DATABASE_URL\" \\");
      line("      --to-schema-datamodel prisma/schema.prisma --exit-code   # expect: no drift");
      line();
      line("  STOP immediately if: any command errors, the backup is unverified, drift appears,");
      line("  an invariant flips to failing, or anything below disagrees with this report.");
      line();
      line("  NOTHING ABOVE HAS BEEN RUN. Copy the commands deliberately, one at a time.");
    } else if (verdict === "READY FOR MIGRATE DEPLOY") {
      h("NEXT STEP");
      line("  This database's history is consistent. The normal release command applies");
      line("  any pending migrations:");
      line();
      line("    npx prisma migrate deploy");
      line();
      line("  (Still take a backup first, and still keep one migration owner.)");
    } else {
      h("NO PLAN OFFERED");
      line("  Adoption is not demonstrably safe from this state, so no commands are proposed.");
      line("  Do NOT run `migrate resolve` to make the error go away -- that records a claim");
      line("  about the database that this audit could not verify.");
    }

    line();
    line("This audit made no changes. It ran only SELECTs and `prisma migrate diff`,");
    line("both of which are read-only.");
    line();
  } finally {
    await db.$disconnect();
  }

  // Non-zero exit on an unsafe verdict so CI can gate on it.
  if (verdict === "ADOPTION BLOCKED" || verdict === "MANUAL DATABASE REVIEW REQUIRED") process.exit(2);
}

main().catch((err) => {
  // Never let a stack trace print a connection string.
  console.error(`\nAudit failed: ${(err as Error).message.replace(/postgres(ql)?:\/\/[^\s"']+/gi, "postgresql://<redacted>")}`);
  process.exit(1);
});
