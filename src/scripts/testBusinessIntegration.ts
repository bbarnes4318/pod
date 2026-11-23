/**
 * Business research engine — integration test on a real, isolated Postgres.
 *
 *   npm run test:business-integration
 *
 * Starts an embedded Postgres, applies every migration with
 * `prisma migrate deploy`, and drives the real engine code end to end:
 * industry research → opportunities → dossier → business episode → script →
 * fact-check. Only the outside world is faked: the web-search client, the
 * demand APIs' HTTP responses and the language models. Those fakes are
 * deliberately literal (they quote the sources they are handed and invent
 * nothing), so every verification and gate in between runs for real.
 *
 * Scenarios: A final expense, B wholesale VoIP, C residential real estate
 * (different businesses → different topics); D sports tables untouched;
 * E nothing to research → honest failure; F tenant isolation; plus cancel,
 * idempotent replay, the 7-day query cache and fact-check transitions.
 */
import EmbeddedPostgres from "embedded-postgres";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { LLMProvider } from "../lib/providers/llm/interface";
import type { SafeFetchResult } from "../lib/net/safeFetch";
import type { ExaLike } from "../lib/business/researchProviders";
import { BUDGETS, runIndustryResearch } from "../lib/business/researchEngine";
import { runDossier } from "../lib/business/businessDossier";
import { createBusinessEpisode, generateBusinessScript, factCheckBusinessScript } from "../lib/business/businessProduction";
import { resolveEditorialPacket } from "../lib/business/businessTopicSnapshot";

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(e as Error).stack?.split("\n").slice(0, 3).join("\n    ")}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });
}

// ---------------------------------------------------------------------------
// The fake outside world
// ---------------------------------------------------------------------------

interface Corpus {
  industry: string;
  sub: string;
  queries: string[];
  demand: string[];
  sources: { url: string; title: string; text: string }[];
  topics: { title: string; category: "EVERGREEN" | "INSIDER_INTELLIGENCE" | "HIDDEN_OPPORTUNITY" }[];
}

const pad = " The analysis draws on filings, carrier bulletins and interviews with operators across several regions over the past year.";
const CORPORA: Record<string, Corpus> = {
  Insurance: {
    industry: "Insurance", sub: "Final expense",
    queries: ["final expense chargeback economics", "final expense live transfer persistency"],
    demand: ["final expense leads", "final expense transfers"],
    sources: [
      { url: "https://naic-review.example/final-expense-lapse", title: "Final expense lapse study", text: "Final expense policies sold through live transfers lapsed at 31% in the first year, compared with 18% for referrals." + pad },
      { url: "https://agentdaily.example/chargebacks", title: "Chargebacks explained", text: "Carriers claw back advance commissions when a final expense policy lapses within the first 12 months of issue." + pad },
      { url: "https://leadwatch.example/transfer-pricing", title: "Transfer pricing", text: "Live transfers for final expense sold for $45 to $70 each in 2025, while aged leads sold for under $5." + pad },
      { url: "https://statedoi.example/complaints", title: "Complaint trends", text: "The department recorded 412 final expense complaints in 2025, most involving resold lead data and repeated calls." + pad },
    ],
    topics: [
      { title: "Why final expense live transfers lose money after chargebacks", category: "INSIDER_INTELLIGENCE" },
      { title: "Final expense persistency: referrals versus transfers", category: "EVERGREEN" },
    ],
  },
  Telecommunications: {
    industry: "Telecommunications", sub: "Wholesale VoIP",
    queries: ["wholesale voip termination margins", "voip billing increments arbitrage"],
    demand: ["wholesale voip", "sip trunking"],
    sources: [
      { url: "https://telecomwire.example/termination", title: "Termination margins", text: "Wholesale VoIP carriers reported average termination margins of 4% on international routes during 2025." + pad },
      { url: "https://sipreport.example/billing", title: "Billing increments", text: "Moving from 6/6 to 60/60 billing increments raised effective per-minute cost by 22% on short-duration traffic." + pad },
      { url: "https://fraudline.example/irsf", title: "IRSF losses", text: "International revenue share fraud cost wholesale VoIP operators an estimated $6.7 billion in 2024." + pad },
      { url: "https://regwatch.example/stir", title: "STIR/SHAKEN", text: "Wholesale VoIP providers must sign calls under STIR/SHAKEN or face blocking by downstream carriers." + pad },
    ],
    topics: [
      { title: "How wholesale VoIP billing increments quietly move margin", category: "INSIDER_INTELLIGENCE" },
      { title: "Wholesale VoIP fraud: what IRSF really costs a carrier", category: "HIDDEN_OPPORTUNITY" },
    ],
  },
  "Real Estate": {
    industry: "Real Estate", sub: "Residential brokerage",
    queries: ["residential brokerage commission changes", "buyer agent agreements adoption"],
    demand: ["buyer agent agreement", "real estate commission"],
    sources: [
      { url: "https://housingdesk.example/commissions", title: "Commission shift", text: "Average buyer agent commission in residential brokerage fell to 2.4% in 2025 after the settlement changes." + pad },
      { url: "https://brokerjournal.example/agreements", title: "Written agreements", text: "Residential brokerage firms now require written buyer agreements before touring, a change adopted nationwide in 2024." + pad },
      { url: "https://mlsdata.example/days", title: "Days on market", text: "Median days on market for residential listings rose to 41 days in 2025, up from 29 days two years earlier." + pad },
      { url: "https://consumerhome.example/survey", title: "Buyer survey", text: "In a 2025 survey, 38% of buyers said they negotiated their agent's fee in residential brokerage deals." + pad },
    ],
    topics: [
      { title: "Residential brokerage after the settlement: who pays the buyer agent", category: "EVERGREEN" },
      { title: "Buyer agreements in residential brokerage: the negotiation nobody trained for", category: "INSIDER_INTELLIGENCE" },
    ],
  },
};

