// Executive brief: normalisation, fallback labelling, section merge, prompt block.
// Pure. Run: npx tsx src/scripts/testExecutiveBrief.ts
import { briefMismatches, briefPromptBlock, deterministicBrief, mergeSection, normalizeBrief, readBrief, validateBriefShape, type BriefContext } from "../lib/studio/executiveBrief";
import { withInFlightLock } from "../lib/rateLimit";

const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const ctx: BriefContext = {
  objective: "Why small businesses overpay for telecom", showName: "Margin", showDescription: "A business show", kind: "business",
  hosts: [{ id: "h1", name: "Ana", role: "analyst" }, { id: "h2", name: "Ben", role: "skeptic" }],
  sources: [{ id: "s1", title: "Telecom pricing dossier", summary: "Contracts auto-renew at list price." }], targetMinutes: 14, productionStyle: "light",
};
const raw = {
  title: { value: "The telecom tax", rationale: "x" }, positioning: { value: "p", rationale: "" }, audience: { value: "a", rationale: "" }, angle: { value: "a", rationale: "" },
  thesis: { value: "t", rationale: "" }, hook: { value: "h", rationale: "" }, researchNeeds: ["n"],
  evidence: [{ sourceId: "s1", use: "core" }, { sourceId: "INVENTED", use: "made up" }],
  segments: [{ title: "Seg", goal: "g", sourceIds: ["s1", "nope"] }],
  hostAssignments: [{ hostId: "h1", perspective: "for", role: "" }, { hostId: "ghost", perspective: "x", role: "" }],
  counterarguments: [], disagreements: [], insiderInsights: [], takeaways: ["t"], conclusion: { value: "c", rationale: "" },
  targetMinutes: 400, productionStyle: "loud", soundDirection: { value: "s", rationale: "" },
};
const b = normalizeBrief(raw, ctx, { source: "model", model: "m" });
assert(b.evidence.length === 1 && b.evidence[0].sourceId === "s1", "invented evidence dropped");
assert(b.segments[0].sourceIds.join() === "s1", "invented segment source dropped");
assert(b.hostAssignments.length === 1, "unknown host dropped");
assert(b.targetMinutes === 60 && b.productionStyle === "light", "clamped to context");
assert(validateBriefShape(raw) === null && validateBriefShape({}) !== null, "shape check");
const d = deterministicBrief(ctx);
assert(d.source === "deterministic" && d.model === null, "fallback labelled deterministic");
const merged = mergeSection({ ...b, rejected: ["hook"] }, { ...d, hook: { value: "new hook", rationale: "" } }, "hook");
assert(merged.hook.value === "new hook" && merged.thesis.value === "t" && !merged.rejected.includes("hook"), "mergeSection replaces one section only");
const block = briefPromptBlock({ ...b, rejected: ["takeaways"] }, { hostName: (id) => (id === "h1" ? "Ana" : undefined), sourceTitle: () => "Telecom pricing dossier" });
assert(block.includes("Central thesis: t") && block.includes("Ana") && !block.includes("What the listener should leave with"), "prompt block honours rejections");
assert(readBrief({ junk: true }) === null && readBrief(b)?.title.value === "The telecom tax", "readBrief");
console.log("ok  executive brief self-check");

// ---- the brief must describe the episode actually being created ----
{
  const fit = briefMismatches(b, { hostIds: ["h1", "h2"], sourceIds: ["s1"] });
  assert(fit.length === 0, "a brief that matches the cast and topics passes");
  const wrongHost = briefMismatches(b, { hostIds: ["h2", "h3"], sourceIds: ["s1"] }, { host: (id) => (id === "h1" ? "Ana" : undefined) });
  assert(wrongHost.length === 1 && wrongHost[0].includes("Ana"), "a host the brief assigns who is not seated is reported by name");
  const missingStory = briefMismatches(b, { hostIds: ["h1"], sourceIds: [] }, { source: () => "Telecom pricing dossier" });
  assert(missingStory.length === 1 && missingStory[0].includes("Telecom pricing dossier"), "a cited story the episode does not carry is reported once (evidence + segment deduped)");
  const dropped = briefMismatches({ ...b, rejected: ["hostAssignments", "evidence", "segments"] }, { hostIds: [], sourceIds: [] });
  assert(dropped.length === 0, "rejected sections are not checked (the writers never see them)");
  console.log("ok  brief/episode match check");
}

