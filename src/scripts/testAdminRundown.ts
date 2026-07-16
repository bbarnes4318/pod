// Admin rundown-builder tests. Run: npm run test:admin-rundown
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: in-memory
   fake DB doubles + dynamic seed payloads are intentionally loosely typed. */
//
// Proves the claim this whole change rests on: Admin and Studio decide with the
// SAME rules, and Admin's extra authority is authority ONLY — never a second,
// quieter rulebook.
//
// Coverage:
//   • Shared behaviour  — below-threshold topics stay visible/pickable, every
//     blocking reason is the precise one, dedupe/order/lead/max-count.
//   • Authorization     — the Basic-Auth primitive fails closed; the shared
//     creation core strips reuseOverride for non-admins; every admin action is
//     requireAdmin()-gated; client-supplied ids can't escalate.
//   • Admin creation    — manual/automatic/hybrid, exact EpisodeTopic order,
//     snapshots, reduced-rundown honesty, and Admin/Studio parity.
//   • Draft behaviour   — save/resume, exact order, mode/target/lead/filters,
//     changed eligibility surfaced not silently dropped, and admin identity
//     persisted with NO invalid foreign key.

process.env.TOPIC_MIN_TALKABILITY = "1";

import fs from "fs";
import path from "path";
import { buildStudioTopicVMs } from "../lib/services/studioTopicPool";
import { evaluateTopicSelection, type EligibilityTopic } from "../lib/services/topicEligibility";
import { getTopicUsage, resolveTopicReusePolicy } from "../lib/services/topicUsageService";
import { getResearchStates } from "../lib/services/researchState";
import { createRundownEpisode } from "../lib/services/rundownCreation";
import { createStudioEpisodeFor, type StudioCtx } from "../lib/services/studioActions";
import {
  getAdminTopicsFor, createAdminEpisodeFor, resumeAdminRundown,
  saveAdminDraftFor, loadAdminDraftFor, discardAdminDraftFor, type AdminCtx,
} from "../lib/services/adminRundown";
import { AdminRundownDraftStateSchema } from "../lib/services/adminDraft";
import { EpisodeTopicSnapshotV1Schema } from "../lib/services/topicSnapshot";
import { verifyAdminAuthHeader } from "../lib/adminBasicAuth";
import { PLATFORM_MAX_TOPICS, DEFAULT_MIN_DEBATE_SCORE } from "../lib/episodeLimits";

/** Pin the cast on every creation. hostCasting.ts resolves an UNPINNED roster
 *  through the module-level `db` rather than the injected one, so leaving hosts
 *  empty would reach past the fake-db seam to a real connection. */
const H = ["host-a", "host-b"];

let passed = 0, failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.error(`  ✗ ${name}\n      ${(err as Error).message}`); }
}
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const okDeps = { assertCanCreateEpisode: async () => ({ ok: true as const }), assertPremiumVoiceAllowed: async () => ({ ok: true as const }) };

function goodTopic(id: string, over: any = {}) {
  return {
    id, title: `Topic ${id}`, status: "approved", sport: "NFL", leagueId: "NFL",
    summary: "A genuinely hot debate about last night's game and what it means for the season.",
    debateScore: 90, controversyScore: 80, starPowerScore: 70, bettingRelevanceScore: 40, recencyScore: 80,
    evidenceIds: [{ type: "news", id: "n1" }], createdAt: new Date("2026-07-10T00:00:00Z"),
    researchBrief: {
      facts: [{ text: "A real grounded fact." }], sourceIds: [{ type: "news", id: "n1" }], stats: [],
      argumentForHostA: "A side", argumentForHostB: "B side", mainAngle: "angle", contrarianAngle: "contra",
      whyMattersNow: "it matters", onAirTalkingPoints: ["point one"], keyFactsContext: [{ text: "key fact" }],
      unsafeClaims: [],
    },
    ...over,
  };
}

