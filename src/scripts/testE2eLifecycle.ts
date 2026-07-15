// E2E lifecycle safety test. Run: npm run test:e2e-lifecycle
/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any -- test harness */
//
// PROVES both teardown paths are SCOPED — they stop only what the run created:
//
//   1. stopRuntime()          — in-memory handles (graceful pg.stop + our tree)
//   2. stopRuntimeFromFile()  — the DURABLE runtime-file fallback, which is what
//                               actually runs under Playwright (globalSetup and
//                               globalTeardown load in separate module registries)
//
// The previous teardown ran `taskkill /IM postgres.exe /F`, which would kill
// EVERY Postgres on the machine. These are the regression guards for that, plus
// for the POSIX process-group path (killing the bare shell PID would leave
// npx/node/next descendants alive).

import path from "path";
import os from "os";
import fs from "fs";
import { spawn, execSync } from "child_process";
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");
import { trackPg, stopRuntime, stopRuntimeFromFile, persistRuntimeInfo, freePort, portInUse } from "../../tests/e2e/runtime";

let passed = 0, failed = 0;
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
function ok(n: string) { passed++; console.log(`  + ${n}`); }
function bad(n: string, e: unknown) { failed++; console.error(`  x ${n}\n      ${(e as Error)?.message || e}`); }

