/* eslint-disable @typescript-eslint/no-explicit-any -- e2e db helper */
// Direct access to the throwaway E2E Postgres so specs can assert against REAL
// rows (not just what the UI claims). The connection string is written by
// global-setup, which owns the database's lifecycle.

import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

let client: PrismaClient | null = null;

export function e2eDb(): PrismaClient {
  if (!client) {
    const file = path.join(process.cwd(), "tests", "e2e", ".auth", "db.json");
    const { dbUrl } = JSON.parse(fs.readFileSync(file, "utf8"));
    client = new PrismaClient({ datasourceUrl: dbUrl } as any);
  }
  return client;
}

/** The topic ids actually written for an episode, in orderIndex order. */
export async function episodeTopicOrder(episodeId: string): Promise<string[]> {
  const rows = await e2eDb().episodeTopic.findMany({
    where: { episodeId }, orderBy: { orderIndex: "asc" }, select: { topicId: true },
  });
  return rows.map((r) => r.topicId);
}

export async function episodeRow(episodeId: string) {
  return e2eDb().episode.findUnique({ where: { id: episodeId }, select: { id: true, ownerId: true, podcastId: true, hostIds: true, description: true } });
}

/**
 * Wait until the autosaved StudioDraft row actually satisfies `predicate`.
 * Deterministic replacement for sleeping past the client's debounce — and a real
 * database assertion that the draft persisted.
 */
export async function waitForDraft(
  ownerId: string,
  predicate: (state: any) => boolean,
  timeoutMs = 10000
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const row = await e2eDb().studioDraft.findUnique({ where: { ownerId } });
    last = row?.state ?? null;
    if (last && predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`StudioDraft never matched the expected state. Last seen: ${JSON.stringify(last)}`);
}

export async function closeE2eDb() {
  if (client) { await client.$disconnect().catch(() => {}); client = null; }
}
