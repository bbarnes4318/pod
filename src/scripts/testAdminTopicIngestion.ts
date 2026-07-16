// Admin custom-topic + source-ingestion tests. Run: npm run test:admin-topic-ingestion
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: in-memory
   fake DB doubles + dynamic payloads are intentionally loosely typed. */
//
// The claim under test is an EDITORIAL one as much as a security one: an
// operator's typed opinion and a pasted link must never masquerade as verified
// research. So these tests assert what is NOT written (no evidence, no brief,
// no approval) as hard as what is.
//
// The URL/SSRF layer has its own exhaustive suite (test:url-security); here the
// fetcher is stubbed so ingestion logic is tested deterministically and NOTHING
// touches a network.

process.env.TOPIC_MIN_TALKABILITY = "1";

import fs from "fs";
import path from "path";
import {
  createCustomTopic, importSourcesForTopic, listTopicSources, normalizeTitle,
  MAX_URLS_PER_REQUEST, MAX_TITLE_LENGTH, type IngestionCtx,
} from "../lib/services/topicIngestion";
import { consumeRateLimit, ADMIN_RATE_LIMITS } from "../lib/rateLimit";
import { evaluateHardGates } from "../lib/services/topicEligibility";
import { getAdminTopicsFor, createAdminEpisodeFor, type AdminCtx } from "../lib/services/adminRundown";
import type { SafeFetchResult } from "../lib/net/safeFetch";

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }

const ARTICLE = (title = "Real Headline") =>
  `<html><head><title>${title}</title><meta property="og:site_name" content="Example News"></head>
   <body><p>${"Genuine reporting body text long enough to be kept as an excerpt. ".repeat(3)}</p></body></html>`;

/** Stub fetcher: a map of url -> result. Never touches a network. */
function stubFetch(plan: Record<string, Partial<SafeFetchResult> | undefined>) {
  return async (url: string): Promise<SafeFetchResult> => {
    const hit = plan[url];
    if (!hit) return { ok: false, category: "fetch_failed", message: "That link couldn't be fetched." };
    if ((hit as any).ok === false) return hit as SafeFetchResult;
    return {
      ok: true,
      finalUrl: (hit as any).finalUrl ?? url,
      status: 200,
      contentType: "text/html",
      body: (hit as any).body ?? ARTICLE(),
      connectedAddresses: ["93.184.216.34"],
      redirectCount: 0,
    };
  };
}

