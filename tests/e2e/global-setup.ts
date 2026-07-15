/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any -- e2e bootstrap */
// Playwright global setup: boot a throwaway embedded Postgres, apply the schema,
// seed deterministic data, start the Next app against it, and log the seeded
// user in (storageState). No external LLM/TTS/research/payment services are
// touched — the whole flow is DB-only. A pidfile lets global-teardown stop
// everything afterwards.

import { request, type FullConfig } from "@playwright/test";
import { spawn } from "child_process";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
const EmbeddedPostgres = require("embedded-postgres").default || require("embedded-postgres");
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { seed, E2E } from "./seed";

const PG_PORT = Number(process.env.E2E_PG_PORT) || 55450;
const APP_PORT = Number(process.env.E2E_APP_PORT) || 3311;
const DB_URL = `postgresql://postgres:postgres@localhost:${PG_PORT}/e2e`;
const APP_URL = `http://localhost:${APP_PORT}`;
const AUTH_SECRET = "e2e-playwright-secret-000000000000000000";
const STATE_DIR = path.join(process.cwd(), "tests", "e2e", ".auth");
const PIDFILE = path.join(STATE_DIR, "runtime.json");

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: DB_URL,
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
  while (Date.now() < deadline) {
    try { const r = await ctx.get(url, { timeout: 5000 }); if (r.status() < 500) { await ctx.dispose(); return; } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  await ctx.dispose();
  throw new Error(`Timed out waiting for ${url}`);
}

export default async function globalSetup(_config: FullConfig) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const dataDir = path.join(process.env.TEMP || "/tmp", `e2e-pg-${PG_PORT}`);
  // A prior run's data dir blocks initdb ("directory exists but is not empty").
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }

  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port: PG_PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("e2e");

  execSync("npx prisma db push --skip-generate --accept-data-loss", { env: childEnv(), stdio: "ignore" });

  const prisma = new PrismaClient({ datasourceUrl: DB_URL } as any);
  await prisma.$connect();
  await seed(prisma, bcrypt);
  await prisma.$disconnect();

  // Free the app port from any zombie dev server before starting a fresh one.
  try {
    const out = execSync(`netstat -ano | findstr :${APP_PORT}`, { encoding: "utf8" });
    const pids = new Set(out.split("\n").map((l) => l.trim().split(/\s+/).pop()).filter((p) => p && /^\d+$/.test(p)));
    for (const pid of pids) { try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); } catch { /* ignore */ } }
  } catch { /* nothing on the port */ }

  // Start the app attached to the Playwright process (which lives for the whole
  // run); global-teardown kills its tree. Logs go to a file for debugging.
  const logFd = fs.openSync(path.join(STATE_DIR, "next.log"), "w");
  const next = spawn("npx", ["next", "dev", "-p", String(APP_PORT)], { env: childEnv(), shell: true, stdio: ["ignore", logFd, logFd] });
  fs.writeFileSync(PIDFILE, JSON.stringify({ nextPid: next.pid, pgPort: PG_PORT }));

  await waitForHttp(`${APP_URL}/app/login`, 180000);
  // Warm up the auth API route (first Turbopack compile can be slow).
  await waitForHttp(`${APP_URL}/api/auth/csrf`, 120000);

  // Log the seeded user in via the real Credentials flow and save the cookies.
  const ctx = await request.newContext({ baseURL: APP_URL, timeout: 120000 });
  const csrf = await (await ctx.get("/api/auth/csrf")).json();
  const res = await ctx.post("/api/auth/callback/credentials", {
    form: { csrfToken: csrf.csrfToken, email: E2E.userA.email, password: E2E.userA.password, callbackUrl: `${APP_URL}/studio/create`, json: "true" },
    maxRedirects: 5,
  });
  if (res.status() >= 400) throw new Error(`Credentials login failed: HTTP ${res.status()}`);
  await ctx.storageState({ path: path.join(STATE_DIR, "state.json") });
  await ctx.dispose();
  // Sanity: the saved session must actually reach /studio/create.
  const check = await request.newContext({ baseURL: APP_URL, storageState: path.join(STATE_DIR, "state.json"), timeout: 120000 });
  const studio = await check.get("/studio/create");
  await check.dispose();
  if (studio.status() >= 400) throw new Error(`Authenticated /studio/create returned HTTP ${studio.status()}`);
}
