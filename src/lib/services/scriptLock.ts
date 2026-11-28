// One way to change a Script row safely: lock it, re-read it, then write.
//
// Every read-modify-write of Script.content goes through lockScriptRow inside
// its transaction, so it waits behind a release (withReleaseLock holds the
// same row while the gate runs) and behind another editor, and then applies
// its change to what is actually saved instead of to a copy read earlier.
// Lock order everywhere: Script, then Episode (withReleaseLock's order), so
// two of these can never deadlock each other.
import crypto from "crypto";
import type { Prisma } from "@prisma/client";

/** A release may hold the row for up to 60s; the client's default 5s limit
 *  would fail a waiting writer instead of letting it land. */
export const SCRIPT_LOCK_TX = { timeout: 75_000, maxWait: 15_000 } as const;

export async function lockScriptRow(tx: Prisma.TransactionClient, scriptId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Script" WHERE "id" = ${scriptId} FOR UPDATE`;
  return tx.script.findUnique({ where: { id: scriptId }, select: { id: true, content: true, status: true, episodeId: true, version: true } });
}

/** Identity of a script's saved content, for "has it changed since I read it?". */
export const scriptContentHash = (content: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(content ?? null)).digest("hex");

export class ScriptChangedError extends Error {
  constructor(what = "This script") {
    super(`${what} was changed by someone else after you opened it. Reload to see the latest version, then make your change again.`);
    this.name = "ScriptChangedError";
  }
}

/** Lock, and refuse if the content is no longer what the caller based its change on. */
export async function lockScriptUnchanged(tx: Prisma.TransactionClient, scriptId: string, expectedHash: string | null | undefined) {
  const row = await lockScriptRow(tx, scriptId);
  if (!row) throw new Error(`Script ${scriptId} not found.`);
  if (expectedHash && scriptContentHash(row.content) !== expectedHash) throw new ScriptChangedError();
  return row;
}