const corpusFor = (text: string) => Object.values(CORPORA).find((c) => text.includes(`Industry: ${c.industry}`) || text.toLowerCase().includes(c.sub.toLowerCase()))!;

function fakeExa(calls: string[]): ExaLike {
  return {
    async search(query: string) {
      calls.push(query);
      const q = query.toLowerCase();
      const c = Object.values(CORPORA).find((x) => x.queries.some((k) => k === q) || x.demand.some((k) => k === q) || q.includes(x.sub.toLowerCase().split(" ")[0])) ?? null;
      return { results: (c?.sources ?? []).map((s) => ({ url: s.url, title: s.title, text: s.text, publishedDate: "2026-06-01" })) };
    },
  };
}

const okJson = (url: string, body: unknown): SafeFetchResult => ({ ok: true, finalUrl: url, status: 200, contentType: "application/json", body: JSON.stringify(body), connectedAddresses: [], redirectCount: 0 } as SafeFetchResult);
const fakeGet = async (url: string): Promise<SafeFetchResult> => {
  if (url.startsWith("https://hn.algolia.com/")) {
    const term = new URL(url).searchParams.get("query") ?? "";
    return okJson(url, { hits: [{ objectID: `${term.length}1`, title: `Ask: ${term} economics`, points: 40, num_comments: 12, created_at: "2026-09-01T00:00:00Z" }] });
  }
  if (url.startsWith("https://itunes.apple.com/")) return okJson(url, { resultCount: 3, results: [{ collectionName: "Some show" }] });
  return { ok: false, category: "fetch_failed", message: "unexpected url in test" } as SafeFetchResult;
};
const deadGet = async (): Promise<SafeFetchResult> => ({ ok: false, category: "fetch_failed", message: "offline" } as SafeFetchResult);

const sourceBlocks = (prompt: string) =>
  [...prompt.matchAll(/<source id="([^"]+)"[^>]*>\n([^\n]*)\n([\s\S]*?)\n<\/source>/g)].map((m) => ({ id: m[1], title: m[2], text: m[3] }));
const firstSentence = (t: string) => t.split(/(?<=\.)\s/)[0];

function structured(fn: (prompt: string, system: string) => unknown, calls?: string[]): LLMProvider {
  return {
    name: "fake",
    generateText: async () => "",
    generateStructuredOutput: async (opts: { prompt: string; systemPrompt?: string }) => {
      calls?.push(opts.systemPrompt?.slice(0, 40) ?? "");
      return fn(opts.prompt, opts.systemPrompt ?? "") as never;
    },
  } as unknown as LLMProvider;
}

