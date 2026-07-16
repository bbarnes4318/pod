"use server";

// Server actions for Admin custom-topic creation and source ingestion.
//
// THE AUTHORIZATION BOUNDARY. Every export calls requireAdmin() FIRST and takes
// the operator identity from adminIdentity() — the server-verified HTTP Basic
// Auth credential. Nothing here reads an actor, ownerId, isAdmin flag or audit
// identity out of the client payload, so a browser cannot escalate by sending
// one and cannot forge who an audit record blames. A Studio session cookie is
// irrelevant: /admin is Basic Auth, checked by the proxy before this runs.

import { requireAdmin, adminIdentity } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import {
  createCustomTopic,
  importSourcesForTopic,
  listTopicSources,
  MAX_URLS_PER_REQUEST,
  type CustomTopicInput,
  type IngestionCtx,
} from "@/lib/services/topicIngestion";
import { consumeRateLimit, rateLimitMessage } from "@/lib/rateLimit";

function ingestionCtx(): IngestionCtx {
  return { db, admin: { id: adminIdentity() } };
}

/** Durable audit, following the existing `admin:*` JobLog convention. Never
 *  blocks the operation — the console line is the fallback. */
async function audit(action: string, record: Record<string, unknown>, output: Record<string, unknown> = {}) {
  const entry = { admin: adminIdentity(), at: new Date().toISOString(), ...record };
  console.warn(`[audit] ${action}`, entry);
  try {
    await db.jobLog.create({
      data: {
        jobType: `admin:${action}`,
        status: "completed",
        input: entry as Prisma.InputJsonValue,
        output: output as Prisma.InputJsonValue,
      },
    });
  } catch {
    /* auditing must never fail the action */
  }
}

/**
 * Create a PENDING custom topic, optionally importing source URLs.
 *
 * The topic is never approved here and never gains evidence — it appears on the
 * board reporting its real blocking reasons.
 */
export async function createCustomTopicAction(input: CustomTopicInput) {
  await requireAdmin();
  const admin = adminIdentity();
  try {
    const urlCount = (input.sourceUrls ?? []).filter((u) => (u ?? "").trim()).length;

    const gate = await consumeRateLimit("customTopicCreate", admin);
    if (!gate.allowed) {
      return { ok: false as const, error: rateLimitMessage("customTopicCreate", gate.retryAfterSeconds) };
    }
    if (urlCount > 0) {
      // Charge per URL: the outbound fetches are the expensive part.
      const fetchGate = await consumeRateLimit("sourceFetch", admin, { cost: urlCount });
      if (!fetchGate.allowed) {
        return { ok: false as const, error: rateLimitMessage("sourceFetch", fetchGate.retryAfterSeconds) };
      }
    }

    const res = await createCustomTopic(ingestionCtx(), input);
    if (!res.ok) return res;

    await audit(
      "topic-custom-create",
      {
        title: input.title,
        idempotencyKey: input.idempotencyKey ?? null,
        sourceUrlCount: urlCount,
        deduplicated: res.deduplicated,
      },
      { topicId: res.topicId, editorialStatus: res.editorialStatus, importedSourceCount: res.importedSourceCount }
    );

    // Import outcomes are audited separately so a security refusal is findable
    // on its own, not buried in a creation record.
    for (const s of res.sources) {
      if (s.status === "imported") {
        await audit("topic-source-import", { topicId: res.topicId, canonicalUrl: s.canonicalUrl });
      } else if (s.status === "duplicate") {
        await audit("topic-source-duplicate", { topicId: res.topicId, canonicalUrl: s.canonicalUrl ?? null });
      } else {
        // The submitted URL is recorded for the operator trail; the reason is
        // the safe category, never internal detail.
        await audit("topic-source-import-failure", { topicId: res.topicId, url: s.url, category: s.status });
      }
    }

    revalidatePath("/admin/episodes");
    revalidatePath("/admin/topics");
    return res;
  } catch (err) {
    console.error("[admin] custom topic creation failed:", (err as Error).message);
    return { ok: false as const, error: "That topic couldn't be created." };
  }
}

/** Import more sources onto an existing topic. Never changes its status. */
export async function importSourcesAction(topicId: string, urls: string[]) {
  await requireAdmin();
  const admin = adminIdentity();
  try {
    const count = (urls ?? []).filter((u) => (u ?? "").trim()).length;
    if (count > MAX_URLS_PER_REQUEST) {
      return { ok: false as const, error: `Import at most ${MAX_URLS_PER_REQUEST} source URLs at a time.` };
    }

    const gate = await consumeRateLimit("sourceImport", admin);
    if (!gate.allowed) return { ok: false as const, error: rateLimitMessage("sourceImport", gate.retryAfterSeconds) };
    const fetchGate = await consumeRateLimit("sourceFetch", admin, { cost: Math.max(1, count) });
    if (!fetchGate.allowed) return { ok: false as const, error: rateLimitMessage("sourceFetch", fetchGate.retryAfterSeconds) };

    const res = await importSourcesForTopic(ingestionCtx(), topicId, urls);
    if (!res.ok) return res;

    for (const s of res.sources) {
      if (s.status === "imported") await audit("topic-source-import", { topicId, canonicalUrl: s.canonicalUrl });
      else if (s.status === "duplicate") await audit("topic-source-duplicate", { topicId, canonicalUrl: s.canonicalUrl ?? null });
      else await audit("topic-source-import-failure", { topicId, url: s.url, category: s.status });
    }

    revalidatePath("/admin/episodes");
    return res;
  } catch (err) {
    console.error("[admin] source import failed:", (err as Error).message);
    return { ok: false as const, error: "Those sources couldn't be imported." };
  }
}

/** The sanitized source list for the preview panel. Plain text only. */
export async function fetchTopicSourcesAction(topicId: string) {
  await requireAdmin();
  try {
    return { ok: true as const, sources: await listTopicSources(ingestionCtx(), topicId) };
  } catch (err) {
    console.error("[admin] source list failed:", (err as Error).message);
    return { ok: false as const, error: "Those sources couldn't be loaded." };
  }
}
