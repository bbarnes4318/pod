/* eslint-disable @typescript-eslint/no-explicit-any -- e2e runtime handles */
// Scoped lifecycle for the E2E stack.
//
// SAFETY: we stop ONLY the exact resources this run created — the specific
// EmbeddedPostgres instance object and the exact spawned Next process tree (by
// PID). We never kill by image name (that would take down unrelated Postgres
// servers on the machine) and never kill "whatever is listening on a port".
// globalSetup and globalTeardown both run in the Playwright runner process, so
// this module's state is shared between them.

import { execSync } from "child_process";
import type { ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";

export interface E2ERuntime {
  pg: { stop: () => Promise<void> } | null;
  nextProc: ChildProcess | null;
  /** Temp ROOT to delete. */
  dataDir: string | null;
  /** The Postgres cluster dir (for postmaster.pid / scoped reaping). */
  pgDataDir: string | null;
}

const runtime: E2ERuntime = { pg: null, nextProc: null, dataDir: null, pgDataDir: null };

export function trackPg(pg: { stop: () => Promise<void> }, tmpRoot: string, pgDataDir?: string) {
  runtime.pg = pg;
  runtime.dataDir = tmpRoot;
  runtime.pgDataDir = pgDataDir ?? null;
}
export function trackNext(proc: ChildProcess) {
  runtime.nextProc = proc;
}

/**
 * Public helper for any test that boots its own embedded Postgres: gracefully
 * stop THAT instance and reap its own leftover children (PG18 spawns io_workers
 * that can outlive the shutdown on Windows). Scoped to the given cluster only.
 */
export async function stopEmbeddedPgScoped(pg: { stop: () => Promise<void> }, dataDir: string): Promise<void> {
  await stopPostgresScoped(dataDir, pg);
}

/** Kill exactly one process tree, cross-platform, BY PID (never by name).
 *  Delegates to the same scoped shutdown the durable fallback uses. */
export async function killTree(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return;
  // We spawn Next detached on POSIX, so it leads its own process group.
  await stopProcessTreeScoped(proc.pid, process.platform !== "win32");
}

/** Direct child PIDs of a given PID — used to reap OUR postgres cluster's own
 *  children (PG18 spawns `io_worker` processes that can outlive a graceful stop
 *  on Windows and become orphans). Scoped: only descendants of our postmaster. */
function childPids(pid: number): number[] {
  try {
    if (process.platform === "win32") {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Select-Object -ExpandProperty ProcessId"`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => !!n && !Number.isNaN(n));
    }
    const out = execSync(`pgrep -P ${pid}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => !!n && !Number.isNaN(n));
  } catch { return []; }
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readPostmasterPid(dataDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(dataDir, "postmaster.pid"), "utf8").split("\n")[0].trim());
    return Number.isNaN(pid) ? null : pid;
  } catch { return null; }
}

/**
 * Stop OUR Postgres cluster and reap any of ITS OWN child processes that
 * survive the graceful shutdown. Everything here is keyed to our data dir /
 * our postmaster PID — an unrelated Postgres is never inspected or signalled.
 */
async function stopPostgresScoped(dataDir: string | null, pgObj?: { stop: () => Promise<void> } | null, pgCtl?: string | null): Promise<void> {
  const postmasterPid = dataDir ? readPostmasterPid(dataDir) : null;
  // Snapshot our cluster's children BEFORE shutdown (afterwards the parent link
  // is gone and they'd be unidentifiable).
  const ourKids = postmasterPid ? childPids(postmasterPid) : [];

  if (pgObj) { try { await pgObj.stop(); } catch { /* fall through */ } }
  else if (pgCtl && dataDir && fs.existsSync(dataDir)) {
    try { execSync(`"${pgCtl}" -D "${dataDir}" -m fast stop`, { stdio: "ignore" }); } catch { /* fall through */ }
  }

  // Reap survivors from OUR tree only.
  for (const pid of [...ourKids, ...(postmasterPid ? [postmasterPid] : [])]) {
    if (isAlive(pid)) killPid(pid);
  }
  // Postgres can spawn a replacement child WHILE shutting down, so poll a few
  // times keyed on OUR postmaster's PID. Windows keeps ParentProcessId even
  // after the parent exits, and we additionally require the process to be THIS
  // repo's embedded-postgres binary — so nothing else can ever match.
  if (postmasterPid) await reapChildrenOfDeadParent(postmasterPid);

  // Final sweep for ORPHANS the parent-keyed pass can't see (see below).
  await reapOrphanedEmbeddedPostgres();
}

/** True if the pid exists. EPERM means it exists but isn't ours to signal. */
function pidExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException)?.code === "EPERM"; }
}

/**
 * Kill ORPHANED embedded-postgres processes: ones running THIS repo's binary
 * whose parent process no longer exists.
 *
 * Why this is needed on top of the parent-keyed reap: Postgres can fork a
 * worker (e.g. an io_worker) DURING shutdown — after the parent-keyed pass has
 * already seen two clean passes — and that worker's recorded parent is gone by
 * the time anyone looks. It is unmistakably ours and it still holds our data
 * dir open, so leaving it behind breaks the "teardown owns what it started"
 * contract.
 *
 * Still double-scoped, and never by name alone:
 *   1. the command line must be THIS repo's node_modules/@embedded-postgres, and
 *   2. its parent must be genuinely dead.
 * A concurrent run from this same repo is therefore untouched: its postmaster
 * has a live parent (node), and its workers have a live postmaster — so neither
 * is ever an orphan. Any other Postgres on the machine fails check 1.
 */
async function reapOrphanedEmbeddedPostgres(): Promise<void> {
  if (process.platform !== "win32") return; // POSIX reparents to init; graceful stop suffices
  const ourBin = path.join(process.cwd(), "node_modules", "@embedded-postgres").replace(/\\/g, "/");
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((r) => setTimeout(r, 400));
    let rows: Array<{ ProcessId: number; ParentProcessId: number; CommandLine?: string }> = [];
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'postgres.exe' } | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (out) {
        const parsed = JSON.parse(out);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch { return; /* can't enumerate — never guess */ }

    let killedAny = false;
    for (const r of rows) {
      if (!r?.ProcessId) continue;
      const cmd = (r.CommandLine || "").replace(/\\/g, "/");
      if (!cmd.includes(ourBin)) continue;                       // not ours
      if (r.ParentProcessId && pidExists(r.ParentProcessId)) continue; // still owned by a live run
      killPid(r.ProcessId);
      killedAny = true;
    }
    if (!killedAny) return;
  }
}

/** Kill leftover embedded-postgres processes whose recorded parent is `pm`. */
async function reapChildrenOfDeadParent(pm: number): Promise<void> {
  if (process.platform !== "win32") return; // POSIX reparents; graceful stop suffices
  const ourBin = path.join(process.cwd(), "node_modules", "@embedded-postgres").replace(/\\/g, "/");
  // Postgres can spawn a replacement child slightly AFTER an earlier pass looks
  // clean, so require two consecutive clean passes rather than stopping at the
  // first empty one.
  let cleanPasses = 0;
  for (let attempt = 0; attempt < 6 && cleanPasses < 2; attempt++) {
    await new Promise((r) => setTimeout(r, 400));
    let rows: Array<{ ProcessId: number; CommandLine?: string }> = [];
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pm}' | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      ).trim();
      if (out) {
        const parsed = JSON.parse(out);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      }
    } catch { /* treat as an empty pass */ }
    let killedAny = false;
    for (const r of rows) {
      // Double-scoped: our postmaster's child AND our own embedded binary.
      if (r?.ProcessId && (r.CommandLine || "").replace(/\\/g, "/").includes(ourBin)) {
        killPid(r.ProcessId);
        killedAny = true;
      }
    }
    cleanPasses = killedAny ? 0 : cleanPasses + 1;
  }
}

/** Kill exactly one PID (and its tree on Windows). Never by name. */
function killPid(pid: number): void {
  if (!pid || Number.isNaN(pid)) return;
  if (process.platform === "win32") {
    try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* gone */ }
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { /* gone */ }
  }
}

/** Is this PID (or POSIX process group, when negative) still alive? */
function targetAlive(target: number): boolean {
  try { process.kill(target, 0); return true; } catch (err) {
    // EPERM means it exists but we may not signal it — still "alive".
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Terminate EXACTLY one recorded process tree, cross-platform, and nothing else.
 *
 * Windows: `taskkill /PID <pid> /T /F` — that PID's tree only, never by image name.
 * POSIX:   when the recorded process leads its own process group (we spawn Next
 *          detached), signal ONLY that group via the negative PID: SIGTERM,
 *          brief grace, then SIGKILL to the SAME negative PID if it survives.
 *          Killing the bare PID would leave npx/node/next descendants alive.
 * Idempotent; an already-dead target counts as success.
 */
export async function stopProcessTreeScoped(pid: number, isProcessGroup: boolean): Promise<void> {
  if (!pid || Number.isNaN(pid)) return;
  if (process.platform === "win32") {
    killPid(pid); // /T tree kill, scoped to this PID
    return;
  }
  // POSIX: prefer the process group so descendants go too.
  const target = isProcessGroup ? -pid : pid;
  try { process.kill(target, "SIGTERM"); } catch { return; /* already gone */ }
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!targetAlive(target)) return;
  }
  try { process.kill(target, "SIGKILL"); } catch { /* raced to exit */ }
}

export interface RuntimeInfo {
  nextPid?: number;
  /** True when nextPid leads its own POSIX process group (spawned detached). */
  nextProcessGroup?: boolean;
  pgDataDir?: string;
  tmpRoot?: string;
}

/** Record what we started so teardown can stop it even if module state is not
 *  shared between Playwright's globalSetup and globalTeardown (it loads them in
 *  separate module registries, so in-memory handles can be empty at teardown). */
export function persistRuntimeInfo(file: string, info: RuntimeInfo): void {
  fs.writeFileSync(file, JSON.stringify(info));
}

/** The embedded-postgres `pg_ctl` binary for this platform, if installed. */
function pgCtlPath(): string | null {
  const base = path.join(process.cwd(), "node_modules", "@embedded-postgres");
  if (!fs.existsSync(base)) return null;
  for (const platformDir of fs.readdirSync(base)) {
    const exe = path.join(base, platformDir, "native", "bin", process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/**
 * Durable fallback teardown: stop EXACTLY our Postgres CLUSTER via `pg_ctl -D
 * <our data dir>` (graceful — takes the postmaster AND its child processes down,
 * leaving no orphaned io_workers), and our Next tree by PID.
 *
 * Perfectly scoped: `pg_ctl -D` acts only on the cluster in OUR temp data
 * directory. An unrelated Postgres has a different data dir and is untouched.
 */
export async function stopRuntimeFromFile(file: string): Promise<void> {
  let info: RuntimeInfo;
  try { info = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
  // Scoped tree shutdown: on POSIX this signals only OUR process group, so the
  // npx/node/next descendants of the spawned shell die with it.
  if (info.nextPid) await stopProcessTreeScoped(info.nextPid, !!info.nextProcessGroup);

  if (info.pgDataDir && fs.existsSync(info.pgDataDir)) {
    await stopPostgresScoped(info.pgDataDir, null, pgCtlPath());
  }
  // Give Windows a moment to release file handles before removing the dir.
  await new Promise((r) => setTimeout(r, 750));
  if (info.tmpRoot) {
    try { fs.rmSync(info.tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
}

/** Stop everything this run started. Safe to call twice / after partial setup.
 *  Used when Playwright happens to share module state; the file-based fallback in
 *  stopRuntimeFromFile covers the case where it doesn't. */
export async function stopRuntime(): Promise<void> {
  if (runtime.nextProc) {
    await killTree(runtime.nextProc);
    runtime.nextProc = null;
  }
  if (runtime.pg) {
    // Graceful stop of ONLY this instance, plus a reap of ITS OWN surviving
    // children — never any other Postgres on the machine.
    await stopPostgresScoped(runtime.pgDataDir, runtime.pg);
    runtime.pg = null;
  }
  if (runtime.dataDir) {
    await new Promise((r) => setTimeout(r, 500)); // let Windows release handles
    try { fs.rmSync(runtime.dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    runtime.dataDir = null;
  }
}

/** An OS-assigned free TCP port (used for the throwaway Postgres). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** True when something is already listening on the port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRINUSE"));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}