const planner = structured((p) => {
  const c = corpusFor(p);
  return { audienceNeeds: [`Understand ${c.sub} economics`], researchQueries: c.queries, demandTerms: c.demand };
});

const rating = (r: number) => ({ rating: r, justification: "From the cited sources." });
const topicWriter = structured((p) => {
  const c = corpusFor(p);
  const src = sourceBlocks(p).filter((s) => !s.id.startsWith("x"));
  return {
    mechanisms: [{ mechanism: `${c.sub} mechanism`, sourceIds: src.slice(0, 2).map((s) => s.id) }],
    topics: c.topics.map((t, i) => {
      const cited = [src[i % src.length], src[(i + 1) % src.length]];
      return {
        category: t.category, title: t.title, businessNiche: c.sub, targetListener: `${c.sub} operators`,
        coreQuestion: `What does ${t.title.toLowerCase()} mean for ${c.sub.toLowerCase()} operators?`,
        listenerProblem: "Margins are disappearing without a clear cause.", whyItMatters: "It changes the unit economics.", whyNow: null,
        undercoveredInformation: "Rarely discussed outside the trade.", potentialOriginalAnalysis: "Compute cost per retained customer from the cited figures.",
        practicalValue: "A checklist operators can apply.", researchLimitations: [],
        sourceIds: cited.map((s) => s.id), observationIds: ["obs-that-does-not-exist"],
        keyClaims: cited.map((s) => ({ claim: firstSentence(s.text), sourceId: s.id, quote: firstSentence(s.text) })),
        ratings: { originalAnalysis: rating(0.8), undercoveredKnowledge: rating(0.8), industrySpecificity: rating(0.9), practicalUsefulness: rating(0.8), evidenceSupportedDepth: rating(0.8), targetListenerFit: rating(0.9), timelinessOrEvergreen: rating(0.8) },
      };
    }),
  };
});
const reviewer = structured((p) => ({ reviews: [...p.matchAll(/<proposal index="(\d+)">/g)].map((m) => ({ index: Number(m[1]), verdict: "keep", genericness: 0.1, note: "Specific." })) }));

const dossierWriter = structured((p) => {
  const src = sourceBlocks(p).filter((s) => !/FIRST_PARTY/.test(s.title));
  const item = (s: { id: string; text: string }) => ({ claim: firstSentence(s.text), sourceId: s.id, quote: firstSentence(s.text) });
  return {
    premise: "The headline price hides the real cost.", targetListener: "Operators", centralQuestion: "Where does the margin go?", listenerPromise: "You'll know which number to watch.",
    industryContext: [item(src[0])], verifiedFacts: src.slice(1, 3).map(item), verifiedStatistics: src.slice(3, 4).map((s) => ({ ...item(s), asOf: "2025" })),
    mechanisms: [{ explanation: "Advance payments create a clawback exposure.", sourceIds: [src[0].id] }],
    originalAnalysis: [{ finding: "Cost per retained customer", method: "Divide price by retention", inputs: [{ label: "close rate", value: "20%", sourceId: null, hypothetical: true }], result: "Illustrative only", status: "completed" }],
    expertDetails: [], practicalApplications: ["Track retention by source."], workedExamples: [{ title: "Hypothetical month", steps: ["Say you buy ten"], hypothetical: true, sourceIds: [] }],
    competingInterpretations: [], misconceptions: [], uncertainties: ["Regional variation is unknown."],
    storyStructure: [{ beat: "Hook", purpose: "Stakes" }, { beat: "Mechanism", purpose: "Explain" }, { beat: "Playbook", purpose: "Apply" }],
    hook: "The cheapest option can be the most expensive one.", takeaway: "Measure what you keep, not what you buy.", factCheckRequirements: [],
  };
});

