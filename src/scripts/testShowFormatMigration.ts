// Show-format cast BACKFILL migration test. Run: npm run test:show-format-migration
//
// THE ONE THING THIS PROVES: migration 20260718000000 stamps every existing
// Episode with the format that actually built it (two_host_debate), mirrors
// pinned legacy hostIds into normalized EpisodeCastMember rows in seat order
// (chair_a then chair_b), leaves auto-cast (empty-pin) episodes honestly
// row-less, skips vanished hosts, destroys nothing, and is idempotent.
//
// Embedded PostgreSQL; no network.

import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { runDataInvariants } from "../lib/services/migrationCheckpoints";

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

const MIGRATION = "20260718000000_add_show_format_cast";

function backfillStatements(): string[] {
  const file = fs.readFileSync(path.join(process.cwd(), "prisma", "migrations", MIGRATION, "migration.sql"), "utf8");
  const start = file.indexOf("-- 2. Backfill");
  assert(start > 0, "backfill section found");
  return file.slice(start).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}

async function main() {
  console.log("\nShow-format cast backfill migration\n");
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-fmtmig-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("fmtmig");
  const dbUrl = `postgresql://postgres:postgres@localhost:${port}/fmtmig`;
  const env = { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" as const };
  execSync("npx prisma migrate deploy", { env, stdio: ["ignore", "pipe", "pipe"] });

  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  const exec = async (sql: string) => { await db.$executeRawUnsafe(sql); };

  try {
    // Legacy-shaped rows: hosts + episodes with pinned/empty/vanished casts.
    await exec(`INSERT INTO "AiHost" ("id","name","slug","role","worldview","speakingStyle","catchphrases","likes","dislikes","argumentPatterns","bannedPhrases","intensityLevel","ttsProvider","ttsVoiceId","isActive","createdAt","updatedAt")
      VALUES ('h-a','Blaze','blaze','host','w','s','[]','[]','[]','[]','[]',9,'stub','v',true,now(),now()),
             ('h-b','Calm','calm','host','w','s','[]','[]','[]','[]','[]',3,'stub','v',true,now(),now())`);
    await exec(`INSERT INTO "Episode" ("id","title","slug","status","hostIds","audioMimeType","explicit","configurationSource","formatId","createdAt","updatedAt")
      VALUES ('ep-pinned','P','ep-p','completed', ARRAY['h-a','h-b'], 'audio/mpeg', false, 'legacy', 'two_host_debate', now(), now()),
             ('ep-empty','E','ep-e','completed', ARRAY[]::text[], 'audio/mpeg', false, 'legacy', 'two_host_debate', now(), now()),
             ('ep-ghost','G','ep-g','completed', ARRAY['h-gone','h-a'], 'audio/mpeg', false, 'legacy', 'two_host_debate', now(), now())`);

    const statements = backfillStatements();
    const run = async () => { for (const s of statements) await exec(s); };
    await run();

    await check("pinned casts are mirrored in seat order with debate roles", async () => {
      const rows = await db.episodeCastMember.findMany({ where: { episodeId: "ep-pinned" }, orderBy: { orderIndex: "asc" } });
      assert(rows.length === 2, `2 rows (got ${rows.length})`);
      assert(rows[0].hostId === "h-a" && rows[0].role === "chair_a" && rows[0].orderIndex === 0, "seat 0 = chair_a");
      assert(rows[1].hostId === "h-b" && rows[1].role === "chair_b" && rows[1].orderIndex === 1, "seat 1 = chair_b");
    });

    await check("empty-pin episodes honestly get NO cast rows (auto-cast at build)", async () => {
      assert((await db.episodeCastMember.count({ where: { episodeId: "ep-empty" } })) === 0, "no fabricated cast");
    });

    await check("vanished hosts are skipped, surviving seats kept with original seat index", async () => {
      const rows = await db.episodeCastMember.findMany({ where: { episodeId: "ep-ghost" } });
      assert(rows.length === 1 && rows[0].hostId === "h-a" && rows[0].orderIndex === 1, "only the surviving host, at its true seat");
    });

    await check("every episode carries formatId two_host_debate (the format that built it)", async () => {
      assert((await db.episode.count({ where: { formatId: "two_host_debate" } })) === 3, "all stamped by the column default");
    });

    await check("nothing is destroyed: legacy hostIds arrays intact", async () => {
      const ep = await db.episode.findUnique({ where: { id: "ep-pinned" } });
      assert(JSON.stringify(ep!.hostIds) === JSON.stringify(["h-a", "h-b"]), "legacy mirror untouched");
    });

    await check("re-running the backfill is idempotent", async () => {
      const before = await db.episodeCastMember.count();
      await run();
      assert((await db.episodeCastMember.count()) === before, "no duplicates on re-run");
    });

    await check("the migration's data invariants pass", async () => {
      const results = await runDataInvariants(db as never);
      const mine = results.filter((r) => ["episodes_have_format", "cast_rows_mirror_pinned_hostids", "cast_seat_order_consistent"].includes(r.name));
      assert(mine.length === 3, "3 invariants ran");
      const failing = mine.filter((r) => !r.ok && !r.inconclusive);
      assert(failing.length === 0, `failing: ${failing.map((f) => `${f.name}: ${f.detail}`).join("; ")}`);
    });

    await check("`migrate status` stays clean", () => {
      const status = execSync("npx prisma migrate status", { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert(/up to date|No pending/i.test(status), "clean");
    });

  } finally {
    await db.$disconnect();
    await pg.stop().catch(() => {});
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}
main().catch((err) => { console.error(err); process.exit(1); });
