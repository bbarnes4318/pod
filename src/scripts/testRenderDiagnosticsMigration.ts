// Render-diagnostics migration test. Run: npm run test:render-diagnostics-migration
//
// Proves the additive 20260718120000_add_render_diagnostics migration:
//   * applies cleanly from an EMPTY database (full history via migrate deploy);
//   * adds EpisodeAudioRender.diagnostics as a NULLABLE jsonb column;
//   * is idempotent (ADD COLUMN IF NOT EXISTS re-runs without error);
//   * stores/returns JSON and leaves historical rows NULL (no backfill);
//   * leaves the schema drift-free (prisma migrate diff --exit-code) and
//     migrate status clean.
//
// Embedded PostgreSQL; no ffmpeg, no storage, no network, no paid APIs.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function main() {
  console.log("\nRender diagnostics migration (additive, idempotent, drift-free)\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-diag-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("diag");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/diag`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" } as NodeJS.ProcessEnv;

  // Mission test 36: applies from an empty database (full migration history).
  execSync("npx prisma migrate deploy", { env, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  try {
    await check("diagnostics column exists as a NULLABLE jsonb on EpisodeAudioRender", async () => {
      const rows = await db.$queryRawUnsafe<Array<{ column_name: string; is_nullable: string; data_type: string }>>(
        `SELECT column_name, is_nullable, data_type FROM information_schema.columns
         WHERE table_name = 'EpisodeAudioRender' AND column_name = 'diagnostics'`
      );
      assert(rows.length === 1, "column present");
      assert(rows[0].is_nullable === "YES", "column is nullable");
      assert(rows[0].data_type === "jsonb", `column is jsonb (got ${rows[0].data_type})`);
    });

    await check("Test 38: the migration is idempotent (ADD COLUMN IF NOT EXISTS re-runs cleanly)", async () => {
      await db.$executeRawUnsafe(`ALTER TABLE "EpisodeAudioRender" ADD COLUMN IF NOT EXISTS "diagnostics" JSONB;`);
      // running the exact migration SQL file again must also be a no-op
      const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20260718120000_add_render_diagnostics/migration.sql"), "utf8");
      for (const stmt of sql.split(";").map((s) => s.trim()).filter((s) => s && !s.startsWith("--"))) {
        await db.$executeRawUnsafe(stmt);
      }
    });

    await check("the column stores JSON and defaults to NULL for rows that omit it", async () => {
      const ep = await db.episode.create({ data: { title: "Diag Ep", slug: `diag-${port}`, status: "audio_ready" } });
      const withDiag = await db.episodeAudioRender.create({
        data: { episodeId: ep.id, renderVersion: 1, status: "succeeded", renderMode: "initial", diagnostics: { version: 1, hello: "world" } as object },
      });
      const withoutDiag = await db.episodeAudioRender.create({
        data: { episodeId: ep.id, renderVersion: 2, status: "succeeded", renderMode: "initial" },
      });
      const a = await db.episodeAudioRender.findUnique({ where: { id: withDiag.id } });
      const b = await db.episodeAudioRender.findUnique({ where: { id: withoutDiag.id } });
      // jsonb does not preserve key insertion order — compare by field, not by
      // stringified bytes.
      const diag = a?.diagnostics as { version?: number; hello?: string } | null;
      assert(diag?.version === 1 && diag?.hello === "world", "diagnostics JSON round-trips");
      assert(b?.diagnostics === null, "omitted diagnostics defaults to NULL (no backfill)");
    });

    await check("Test 39: schema has zero drift against the migration history", () => {
      // exit 0 = no drift; exit 2 = drift (execSync throws on non-zero).
      execSync(
        `npx prisma migrate diff --from-url "${dbUrl}" --to-schema-datamodel prisma/schema.prisma --exit-code`,
        { env, stdio: ["ignore", "pipe", "pipe"] }
      );
    });

    await check("Test 37: migrate status is clean (all migrations applied)", () => {
      execSync("npx prisma migrate status", { env, stdio: ["ignore", "pipe", "pipe"] });
    });
  } finally {
    await db.$disconnect();
    await pg.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