// ---- duplicate-request guard: a second concurrent call is refused, not charged ----
void (async () => {
  const store = new Map<string, string>();
  const redis = {
    set: async (k: string, v: string, _px: string, _ms: number, nx: string) => { if (nx === "NX" && store.has(k)) return null; store.set(k, v); return "OK"; },
    del: async (k: string) => { store.delete(k); return 1; },
  };
  let calls = 0;
  let release!: () => void;
  const slow = () => new Promise<string>((r) => { calls++; release = () => r("done"); });
  const first = withInFlightLock("t", 1000, slow, { redis });
  await new Promise((r) => setTimeout(r, 5));
  const second = await withInFlightLock("t", 1000, async () => { calls++; return "x"; }, { redis });
  assert(second.busy === true && calls === 1, "second call while the first is in flight is refused without running");
  release();
  const firstDone = await first;
  assert(!firstDone.busy && firstDone.value === "done", "first call completes");
  await new Promise((r) => setTimeout(r, 5));
  const third = await withInFlightLock("t", 1000, async () => "again", { redis });
  assert(!third.busy && third.value === "again", "lock is released after the call finishes");
  const broken = { set: async () => { throw new Error("down"); }, del: async () => 0 };
  const degraded = await withInFlightLock("t", 1000, async () => "ran", { redis: broken });
  assert(!degraded.busy && degraded.value === "ran", "an unreachable limiter never blocks the user");
  console.log("ok  in-flight lock");
})();

// ---- the approved brief reaches production (source checks: generation needs a model and a database) ----
import fs from "node:fs";
import path from "node:path";
{
  const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
  const studio = src("lib/services/studioActions.ts");
  assert(/readBrief\(input\.brief\)/.test(studio) && /couldn't be read/.test(studio), "creation validates the brief and refuses a malformed one");
  assert(/editorialBrief: brief,/.test(studio) && !/episode\.update\([^)]*editorialBrief/.test(studio), "sports creation hands the brief to the episode transaction, never a separate update");
  const record = src("lib/services/episodeService.ts");
  assert(/briefMismatches\(settings\.editorialBrief[\s\S]{0,400}throw new Error[\s\S]{0,200}tx\.episode\.create\(\{[\s\S]{0,2500}editorialBrief: settings\.editorialBrief/.test(record), "sports: brief checked against the written cast/topics and stored inside the same transaction as the episode");
  const bizCreate = src("lib/business/businessProduction.ts");
  assert(/briefMismatches\(/.test(bizCreate) && /tx\.episode\.create\(\{[\s\S]{0,900}editorialBrief: input\.editorialBrief/.test(bizCreate), "business: brief checked and stored inside the episode transaction");
  const biz = src("app/studio/shows/businessActions.ts");
  assert(/createBusinessEpisode\(db, \{[^}]*editorialBrief: brief \}\)[\s\S]{0,200}await queueScriptGenerationJob/.test(biz) && !/episode\.update\([^)]*editorialBrief/.test(biz), "business stores the brief with the episode BEFORE queueing the script job");
  const sports = src("lib/services/scriptService.ts");
  assert(/readBrief\(ep\.editorialBrief\)/.test(sports) && /const systemPrompt = executiveBrief\s*\? baseSystemPrompt \+ "\\n" \+ briefPromptBlock/.test(sports), "the sports writer's one system prompt carries the brief");
  const bizGen = src("lib/business/businessProduction.ts");
  assert((bizGen.match(/\+ briefBlock\(/g) ?? []).length === 2, "both business writing paths (writing room and single writer) carry the brief");
  const action = src("app/studio/create/producerActions.ts");
  assert(/getRoleLLMProvider\(ROLE\)/.test(action) && /roleHasRealProvider\(ROLE\)/.test(action) && /maxTokens: MAX_TOKENS/.test(action), "the brief uses role routing, checks availability, and caps tokens");
  assert(/deterministicBrief\(ctx\)/.test(action) && !/source: "model"[^\n]*deterministic/.test(action), "fallback is the deterministic brief, never labelled as model output");
  assert(/withInFlightLock\(`brief:\$\{user\.id\}`/.test(action) && /consumeRateLimit\("briefDraft", user\.id\)[\s\S]{0,300}getRoleLLMProvider\(ROLE\)/.test(action), "brief drafting: one in flight per user, hourly limit counted before the model call");
  const chem = src("app/studio/hosts/chemistryActions.ts");
  assert(/if \(wanted && !wanted\.has\(i\)\) continue;/.test(chem), "partial voicing can be recovered by re-voicing only the failed lines");
  assert(/consumeRateLimit\("auditionWrite"/.test(chem) && /consumeRateLimit\("auditionVoice"/.test(chem) && /assertPremiumVoiceAllowed\(user\.id, engine\)/.test(chem) && (chem.match(/withInFlightLock\(/g) ?? []).length === 2, "auditions: per-user limits, one in flight, and the premium-voice plan rule on voicing");
  console.log("ok  executive brief propagation (source checks)");
}
