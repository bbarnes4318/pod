// Shared harness for the database-integration scripts.
//
// These run ONLY in the Database Integration workflow, against throwaway
// PostgreSQL and Redis service containers. They exist because the unit suites
// prove the port contracts against in-memory fakes, which says nothing about
// the Prisma SQL or the migrations.

import { PrismaClient } from "@prisma/client";

let checks = 0;
let failures = 0;

export async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  checks += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${(err as Error).message}`);
  }
}

export function summarize(suite: string): never {
  const line = `${checks - failures}/${checks} checks passed`;
  if (failures > 0) {
    console.error(`\n${suite}: ${line} — ${failures} FAILED\n`);
    process.exit(1);
  }
  console.log(`\n${suite}: ${line}\n`);
  process.exit(0);
}

/** A client that is always disconnected, so the job cannot hang on an open handle. */
export function prisma(): PrismaClient {
  return new PrismaClient();
}

export async function withPrisma<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = prisma();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}

/** A collision-resistant suffix so re-runs never trip a unique constraint. */
export function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function requireEnv(name: string): string {
  const v = (process.env[name] || "").trim();
  if (!v) {
    console.error(`${name} is required for the integration suite.`);
    process.exit(2);
  }
  return v;
}
