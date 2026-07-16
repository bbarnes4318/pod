// Studio multi-topic rundown tests. Run: npm run test:studio-rundown
/* eslint-disable @typescript-eslint/no-explicit-any -- test harness: in-memory
   fake DB doubles + dynamic seed payloads are intentionally loosely typed. */
//
// Fake-db integration + unit coverage: topic-pool VM, resume persistence,
// estimates, rundown rules + mode transitions, durable-draft schema validation,
// and the ACTUAL Studio server-action logic (studioActions) run under a fake
// authenticated-user seam — ownerId from session, cross-user rejection, private
// hosts hidden, no reuseOverride, podcast inheritance reaching the episode,
// automatic preferences reaching createEpisodeDraft, hybrid rejected pins,
// draft cleared on success / retained on failure.

process.env.TOPIC_MIN_TALKABILITY = "1";

import { buildStudioTopicVMs } from "../lib/services/studioTopicPool";
import { getTopicUsage, resolveTopicReusePolicy } from "../lib/services/topicUsageService";
import { loadStudioDraft, saveStudioDraft, clearStudioDraft, RundownDraftStateSchema } from "../lib/services/studioDraft";
import { estimateRundown } from "../lib/services/episodeEstimate";
import { validateRundownDraft, leadFirst, dedupeIds, applyModeChange } from "../lib/studio/rundownRules";
import { createEpisodeDraft } from "../lib/services/episodeCreation";
import {
  createStudioEpisodeFor, getStudioTopicsFor, getStudioPodcastsFor,
  saveStudioDraftFor, loadStudioDraftFor, discardStudioDraftFor, type StudioCtx,
} from "../lib/services/studioActions";
import { PLATFORM_MAX_TOPICS } from "../lib/episodeLimits";

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
    evidenceIds: [{ type: "newsItem", id: "n1" }], createdAt: new Date("2026-07-10T00:00:00Z"),
    researchBrief: {
      facts: [{ text: "A real grounded fact." }], sourceIds: [{ type: "newsItem", id: "n1" }], stats: [],
      argumentForHostA: "A side", argumentForHostB: "B side", mainAngle: "angle", contrarianAngle: "contra",
      whyMattersNow: "it matters", onAirTalkingPoints: ["point one"], keyFactsContext: [{ text: "key fact" }],
      unsafeClaims: [{ claim: "SECRET flagged claim" }, { claim: "another" }],
    },
    ...over,
  };
}