function makeFakeDb(seed: { topics?: any[]; podcasts?: any[]; hosts?: any[]; teams?: any[]; jobLogs?: any[] }) {
  const topics = new Map((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const podcasts = seed.podcasts || [];
  const hosts = seed.hosts || [{ id: "host-a", ownerId: null, isActive: true }, { id: "host-b", ownerId: null, isActive: true }];
  const teams = seed.teams || [];
  const jobLogs: any[] = seed.jobLogs || [];
  const episodes = new Map<string, any>();
  const episodeTopics: any[] = [];
  const studioDrafts = new Map<string, any>();
  const adminDrafts = new Map<string, any>();
  const makeEpisode = (data: any) => { const e = { id: `ep-${episodes.size + 1}`, ...data }; episodes.set(e.id, e); return e; };
  const etFindMany = async ({ where, select }: any) => {
    const rows = episodeTopics.filter((et) => {
      if (where?.topicId?.in && !where.topicId.in.includes(et.topicId)) return false;
      if (where?.episode?.podcastId) { const ep = episodes.get(et.episodeId); if (!ep || ep.podcastId !== where.episode.podcastId) return false; }
      return true;
    });
    return rows.map((et) => {
      const ep = episodes.get(et.episodeId);
      const out: any = { topicId: et.topicId, selectedAt: et.selectedAt };
      if (select?.episode) out.episode = { ownerId: ep?.ownerId ?? null, podcastId: ep?.podcastId ?? null };
      return out;
    });
  };
  return {
    _episodes: episodes, _episodeTopics: episodeTopics, _adminDrafts: adminDrafts, _jobLogs: jobLogs,
    topicCandidate: {
      findUnique: async ({ where }: any) => topics.get(where.id) ?? null,
      findMany: async ({ where }: any) => [...topics.values()].filter((t) =>
        where?.status?.in ? where.status.in.includes(t.status) : where?.status ? t.status === where.status : true),
      update: async ({ where, data }: any) => { const t = topics.get(where.id); Object.assign(t, data); return t; },
    },
    aiHost: { findMany: async ({ where }: any) => hosts.filter((h) => (where?.id?.in ? where.id.in.includes(h.id) : true)).map((h) => ({ id: h.id })) },
    team: { findMany: async ({ where }: any) => teams.filter((t: any) => (where?.id?.in ? where.id.in.includes(t.id) : true)).map((t: any) => ({ id: t.id, name: t.name })) },
    podcast: {
      findUnique: async ({ where }: any) => podcasts.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }: any) => podcasts.filter((p) => (where?.ownerId ? p.ownerId === where.ownerId : true)),
    },
    episode: { findUnique: async ({ where }: any) => [...episodes.values()].find((e) => e.slug === where.slug) ?? null, create: async ({ data }: any) => makeEpisode(data) },
    episodeTopic: { findMany: etFindMany, create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    jobLog: {
      findMany: async ({ where }: any) => jobLogs
        .filter((j) => (where?.jobType ? j.jobType === where.jobType : true))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      create: async ({ data }: any) => { jobLogs.push(data); return data; },
    },
    $transaction: async (fn: any) => fn({
      episode: { create: async ({ data }: any) => makeEpisode(data) },
      episodeTopic: { create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    }),
    studioDraft: {
      findUnique: async ({ where }: any) => studioDrafts.get(where.ownerId) ?? null,
      upsert: async ({ where, create, update }: any) => { const ex = studioDrafts.get(where.ownerId); studioDrafts.set(where.ownerId, ex ? { ...ex, ...update } : create); return studioDrafts.get(where.ownerId); },
      deleteMany: async ({ where }: any) => { studioDrafts.delete(where.ownerId); return { count: 1 }; },
    },
    adminDraft: {
      findUnique: async ({ where }: any) => adminDrafts.get(where.adminId) ?? null,
      upsert: async ({ where, create, update }: any) => { const ex = adminDrafts.get(where.adminId); adminDrafts.set(where.adminId, ex ? { ...ex, ...update } : create); return adminDrafts.get(where.adminId); },
      deleteMany: async ({ where }: any) => { adminDrafts.delete(where.adminId); return { count: 1 }; },
    },
  };
}

const adminCtxFor = (db: any, id = "admin"): AdminCtx => ({ admin: { id }, db });
const studioCtxFor = (db: any, id = "oA", role = "USER"): StudioCtx => ({ user: { id, role }, db });
const poolCtx = (usage: any = new Map()) => ({ usage, policy: resolveTopicReusePolicy() });

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]!; }
  try { await fn(); } finally { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
}