const IS_WIN = process.platform === "win32";
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Direct children of a pid (same technique the teardown uses). */
function childPids(pid: number): number[] {
  try {
    if (IS_WIN) {
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

/**
 * A long-lived process that itself spawns a long-lived child, mirroring how the
 * harness spawns a shell that spawns npx -> node -> next. Detached on POSIX so
 * it leads its own process group (exactly like the real Next spawn).
 */
function spawnParentWithChild(): Promise<{ parentPid: number; childPid: number; proc: ReturnType<typeof spawn> }> {
  const script =
    "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});" +
    "process.stdout.write(String(c.pid)+'\\n');setInterval(()=>{},1e9);";
  const proc = spawn(process.execPath, ["-e", script], {
    detached: !IS_WIN, // POSIX: own process group, like the real Next spawn
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stdout!.on("data", (d) => {
      buf += String(d);
      if (buf.includes("\n")) resolve({ parentPid: proc.pid!, childPid: Number(buf.trim()), proc });
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("child pid not reported in time")), 10000);
  });
}

async function main() {
  console.log("E2E lifecycle safety (scoped teardown):");

  /* =====================================================================
   * PART 1 — stopRuntime(): in-memory path (Postgres scoping)
   * ===================================================================== */
  const bystanderPg = await bootPg("bystander");   // stands in for a dev database
  const ownedPg = await bootPg("owned");
  trackPg(ownedPg.pg, path.dirname(ownedPg.dir), ownedPg.dir);
  const ownedPostmaster = Number(fs.readFileSync(path.join(ownedPg.dir, "postmaster.pid"), "utf8").split("\n")[0].trim());
  const ownedKids = childPids(ownedPostmaster);
  const bystanderPostmaster = Number(fs.readFileSync(path.join(bystanderPg.dir, "postmaster.pid"), "utf8").split("\n")[0].trim());

  try {
    try {
      assert(await canQuery(bystanderPg.pg), "bystander up");
      assert(await canQuery(ownedPg.pg), "owned up");
      ok("stopRuntime: both Postgres instances running before teardown");
    } catch (e) { bad("stopRuntime: both Postgres instances running before teardown", e); }

    await stopRuntime();

    try {
      assert(!(await portInUse(ownedPg.port)), `owned instance (port ${ownedPg.port}) stopped`);
      assert(!alive(ownedPostmaster), "our postmaster is gone");
      const survivors = ownedKids.filter(alive);
      assert(survivors.length === 0, `no orphaned children of OUR postmaster (survivors: ${survivors.join(", ")})`);
      ok("stopRuntime: stopped OUR Postgres and reaped its own children");
    } catch (e) { bad("stopRuntime: stopped OUR Postgres and reaped its own children", e); }

    try {
      assert(alive(bystanderPostmaster), "unrelated postmaster untouched");
      assert(await portInUse(bystanderPg.port), "unrelated Postgres still listening");
      assert(await canQuery(bystanderPg.pg), "unrelated Postgres still accepts queries");
      ok("stopRuntime: UNRELATED Postgres survives (never killed by image name)");
    } catch (e) { bad("stopRuntime: UNRELATED Postgres survives (never killed by image name)", e); }

    try {
      assert(!fs.existsSync(path.dirname(ownedPg.dir)), "owned temp dir removed");
      await stopRuntime(); // idempotent
      ok("stopRuntime: temp dir removed and re-running is safe");
    } catch (e) { bad("stopRuntime: temp dir removed and re-running is safe", e); }

    /* ===================================================================
     * PART 2 — stopRuntimeFromFile(): the DURABLE fallback (what really runs)
     * =================================================================== */
    const owned = await spawnParentWithChild();      // ours: parent + descendant
    const bystanderProc = await spawnParentWithChild(); // unrelated: must survive
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-e2e-fileteardown-"));
    fs.writeFileSync(path.join(tmpRoot, "marker.txt"), "temporary resource");
    const runtimeFile = path.join(tmpRoot, "runtime.json");
    persistRuntimeInfo(runtimeFile, {
      nextPid: owned.parentPid,
      nextProcessGroup: !IS_WIN, // recorded exactly as global-setup records it
      tmpRoot,
    });

    try {
      assert(alive(owned.parentPid) && alive(owned.childPid), "owned parent + descendant are running");
      assert(alive(bystanderProc.parentPid) && alive(bystanderProc.childPid), "bystander parent + descendant are running");
      ok("stopRuntimeFromFile: owned tree and an unrelated tree are both running first");
    } catch (e) { bad("stopRuntimeFromFile: owned tree and an unrelated tree are both running first", e); }

    // The exact durable teardown Playwright's globalTeardown performs.
    await stopRuntimeFromFile(runtimeFile);
    await sleep(600);

    try {
      assert(!alive(owned.parentPid), `owned parent (pid ${owned.parentPid}) terminated`);
      ok("stopRuntimeFromFile: the recorded process was terminated");
    } catch (e) { bad("stopRuntimeFromFile: the recorded process was terminated", e); }

    try {
      assert(!alive(owned.childPid), `owned DESCENDANT (pid ${owned.childPid}) terminated — not just the shell`);
      ok(`stopRuntimeFromFile: its DESCENDANT was terminated too (${IS_WIN ? "taskkill /T tree" : "POSIX process group"})`);
    } catch (e) { bad("stopRuntimeFromFile: its DESCENDANT was terminated too", e); }

    try {
      assert(alive(bystanderProc.parentPid), `unrelated parent (pid ${bystanderProc.parentPid}) still alive`);
      assert(alive(bystanderProc.childPid), `unrelated descendant (pid ${bystanderProc.childPid}) still alive`);
      ok("stopRuntimeFromFile: an UNRELATED process group is untouched");
    } catch (e) { bad("stopRuntimeFromFile: an UNRELATED process group is untouched", e); }

    try {
      assert(!fs.existsSync(runtimeFile), "runtime file removed");
      assert(!fs.existsSync(tmpRoot), "temporary resources removed");
      ok("stopRuntimeFromFile: removed its runtime file and temp resources");
    } catch (e) { bad("stopRuntimeFromFile: removed its runtime file and temp resources", e); }

    try {
      await stopRuntimeFromFile(runtimeFile); // missing file, dead pids
      ok("stopRuntimeFromFile: calling it again is safe (idempotent)");
    } catch (e) { bad("stopRuntimeFromFile: calling it again is safe (idempotent)", e); }

    // Clean up the bystander we deliberately kept alive.
    try {
      if (IS_WIN) execSync(`taskkill /PID ${bystanderProc.parentPid} /T /F`, { stdio: "ignore" });
      else process.kill(-bystanderProc.parentPid, "SIGKILL");
    } catch { /* already gone */ }
  } finally {
    await bystanderPg.pg.stop().catch(() => {});
    try { fs.rmSync(path.dirname(bystanderPg.dir), { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