/** Writes only from the FACTS list it is handed, citing each fact by id. */
const scriptWriter = (opts: { inventNumber?: boolean } = {}) => structured((p) => {
  const names = [...p.matchAll(/^- ([^:\n]+): /gm)].map((m) => m[1]).slice(0, 2);
  const facts = [...p.matchAll(/^(F\d+) \[[^\]]+\] (.+)$/gm)].map((m) => ({ id: m[1], claim: m[2] }));
  const line = (i: number, text: string, factIds: string[] = []) => ({ speakerName: names[i % names.length], text, tone: "conversational", isFactualClaim: factIds.length > 0, factIds });
  const chatter = ["Let's get into it.", "That's the part people skip.", "Okay, so why does that matter?", "Walk me through it.", "Right, and that changes the math.", "Which brings us to the playbook."];
  const lines = Array.from({ length: 24 }, (_, i) => (i % 3 === 1 && facts.length ? line(i, facts[i % facts.length].claim, [facts[i % facts.length].id]) : line(i, chatter[i % chatter.length])));
  if (opts.inventNumber) lines[4] = line(4, "Roughly 87% of operators never notice this.", [facts[0].id]);
  return { segments: [{ type: "cold_open", title: "Open", lines: lines.slice(0, 6) }, { type: "segment", title: "Mechanism", lines: lines.slice(6, 18) }, { type: "closing", title: "Close", lines: lines.slice(18) }] };
});

// ---------------------------------------------------------------------------

