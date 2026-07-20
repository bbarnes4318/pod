// Regression gate for the production Redis secret leak (deploy blocker A) and
// the env-driven worker concurrency (blocker C).
//
//   1. Behavioral: describeRedisConnection() must NEVER contain the username or
//      password from REDIS_URL — only a bare status plus host:port.
//   2. Static:     src/lib/queue/worker.ts must not log the raw REDIS_URL, and
//      its BullMQ concurrency must be env-driven (not a hardcoded literal).
//
// Run: npm run test:redis-log-sanitization

import fs from "fs";
import path from "path";
import { describeRedisConnection } from "../lib/env";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${(e as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const SECRET_USER = "produser";
const SECRET_PASS = "sup3r-s3cret-pw";

check("describeRedisConnection() hides credentials from a full auth URL", () => {
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = `redis://${SECRET_USER}:${SECRET_PASS}@redis-prod.internal:6380`;
  const out = describeRedisConnection();
  process.env.REDIS_URL = prev;
  assert(!out.includes(SECRET_PASS), `password leaked in: ${out}`);
  assert(!out.includes(SECRET_USER), `username leaked in: ${out}`);
  assert(out.includes("redis-prod.internal") && out.includes("6380"), `expected host:port, got: ${out}`);
});

check("describeRedisConnection() handles rediss:// and missing port safely", () => {
  const prev = process.env.REDIS_URL;
  process.env.REDIS_URL = `rediss://default:${SECRET_PASS}@r.example.com`;
  const out = describeRedisConnection();
  process.env.REDIS_URL = prev;
  assert(!out.includes(SECRET_PASS), `password leaked in: ${out}`);
  assert(out.startsWith("configured"), `expected configured status, got: ${out}`);
});

const workerSrc = fs.readFileSync(path.join(process.cwd(), "src", "lib", "queue", "worker.ts"), "utf8");

check("worker.ts never logs the raw REDIS_URL", () => {
  // Any console.* line that references process.env.REDIS_URL is a leak.
  const leak = workerSrc
    .split("\n")
    .find((l) => /console\.(log|info|warn|error|debug)/.test(l) && /process\.env\.REDIS_URL/.test(l));
  assert(!leak, `console line logs raw REDIS_URL: ${leak?.trim()}`);
});

check("worker.ts BullMQ concurrency is env-driven, not a hardcoded literal", () => {
  assert(/concurrency:\s*WORKER_CONCURRENCY/.test(workerSrc), "concurrency is not wired to WORKER_CONCURRENCY");
  assert(!/concurrency:\s*\d+/.test(workerSrc), "a hardcoded numeric concurrency literal is still present");
  assert(/process\.env\.WORKER_CONCURRENCY/.test(workerSrc), "WORKER_CONCURRENCY env var is not read");
});

console.log(`\n${5 - failed}/5 checks passed`);
if (failed > 0) process.exit(1);