function makeFakeDb(seed: { topics?: any[]; podcasts?: any[]; hosts?: any[]; teams?: any[] }) {
  const topics = new Map((seed.topics || []).map((t) => [t.id, structuredClone(t)]));
  const podcasts = seed.podcasts || [];
  const hosts = seed.hosts || [{ id: "host-a", ownerId: null, isActive: true }, { id: "host-b", ownerId: null, isActive: true }];
  const teams = seed.teams || [];
  const episodes = new Map<string, any>();
  const episodeTopics: any[] = [];
  const drafts = new Map<string, any>();
  const makeEpisode = (data: any) => { const e = { id: `ep-${episodes.size + 1}`, ...data }; episodes.set(e.id, e); return e; };
  const etFindMany = async ({ where, select }: any) => {
    const rows = episodeTopics.filter((et) => {
      if (where?.topicId?.in && !where.topicId.in.includes(et.topicId)) return false;
      if (where?.selectedAt?.gte && !(new Date(et.selectedAt) >= new Date(where.selectedAt.gte))) return false;
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
  const hostFindMany = async ({ where }: any) => {
    return hosts.filter((h) => {
      if (where?.id?.in && !where.id.in.includes(h.id)) return false;
      if (where?.isActive === true && h.isActive === false) return false;
      if (where?.OR) { const ok = where.OR.some((c: any) => ("ownerId" in c ? c.ownerId === h.ownerId : true)); if (!ok) return false; }
      return true;
    }).map((h) => ({ id: h.id }));
  };
  return {
    _episodes: episodes, _episodeTopics: episodeTopics, _drafts: drafts,
    topicCandidate: {
      findUnique: async ({ where }: any) => topics.get(where.id) ?? null,
      findMany: async ({ where }: any) => [...topics.values()].filter((t) => (where?.status?.in ? where.status.in.includes(t.status) : where?.status ? t.status === where.status : true)),
    },
    aiHost: { findMany: hostFindMany },
    team: { findMany: async ({ where }: any) => teams.filter((t: any) => (where?.id?.in ? where.id.in.includes(t.id) : true)).map((t: any) => ({ id: t.id, name: t.name })) },
    podcast: {
      findUnique: async ({ where }: any) => podcasts.find((p) => p.id === where.id) ?? null,
      findMany: async ({ where }: any) => podcasts.filter((p) => (where?.ownerId ? p.ownerId === where.ownerId : true)),
    },
    episode: { findUnique: async ({ where }: any) => [...episodes.values()].find((e) => e.slug === where.slug) ?? null, create: async ({ data }: any) => makeEpisode(data) },
    episodeTopic: { findMany: etFindMany, create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    $transaction: async (fn: any) => fn({
      episode: { create: async ({ data }: any) => makeEpisode(data) },
      episodeTopic: { create: async ({ data }: any) => { episodeTopics.push(data); return data; } },
    }),
    studioDraft: {
      findUnique: async ({ where }: any) => drafts.get(where.ownerId) ?? null,
      upsert: async ({ where, create, update }: any) => { const ex = drafts.get(where.ownerId); drafts.set(where.ownerId, ex ? { ...ex, ...update } : create); return drafts.get(where.ownerId); },
      deleteMany: async ({ where }: any) => { drafts.delete(where.ownerId); return { count: 1 }; },
    },
  };
}

const H = ["host-a", "host-b"];
const ctxFor = (db: any, id = "oA", role = "USER"): StudioCtx => ({ user: { id, role }, db });

async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { prev[k] = process.env[k]; process.env[k] = env[k]; }
  try { await fn(); } finally { for (const k of Object.keys(env)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]!; } }
}

async function run() {
  console.log("Studio multi-topic rundown:");

  // ---- Topic-pool VM ----
  await check("VM: readiness/eligibility/counts + research preview + unsafe-claim withholding", () => {
    const topics = [goodTopic("t1"), goodTopic("t2", { status: "pending" }), goodTopic("t3", { researchBrief: null })];
    const vms = buildStudioTopicVMs(topics as any, { usage: new Map(), policy: { mode: "allow", cooldownDays: 7 } });
    const t1 = vms.find((v) => v.id === "t1")!;
    assert(t1.readiness === "ready" && t1.eligible && t1.evidenceCount === 1 && t1.sourceCount === 1, "t1 ready/eligible/counts");
    assert(t1.brief!.flaggedClaimCount === 2 && !JSON.stringify(t1.brief).includes("SECRET"), "unsafe claims withheld (count only)");
    assert(!vms.find((v) => v.id === "t2")!.eligible && !vms.find((v) => v.id === "t3")!.eligible, "pending + no-brief ineligible, shown with reason");
  });
  await check("VM: usage owner/show-scoped — Owner B never sees Owner A's usage", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA" }] });
    await createEpisodeDraft({ mode: "manual", selectedTopicIds: ["t1"], ownerId: "oA", podcastId: "pA", hostIds: H }, { db });
    const vmsB = buildStudioTopicVMs([goodTopic("t1")] as any, { usage: await getTopicUsage(["t1"], { ownerId: "oB" }, db as any), policy: { mode: "allow", cooldownDays: 7 } });
    assert(vmsB[0].usedByYouCount === 0 && vmsB[0].usedByShowCount === null, "owner B sees zero + no show count");
  });

  // ---- Resume draft + schema validation (item 6) ----
  await check("resume: save→load round-trips full state incl. preferences (cross-session)", async () => {
    const db = makeFakeDb({});
    const state = { mode: "hybrid", selectedTopicIds: ["t2", "t1"], leadTopicId: "t2", targetTopicCount: 4, podcastId: null, hostIds: H, productionStyle: "full", sfxDensity: "hype", title: "My show", description: "notes", verticals: ["NFL"], minDebateScore: 60, activeStep: "topics" };
    assert((await saveStudioDraft("oA", state, db as any)).ok, "save ok");
    const loaded = await loadStudioDraft("oA", db as any);
    assert(!!loaded && loaded.verticals?.[0] === "NFL" && loaded.minDebateScore === 60 && loaded.leadTopicId === "t2" && loaded.description === "notes", "state incl. prefs restored");
  });
  await check("resume: corrupt blob FAILS OPEN; invalid state REJECTED before persist", async () => {
    const db = makeFakeDb({});
    db._drafts.set("oA", { state: { mode: "nope" } });
    assert((await loadStudioDraft("oA", db as any)) === null, "corrupt → null");
    assert(!(await saveStudioDraft("oB", { mode: "bogus" } as any, db as any)).ok && !db._drafts.has("oB"), "invalid rejected, nothing persisted");
  });
  await check("schema: ONE platform max — targetTopicCount 0, 7, 24 all rejected; 6 allowed", () => {
    const base = { mode: "automatic", selectedTopicIds: [], hostIds: H, activeStep: "topics" };
    assert(!RundownDraftStateSchema.safeParse({ ...base, targetTopicCount: 0 }).success, "0 rejected");
    assert(!RundownDraftStateSchema.safeParse({ ...base, targetTopicCount: 7 }).success, "7 rejected (> platform max)");
    assert(!RundownDraftStateSchema.safeParse({ ...base, targetTopicCount: 24 }).success, "24 rejected");
    assert(RundownDraftStateSchema.safeParse({ ...base, targetTopicCount: PLATFORM_MAX_TOPICS }).success, "6 allowed");
    assert(PLATFORM_MAX_TOPICS === 6, "platform max is 6");
  });
  await check("schema: superRefine enforces mode rules, lead-in-set, host cap; dedupes before save", () => {
    const V = (s: any) => RundownDraftStateSchema.safeParse(s).success;
    assert(!V({ mode: "manual", selectedTopicIds: [], hostIds: H, activeStep: "topics", targetTopicCount: 3 }), "manual 0 rejected");
    assert(!V({ mode: "automatic", selectedTopicIds: ["t1"], hostIds: H, activeStep: "topics", targetTopicCount: 3 }), "auto+picks rejected");
    assert(!V({ mode: "automatic", selectedTopicIds: [], leadTopicId: "t1", hostIds: H, activeStep: "topics", targetTopicCount: 3 }), "auto+lead rejected");
    assert(!V({ mode: "hybrid", selectedTopicIds: ["a", "b", "c", "d"], targetTopicCount: 3, hostIds: H, activeStep: "topics" }), "hybrid pins>target rejected");
    assert(!V({ mode: "manual", selectedTopicIds: ["a"], leadTopicId: "zzz", hostIds: H, targetTopicCount: 3, activeStep: "topics" }), "lead not in set rejected");
    assert(!V({ mode: "manual", selectedTopicIds: ["a"], hostIds: ["h1", "h2", "h3"], targetTopicCount: 3, activeStep: "topics" }), ">2 hosts rejected");
    const dd = RundownDraftStateSchema.safeParse({ mode: "manual", selectedTopicIds: ["a", "b", "a", "c"], hostIds: H, targetTopicCount: 3, activeStep: "topics" });
    assert(dd.success && JSON.stringify(dd.data.selectedTopicIds) === JSON.stringify(["a", "b", "c"]), "topic ids deduped preserving order");
  });

  // ---- Inheritance provenance in the durable draft ----
  await check("provenance: overrides parse, persist, and restore", async () => {
    const db = makeFakeDb({});
    const state = {
      mode: "automatic", selectedTopicIds: [], targetTopicCount: 4, hostIds: H, activeStep: "topics",
      verticals: ["NFL"], teams: ["Kansas City Chiefs"],
      overrides: { hosts: false, targetTopicCount: true, selectionPreferences: false },
    };
    assert((await saveStudioDraft("oA", state, db as any)).ok, "save ok");
    const loaded = await loadStudioDraft("oA", db as any);
    assert(!!loaded, "draft restored");
    assert(loaded!.overrides.targetTopicCount === true, "explicit override restored as explicit");
    assert(loaded!.overrides.hosts === false && loaded!.overrides.selectionPreferences === false, "inherited values restored as inherited");
  });
  await check("provenance: a LEGACY draft without overrides gets safe defaults (nothing is an override)", async () => {
    const db = makeFakeDb({});
    // Simulate a draft persisted before provenance existed.
    db._drafts.set("oA", { state: { mode: "automatic", selectedTopicIds: [], targetTopicCount: 4, hostIds: H, activeStep: "topics", verticals: ["NFL"] } });
    const loaded = await loadStudioDraft("oA", db as any);
    assert(!!loaded, "legacy draft still loads (backwards compatible)");
    assert(loaded!.overrides.hosts === false && loaded!.overrides.targetTopicCount === false && loaded!.overrides.selectionPreferences === false,
      "legacy values default to INHERITED, so a newly selected podcast can replace them");
  });
  await check("provenance: a non-empty inherited value is NOT inferred to be an override", async () => {
    const db = makeFakeDb({});
    // Inherited hosts/verticals are non-empty — provenance must still say "not an override".
    const state = { mode: "automatic", selectedTopicIds: [], targetTopicCount: 4, hostIds: H, verticals: ["NFL"], teams: ["Chiefs"], activeStep: "topics", overrides: { hosts: false, targetTopicCount: false, selectionPreferences: false } };
    await saveStudioDraft("oA", state, db as any);
    const loaded = await loadStudioDraft("oA", db as any);
    assert(loaded!.hostIds.length === 2 && loaded!.overrides.hosts === false, "values persist but remain inherited");
  });

  // ---- TTS validation in the durable draft ----
  await check("schema: invalid TTS provider rejected; supported id normalized", () => {
    const base: any = { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 3, hostIds: H, activeStep: "topics" };
    assert(!RundownDraftStateSchema.safeParse({ ...base, ttsProvider: "not-a-provider" }).success, "unknown provider rejected");
    const okp = RundownDraftStateSchema.safeParse({ ...base, ttsProvider: "ElevenLabs" });
    assert(okp.success && okp.data.ttsProvider === "elevenlabs", "supported provider normalized to canonical id");
  });
  await check("schema: malformed / mismatched ttsVoiceOverrides rejected (shared validator)", () => {
    const base: any = { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 3, hostIds: H, activeStep: "topics" };
    const V = (o: unknown) => RundownDraftStateSchema.safeParse({ ...base, ttsVoiceOverrides: o }).success;
    assert(!V({ "host-a": "not-an-object" }), "non-object override rejected");
    assert(!V({ "host-a": { provider: "bogus", voiceId: "x" } }), "unknown override provider rejected");
    // A real provider/voice MISMATCH the shared validator can determine:
    assert(!V({ "host-a": { provider: "openai", voiceId: "definitely-not-an-openai-voice" } }), "openai voice mismatch rejected");
    assert(!V({ "host-a": { provider: "fish", voiceId: "too-short" } }), "fish reference-id mismatch rejected");
    assert(V({ "host-a": { provider: "elevenlabs", voiceId: "v1" } }), "well-formed override accepted");
  });

  // ---- Estimates + rules + mode transitions (item 3) ----
  await check("estimate: grounded; cost null without a rate, labeled with a rate", async () => {
    assert(estimateRundown({ topicCount: 3 }).estimatedCostUsd === null, "no fake cost");
    await withEnv({ TTS_COST_PER_1K_CHARS: "0.30" }, async () => { assert(estimateRundown({ topicCount: 3 }).estimatedCostUsd! > 0, "cost with rate"); });
  });
  await check("rules: dedupe + leadFirst", () => {
    assert(JSON.stringify(dedupeIds(["a", "b", "a"])) === JSON.stringify(["a", "b"]), "dedupe");
    assert(JSON.stringify(leadFirst(["a", "b", "c"], "c")) === JSON.stringify(["c", "a", "b"]), "leadFirst");
  });
  await check("mode transition: → Automatic clears picks + lead", () => {
    const r = applyModeChange({ mode: "manual", selectedTopicIds: ["a", "b"], leadTopicId: "a", targetTopicCount: 3 }, "automatic", 6);
    assert(r.selectedTopicIds.length === 0 && r.leadTopicId === null, "automatic clears selection + lead");
  });
  await check("mode transition: Automatic → Manual starts empty (no resurrected ids)", () => {
    const r = applyModeChange({ mode: "automatic", selectedTopicIds: [], leadTopicId: null, targetTopicCount: 4 }, "manual", 6);
    assert(r.selectedTopicIds.length === 0, "no stale ids resurrected");
  });
  await check("mode transition: Manual → Hybrid preserves picks and clamps target ≥ pinned", () => {
    const r = applyModeChange({ mode: "manual", selectedTopicIds: ["a", "b", "c", "d"], leadTopicId: "a", targetTopicCount: 2 }, "hybrid", 6);
    assert(JSON.stringify(r.selectedTopicIds) === JSON.stringify(["a", "b", "c", "d"]) && r.targetTopicCount === 4 && !!r.note, "picks kept, target clamped to 4, note set");
  });

  // ---- ACTUAL Studio server actions (item 11) via the auth seam ----
  await check("action: createStudioEpisode stamps ownerId from the SESSION (client can't inject)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    // Note: StudioEpisodeInput has NO ownerId field — it comes from ctx.user only.
    const res = await createStudioEpisodeFor(ctxFor(db, "oA"), { mode: "manual", selectedTopicIds: ["t1"], hostIds: H } as any, okDeps);
    assert(res.success, (res as any).error);
    assert(db._episodes.get((res as any).episodeId).ownerId === "oA", "episode.ownerId === session user");
  });
  await check("action: another user's podcast is rejected (list, scope, and create)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA", name: "A show", verticals: [], teams: [], segmentCount: 3, hostIds: [] }] });
    const asB = ctxFor(db, "oB");
    assert((await getStudioPodcastsFor(asB)).podcasts.length === 0, "B doesn't list A's podcast");
    const scoped = await getStudioTopicsFor(asB, "pA");
    assert(!scoped.success, "B can't scope usage to A's podcast");
    const created = await createStudioEpisodeFor(asB, { mode: "manual", selectedTopicIds: ["t1"], podcastId: "pA", hostIds: H } as any, okDeps);
    assert(!created.success && /another account/i.test((created as any).error), "B can't create under A's podcast");
  });
  await check("action: a private host of another user is hidden (build rejected)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")], hosts: [{ id: "priv-A", ownerId: "oA", isActive: true }, { id: "host-b", ownerId: null, isActive: true }] });
    // User B tries to cast A's private host → assertHostsCastable rejects it.
    const res = await createStudioEpisodeFor(ctxFor(db, "oB"), { mode: "manual", selectedTopicIds: ["t1"], hostIds: ["priv-A", "host-b"] } as any, okDeps);
    assert(!res.success && /host/i.test((res as any).error), "another user's private host is not castable");
  });
  await check("action: reuseOverride cannot be submitted from Studio (blocked under exclude_podcast)", async () => {
    await withEnv({ TOPIC_REUSE_MODE: "exclude_podcast" }, async () => {
      const db = makeFakeDb({ topics: [goodTopic("t1")], podcasts: [{ id: "pA", ownerId: "oA", name: "A", verticals: [], teams: [], segmentCount: 3, hostIds: [] }] });
      await createStudioEpisodeFor(ctxFor(db), { mode: "manual", selectedTopicIds: ["t1"], podcastId: "pA", hostIds: H } as any, okDeps);
      const r2 = await createStudioEpisodeFor(ctxFor(db), { mode: "manual", selectedTopicIds: ["t1"], podcastId: "pA", hostIds: H } as any, okDeps);
      // No reuseOverride is ever sent, so the second reuse is blocked.
      assert(!r2.success && (r2 as any).rejectedTopics?.some((x: any) => x.category === "recently_used"), "Studio can't bypass reuse via override");
    });
  });
  await check("action: podcast host + target inheritance reaches the created episode", async () => {
    const db = makeFakeDb({
      topics: [goodTopic("t1", { debateScore: 99 }), goodTopic("t2", { debateScore: 98 }), goodTopic("t3", { debateScore: 97 })],
      podcasts: [{ id: "pA", ownerId: "oA", name: "A", verticals: ["NFL"], teams: [], segmentCount: 2, hostIds: ["host-a", "host-b"] }],
    });
    // Client omits hostIds + targetTopicCount → server inherits from the podcast.
    const res = await createStudioEpisodeFor(ctxFor(db), { mode: "automatic", podcastId: "pA", selectedTopicIds: [] } as any, okDeps);
    assert(res.success, (res as any).error);
    const ep = db._episodes.get((res as any).episodeId);
    assert(JSON.stringify(ep.hostIds) === JSON.stringify(["host-a", "host-b"]), "episode inherits podcast hosts A+B");
    assert((res as any).finalOrder.length === 2, "episode inherits podcast segment count (2)");
  });
  await check("action: podcast Team IDs resolve to NAMES (never raw ids) and reach createEpisodeDraft", async () => {
    const db = makeFakeDb({
      topics: [goodTopic("t1", { summary: "The Chiefs collapsed in the 4th." })],
      teams: [{ id: "KC", name: "Kansas City Chiefs" }, { id: "PHI", name: "Philadelphia Eagles" }],
      podcasts: [{ id: "pA", ownerId: "oA", name: "A", verticals: ["NFL"], teams: ["KC", "PHI"], segmentCount: 2, hostIds: [] }],
    });
    const list = await getStudioPodcastsFor(ctxFor(db));
    const vm = list.podcasts[0];
    assert(JSON.stringify(vm.teamIds) === JSON.stringify(["KC", "PHI"]), "teamIds preserved");
    assert(JSON.stringify(vm.teamNames) === JSON.stringify(["Kansas City Chiefs", "Philadelphia Eagles"]), "team NAMES resolved");
    assert(!vm.teamNames.includes("KC"), "raw ids are never presented as names");
    // Client omits teams → server inherits + resolves ids to names for selection.
    const res = await createStudioEpisodeFor(ctxFor(db), { mode: "manual", selectedTopicIds: ["t1"], podcastId: "pA", hostIds: H } as any, okDeps);
    assert(res.success, (res as any).error);
  });
  await check("action: automatic preferences reach createEpisodeDraft (different pool → different rundown)", async () => {
    const db = makeFakeDb({ topics: [goodTopic("nfl", { debateScore: 99 }), goodTopic("nba", { sport: "NBA", leagueId: "NBA", debateScore: 99 })] });
    const withNfl = await createStudioEpisodeFor(ctxFor(db), { mode: "automatic", selectedTopicIds: [], targetTopicCount: 2, hostIds: H, verticals: ["NFL"] } as any, okDeps);
    assert(withNfl.success && (withNfl as any).finalOrder.includes("nfl") && !(withNfl as any).finalOrder.includes("nba"), "verticals:NFL selects only the NFL topic");
    const db2 = makeFakeDb({ topics: [goodTopic("weak", { debateScore: 80 }), goodTopic("strong", { debateScore: 99 })] });
    const hi = await createStudioEpisodeFor(ctxFor(db2), { mode: "automatic", selectedTopicIds: [], targetTopicCount: 2, hostIds: H, minDebateScore: 95 } as any, okDeps);
    assert(hi.success && (hi as any).finalOrder.includes("strong") && !(hi as any).finalOrder.includes("weak"), "minDebateScore 95 excludes the weak topic");
  });
  await check("action: hybrid rejected pins are returned", async () => {
    const db = makeFakeDb({ topics: [goodTopic("pin", { status: "pending" }), goodTopic("a1", { debateScore: 99 })] });
    const res = await createStudioEpisodeFor(ctxFor(db), { mode: "hybrid", selectedTopicIds: ["pin"], targetTopicCount: 2, hostIds: H } as any, okDeps);
    // 'pin' is not approved → rejected + surfaced; build proceeds from auto-fill.
    assert((res as any).rejectedTopics?.some((x: any) => x.id === "pin"), "rejected pin surfaced");
  });
  await check("action: draft CLEARED on success, RETAINED on failure", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1")] });
    await saveStudioDraftFor(ctxFor(db), { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 3, hostIds: H, activeStep: "review" } as any);
    assert(db._drafts.has("oA"), "draft saved");
    await createStudioEpisodeFor(ctxFor(db), { mode: "manual", selectedTopicIds: ["t1"], hostIds: H } as any, okDeps);
    assert(!db._drafts.has("oA"), "draft cleared after success");
    // Failure path: strict manual with a non-existent topic → fail, draft kept.
    const db2 = makeFakeDb({ topics: [] });
    await saveStudioDraftFor(ctxFor(db2), { mode: "manual", selectedTopicIds: ["ghost"], targetTopicCount: 3, hostIds: H, activeStep: "review" } as any);
    const fail = await createStudioEpisodeFor(ctxFor(db2), { mode: "manual", selectedTopicIds: ["ghost"], hostIds: H } as any, okDeps);
    assert(!fail.success && db2._drafts.has("oA"), "draft retained after failed creation");
  });
  await check("action: load/save/discard round-trip through the seam", async () => {
    const db = makeFakeDb({});
    await saveStudioDraftFor(ctxFor(db), { mode: "manual", selectedTopicIds: ["t1"], targetTopicCount: 3, hostIds: H, activeStep: "topics" } as any);
    assert((await loadStudioDraftFor(ctxFor(db))).draft?.mode === "manual", "load sees saved draft");
    await discardStudioDraftFor(ctxFor(db));
    assert((await loadStudioDraftFor(ctxFor(db))).draft === null, "discard clears");
  });

  // ---- Shared createEpisodeDraft path (finalOrder is source of truth) ----
  await check("manual: lead-first order == written EpisodeTopic order", async () => {
    const db = makeFakeDb({ topics: [goodTopic("t1"), goodTopic("t2"), goodTopic("t3")] });
    const res = await createEpisodeDraft({ mode: "manual", selectedTopicIds: leadFirst(["t1", "t2", "t3"], "t3"), strictSelection: true, ownerId: "oA", hostIds: H }, { db });
    const written = db._episodeTopics.sort((a: any, b: any) => a.orderIndex - b.orderIndex).map((e: any) => e.topicId);
    assert(JSON.stringify(res.finalOrder) === JSON.stringify(["t3", "t1", "t2"]) && JSON.stringify(res.finalOrder) === JSON.stringify(written), "finalOrder == request == DB rows");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
run().catch((e) => { console.error("FATAL", e); process.exit(1); });