async function main() {
  const port = await freePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pod-biz-pg-"));
  const pg = new EmbeddedPostgres({ databaseDir: path.join(tmpRoot, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  let db: PrismaClient | null = null;
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("business");
    const dbUrl = `postgresql://postgres:postgres@localhost:${port}/business`;
    execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: dbUrl, NODE_ENV: "development" }, stdio: ["ignore", "pipe", "pipe"] });
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await run(db);
  } finally {
    await db?.$disconnect().catch(() => {});
    await pg.stop().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

async function run(db: PrismaClient) {
  const now = () => new Date("2026-11-22T12:00:00Z");
  const hostRow = (name: string) => db.aiHost.create({ data: { name, slug: name.toLowerCase(), role: "host", worldview: "-", speakingStyle: "-", catchphrases: [], likes: [], dislikes: [], argumentPatterns: [], bannedPhrases: [], ttsProvider: "fish", ttsVoiceId: `v-${name}`, intensityLevel: 5 } });
  const [h1, h2] = [await hostRow("Avery"), await hostRow("Jordan")];
  const resolveCast = async () => [{ host: h1, role: "host" }, { host: h2, role: "expert" }];

  const users = { a: await db.user.create({ data: { email: "a@test.local" } }), b: await db.user.create({ data: { email: "b@test.local" } }) };
  const makeShow = async (key: keyof typeof CORPORA, ownerId: string, website: string | null, description: string | null) => {
    const c = CORPORA[key];
    const pod = await db.podcast.create({ data: { name: `${c.sub} Show`, cadence: "one_time", intelligenceType: "BUSINESS", ownerId, hostIds: [h1.id, h2.id] } });
    await db.businessProfile.create({ data: { podcastId: pod.id, businessName: `${c.sub} Co`, websiteUrl: website, description, industry: c.industry, subIndustries: [c.sub], targetAudiences: [`${c.sub} operators`], primaryGoal: "Thought leadership", geographicMarkets: ["United States"], language: "English", findings: [], answers: { fields: {}, followups: {} } } });
    return pod;
  };
  const newRun = (podcastId: string, key: string, extra: Record<string, unknown> = {}) =>
    db.businessResearchRun.create({ data: { podcastId, kind: "industry", depth: "QUICK", idempotencyKey: key, profileVersion: 1, budget: BUDGETS.QUICK as never, status: "queued", ...extra } });
  const engine = (exaCalls: string[] = []) => ({ db, llm: { planner, topics: topicWriter, reviewer }, exa: fakeExa(exaCalls), get: fakeGet, env: {} as NodeJS.ProcessEnv, now });

  const sportsBefore = { topics: await db.topicCandidate.count(), links: await db.episodeTopic.count() };
  const sportsPod = await db.podcast.create({ data: { name: "Sports Show", cadence: "one_time", ownerId: users.a.id } });
  const sportsEp = await db.episode.create({ data: { title: "Sports ep", slug: "sports-ep", status: "draft", podcastId: sportsPod.id } });

  const showA = await makeShow("Insurance", users.a.id, "https://buckeye.example", "We place final expense policies for seniors.");
  const showB = await makeShow("Telecommunications", users.a.id, "https://carrier.example", "Wholesale VoIP termination for carriers.");
  const showC = await makeShow("Real Estate", users.b.id, "https://homes.example", "A residential brokerage in Ohio.");

  console.log("Industry research (A/B/C)");
  const runs: Record<string, string> = {};
  for (const [label, pod] of [["A", showA], ["B", showB], ["C", showC]] as const) {
    await check(`scenario ${label}: research completes with verified, specific opportunities`, async () => {
      const r = await newRun(pod.id, `run-${label}`);
      runs[label] = r.id;
      const res = await runIndustryResearch(r.id, engine());
      assert.equal(res.status, "completed", JSON.stringify(res.limitations));
      const opps = await db.businessTopicOpportunity.findMany({ where: { podcastId: pod.id } });
      assert.equal(opps.length, 2);
      for (const o of opps) {
        assert.equal(o.editorialStatus, "CANDIDATE", `${o.title}: ${JSON.stringify(o.holdReasons)}`);
        const claims = o.keyClaims as { verdict: string }[];
        assert.ok(claims.every((k) => k.verdict === "SOURCE_SUPPORTED"));
        assert.ok(o.potentialIas > 0 && o.achievedIas == null, "potential IAS only until a dossier exists");
      }
      const row = await db.businessResearchRun.findUniqueOrThrow({ where: { id: r.id } });
      const lim = row.limitations as { adapter: string; status: string }[];
      assert.ok(lim.some((l) => /YouTube/i.test(l.adapter) && l.status === "NOT_CONFIGURED"), "missing key is reported");
      assert.ok(lim.some((l) => l.status === "NOT_INTEGRATED"), "unintegrated adapters are reported");
      assert.ok(lim.some((l) => l.adapter === "citation integrity"), "invented observation id discarded and reported");
      const obs = await db.demandObservation.count({ where: { runId: r.id } });
      assert.ok(obs > 0, "keyless demand adapters ran");
    });
  }
  await check("different businesses get different topics", async () => {
    const titles = async (id: string) => new Set((await db.businessTopicOpportunity.findMany({ where: { podcastId: id } })).map((o) => o.title));
    const [a, b, c] = [await titles(showA.id), await titles(showB.id), await titles(showC.id)];
    for (const t of a) assert.ok(!b.has(t) && !c.has(t));
    for (const t of b) assert.ok(!c.has(t));
  });

  console.log("Run controls");
  await check("idempotent replay of a completed run creates nothing", async () => {
    const before = await db.businessTopicOpportunity.count();
    const res = await runIndustryResearch(runs.A, engine());
    assert.equal(res.status, "completed");
    assert.equal(await db.businessTopicOpportunity.count(), before);
  });
  await check("second run within 7 days reuses cached queries and drops repeated topics", async () => {
    const calls: string[] = [];
    const r = await newRun(showA.id, "run-A2");
    const res = await runIndustryResearch(r.id, engine(calls));
    const row = await db.businessResearchRun.findUniqueOrThrow({ where: { id: r.id } });
    assert.ok((row.usage as { cacheHits: number }).cacheHits >= CORPORA.Insurance.queries.length);
    assert.ok(!calls.some((q) => CORPORA.Insurance.queries.includes(q)), "cached queries were not re-sent");
    assert.equal(res.opportunities, 0);
    assert.ok((row.limitations as { adapter: string }[]).some((l) => l.adapter === "repetition"));
  });
  await check("cancel request stops the run as cancelled, nothing created", async () => {
    const r = await newRun(showB.id, "run-B-cancel", { cancelRequested: true });
    const before = await db.businessTopicOpportunity.count();
    const res = await runIndustryResearch(r.id, engine());
    assert.equal(res.status, "cancelled");
    assert.equal(await db.businessTopicOpportunity.count(), before);
  });

  console.log("Scenario E — nothing to research");
  await check("no website, no description, no providers → failed run, zero topics", async () => {
    const pod = await makeShow("Insurance", users.b.id, null, null);
    const r = await newRun(pod.id, "run-E");
    await assert.rejects(runIndustryResearch(r.id, { db, llm: { planner: null, topics: topicWriter, reviewer }, exa: null, get: deadGet, env: {} as NodeJS.ProcessEnv, now }), /Nothing was generated/);
    const row = await db.businessResearchRun.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(row.status, "failed");
    assert.equal(await db.businessTopicOpportunity.count({ where: { podcastId: pod.id } }), 0);
  });
  await check("no topic model → failed run, no invented topics", async () => {
    const r = await newRun(showC.id, "run-C-nomodel");
    await assert.rejects(runIndustryResearch(r.id, { ...engine(), llm: { planner, topics: null, reviewer } }), /No topics were invented/);
    assert.equal(await db.businessTopicOpportunity.count({ where: { runId: r.id } }), 0);
  });

  console.log("Dossier → episode → script → fact-check (A)");
  const opp = (await db.businessTopicOpportunity.findFirstOrThrow({ where: { podcastId: showA.id }, orderBy: { createdAt: "asc" } }));
  await check("unapproved topic can't produce an episode", async () => {
    const r = await createBusinessEpisode(db, { podcastId: showA.id, opportunityId: opp.id, ownerId: users.a.id });
    assert.equal(r.success, false);
  });
  await check("dossier verifies claims, becomes READY, achieved IAS recorded", async () => {
    const d = await db.businessResearchRun.create({ data: { podcastId: showA.id, kind: "dossier", depth: "QUICK", idempotencyKey: "dossier-A", profileVersion: 1, budget: {}, opportunityId: opp.id } });
    const res = await runDossier(d.id, { db, writer: dossierWriter, exa: fakeExa([]), now });
    const dossier = await db.businessResearchDossier.findUniqueOrThrow({ where: { opportunityId: opp.id } });
    assert.equal(res.status, "READY", JSON.stringify(dossier.holdReasons));
    assert.ok(dossier.verifiedClaimCount >= 4);
    const o = await db.businessTopicOpportunity.findUniqueOrThrow({ where: { id: opp.id } });
    assert.ok(o.achievedIas != null && o.achievedIas > 0);
  });
  let episodeId = "";
  await check("tenant isolation: another show can't use this topic", async () => {
    await db.businessTopicOpportunity.update({ where: { id: opp.id }, data: { editorialStatus: "APPROVED" } });
    const r = await createBusinessEpisode(db, { podcastId: showB.id, opportunityId: opp.id, ownerId: users.a.id });
    assert.equal(r.success, false);
    assert.match(r.success ? "" : r.error, /not found/i);
  });
  await check("approved + READY → business episode with frozen snapshot; topic claimed once", async () => {
    const r = await createBusinessEpisode(db, { podcastId: showA.id, opportunityId: opp.id, ownerId: users.a.id }, now());
    assert.ok(r.success, r.success ? "" : r.error);
    episodeId = r.success ? r.episodeId : "";
    const again = await createBusinessEpisode(db, { podcastId: showA.id, opportunityId: opp.id, ownerId: users.a.id });
    assert.equal(again.success, false, "double click can't make two episodes");
    const ep = await db.episode.findUniqueOrThrow({ where: { id: episodeId }, include: { podcast: true, topics: true, businessTopics: true } });
    assert.equal(ep.topics.length, 0, "no fake sports TopicCandidate links");
    assert.equal(resolveEditorialPacket(ep).kind, "BUSINESS");
    assert.equal((await db.businessTopicOpportunity.findUniqueOrThrow({ where: { id: opp.id } })).editorialStatus, "PRODUCED");
  });
  let scriptId = "";
  await check("grounded script: every factual line cites a dossier fact, TTS line shape", async () => {
    const res = await generateBusinessScript(db, { episodeId }, { writer: scriptWriter(), resolveCast });
    scriptId = res.scriptId;
    assert.equal(res.flaggedLines, 0, res.reasons.join(" "));
    const s = await db.script.findUniqueOrThrow({ where: { id: scriptId } });
    assert.equal(s.status, "draft");
    const lines = (s.content as { segments: { lines: Record<string, unknown>[] }[] }).segments.flatMap((x) => x.lines);
    for (const l of lines) for (const k of ["lineIndex", "speakerName", "speakerHostId", "text", "tone", "isFactualClaim", "needsHumanReview", "evidenceRefs"]) assert.ok(k in l, k);
    assert.ok(lines.filter((l) => l.isFactualClaim).every((l) => (l.evidenceRefs as unknown[]).length > 0));
    assert.equal((await db.episode.findUniqueOrThrow({ where: { id: episodeId } })).status, "script_draft");
  });
  await check("no independent judge → needs_review, never passed; the episode does not advance", async () => {
    const r0 = await factCheckBusinessScript(db, scriptId);
    assert.equal(r0.status, "needs_review", r0.errors.join(" "));
    assert.equal(r0.verification.semantic, "SEMANTIC_VERIFICATION_UNAVAILABLE");
  });
  const entail = async () => "entailed" as const;
  await check("fact-check passes with an independent judge; approval then moves the episode to fact_checked", async () => {
    const r1 = await factCheckBusinessScript(db, scriptId, { judge: entail });
    assert.equal(r1.status, "passed", [...r1.errors, ...r1.warnings].join(" "));
    assert.equal((await db.episode.findUniqueOrThrow({ where: { id: episodeId } })).status, "script_draft", "unapproved script doesn't advance");
    await db.script.update({ where: { id: scriptId }, data: { status: "approved" } });
    const r2 = await factCheckBusinessScript(db, scriptId, { judge: entail });
    assert.equal(r2.status, "passed");
    assert.equal((await db.episode.findUniqueOrThrow({ where: { id: episodeId } })).status, "fact_checked");
  });
  await check("an invented statistic is flagged by the writer audit and fails fact-check", async () => {
    await db.episode.update({ where: { id: episodeId }, data: { status: "script_draft" } });
    const res = await generateBusinessScript(db, { episodeId, forceRegenerate: true }, { writer: scriptWriter({ inventNumber: true }), resolveCast });
    assert.equal(res.flaggedLines, 1);
    const fc = await factCheckBusinessScript(db, res.scriptId);
    assert.equal(fc.status, "failed");
    assert.match(fc.errors.join(" "), /87%/);
    assert.equal((await db.script.findUniqueOrThrow({ where: { id: res.scriptId } })).status, "needs_revision");
  });

  console.log("Scenario D/F — sports untouched, tenants separated");
  await check("sports tables untouched; sports episode still resolves to the SPORTS packet", async () => {
    assert.equal(await db.topicCandidate.count(), sportsBefore.topics);
    assert.equal(await db.episodeTopic.count(), sportsBefore.links);
    const ep = await db.episode.findUniqueOrThrow({ where: { id: sportsEp.id }, include: { podcast: true, topics: true, businessTopics: true } });
    assert.equal(resolveEditorialPacket(ep).kind, "SPORTS");
  });
  await check("business production refuses a sports show", async () => {
    const r = await createBusinessEpisode(db, { podcastId: sportsPod.id, opportunityId: opp.id, ownerId: users.a.id });
    assert.equal(r.success, false);
  });
  await check("research on a sports show is refused", async () => {
    const r = await newRun(sportsPod.id, "run-sports");
    await assert.rejects(runIndustryResearch(r.id, engine()), /business show/);
  });
  await check("every source, observation and opportunity is scoped to its own show", async () => {
    for (const pod of [showA, showB, showC]) {
      const runIds = (await db.businessResearchRun.findMany({ where: { podcastId: pod.id } })).map((r) => r.id);
      assert.equal(await db.businessResearchSource.count({ where: { runId: { in: runIds }, NOT: { podcastId: pod.id } } }), 0);
      assert.equal(await db.demandObservation.count({ where: { runId: { in: runIds }, NOT: { podcastId: pod.id } } }), 0);
      const opps = await db.businessTopicOpportunity.findMany({ where: { podcastId: pod.id } });
      const cited = opps.flatMap((o) => o.citedSourceIds);
      assert.equal(await db.businessResearchSource.count({ where: { id: { in: cited }, NOT: { podcastId: pod.id } } }), 0, "no cross-tenant citations");
    }
    const ownerC = await db.businessTopicOpportunity.findMany({ where: { podcastId: showC.id } });
    assert.ok(ownerC.every((o) => o.ownerId === users.b.id));
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
