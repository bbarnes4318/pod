/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any -- e2e bootstrap */
// Playwright global setup: boot a throwaway embedded Postgres on an OS-assigned
// FREE port, apply the schema, seed deterministic data, start the Next app, and
// log the seeded user in (storageState). DB-only — no external LLM/TTS/research/
// payment services.
//
// SAFETY: every resource is tracked in runtime.ts and stopped by PID / by object
// in global-teardown. Nothing is ever killed by image name or by port owner. If
// setup fails halfway, we stop whatever we already started before rethrowing.

import { request, type FullConfig } from "@playwright/test";
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seed, E2E } from "./seed";
import { trackPg, trackNext, stopRuntime, freePort, portInUse, persistRuntimeInfo } from "./runtime";

const APP_PORT = Number(process.env.E2E_APP_PORT) || 3311;
const APP_URL = `http://localhost:${APP_PORT}`;
const AUTH_SECRET = "e2e-playwright-secret-000000000000000000";
export const STATE_DIR = path.join(process.cwd(), "tests", "e2e", ".auth");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const DB_FILE = path.join(STATE_DIR, "db.json");
export const RUNTIME_FILE = path.join(STATE_DIR, "runtime.json");

function childEnv(dbUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: dbUrl,
    AUTH_SECRET, NEXTAUTH_SECRET: AUTH_SECRET,
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    NODE_ENV: "development",
    E2E_TEST_MODE: "1",
    TOPIC_MIN_TALKABILITY: "1",
  };
}

async function waitForHttp(url: string, timeoutMs: number) {
  const ctx = await request.newContext();
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try { const r = await ctx.get(url, { timeout: 5000 }); if (r.status() < 500) return; } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Timed out waiting for ${url}`);
  } finally {
    await ctx.dispose();
  }
}

export default async function globalSetup(_config: FullConfig) {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // The app port must match playwright.config's baseURL, so it stays fixed.
  // FAIL CLEARLY if it's occupied — never kill whatever owns it.
  if (await portInUse(APP_PORT)) {
    throw new Error(
      `E2E app port ${APP_PORT} is already in use. Stop that process, or set E2E_APP_PORT to a free port. ` +
      `(This harness will not kill a process it did not start.)`
    );
  }

  try {
    // Postgres port is internal, so take an OS-assigned free one — no clashes.
    const pgPort = await freePort();
    const dbUrl = `postgresql://postgres:postgres@localhost:${pgPort}/e2e`;
    const dataDir = path.join(fs.mkdtempSync(path.join(require("os").tmpdir(), "pod-e2e-pg-")), "data");

    const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port: pgPort, persistent: false });
    await pg.initialise();
    await pg.start();
    trackPg(pg, path.dirname(dataDir), dataDir); // track immediately so failures below still clean up
    // Durable record: Playwright loads globalSetup/globalTeardown in separate
    // module registries, so teardown may not see the in-memory handles.
    persistRuntimeInfo(RUNTIME_FILE, { pgDataDir: dataDir, tmpRoot: path.dirname(dataDir) });
    await pg.createDatabase("e2e");

    execSync("npx prisma db push --skip-generate --accept-data-loss", { env: childEnv(dbUrl), stdio: "ignore" });

    const prisma = new PrismaClient({ datasourceUrl: dbUrl } as any);
    await prisma.$connect();
    await seed(prisma, bcrypt);
    await prisma.$disconnect();

    // Share the DB URL with the specs so they can assert against real rows.
    fs.writeFileSync(DB_FILE, JSON.stringify({ dbUrl, appPort: APP_PORT }));

    // Start the app. POSIX: detached => own process group (killable as a group).
    // Windows: shell pid + taskkill /T kills the tree. Either way: BY PID only.
    const logFd = fs.openSync(path.join(STATE_DIR, "next.log"), "w");
    const next = spawn("npx", ["next", "dev", "-p", String(APP_PORT)], {
      env: childEnv(dbUrl),
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", logFd, logFd],
    });
    trackNext(next);
    persistRuntimeInfo(RUNTIME_FILE, { nextPid: next.pid, pgDataDir: dataDir, tmpRoot: path.dirname(dataDir) });

    await waitForHttp(`${APP_URL}/app/login`, 180000);
    await waitForHttp(`${APP_URL}/api/auth/csrf`, 120000);

    // Real Credentials login → storageState.
    const ctx = await request.newContext({ baseURL: APP_URL, timeout: 120000 });
    const csrf = await (await ctx.get("/api/auth/csrf")).json();
    const res = await ctx.post("/api/auth/callback/credentials", {
      form: { csrfToken: csrf.csrfToken, email: E2E.userA.email, password: E2E.userA.password, callbackUrl: `${APP_URL}/studio/create`, json: "true" },
      maxRedirects: 5,
    });
    if (res.status() >= 400) throw new Error(`Credentials login failed: HTTP ${res.status()}`);
    await ctx.storageState({ path: STATE_FILE });
    await ctx.dispose();

    const check = await request.newContext({ baseURL: APP_URL, storageState: STATE_FILE, timeout: 120000 });
    const studio = await check.get("/studio/create");
    await check.dispose();
    if (studio.status() >= 400) throw new Error(`Authenticated /studio/create returned HTTP ${studio.status()}`);
  } catch (err) {
    // Partial setup: stop exactly what we started, then surface the failure.
    await stopRuntime();
    throw err;
  }
}
