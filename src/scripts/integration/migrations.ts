// Migration integrity against a REAL PostgreSQL that started empty.
//
// `prisma migrate deploy` succeeding is necessary but not sufficient: it does
// not prove the migrations describe the same schema as prisma/schema.prisma,
// and it does not prove the repo's own manifest knows about them. Both are
// checked here, on the real migrated database.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MIGRATION_CHECKPOINTS } from "../../lib/services/migrationCheckpoints";
import { check, summarize, withPrisma, requireEnv } from "./helpers";

async function main() {
  const databaseUrl = requireEnv("DATABASE_URL");
  console.log("\nMigration integrity (real PostgreSQL)\n");

  const dir = path.resolve(process.cwd(), "prisma/migrations");
  const onDisk = fs
    .readdirSync(dir)
    .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
    .sort();

  await check("every migration on disk is APPLIED and finished", async () => {
    await withPrisma(async (db) => {
      const rows = await db.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null }>>(
        `SELECT migration_name, finished_at FROM "_prisma_migrations"`
      );
      const applied = new Set(rows.filter((r) => r.finished_at).map((r) => r.migration_name));
      const unfinished = rows.filter((r) => !r.finished_at).map((r) => r.migration_name);
      if (unfinished.length) throw new Error(`recorded but never finished: ${unfinished.join(", ")}`);
      const missing = onDisk.filter((m) => !applied.has(m));
      if (missing.length) throw new Error(`on disk but not applied: ${missing.join(", ")}`);
      console.log(`       ${applied.size} migration(s) applied from empty`);
    });
  });

  await check("the migrated database has NO DRIFT from prisma/schema.prisma", async () => {
    // `migrate diff` exits 2 when there IS a difference (--exit-code), which is
    // exactly the failure we want: a migration whose SQL does not reproduce the
    // schema every other test is written against.
    const r = spawnSync(
      "npx",
      [
        "prisma", "migrate", "diff",
        "--from-url", databaseUrl,
        "--to-schema-datamodel", "prisma/schema.prisma",
        "--exit-code",
      ],
      { encoding: "utf8", shell: process.platform === "win32" }
    );
    if (r.status === 0) return; // no difference
    const detail = `${r.stdout || ""}${r.stderr || ""}`.trim().slice(0, 1500);
    throw new Error(`schema drift between the migrations and schema.prisma:\n${detail}`);
  });

  await check("the migration manifest registers every migration directory", () => {
    const registered = MIGRATION_CHECKPOINTS.map((m) => m.name).sort();
    const unregistered = onDisk.filter((d) => !registered.includes(d));
    const phantom = registered.filter((d) => !onDisk.includes(d));
    if (unregistered.length) {
      throw new Error(
        `migration(s) missing a checkpoint entry in migrationCheckpoints.ts: ${unregistered.join(", ")}`
      );
    }
    if (phantom.length) {
      throw new Error(`checkpoint entries with no migration directory: ${phantom.join(", ")}`);
    }
  });

  await check("the new tables in this release actually exist", async () => {
    await withPrisma(async (db) => {
      const expected = ["ScriptLegacyRelease", "VoiceAudition", "ListenerLearningEvent"];
      const rows = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
      );
      const present = new Set(rows.map((r) => r.table_name));
      const missing = expected.filter((t) => !present.has(t));
      if (missing.length) throw new Error(`missing table(s) after migrate deploy: ${missing.join(", ")}`);
    });
  });

  summarize("Migration integrity");
}

main();