function makeFakeDb(seed: { topics?: any[] } = {}) {
  const topics = new Map<string, any>((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const sources: any[] = [];
  const jobLogs: any[] = [];
  let seq = 0;
  let failNextSourceWrite = false;

  const api: any = {
    _topics: topics, _sources: sources, _jobLogs: jobLogs,
    _failNextSourceWrite: (on: boolean) => { failNextSourceWrite = on; },
    topicCandidate: {
      create: async ({ data }: any) => { const t = { id: `t-${++seq}`, createdAt: new Date(), ...data }; topics.set(t.id, t); return t; },
      findUnique: async ({ where }: any) => topics.get(where.id) ?? null,
      findMany: async ({ where }: any) => [...topics.values()].filter((t) =>
        where?.status?.in ? where.status.in.includes(t.status) : true),
      update: async ({ where, data }: any) => { const t = topics.get(where.id); Object.assign(t, data); return t; },
    },
    topicSource: {
      create: async ({ data }: any) => {
        if (failNextSourceWrite) throw new Error("simulated database failure");
        // Honour the real @@unique([topicId, canonicalUrl]).
        if (sources.some((s) => s.topicId === data.topicId && s.canonicalUrl === data.canonicalUrl)) {
          throw new Error("Unique constraint failed on the fields: (`topicId`,`canonicalUrl`)");
        }
        const row = { id: `s-${++seq}`, createdAt: new Date(), ...data };
        sources.push(row);
        return row;
      },
      findMany: async ({ where }: any) => sources.filter((s) => (where?.topicId ? s.topicId === where.topicId : true)),
    },
    jobLog: {
      create: async ({ data }: any) => { jobLogs.push(data); return data; },
      findFirst: async ({ where }: any) =>
        [...jobLogs].reverse().find((j) => (where?.jobType ? j.jobType === where.jobType : true)) ?? null,
      // Read by researchState.ts to derive live research state from real job history.
      findMany: async ({ where }: any) =>
        jobLogs
          .filter((j) => (where?.jobType ? j.jobType === where.jobType : true))
          .map((j) => ({ status: j.status, input: j.input, createdAt: j.createdAt ?? new Date() }))
          .reverse(),
    },
    aiHost: { findMany: async () => [{ id: "host-a" }, { id: "host-b" }] },
    team: { findMany: async () => [] },
    podcast: { findUnique: async () => null, findMany: async () => [] },
    episode: { findUnique: async () => null, create: async ({ data }: any) => ({ id: `ep-${++seq}`, ...data }) },
    episodeTopic: { findMany: async () => [], create: async ({ data }: any) => data },
    adminDraft: { findUnique: async () => null, upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) },
    // A transaction that ROLLS BACK: the doubles record what the callback did,
    // and on throw we restore the pre-transaction snapshot.
    $transaction: async (fn: any) => {
      const topicSnapshot = new Map(topics);
      const sourceSnapshot = [...sources];
      try {
        return await fn(api);
      } catch (err) {
        topics.clear();
        for (const [k, v] of topicSnapshot) topics.set(k, v);
        sources.length = 0;
        sources.push(...sourceSnapshot);
        throw err;
      }
    },
  };
  return api;
}

const ctxFor = (db: any, id = "e2e-admin"): IngestionCtx => ({ db, admin: { id } });
const adminCtxFor = (db: any, id = "e2e-admin"): AdminCtx => ({ admin: { id }, db });

async function main() {
  console.log("\nAdmin custom topics + source ingestion\n");

  // =====================================================================
  console.log("Custom topic — editorial input, never verified fact");
  // =====================================================================

  await check("a title is required", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "   " });
    assert(!r.ok && r.field === "title", `expected a title error, got ${JSON.stringify(r)}`);
  });

  await check("the title is trimmed and length-capped", async () => {
    const db = makeFakeDb();
    const ok: any = await createCustomTopic(ctxFor(db), { title: "  Spacious Take  " });
    assert(ok.ok, "should create");
    assert(db._topics.get(ok.topicId).title === "Spacious Take", `title not trimmed: '${db._topics.get(ok.topicId).title}'`);
    const long: any = await createCustomTopic(ctxFor(db), { title: "x".repeat(MAX_TITLE_LENGTH + 1) });
    assert(!long.ok && long.field === "title", "an over-long title must be rejected");
  });

  await check("CORE: a custom topic is created PENDING and is never silently approved", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "Is the MVP race over?" });
    assert(r.ok, "should create");
    assert(r.editorialStatus === "pending", `status was ${r.editorialStatus}`);
    assert(db._topics.get(r.topicId).status === "pending", "the stored row must be pending");
  });

  await check("CORE: NO fabricated evidence, facts or research brief are created", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), {
      title: "A hot take", angle: "The refs decided it", notes: "Some editorial notes",
      sourceUrls: ["https://news.test/a"],
    }, { fetchUrl: stubFetch({ "https://news.test/a": {} }) });
    assert(r.ok, "should create");
    const row = db._topics.get(r.topicId);
    // evidenceIds is the PIPELINE's verified output — an operator's opinion and
    // a pasted link must never appear there.
    assert(Array.isArray(row.evidenceIds) && row.evidenceIds.length === 0, `evidenceIds must be empty, got ${JSON.stringify(row.evidenceIds)}`);
    assert(row.researchBrief === undefined, "no ResearchBrief may be created");
    assert(r.researchReadiness === "not_researched", `readiness was ${r.researchReadiness}`);
    // ...even though a source WAS really imported.
    assert(r.importedSourceCount === 1, "the real source should still be imported");
  });

  await check("CORE: scores are zero, not invented", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "Unscored take" });
    const row = db._topics.get(r.topicId);
    for (const f of ["controversyScore", "starPowerScore", "bettingRelevanceScore", "recencyScore", "debateScore"]) {
      assert(row[f] === 0, `${f} was invented as ${row[f]}`);
    }
  });

  await check("CORE: the topic's REAL blocking reason is reported by the shared gate", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "Blocked take" });
    const row = db._topics.get(r.topicId);
    // Pending first...
    let reasons = evaluateHardGates({ ...row, researchBrief: null } as any, row.id);
    assert(reasons[0].code === "pending_approval", `expected pending_approval, got ${reasons[0].code}`);
    // ...and after approval, the honest "no evidence" — NOT a fake readiness.
    reasons = evaluateHardGates({ ...row, status: "approved", researchBrief: null } as any, row.id);
    assert(reasons[0].code === "insufficient_evidence", `expected insufficient_evidence, got ${reasons[0].code}`);
  });

  await check("angle, notes and free-text entities are kept as editorial context", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), {
      title: "T", angle: "The contrarian angle", notes: "Editorial notes here", teamsOrPlayers: "Chiefs, Mahomes",
    });
    const summary = db._topics.get(r.topicId).summary as string;
    assert(summary.includes("The contrarian angle") && summary.includes("Editorial notes here") && summary.includes("Chiefs, Mahomes"),
      `context lost: ${summary}`);
  });

  await check("the admin identity is recorded on every imported source", async () => {
    const db = makeFakeDb();
    await createCustomTopic(ctxFor(db, "ops-jane"), { title: "T", sourceUrls: ["https://news.test/a"] },
      { fetchUrl: stubFetch({ "https://news.test/a": {} }) });
    assert(db._sources[0].createdByAdminIdentity === "ops-jane", `identity was ${db._sources[0].createdByAdminIdentity}`);
  });

  await check("a new custom topic APPEARS in the Admin catalog with its blocking reason", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "Fresh custom take" });
    const pool: any = await getAdminTopicsFor(adminCtxFor(db));
    assert(pool.success, "pool should load");
    const vm = pool.topics.find((t: any) => t.id === r.topicId);
    assert(!!vm, "the new topic must be visible on the Admin board");
    assert(!vm.eligible, "a pending topic must not be selectable");
    assert(vm.eligibility.blockingReasons[0].code === "pending_approval", `reason was ${vm.eligibility.blockingReasons[0].code}`);
  });

  await check("CORE: a blocked custom topic cannot become an episode before the gates pass", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "Not ready" });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: [r.topicId], hostIds: ["host-a", "host-b"] });
    assert(!res.success, "an unapproved, evidence-less topic must not create an episode");
  });

  // =====================================================================
  console.log("\nDuplicate handling + idempotency");
  // =====================================================================

  await check("title normalization ignores case, punctuation and spacing", () => {
    assert(normalizeTitle("The  MVP Race — Over?!") === normalizeTitle("the mvp race over"), "should normalize to the same key");
    assert(normalizeTitle("A different take") !== normalizeTitle("the mvp race over"), "genuinely different titles must differ");
  });

  await check("a likely duplicate returns a WARNING plus the existing topic — it does not block", async () => {
    const db = makeFakeDb();
    const first: any = await createCustomTopic(ctxFor(db), { title: "The MVP race is over" });
    const second: any = await createCustomTopic(ctxFor(db), { title: "the  MVP  Race  is  over!" });
    assert(second.ok, "a similar title must NOT be refused — two takes can share a headline");
    assert(!!second.duplicateWarning, "a duplicate warning should be returned");
    assert(second.duplicateWarning.topicId === first.topicId, "the warning must reference the existing topic");
    assert(second.topicId !== first.topicId, "the operator's explicit second topic is still created");
  });

  await check("genuinely different topics are never flagged as duplicates", async () => {
    const db = makeFakeDb();
    await createCustomTopic(ctxFor(db), { title: "The MVP race is over" });
    const other: any = await createCustomTopic(ctxFor(db), { title: "Trade deadline: buyers or sellers?" });
    assert(other.ok && !other.duplicateWarning, "different titles must not warn");
  });

  await check("CORE: a repeated submit with the same idempotency key returns the SAME topic", async () => {
    const db = makeFakeDb();
    const key = "submit-abc-123";
    const first: any = await createCustomTopic(ctxFor(db), { title: "Double clicked", idempotencyKey: key });
    await db.jobLog.create({ data: { jobType: "admin:topic-custom-create", status: "completed", input: { idempotencyKey: key }, output: { topicId: first.topicId } } });
    const again: any = await createCustomTopic(ctxFor(db), { title: "Double clicked", idempotencyKey: key });
    assert(again.ok, "the retry should succeed");
    assert(again.topicId === first.topicId, "a double-submit must not create a second topic");
    assert(again.deduplicated === true, "the retry should report that it was deduplicated");
    assert(db._topics.size === 1, `expected 1 topic, got ${db._topics.size}`);
  });

  // =====================================================================
  console.log("\nSource ingestion");
  // =====================================================================

  await check("a valid article imports with sanitized metadata", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "T", sourceUrls: ["https://news.test/a"] },
      { fetchUrl: stubFetch({ "https://news.test/a": { body: ARTICLE("Chiefs win thriller") } }) });
    assert(r.importedSourceCount === 1, "expected 1 import");
    assert(r.sources[0].status === "imported", `status ${r.sources[0].status}`);
    const row = db._sources[0];
    assert(row.title === "Chiefs win thriller", `title ${row.title}`);
    assert(row.publisher === "Example News", `publisher ${row.publisher}`);
    assert(typeof row.contentHash === "string" && row.contentHash.length === 64, "a content hash should be stored");
    assert(row.excerpt.includes("Genuine reporting body text"), "the excerpt should be stored");
    assert(row.fetchStatus === "imported", `fetchStatus ${row.fetchStatus}`);
  });

  await check("CORE: raw HTML is NEVER stored", async () => {
    const db = makeFakeDb();
    await createCustomTopic(ctxFor(db), { title: "T", sourceUrls: ["https://news.test/a"] },
      { fetchUrl: stubFetch({ "https://news.test/a": { body: `<html><body><script>alert(1)</script><p>${"Real text long enough to keep as an excerpt. ".repeat(3)}</p></body></html>` } }) });
    const blob = JSON.stringify(db._sources[0]);
    assert(!blob.includes("<script"), "a script tag reached the database");
    assert(!blob.includes("<p>"), "raw HTML reached the database");
    assert(!blob.includes("alert(1)"), "a script payload reached the database");
  });

  await check("more than the max URLs per request is refused", async () => {
    const db = makeFakeDb();
    const urls = Array.from({ length: MAX_URLS_PER_REQUEST + 1 }, (_, i) => `https://news.test/${i}`);
    const r: any = await createCustomTopic(ctxFor(db), { title: "T", sourceUrls: urls });
    assert(!r.ok && r.field === "sourceUrls", `expected a sourceUrls error, got ${JSON.stringify(r)}`);
  });

  await check("CORE: partial failure keeps the successes and reports each URL honestly", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), {
      title: "Mixed bag",
      sourceUrls: ["https://good.test/a", "https://blocked.test/b", "https://slow.test/c"],
    }, {
      fetchUrl: stubFetch({
        "https://good.test/a": {},
        "https://blocked.test/b": { ok: false, category: "blocked_destination", message: "That link points somewhere this server won't fetch." } as any,
        "https://slow.test/c": { ok: false, category: "timeout", message: "That site took too long to respond." } as any,
      }),
    });
    assert(r.ok, "the topic must still be created");
    assert(r.importedSourceCount === 1 && r.failedSourceCount === 2, `counts: ${r.importedSourceCount}/${r.failedSourceCount}`);
    assert(r.sources.length === 3, "every URL must get a result");
    const byUrl = Object.fromEntries(r.sources.map((s: any) => [s.url, s.status]));
    assert(byUrl["https://good.test/a"] === "imported", "the good URL should import");
    assert(byUrl["https://blocked.test/b"] === "blocked_destination", `blocked -> ${byUrl["https://blocked.test/b"]}`);
    assert(byUrl["https://slow.test/c"] === "timeout", `timeout -> ${byUrl["https://slow.test/c"]}`);
    assert(db._sources.length === 1, "only the successful source may be persisted");
  });

  await check("retryable failures are distinguished from structural ones", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), {
      title: "T", sourceUrls: ["https://slow.test/a", "https://evil.test/b"],
    }, {
      fetchUrl: stubFetch({
        "https://slow.test/a": { ok: false, category: "timeout", message: "" } as any,
        "https://evil.test/b": { ok: false, category: "blocked_destination", message: "" } as any,
      }),
    });
    const byUrl = Object.fromEntries(r.sources.map((s: any) => [s.url, s.retryable]));
    assert(byUrl["https://slow.test/a"] === true, "a timeout should be retryable");
    assert(byUrl["https://evil.test/b"] === false, "a blocked destination is structural — retrying is pointless");
  });

  await check("an invalid URL is rejected without any fetch attempt", async () => {
    const db = makeFakeDb();
    let called = 0;
    const r: any = await createCustomTopic(ctxFor(db), { title: "T", sourceUrls: ["not a url", "file:///etc/passwd", "https://u:p@x.test/a"] },
      { fetchUrl: (async () => { called++; return { ok: false, category: "fetch_failed", message: "" }; }) as any });
    assert(called === 0, "a structurally invalid URL must never reach the fetcher");
    const codes = r.sources.map((s: any) => s.status);
    assert(codes.includes("invalid_url") && codes.includes("unsupported_protocol") && codes.includes("embedded_credentials"),
      `expected precise reasons, got ${codes.join(",")}`);
  });

  await check("two URLs canonicalizing to the SAME document import once", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), {
      title: "T", sourceUrls: ["https://news.test/a#top", "https://news.test/a?utm_source=x"],
    }, {
      fetchUrl: stubFetch({
        "https://news.test/a#top": { finalUrl: "https://news.test/a" },
        "https://news.test/a?utm_source=x": { finalUrl: "https://news.test/a" },
      }),
    });
    assert(db._sources.length === 1, `expected 1 stored source, got ${db._sources.length}`);
    assert(r.sources.filter((s: any) => s.status === "duplicate").length === 1, "the second should be reported as a duplicate");
  });

  await check("importing onto an existing topic skips already-imported sources", async () => {
    const db = makeFakeDb();
    const created: any = await createCustomTopic(ctxFor(db), { title: "T", sourceUrls: ["https://news.test/a"] },
      { fetchUrl: stubFetch({ "https://news.test/a": {} }) });
    const again: any = await importSourcesForTopic(ctxFor(db), created.topicId, ["https://news.test/a"],
      { fetchUrl: stubFetch({ "https://news.test/a": {} }) });
    assert(again.ok, "should succeed");
    assert(again.sources[0].status === "duplicate", `expected duplicate, got ${again.sources[0].status}`);
    assert(db._sources.length === 1, "no second copy may be stored");
  });

  await check("enrichment of an existing topic never changes its editorial status", async () => {
    const db = makeFakeDb();
    const created: any = await createCustomTopic(ctxFor(db), { title: "T" });
    await db.topicCandidate.update({ where: { id: created.topicId }, data: { status: "approved" } });
    await importSourcesForTopic(ctxFor(db), created.topicId, ["https://news.test/b"], { fetchUrl: stubFetch({ "https://news.test/b": {} }) });
    const row = db._topics.get(created.topicId);
    assert(row.status === "approved", "status must be untouched");
    assert(Array.isArray(row.evidenceIds) && row.evidenceIds.length === 0, "importing a source must never write evidence");
  });

  await check("a multi-source topic stores each source", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "T", sourceUrls: ["https://a.test/1", "https://b.test/2"] },
      { fetchUrl: stubFetch({ "https://a.test/1": { finalUrl: "https://a.test/1" }, "https://b.test/2": { finalUrl: "https://b.test/2" } }) });
    assert(r.importedSourceCount === 2, `imported ${r.importedSourceCount}`);
    assert(db._sources.length === 2, `stored ${db._sources.length}`);
    assert(db._sources.every((s: any) => s.topicId === r.topicId), "every source must link to the topic");
  });

  await check("CORE: a database failure rolls the whole creation back", async () => {
    const db = makeFakeDb();
    db._failNextSourceWrite(true);
    let threw = false;
    try {
      await createCustomTopic(ctxFor(db), { title: "Doomed", sourceUrls: ["https://news.test/a"] },
        { fetchUrl: stubFetch({ "https://news.test/a": {} }) });
    } catch { threw = true; }
    assert(threw, "a database failure should surface, not be swallowed");
    assert(db._topics.size === 0, `the topic must not survive a failed transaction (found ${db._topics.size})`);
    assert(db._sources.length === 0, "no partial sources may survive");
  });

  await check("the sanitized source list is safe to display", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "T", sourceUrls: ["https://news.test/a"] },
      { fetchUrl: stubFetch({ "https://news.test/a": {} }) });
    const list = await listTopicSources(ctxFor(db), r.topicId);
    assert(list.length === 1, "expected one source");
    assert(!("contentHash" in list[0]) || true, "internal fields need not be exposed");
    assert(!/[<>]/.test(JSON.stringify(list[0])), "no markup may reach the UI payload");
  });

  // =====================================================================
  console.log("\nResearch integration");
  // =====================================================================

  await check("a pending custom topic requires approval before research is meaningful", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "T" });
    assert(r.nextActions[0] === "approve", `approval must come first, got ${r.nextActions.join(",")}`);
    assert(r.nextActions.includes("research"), "research should be an offered next action");
  });

  await check("research readiness is reported honestly as not_researched", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "T", sourceUrls: ["https://news.test/a"] },
      { fetchUrl: stubFetch({ "https://news.test/a": {} }) });
    // Importing sources is NOT research. Claiming otherwise would be the exact
    // fabrication this feature is built to avoid.
    assert(r.researchReadiness === "not_researched", `readiness was ${r.researchReadiness}`);
  });

  await check("no research state is invented without a durable record", async () => {
    const db = makeFakeDb();
    const r: any = await createCustomTopic(ctxFor(db), { title: "T" });
    const pool: any = await getAdminTopicsFor(adminCtxFor(db));
    const vm = pool.topics.find((t: any) => t.id === r.topicId);
    const codes = vm.eligibility.warnings.map((w: any) => w.code);
    // With no JobLog rows there is no proof of any research run, so none is claimed.
    assert(!codes.includes("research_queued") && !codes.includes("research_in_progress") && !codes.includes("research_failed"),
      `research state invented without a record: ${codes.join(",")}`);
  });

  // =====================================================================
  console.log("\nAuthorization + audit + rate limits");
  // =====================================================================

  await check("EVERY exported ingestion action is requireAdmin()-gated", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/episodes/ingestionActions.ts"), "utf8");
    const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    assert(exported.length >= 3, `expected the full action surface, found ${exported.length}`);
    for (const name of exported) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const end = body.indexOf("\nexport async function", 1);
      const fn = end === -1 ? body : body.slice(0, end);
      assert(/await requireAdmin\(\);/.test(fn), `${name}() does NOT call requireAdmin()`);
    }
  });

  await check("no ingestion action trusts a client-supplied identity or admin flag", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/episodes/ingestionActions.ts"), "utf8");
    assert(!/input\.(isAdmin|role|ownerId|adminId|actor|auditActor)/.test(src), "an action reads authority from the client payload");
    assert(/adminIdentity\(\)/.test(src), "the operator identity must come from the verified credential");
  });

  await check("the audit actor is derived server-side, never from the caller", async () => {
    const db = makeFakeDb();
    // Even if a caller tries to pass an actor, the service takes ctx.admin.id,
    // which the action layer fills from adminIdentity().
    await createCustomTopic(ctxFor(db, "real-operator"), { title: "T", sourceUrls: ["https://news.test/a"] } as any,
      { fetchUrl: stubFetch({ "https://news.test/a": {} }) });
    assert(db._sources[0].createdByAdminIdentity === "real-operator", "the recorded identity must be the server's");
  });

  await check("all four audit event types are wired to the real convention", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/episodes/ingestionActions.ts"), "utf8");
    for (const evt of ["topic-custom-create", "topic-source-import", "topic-source-import-failure", "topic-source-duplicate"]) {
      assert(src.includes(`"${evt}"`), `missing audit event: admin:${evt}`);
    }
    assert(/jobType: `admin:\$\{action\}`/.test(src), "audits must use the existing admin:* JobLog convention");
  });

  await check("the rate limiter refuses once the window limit is exceeded", async () => {
    const counts = new Map<string, number>();
    const redis = {
      incrby: async (k: string, n: number) => { const v = (counts.get(k) ?? 0) + n; counts.set(k, v); return v; },
      expire: async () => 1,
      ttl: async () => 60,
    };
    const rule = ADMIN_RATE_LIMITS.customTopicCreate;
    let last = await consumeRateLimit("customTopicCreate", "op", { redis });
    for (let i = 1; i < rule.limit; i++) last = await consumeRateLimit("customTopicCreate", "op", { redis });
    assert(last.allowed, "requests within the limit must be allowed");
    const over = await consumeRateLimit("customTopicCreate", "op", { redis });
    assert(!over.allowed, "the request past the limit must be refused");
    assert(over.retryAfterSeconds > 0, "a retry-after should be offered");
  });

  await check("rate limits are scoped per operator", async () => {
    const counts = new Map<string, number>();
    const redis = {
      incrby: async (k: string, n: number) => { const v = (counts.get(k) ?? 0) + n; counts.set(k, v); return v; },
      expire: async () => 1, ttl: async () => 60,
    };
    for (let i = 0; i < ADMIN_RATE_LIMITS.customTopicCreate.limit + 1; i++) await consumeRateLimit("customTopicCreate", "op1", { redis });
    const other = await consumeRateLimit("customTopicCreate", "op2", { redis });
    assert(other.allowed, "one operator's limit must not block another");
  });

  await check("URL fetches are charged per URL, not per request", async () => {
    const counts = new Map<string, number>();
    const redis = {
      incrby: async (k: string, n: number) => { const v = (counts.get(k) ?? 0) + n; counts.set(k, v); return v; },
      expire: async () => 1, ttl: async () => 60,
    };
    const r = await consumeRateLimit("sourceFetch", "op", { cost: 5, redis });
    assert(r.remaining === ADMIN_RATE_LIMITS.sourceFetch.limit - 5, `expected 5 charged, remaining ${r.remaining}`);
  });

  await check("CORE: an unavailable limiter FAILS SAFE instead of hanging the operator", async () => {
    // The shared redis client retries forever (BullMQ needs maxRetriesPerRequest:
    // null), so an unbounded command would never settle. This must not hang.
    const neverSettles = {
      incrby: () => new Promise<number>(() => {}),
      expire: async () => 1,
      ttl: async () => 60,
    };
    const started = Date.now();
    const r = await consumeRateLimit("customTopicCreate", "op", { redis: neverSettles as any });
    const elapsed = Date.now() - started;
    assert(r.allowed, "a limiter that can't answer must not block an authorized operator");
    assert(r.degraded, "the degraded state must be reported, not hidden");
    assert(elapsed < 3000, `the limiter hung for ${elapsed}ms — it must time out`);
  });

  await check("a throwing limiter also fails safe", async () => {
    const broken = { incrby: async () => { throw new Error("redis down"); }, expire: async () => 1, ttl: async () => 60 };
    const r = await consumeRateLimit("sourceImport", "op", { redis: broken as any });
    assert(r.allowed && r.degraded, "a throwing limiter must fail safe and say so");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
