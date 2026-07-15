// E2E lifecycle safety test. Run: npm run test:e2e-lifecycle
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any -- test harness */
//
// PROVES the Playwright teardown is SCOPED: it stops only the exact embedded
// Postgres instance the run created, and leaves every OTHER Postgres on the
// machine alone. (The previous teardown ran `taskkill /IM postgres.exe /F`,
// which would kill unrelated dev/production-like databases — this test is the
// regression guard for that.)

import path from "path";
import os from "os";
import fs from "fs";
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");
import { execSync } from "child_process";
import { trackPg, stopRuntime, freePort, portInUse } from "../../tests/e2e/runtime";

/** Direct children of a pid (same technique the teardown uses). */
function childPids(pid: number): number[] {
  try {
    if (process.platform === "win32") {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object -ExpandProperty ProcessId"`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => !!n && !Number.isNaN(n));
    }
    return execSync(`pgrep -P ${pid}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => !!n && !Number.isNaN(n));
  } catch { return []; }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function ok(n: string) { passed++; console.log(`  ✓ ${n}`); }
function bad(n: string, e: unknown) { failed++; console.error(`  ✗ ${n}\n      ${(e as Error)?.message || e}`); }

async function bootPg(label: string) {
  const port = await freePort();
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `pod-${label}-`)), "data");
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("db");
  return { pg, port, dir };
}

async function canQuery(pg: any): Promise<boolean> {
  try {
    const client = pg.getPgClient("db");
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch { return false; }
}

async function main() {
  console.log("E2E lifecycle safety (scoped teardown):");

  // An UNRELATED Postgres — stands in for the developer's own database.
  const bystander = await bootPg("bystander");
  // The Postgres the "E2E run" owns.
  const owned = await bootPg("owned");
  trackPg(owned.pg, path.dirname(owned.dir), owned.dir);
  // Snapshot our cluster's own processes so we can prove none are orphaned.
  const ownedPostmaster = Number(fs.readFileSync(path.join(owned.dir, "postmaster.pid"), "utf8").split("\n")[0].trim());
  const ownedKids = childPids(ownedPostmaster);
  const bystanderPostmaster = Number(fs.readFileSync(path.join(bystander.dir, "postmaster.pid"), "utf8").split("\n")[0].trim());

  try {
    try {
      assert(await canQuery(bystander.pg), "bystander is up before teardown");
      assert(await canQuery(owned.pg), "owned instance is up before teardown");
      ok("both Postgres instances are running before teardown");
    } catch (e) { bad("both Postgres instances are running before teardown", e); }

    // The exact teardown Playwright runs.
    await stopRuntime();

    try {
      assert(!(await portInUse(owned.port)), `owned instance (port ${owned.port}) was stopped`);
      ok("teardown STOPPED the instance this run created");
    } catch (e) { bad("teardown STOPPED the instance this run created", e); }

    try {
      assert(await portInUse(bystander.port), `bystander (port ${bystander.port}) must still be listening`);
      assert(await canQuery(bystander.pg), "bystander must still accept queries");
      ok("teardown left the UNRELATED Postgres running (never killed by image name)");
    } catch (e) { bad("teardown left the UNRELATED Postgres running (never killed by image name)", e); }

    try {
      assert(ownedKids.length > 0, "our postmaster had child processes to reap (sanity)");
      const survivors = ownedKids.filter(alive);
      assert(survivors.length === 0, `no orphaned children of OUR postmaster remain (survivors: ${survivors.join(", ")})`);
      assert(!alive(ownedPostmaster), "our postmaster is gone");
      ok("teardown left NO orphaned postgres child processes (PG18 io_workers reaped)");
    } catch (e) { bad("teardown left NO orphaned postgres child processes (PG18 io_workers reaped)", e); }

    try {
      assert(alive(bystanderPostmaster), "the unrelated postmaster process is untouched");
      ok("the unrelated Postgres process itself was never signalled");
    } catch (e) { bad("the unrelated Postgres process itself was never signalled", e); }

    try {
      assert(!fs.existsSync(path.dirname(owned.dir)), "owned data dir removed");
      ok("teardown cleaned up its temporary data directory");
    } catch (e) { bad("teardown cleaned up its temporary data directory", e); }

    try {
      await stopRuntime(); // idempotent / safe after partial setup
      ok("teardown is safe to run twice (idempotent)");
    } catch (e) { bad("teardown is safe to run twice (idempotent)", e); }
  } finally {
    await bystander.pg.stop().catch(() => {});
    try { fs.rmSync(path.dirname(bystander.dir), { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
