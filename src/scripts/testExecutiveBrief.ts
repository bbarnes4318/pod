// Executive brief: normalisation, fallback labelling, section merge, prompt block.
// Pure. Run: npx tsx src/scripts/testExecutiveBrief.ts
import { briefPromptBlock, deterministicBrief, mergeSection, normalizeBrief, readBrief, validateBriefShape, type BriefContext } from "../lib/studio/executiveBrief";

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

// ---- the approved brief reaches production (source checks: generation needs a model and a database) ----
import fs from "node:fs";
import path from "node:path";
{
  const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const assert = (c: unknown, m: string) => { if (!c) throw new Error(m); };
  const studio = src("lib/services/studioActions.ts");
  assert(/readBrief\(input\.brief\)/.test(studio) && /couldn't be read/.test(studio), "creation validates the brief and refuses a malformed one");
  assert(/episode\.update\(\{ where: \{ id: res\.episodeId \}, data: \{ editorialBrief: brief/.test(studio), "creation stores the brief on the episode");
  const biz = src("app/studio/shows/businessActions.ts");
  assert(/editorialBrief: brief[\s\S]{0,80}\n\s*await queueScriptGenerationJob/.test(biz), "business stores the brief BEFORE queueing the script job");
  const sports = src("lib/services/scriptService.ts");
  assert(/readBrief\(ep\.editorialBrief\)/.test(sports) && /const systemPrompt = executiveBrief\s*\? baseSystemPrompt \+ "\\n" \+ briefPromptBlock/.test(sports), "the sports writer's one system prompt carries the brief");
  const bizGen = src("lib/business/businessProduction.ts");
  assert((bizGen.match(/\+ briefBlock\(/g) ?? []).length === 2, "both business writing paths (writing room and single writer) carry the brief");
  const action = src("app/studio/create/producerActions.ts");
  assert(/getRoleLLMProvider\(ROLE\)/.test(action) && /roleHasRealProvider\(ROLE\)/.test(action) && /maxTokens: MAX_TOKENS/.test(action), "the brief uses role routing, checks availability, and caps tokens");
  assert(/deterministicBrief\(ctx\)/.test(action) && !/source: "model"[^\n]*deterministic/.test(action), "fallback is the deterministic brief, never labelled as model output");
  console.log("ok  executive brief propagation (source checks)");
}