async function main() {
  console.log("\nAdmin rundown builder\n");

  // =====================================================================
  console.log("Shared behaviour — Admin sees what Studio's rules say, not a hidden filter");
  // =====================================================================

  await check("a topic BELOW the automatic debate threshold stays visible AND manually selectable on the Admin board", async () => {
    const low = goodTopic("low", { debateScore: DEFAULT_MIN_DEBATE_SCORE - 1 });
    const db = makeFakeDb({ topics: [low] });
    const res = await getAdminTopicsFor(adminCtxFor(db));
    assert(res.success, "pool load failed");
    const vm = (res as any).topics.find((t: any) => t.id === "low");
    assert(!!vm, "the low-scoring topic was HIDDEN from Admin — the old SQL filter is back");
    assert(vm.eligible, "the low-scoring topic was not manually selectable");
    assert(vm.eligibility.visible, "topic not visible");
    assert(!vm.eligibility.automaticallySelectable, "it should still be skipped by the AUTO picker");
    assert(vm.eligibility.warnings.some((w: any) => w.code === "below_automatic_threshold"), "no below_automatic_threshold warning explaining the auto-skip");
    assert(vm.eligibility.blockingReasons.length === 0, "a low score must never BLOCK a manual pick");
  });

  await check("an evidence-blocked topic reports the EVIDENCE reason (never a low-score reason)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("noev", { evidenceIds: [] })] });
    const res: any = await getAdminTopicsFor(adminCtxFor(db));
    const vm = res.topics.find((t: any) => t.id === "noev");
    assert(!!vm, "evidence-less topic was hidden instead of explained");
    assert(!vm.eligible, "a topic with no evidence must not be selectable");
    assert(vm.eligibility.blockingReasons[0].code === "insufficient_evidence", `expected insufficient_evidence, got ${vm.eligibility.blockingReasons[0].code}`);
    assert(/evidenceIds/.test(vm.unavailableReason), "the reason must name the real problem");
  });

  await check("pending / rejected / archived each get their OWN explanation", async () => {
    const db = makeFakeDb({ topics: [goodTopic("p", { status: "pending" }), goodTopic("r", { status: "rejected" }), goodTopic("a", { status: "archived" })] });
    const res: any = await getAdminTopicsFor(adminCtxFor(db));
    const code = (id: string) => res.topics.find((t: any) => t.id === id).eligibility.blockingReasons[0].code;
    assert(code("p") === "pending_approval", `pending -> ${code("p")}`);
    assert(code("r") === "rejected", `rejected -> ${code("r")}`);
    assert(code("a") === "archived", `archived -> ${code("a")}`);
    assert(res.topics.length === 3, "unapproved topics were hidden from an authorized admin");
  });

  await check("missing brief / facts / sources / host arguments are distinct reasons", async () => {
    const db = makeFakeDb({ topics: [
      goodTopic("nb", { researchBrief: null }),
      goodTopic("nf", { researchBrief: { ...goodTopic("x").researchBrief, facts: [] } }),
      goodTopic("ns", { researchBrief: { ...goodTopic("x").researchBrief, sourceIds: [] } }),
      goodTopic("nh", { researchBrief: { ...goodTopic("x").researchBrief, argumentForHostA: "  " } }),
    ] });
    const res: any = await getAdminTopicsFor(adminCtxFor(db));
    const code = (id: string) => res.topics.find((t: any) => t.id === id).eligibility.blockingReasons[0].code;
    assert(code("nb") === "missing_brief", `nb -> ${code("nb")}`);
    assert(code("nf") === "missing_facts", `nf -> ${code("nf")}`);
    assert(code("ns") === "missing_sources", `ns -> ${code("ns")}`);
    assert(code("nh") === "missing_host_arguments", `nh -> ${code("nh")}`);
  });

  await check("research IN PROGRESS and FAILED are derived from real job history", async () => {
    const db = makeFakeDb({
      topics: [goodTopic("t-run"), goodTopic("t-fail"), goodTopic("t-done")],
      jobLogs: [
        { jobType: "generate:research-brief", status: "running", input: { topicId: "t-run" }, createdAt: new Date("2026-07-14T10:00:00Z") },
        { jobType: "generate:research-brief", status: "failed", input: { topicId: "t-fail" }, createdAt: new Date("2026-07-14T10:00:00Z") },
        { jobType: "generate:research-brief", status: "completed", input: { topicId: "t-done" }, createdAt: new Date("2026-07-14T10:00:00Z") },
      ],
    });
    const res: any = await getAdminTopicsFor(adminCtxFor(db));
    const warns = (id: string) => res.topics.find((t: any) => t.id === id).eligibility.warnings.map((w: any) => w.code);
    assert(warns("t-run").includes("research_in_progress"), `t-run -> ${warns("t-run")}`);
    assert(warns("t-fail").includes("research_failed"), `t-fail -> ${warns("t-fail")}`);
    assert(!warns("t-done").includes("research_failed") && !warns("t-done").includes("research_in_progress"), "a completed run must not warn");
  });

  await check("the newest research attempt wins over an older one", async () => {
    const db = makeFakeDb({
      topics: [goodTopic("t1")],
      jobLogs: [
        { jobType: "generate:research-brief", status: "failed", input: { topicId: "t1" }, createdAt: new Date("2026-07-01T00:00:00Z") },
        { jobType: "generate:research-brief", status: "running", input: { topicId: "t1" }, createdAt: new Date("2026-07-14T00:00:00Z") },
      ],
    });
    const states = await getResearchStates(["t1"], db as any);
    assert(states.get("t1") === "in_progress", `expected the LATEST attempt to win, got ${states.get("t1")}`);
  });

  await check("recently used by the show is a WARNING under a warn policy (not a block)", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "warn", TOPIC_REUSE_COOLDOWN_DAYS: "7" }, async () => {
      const usage = new Map([["t1", { topicId: "t1", currentOwnerUseCount: 0, currentOwnerLastUsedAt: null, currentOwnerRecentUseCount: 0, currentPodcastUseCount: 1, currentPodcastLastUsedAt: new Date(), currentPodcastRecentUseCount: 1 }]]);
      const vms = buildStudioTopicVMs([goodTopic("t1")] as any, { ...poolCtx(usage), podcastId: "pod1", actor: { kind: "admin", adminId: "admin" } });
      assert(vms[0].eligible, "warn mode must not block");
      assert(vms[0].eligibility.warnings.some((w) => w.code === "recently_used"), "no recently_used warning");
    });
  });

  await check("the podcast reuse policy BLOCKS an owner but offers an admin the audited override", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast", TOPIC_REUSE_COOLDOWN_DAYS: "7" }, async () => {
      const usage = new Map([["t1", { topicId: "t1", currentOwnerUseCount: 0, currentOwnerLastUsedAt: null, currentOwnerRecentUseCount: 0, currentPodcastUseCount: 1, currentPodcastLastUsedAt: new Date(), currentPodcastRecentUseCount: 1 }]]);
      const asOwner = buildStudioTopicVMs([goodTopic("t1")] as any, { ...poolCtx(usage), podcastId: "pod1", actor: { kind: "owner", ownerId: "oA" } });
      assert(!asOwner[0].eligible, "an owner must be blocked by the reuse policy");
      assert(asOwner[0].eligibility.blockingReasons[0].code === "reuse_policy_blocked", "wrong block code for owner");
      assert(!asOwner[0].eligibility.actions.includes("reuse_override" as never), "an owner must NOT be offered the override");

      const asAdmin = buildStudioTopicVMs([goodTopic("t1")] as any, { ...poolCtx(usage), podcastId: "pod1", actor: { kind: "admin", adminId: "admin" } });
      assert(asAdmin[0].eligible, "an admin keeps the topic selectable via the override");
      assert(asAdmin[0].eligibility.actions.includes("reuse_override" as never), "the admin override action was not offered");
      assert(asAdmin[0].eligibility.warnings.some((w) => w.code === "recently_used"), "the admin still needs the recent-use warning");
    });
  });

  await check("admin-only actions are offered to admins and withheld from owners", async () => {
    const pending = goodTopic("p", { status: "pending" }) as unknown as EligibilityTopic;
    const asAdmin = evaluateTopicSelection(pending, { actor: { kind: "admin", adminId: "admin" }, policy: resolveTopicReusePolicy(), usage: new Map(), topicId: "p" });
    const asOwner = evaluateTopicSelection(pending, { actor: { kind: "owner", ownerId: "oA" }, policy: resolveTopicReusePolicy(), usage: new Map(), topicId: "p" });
    assert(asAdmin.actions.includes("approve"), "admin should be offered approve");
    assert(!asOwner.actions.includes("approve"), "an owner must NEVER be offered approve");
    assert(!asOwner.actions.includes("regenerate_research"), "an owner must NEVER be offered regenerate_research");
  });

  await check("already-selected topics warn without blocking", async () => {
    const vms = buildStudioTopicVMs([goodTopic("t1")] as any, { ...poolCtx(), selectedTopicIds: ["t1"], actor: { kind: "admin", adminId: "admin" } });
    assert(vms[0].eligibility.warnings.some((w) => w.code === "already_selected"), "no already_selected warning");
    assert(vms[0].eligible, "already-selected must not become un-selectable");
  });

  // =====================================================================
  console.log("\nAuthorization — authority differs, rules don't");
  // =====================================================================

  await check("the admin credential check FAILS CLOSED when no password is configured", async () => {
    await withEnv({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: undefined }, async () => {
      const header = "Basic " + Buffer.from("admin:anything").toString("base64");
      assert(verifyAdminAuthHeader(header) === false, "auth passed with NO configured password — fail-open!");
    });
  });

  await check("the admin credential check rejects a wrong password and a missing header", async () => {
    await withEnv({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "s3cret" }, async () => {
      assert(verifyAdminAuthHeader(null) === false, "missing header accepted");
      assert(verifyAdminAuthHeader("Basic " + Buffer.from("admin:wrong").toString("base64")) === false, "wrong password accepted");
      assert(verifyAdminAuthHeader("Basic " + Buffer.from("admin:s3cret").toString("base64")) === true, "correct password rejected");
    });
  });

  await check("EVERY exported admin rundown action is requireAdmin()-gated", async () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/episodes/rundownActions.ts"), "utf8");
    const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    assert(exported.length >= 7, `expected the full action surface, found ${exported.length}`);
    for (const name of exported) {
      const body = src.slice(src.indexOf(`export async function ${name}`));
      const end = body.indexOf("\nexport async function", 1);
      const fn = end === -1 ? body : body.slice(0, end);
      assert(/await requireAdmin\(\);/.test(fn), `${name}() does NOT call requireAdmin() — unauthenticated access`);
    }
  });

  await check("no admin action trusts a client-supplied role / ownerId / isAdmin flag", async () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/admin/episodes/rundownActions.ts"), "utf8");
    assert(!/input\.(isAdmin|role|ownerId)/.test(src), "an admin action reads authority out of the client payload");
    assert(/adminIdentity\(\)/.test(src), "the operator identity must come from the server-verified credential");
  });

  await check("the shared core STRIPS reuseOverride for an owner actor (a Studio user cannot self-authorize)", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast", TOPIC_REUSE_COOLDOWN_DAYS: "7" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2")], podcasts: [{ id: "pod1", ownerId: "oA", verticals: [], teams: [], segmentCount: 2, hostIds: [] }] });
      // t1 was used by pod1 moments ago.
      const prior = await db.episode.create({ data: { podcastId: "pod1", ownerId: "oA", slug: "prior", title: "Prior" } });
      db._episodeTopics.push({ episodeId: prior.id, topicId: "t1", orderIndex: 0, selectedAt: new Date() });

      // An owner hand-crafting reuseOverride: true must NOT get the override.
      const res = await createRundownEpisode(
        { db: db as any, authority: { kind: "owner", ownerId: "oA" }, canUsePodcast: () => true },
        { mode: "manual", selectedTopicIds: ["t1"], podcastId: "pod1", reuseOverride: true, hostIds: H }
      );
      assert(!(res.success && res.reuseOverrideApplied), "an OWNER got the admin reuse override — privilege escalation");
    });
  });

  await check("the same call WITH admin authority does apply the override", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast", TOPIC_REUSE_COOLDOWN_DAYS: "7" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pod1", ownerId: "oA", verticals: [], teams: [], segmentCount: 2, hostIds: [] }] });
      const prior = await db.episode.create({ data: { podcastId: "pod1", ownerId: "oA", slug: "prior", title: "Prior" } });
      db._episodeTopics.push({ episodeId: prior.id, topicId: "t1", orderIndex: 0, selectedAt: new Date() });

      const res = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: ["t1"], podcastId: "pod1", reuseOverride: true, hostIds: H });
      assert(res.success, `admin creation failed: ${(res as any).error}`);
      assert((res as any).reuseOverrideApplied, "the admin override was not applied");
      assert((res as any).finalOrder.includes("t1"), "the overridden topic didn't make the rundown");
    });
  });

  await check("an admin WITHOUT the override is still bound by the reuse policy (rules are shared)", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast", TOPIC_REUSE_COOLDOWN_DAYS: "7" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pod1", ownerId: "oA", verticals: [], teams: [], segmentCount: 2, hostIds: [] }] });
      const prior = await db.episode.create({ data: { podcastId: "pod1", ownerId: "oA", slug: "prior", title: "Prior" } });
      db._episodeTopics.push({ episodeId: prior.id, topicId: "t1", orderIndex: 0, selectedAt: new Date() });

      const res = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: ["t1"], podcastId: "pod1", hostIds: H });
      assert(!res.success, "an admin bypassed the reuse policy WITHOUT asking for the override");
    });
  });

  // =====================================================================
  console.log("\nAdmin creation — through the SHARED createEpisodeDraft");
  // =====================================================================

  await check("manual: three topics keep the operator's EXACT order in EpisodeTopic", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2"), goodTopic("t3")] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: ["t3", "t1", "t2"], hostIds: H });
    assert(res.success, `creation failed: ${res.error}`);
    assert(JSON.stringify(res.finalOrder) === JSON.stringify(["t3", "t1", "t2"]), `finalOrder ${res.finalOrder}`);
    const rows = db._episodeTopics.filter((e: any) => e.episodeId === res.episodeId).sort((a: any, b: any) => a.orderIndex - b.orderIndex);
    assert(JSON.stringify(rows.map((r: any) => r.topicId)) === JSON.stringify(["t3", "t1", "t2"]), "EpisodeTopic order != the operator's order");
  });

  await check("manual: the lead story is moved to position 1", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2"), goodTopic("t3")] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: ["t1", "t2", "t3"], leadTopicId: "t3", hostIds: H });
    assert(res.success, `creation failed: ${res.error}`);
    assert(res.finalOrder[0] === "t3", `lead not first: ${res.finalOrder}`);
    assert(JSON.stringify(res.finalOrder) === JSON.stringify(["t3", "t1", "t2"]), "the rest of the order was not preserved behind the lead");
  });

  await check("manual: a valid, versioned topic snapshot is created for every EpisodeTopic row", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2")] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: ["t1", "t2"], hostIds: H });
    const rows = db._episodeTopics.filter((e: any) => e.episodeId === res.episodeId);
    assert(rows.length === 2, "wrong row count");
    for (const r of rows) {
      assert(!!r.snapshot, `no immutable snapshot for ${r.topicId}`);
      // Validate against the REAL shared snapshot schema, not a guess at its shape.
      const parsed = EpisodeTopicSnapshotV1Schema.safeParse(r.snapshot);
      assert(parsed.success, `snapshot for ${r.topicId} doesn't satisfy the V1 schema: ${parsed.success ? "" : parsed.error.issues[0]?.message}`);
      assert(parsed.success && parsed.data.source === "creation", "snapshot not marked as created at selection time");
      assert(parsed.success && parsed.data.title === `Topic ${r.topicId}`, "snapshot didn't capture the topic as selected");
    }
  });

  await check("manual: an ADMIN-created episode is ownerless (no invalid User FK)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: ["t1"], hostIds: H });
    const ep = db._episodes.get(res.episodeId);
    assert(ep.ownerId === undefined || ep.ownerId === null, `admin episode got ownerId=${ep.ownerId} — that id has no User row`);
  });

  await check("manual: duplicate picks are deduplicated, first position wins", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2")] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: ["t1", "t2", "t1"], hostIds: H });
    assert(JSON.stringify(res.finalOrder) === JSON.stringify(["t1", "t2"]), `dedupe/order wrong: ${res.finalOrder}`);
  });

  await check(`manual: more than the platform maximum (${PLATFORM_MAX_TOPICS}) is rejected`, async () => {
    const ids = Array.from({ length: PLATFORM_MAX_TOPICS + 1 }, (_, i) => `t${i + 1}`);
    const db = makeFakeDb({ topics: ids.map((id) => goodTopic(id)) });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "manual", selectedTopicIds: ids, hostIds: H });
    assert(!res.success, "the platform topic cap was not enforced for Admin");
  });

  await check("automatic: the backend picks and returns the ordered rundown", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2"), goodTopic("t3")] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "automatic", selectedTopicIds: [], targetTopicCount: 2, hostIds: H });
    assert(res.success, `creation failed: ${res.error}`);
    assert(res.finalOrder.length === 2, `expected 2 auto topics, got ${res.finalOrder.length}`);
    assert(res.autoSelectedTopicIds.length === 2, "auto-selected topics were not reported as auto");
  });

  await check("automatic: a reduced rundown is reported honestly — nothing unrelated substituted", async () => {
    // Only ONE topic qualifies; the rest are blocked for real reasons.
    const db = makeFakeDb({ topics: [goodTopic("ok"), goodTopic("bad1", { evidenceIds: [] }), goodTopic("bad2", { status: "pending" })] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "automatic", selectedTopicIds: [], targetTopicCount: 3, hostIds: H });
    assert(res.success, `creation failed: ${res.error}`);
    assert(res.finalOrder.length === 1, `expected only the 1 qualifying topic, got ${res.finalOrder.length}`);
    assert(res.finalOrder[0] === "ok", "an unrelated topic was substituted in");
    assert(res.requestedCount === 3, `requestedCount should stay 3, got ${res.requestedCount}`);
    assert(res.finalOrder.length < res.requestedCount, "the shortfall must be visible to the caller");
  });

  await check("hybrid: pinned topics keep their order at the front and auto-fill takes the rest", async () => {
    const db = makeFakeDb({ topics: [goodTopic("p1"), goodTopic("p2"), goodTopic("a1"), goodTopic("a2")] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "hybrid", selectedTopicIds: ["p2", "p1"], targetTopicCount: 3, hostIds: H });
    assert(res.success, `creation failed: ${res.error}`);
    assert(res.finalOrder[0] === "p2" && res.finalOrder[1] === "p1", `pinned order was rewritten: ${res.finalOrder}`);
    assert(res.finalOrder.length === 3, `target count not met: ${res.finalOrder}`);
    assert(res.autoSelectedTopicIds.length === 1, "the auto-filled slot wasn't marked as auto");
    assert(!res.autoSelectedTopicIds.includes("p1") && !res.autoSelectedTopicIds.includes("p2"), "a pinned topic was mislabelled auto-filled");
  });

  await check("hybrid: the lead pin stays first even ahead of the other pins", async () => {
    const db = makeFakeDb({ topics: [goodTopic("p1"), goodTopic("p2"), goodTopic("a1")] });
    const res: any = await createAdminEpisodeFor(adminCtxFor(db), { mode: "hybrid", selectedTopicIds: ["p1", "p2"], leadTopicId: "p2", targetTopicCount: 3, hostIds: H });
    assert(res.success, `creation failed: ${res.error}`);
    assert(res.finalOrder[0] === "p2", `lead pin not first: ${res.finalOrder}`);
  });

  // =====================================================================
  console.log("\nAdmin/Studio parity — equivalent input, identical outcome");
  // =====================================================================

  await check("PARITY: manual — identical finalOrder and identical EpisodeTopic order", async () => {
    const seed = () => [goodTopic("t1"), goodTopic("t2"), goodTopic("t3")];
    const adb = makeFakeDb({ topics: seed() });
    const sdb = makeFakeDb({ topics: seed() });
    const a: any = await createAdminEpisodeFor(adminCtxFor(adb), { mode: "manual", selectedTopicIds: ["t2", "t3", "t1"], leadTopicId: "t3", hostIds: H });
    const s: any = await createStudioEpisodeFor(studioCtxFor(sdb), { mode: "manual", selectedTopicIds: ["t2", "t3", "t1"], leadTopicId: "t3", hostIds: H }, okDeps);
    assert(a.success && s.success, "one surface failed to create");
    assert(JSON.stringify(a.finalOrder) === JSON.stringify(s.finalOrder), `Admin ${a.finalOrder} != Studio ${s.finalOrder}`);
    const order = (db: any, id: string) => db._episodeTopics.filter((e: any) => e.episodeId === id).sort((x: any, y: any) => x.orderIndex - y.orderIndex).map((r: any) => r.topicId);
    assert(JSON.stringify(order(adb, a.episodeId)) === JSON.stringify(order(sdb, s.episodeId)), "EpisodeTopic order differs between surfaces");
  });

  await check("PARITY: automatic — the same topics are selected in the same order", async () => {
    const seed = () => [goodTopic("t1", { debateScore: 95 }), goodTopic("t2", { debateScore: 85 }), goodTopic("t3", { debateScore: 75 })];
    const adb = makeFakeDb({ topics: seed() });
    const sdb = makeFakeDb({ topics: seed() });
    const a: any = await createAdminEpisodeFor(adminCtxFor(adb), { mode: "automatic", selectedTopicIds: [], targetTopicCount: 2, hostIds: H });
    const s: any = await createStudioEpisodeFor(studioCtxFor(sdb), { mode: "automatic", selectedTopicIds: [], targetTopicCount: 2, hostIds: H }, okDeps);
    assert(JSON.stringify(a.finalOrder) === JSON.stringify(s.finalOrder), `Admin ${a.finalOrder} != Studio ${s.finalOrder}`);
  });

  await check("PARITY: hybrid — pinned + auto-filled resolve identically", async () => {
    const seed = () => [goodTopic("p1"), goodTopic("a1", { debateScore: 88 }), goodTopic("a2", { debateScore: 77 })];
    const adb = makeFakeDb({ topics: seed() });
    const sdb = makeFakeDb({ topics: seed() });
    const a: any = await createAdminEpisodeFor(adminCtxFor(adb), { mode: "hybrid", selectedTopicIds: ["p1"], targetTopicCount: 2, hostIds: H });
    const s: any = await createStudioEpisodeFor(studioCtxFor(sdb), { mode: "hybrid", selectedTopicIds: ["p1"], targetTopicCount: 2, hostIds: H }, okDeps);
    assert(JSON.stringify(a.finalOrder) === JSON.stringify(s.finalOrder), `Admin ${a.finalOrder} != Studio ${s.finalOrder}`);
    assert(JSON.stringify(a.autoSelectedTopicIds) === JSON.stringify(s.autoSelectedTopicIds), "auto-fill labelling differs");
  });

  await check("PARITY: the same topic yields the same eligibility codes for admin and owner (hard gates)", async () => {
    const cases = [goodTopic("g"), goodTopic("p", { status: "pending" }), goodTopic("e", { evidenceIds: [] }), goodTopic("b", { researchBrief: null })];
    for (const t of cases) {
      const asAdmin = evaluateTopicSelection(t as unknown as EligibilityTopic, { actor: { kind: "admin", adminId: "admin" }, policy: resolveTopicReusePolicy(), usage: new Map(), topicId: t.id });
      const asOwner = evaluateTopicSelection(t as unknown as EligibilityTopic, { actor: { kind: "owner", ownerId: "oA" }, policy: resolveTopicReusePolicy(), usage: new Map(), topicId: t.id });
      assert(JSON.stringify(asAdmin.blockingReasons) === JSON.stringify(asOwner.blockingReasons), `hard gates differ for ${t.id}`);
      assert(asAdmin.manuallySelectable === asOwner.manuallySelectable, `selectability differs for ${t.id}`);
    }
  });

  await check("PARITY: Admin's board and Studio's board agree on every shared topic's eligibility", async () => {
    const topics = [goodTopic("t1"), goodTopic("low", { debateScore: 10 }), goodTopic("noev", { evidenceIds: [] })];
    const adb = makeFakeDb({ topics });
    const sdb = makeFakeDb({ topics });
    const a: any = await getAdminTopicsFor(adminCtxFor(adb));
    const { getStudioTopicsFor } = await import("../lib/services/studioActions");
    const s: any = await getStudioTopicsFor(studioCtxFor(sdb));
    for (const st of s.topics) {
      const at = a.topics.find((x: any) => x.id === st.id);
      assert(!!at, `Admin hid ${st.id} which Studio shows`);
      assert(at.eligible === st.eligible, `selectability differs for ${st.id}`);
      assert(JSON.stringify(at.eligibility.blockingReasons) === JSON.stringify(st.eligibility.blockingReasons), `blocking reasons differ for ${st.id}`);
    }
  });

  await check("EXPECTED DIFFERENCE: Admin sees the unapproved catalog that Studio does not", async () => {
    const topics = [goodTopic("ok"), goodTopic("rej", { status: "rejected" })];
    const adb = makeFakeDb({ topics });
    const sdb = makeFakeDb({ topics });
    const a: any = await getAdminTopicsFor(adminCtxFor(adb));
    const { getStudioTopicsFor } = await import("../lib/services/studioActions");
    const s: any = await getStudioTopicsFor(studioCtxFor(sdb));
    assert(a.topics.some((t: any) => t.id === "rej"), "Admin should see rejected topics (to act on them)");
    assert(!s.topics.some((t: any) => t.id === "rej"), "Studio must not see rejected topics");
  });

  // =====================================================================
  console.log("\nAdmin draft — save, resume, and honest change reporting");
  // =====================================================================

  await check("save + resume restores mode, EXACT order, lead, target and filters", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2"), goodTopic("t3")] });
    const ctx = adminCtxFor(db);
    const state = {
      mode: "hybrid" as const, selectedTopicIds: ["t3", "t1"], leadTopicId: "t1", targetTopicCount: 3,
      sport: "NFL", minDebateScore: 55, title: "My show", description: "desc",
      reuseOverride: true, reuseOverrideReason: "editorial call", activeStep: "topics" as const,
    };
    const saved = await saveAdminDraftFor(ctx, state);
    assert(saved.success, `save failed: ${(saved as any).error}`);

    const res = await resumeAdminRundown(ctx);
    assert(!!res.draft, "no draft restored");
    assert(res.draft!.mode === "hybrid", "mode lost");
    assert(JSON.stringify(res.draft!.selectedTopicIds) === JSON.stringify(["t3", "t1"]), `order lost: ${res.draft!.selectedTopicIds}`);
    assert(res.draft!.leadTopicId === "t1", "lead lost");
    assert(res.draft!.targetTopicCount === 3, "target lost");
    assert(res.draft!.sport === "NFL" && res.draft!.minDebateScore === 55, "filters lost");
    assert(res.draft!.reuseOverride === true && res.draft!.reuseOverrideReason === "editorial call", "the authorized override decision was lost");
  });

  await check("the admin draft is keyed by the ADMIN IDENTITY — no User foreign key involved", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    // Deliberately an identity that has NO User row anywhere.
    const ctx = adminCtxFor(db, "ops-operator-no-user-row");
    const saved = await saveAdminDraftFor(ctx, { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 1, hostIds: H });
    assert(saved.success, `admin identity could not persist a draft: ${(saved as any).error}`);
    const row = db._adminDrafts.get("ops-operator-no-user-row");
    assert(!!row, "the draft was not stored under the admin identity");
    assert(!("ownerId" in row), "the admin draft must not carry a User-scoped ownerId");
    const loaded = await loadAdminDraftFor(ctx);
    assert(loaded.draft?.selectedTopicIds[0] === "t1", "round-trip failed");
  });

  await check("two operators keep independent drafts", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2")] });
    await saveAdminDraftFor(adminCtxFor(db, "op1"), { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 1, hostIds: H });
    await saveAdminDraftFor(adminCtxFor(db, "op2"), { mode: "manual", selectedTopicIds: ["t2"], targetTopicCount: 1, hostIds: H });
    const a = await loadAdminDraftFor(adminCtxFor(db, "op1"));
    const b = await loadAdminDraftFor(adminCtxFor(db, "op2"));
    assert(a.draft?.selectedTopicIds[0] === "t1" && b.draft?.selectedTopicIds[0] === "t2", "operator drafts collided");
  });

  await check("CHANGED ELIGIBILITY on resume is reported, and the topic is NOT silently removed", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2")] });
    const ctx = adminCtxFor(db);
    await saveAdminDraftFor(ctx, { mode: "manual", selectedTopicIds: ["t1", "t2"], targetTopicCount: 2, hostIds: H });

    // t1 is rejected by an editor while the draft is parked.
    await db.topicCandidate.update({ where: { id: "t1" }, data: { status: "rejected" } });

    const res = await resumeAdminRundown(ctx);
    assert(res.draft!.selectedTopicIds.includes("t1"), "the now-ineligible topic was SILENTLY DROPPED from the draft");
    assert(res.changedSelections.length === 1, `expected 1 changed selection, got ${res.changedSelections.length}`);
    assert(res.changedSelections[0].topicId === "t1", "wrong topic reported");
    assert(res.changedSelections[0].blockingReasons[0].code === "rejected", `expected the real reason, got ${res.changedSelections[0].blockingReasons[0].code}`);
  });

  await check("a selection whose topic was DELETED is reported as not_found, not dropped", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    const ctx = adminCtxFor(db);
    await saveAdminDraftFor(ctx, { mode: "manual", selectedTopicIds: ["t1", "ghost"], targetTopicCount: 2, hostIds: H });
    const res = await resumeAdminRundown(ctx);
    assert(res.draft!.selectedTopicIds.includes("ghost"), "the missing topic was silently dropped");
    assert(res.changedSelections.some((c) => c.topicId === "ghost" && c.blockingReasons[0].code === "not_found"), "the missing topic wasn't reported as not_found");
  });

  await check("an unchanged draft reports NO spurious changes", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2")] });
    const ctx = adminCtxFor(db);
    await saveAdminDraftFor(ctx, { mode: "manual", selectedTopicIds: ["t1", "t2"], targetTopicCount: 2, hostIds: H });
    const res = await resumeAdminRundown(ctx);
    assert(res.changedSelections.length === 0, `false-positive change reports: ${JSON.stringify(res.changedSelections)}`);
  });

  await check("the draft is cleared once the episode is created", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    const ctx = adminCtxFor(db);
    await saveAdminDraftFor(ctx, { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 1, hostIds: H });
    const res: any = await createAdminEpisodeFor(ctx, { mode: "manual", selectedTopicIds: ["t1"], hostIds: H });
    assert(res.success, "creation failed");
    const after = await loadAdminDraftFor(ctx);
    assert(after.draft === null, "the draft survived creation — a duplicate is one refresh away");
  });

  await check("a FAILED creation RETAINS the draft (the operator keeps their work)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1", { status: "pending" })] });
    const ctx = adminCtxFor(db);
    await saveAdminDraftFor(ctx, { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 1, hostIds: H });
    const res: any = await createAdminEpisodeFor(ctx, { mode: "manual", selectedTopicIds: ["t1"], hostIds: H });
    assert(!res.success, "an unapproved topic should not have created an episode");
    const after = await loadAdminDraftFor(ctx);
    assert(after.draft !== null, "the draft was discarded after a FAILED creation");
  });

  await check("discard removes the draft", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    const ctx = adminCtxFor(db);
    await saveAdminDraftFor(ctx, { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 1, hostIds: H });
    await discardAdminDraftFor(ctx);
    const after = await loadAdminDraftFor(ctx);
    assert(after.draft === null, "discard didn't remove the draft");
  });

  await check("the admin draft schema enforces the SAME shared rundown rules as Studio", async () => {
    assert(!AdminRundownDraftStateSchema.safeParse({ mode: "automatic", selectedTopicIds: ["t1"], targetTopicCount: 2, hostIds: H }).success, "automatic must not carry hand-picked topics");
    assert(!AdminRundownDraftStateSchema.safeParse({ mode: "manual", selectedTopicIds: [], targetTopicCount: 2, hostIds: H }).success, "manual needs at least one topic");
    assert(!AdminRundownDraftStateSchema.safeParse({ mode: "manual", selectedTopicIds: ["t1"], leadTopicId: "nope", targetTopicCount: 1, hostIds: H }).success, "the lead must be one of the selected topics");
    assert(!AdminRundownDraftStateSchema.safeParse({ mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: PLATFORM_MAX_TOPICS + 1, hostIds: H }).success, "the platform max must be enforced");
    const dup = AdminRundownDraftStateSchema.safeParse({ mode: "manual", selectedTopicIds: ["t1", "t1", "t2"], targetTopicCount: 2, hostIds: H });
    assert(dup.success && JSON.stringify(dup.data.selectedTopicIds) === JSON.stringify(["t1", "t2"]), "ordered dedupe not applied");
  });

  await check("a corrupt stored draft resumes as a fresh builder rather than crashing", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    db._adminDrafts.set("admin", { adminId: "admin", state: { mode: "nonsense", selectedTopicIds: 42 } });
    const res = await resumeAdminRundown(adminCtxFor(db));
    assert(res.draft === null, "a corrupt blob must fail open to no-draft");
    assert(res.topics.length === 1, "the board should still load");
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
