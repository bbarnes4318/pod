// Script-model A/B on the SAME episode — provider-agnostic.
//
//   npm run test:model-ab
//
// Real RSS stories are fetched ONCE, topics picked ONCE, enriched briefs built
// ONCE, then the identical outline-driven script engine runs twice — once per
// script model. Both scripts are scored with the same rubric, and per-side
// usage/cost is reported.
//
// CONFIGURE BOTH SIDES BY ENVIRONMENT. This harness used to hardcode
// "gpt-5.5 versus claude-opus-4-8", which made the comparison anyone actually
// needed — Gemini versus Anthropic — a source-code edit. Both sides are now
// variables:
//
//   MODEL_AB_A_PROVIDER=gemini      MODEL_AB_A_MODEL=gemini-3.6-flash
//   MODEL_AB_B_PROVIDER=anthropic   MODEL_AB_B_MODEL=claude-opus-5
//
// THE SHARED-PREP RULE. Preparation (topic picking + brief enrichment) runs
// ONCE on ONE model, and both sides receive the byte-identical prompt built
// from it. Running prep separately per side would mean each model wrote from
// different source material, and the measured difference would be partly the
// prep model's — which is not a script-model comparison at all. Override the
// prep model with MODEL_AB_PREP_PROVIDER / MODEL_AB_PREP_MODEL; it defaults to
// side A.

import fs from "fs";
import path from "path";
import { execSync } from "node:child_process";
import { XMLParser } from "fast-xml-parser";
import * as dotenv from "dotenv";

/** Load env from this checkout AND the main worktree — `.env` files are
 *  gitignored, so a `git worktree` checkout does not have them. */
function loadEnv() {
  const roots = [process.cwd()];
  try {
    const commonDir = execSync("git rev-parse --path-format=absolute --git-common-dir", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const mainRoot = path.dirname(commonDir);
    if (mainRoot && mainRoot !== process.cwd()) roots.push(mainRoot);
  } catch {
    /* not a git checkout */
  }
  for (const root of roots) {
    for (const file of [".env.coolify.local", ".env.local", ".env"]) {
      const full = path.join(root, file);
      if (fs.existsSync(full)) dotenv.config({ path: full });
    }
  }
}
loadEnv();

import { fetchArticleExcerpts } from "../lib/research/articleText";
import { scoreTopicTalkability } from "../lib/services/talkabilityService";
import { dedupeScriptSegments, normalizeLineIndexes, findRepetitions } from "../lib/services/scriptRepetition";
import { scoreScriptQuality } from "../lib/services/episodeQualityService";
import { getLLMProvider, isSupportedLLMProvider, SUPPORTED_LLM_PROVIDERS } from "../lib/providers/llm/factory";
import { LLMProvider, LLMUsage } from "../lib/providers/llm/interface";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";

const FEEDS = (process.env.NEWS_RSS_FEEDS ||
  "https://www.espn.com/espn/rss/news,https://www.cbssports.com/rss/headlines/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Which env var carries each provider's credential. Used only to fail EARLY
 *  with a specific message rather than half way through a paid run. */
const KEY_ENV: Record<string, string> = {
  gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * $/1M tokens. Published rates where known; every entry is labelled with its
 * provenance so a cost line is never mistaken for a quote. An unlisted model
 * reports tokens only — a fabricated price is worse than no price.
 */
const PRICES: Record<string, { in: number; out: number; note: string }> = {
  "gemini-3.6-flash": { in: 1.5, out: 7.5, note: "published" },
  "claude-opus-5": { in: 5, out: 25, note: "published" },
  "claude-opus-4-8": { in: 5, out: 25, note: "published" },
  "claude-sonnet-5": { in: 3, out: 15, note: "published" },
};

interface SideConfig {
  label: string;
  provider: string;
  model?: string;
}

function readSide(letter: "A" | "B", defaults: { provider: string; model: string }): SideConfig {
  const provider = (process.env[`MODEL_AB_${letter}_PROVIDER`] || defaults.provider).trim().toLowerCase();
  const model = (process.env[`MODEL_AB_${letter}_MODEL`] || defaults.model).trim() || undefined;
  if (!isSupportedLLMProvider(provider)) {
    throw new Error(
      `MODEL_AB_${letter}_PROVIDER='${provider}' is not supported. Legal values: ${SUPPORTED_LLM_PROVIDERS.join(", ")}.`
    );
  }
  if (provider === "stub") {
    throw new Error(`MODEL_AB_${letter}_PROVIDER=stub cannot generate a script — pick a real provider.`);
  }
  return { label: `${provider}/${model ?? "default"}`, provider, model };
}

interface FeedItem { index: number; title: string; description: string; link: string; pubDate: string; }

/** LLM-authored JSON. Only the fields this harness reads are declared; the rest
 *  is carried through untouched, so a model adding a field is not a type error. */
interface Topic {
  title: string;
  summary: string;
  sport?: string;
  itemIndexes?: number[];
}
interface Brief {
  mainAngle?: string;
  whyMattersNow?: string;
  strongestDebateQuestion?: string;
  contrarianAngle?: string;
  suggestedHostTake?: string;
  argumentForHostA?: string;
  argumentForHostB?: string;
  keyFactsContext?: unknown[];
  onAirTalkingPoints?: unknown[];
  counterArguments?: unknown[];
}
interface ScriptLine { text?: string }
interface ScriptSegment { type?: string; title?: string; lines?: ScriptLine[] }
type QualityReport = ReturnType<typeof scoreScriptQuality>;

function textOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return String(o["#text"] ?? o.__cdata ?? "");
  }
  return String(v);
}

async function fetchFeedItems(): Promise<FeedItem[]> {
  const parser = new XMLParser({ ignoreAttributes: false });
  const items: FeedItem[] = [];
  for (const feed of FEEDS) {
    try {
      const res = await fetch(feed, { headers: { "User-Agent": "TakeMachineResearch/1.0" } });
      const xml = await res.text();
      const doc = parser.parse(xml);
      const raw = doc?.rss?.channel?.item || [];
      for (const it of Array.isArray(raw) ? raw : [raw]) {
        const title = textOf(it?.title).trim();
        const link = textOf(it?.link).trim();
        if (!title || !link) continue;
        items.push({
          index: items.length,
          title,
          description: textOf(it?.description).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 250),
          link,
          pubDate: textOf(it?.pubDate),
        });
      }
    } catch (err: unknown) {
      console.warn(`  feed failed (${feed}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return items.slice(0, 28);
}

async function pickTopics(llm: LLMProvider, items: FeedItem[]): Promise<Topic[]> {
  const listing = items.map((i) => `[${i.index}] ${i.title} — ${i.description || "(no summary)"} (${i.pubDate})`).join("\n");
  const res = await llm.generateStructuredOutput<{ topics?: Topic[] }>({
    systemPrompt: "You are the story editor for a two-host sports DEBATE podcast. You hunt for stories with conflict, stakes, surprise, and named people — not routine game recaps. Return valid JSON only.",
    prompt: `Today's real headlines:\n${listing}\n\nPick the 2 MOST DEBATE-WORTHY topics (distinct from each other). For each: {"title": "punchy debate-question title", "summary": "one paragraph: the tension and stakes", "sport": "...", "itemIndexes": [supporting item indexes, 1-4 of them]}\n\nReturn: { "topics": [ ... ] }`,
    temperature: 0.6,
    maxTokens: 6000,
  });
  const topics = Array.isArray(res?.topics) ? res.topics.slice(0, 2) : [];
  if (topics.length === 0) throw new Error("Topic picker returned nothing.");
  return topics;
}

async function buildEnrichedBrief(llm: LLMProvider, topic: Topic, items: FeedItem[]): Promise<Brief> {
  const supporting = (topic.itemIndexes || []).map((i: number) => items[i]).filter(Boolean);
  const excerpts = await fetchArticleExcerpts(supporting.map((s: FeedItem) => s.link), { maxArticles: 3, maxCharsPerArticle: 2400 });
  const evidence = supporting
    .map((s: FeedItem) => {
      const ex = excerpts.find((e) => e.url === s.link);
      return `news-${s.index}: "${s.title}" (${s.pubDate})\nRSS summary: ${s.description}\nARTICLE TEXT:\n${ex?.ok ? ex.excerpt : "(fetch failed — use RSS summary only)"}`;
    })
    .join("\n\n---\n\n");
  console.log(`    enrichment: ${excerpts.filter((e) => e.ok).length}/${supporting.length} full articles fetched`);

  return llm.generateStructuredOutput<Brief>({
    systemPrompt: `You prepare fact-grounded debate briefs for a sports podcast. Use ONLY the supplied evidence. Mine the ARTICLE TEXT for exact numbers, dates, records, and who-said-what. Quotes at most 20 words, attributed, never longer verbatim passages. Every keyFactsContext item must carry a concrete number or named person. Surface CONFLICT and stakes. Aim for 8-12 keyFactsContext items. Return valid JSON only.`,
    prompt: `Topic: ${topic.title}\nSummary: ${topic.summary}\n\nEVIDENCE:\n${evidence}\n\nReturn JSON: { "mainAngle": "...", "whyMattersNow": "...", "keyFactsContext": [ { "text": "...", "evidenceRefs": [ { "type": "newsItem", "id": "news-<index>" } ], "confidence": "high" } ], "onAirTalkingPoints": [ { "text": "...", "evidenceRefs": [] } ], "counterArguments": [ { "host": "Zabala" | "Mercer", "claim": "..." } ], "contrarianAngle": "...", "strongestDebateQuestion": "...", "suggestedHostTake": "...", "argumentForHostA": "...", "argumentForHostB": "...", "sourceIds": [ { "type": "newsItem", "id": "news-<index>" } ] }`,
    temperature: 0.4,
    maxTokens: 10000,
  });
}

function topicPromptBlock(idx: number, topic: Topic, brief: Brief): string {
  const lines = [``, `Topic #${idx + 1}: ${topic.title}`, `Sport/League: ${topic.sport || "N/A"}`];
  if (brief.mainAngle) lines.push(`Main Angle: ${brief.mainAngle}`);
  if (brief.whyMattersNow) lines.push(`Why It Matters RIGHT NOW: ${brief.whyMattersNow}`);
  if (brief.strongestDebateQuestion) lines.push(`Strongest Debate Question: ${brief.strongestDebateQuestion}`);
  if (brief.contrarianAngle) lines.push(`Contrarian Angle (use it): ${brief.contrarianAngle}`);
  if (brief.suggestedHostTake) lines.push(`Suggested Host Take: ${brief.suggestedHostTake}`);
  lines.push(
    `Zabala Debate Stance: ${brief.argumentForHostA || ""}`,
    `Mercer Debate Stance: ${brief.argumentForHostB || ""}`,
    `Key Grounded Facts: ${JSON.stringify(brief.keyFactsContext || [])}`,
    `On-Air Talking Points: ${JSON.stringify(brief.onAirTalkingPoints || [])}`,
    `Suggested Counter-arguments: ${JSON.stringify(brief.counterArguments || [])}`,
    `Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): []`,
    ``
  );
  return lines.join("\n");
}

interface SideResult {
  config: SideConfig;
  completed: boolean;
  error?: string;
  segments: ScriptSegment[];
  quality: QualityReport | null;
  repetitionRatio: number;
  lineCount: number;
  seconds: number;
  usage: LLMUsage;
  /** Movements the engine had to retry, and outright JSON failures. */
  movementRetries: number;
  jsonFailures: number;
}

async function generateAndScore(config: SideConfig, topicsPrompts: string, systemPrompt: string): Promise<SideResult> {
  const llm = getLLMProvider({ provider: config.provider, model: config.model });
  const start = Date.now();
  let movementRetries = 0;
  let jsonFailures = 0;

  const base: SideResult = {
    config,
    completed: false,
    segments: [],
    quality: null,
    repetitionRatio: 0,
    lineCount: 0,
    seconds: 0,
    usage: { inputTokens: 0, outputTokens: 0, requestCount: 0 },
    movementRetries,
    jsonFailures,
  };

  try {
    const out = await generateOutlineDrivenScript(llm, {
      speakerNames: ["Zabala", "Mercer"],
      systemPrompt,
      episodeTitle: `Model A/B test (${config.label})`,
      topicsPrompts,
      targetDuration: 10,
      version: 1,
      temperature: 0.85, // ignored by models that reject sampling params
      maxTokens: 16000,
      log: (m) => {
        console.log(`    [${config.label}] ${m}`);
        // The engine logs its own retries and fallbacks; counting them is how a
        // side that "completed" but limped is distinguished from one that ran
        // clean. A score alone hides that entirely.
        if (/attempt \d+ failed/i.test(m)) movementRetries++;
        if (/failed to parse|single-shot fallback/i.test(m)) jsonFailures++;
      },
    });
    const { segments } = dedupeScriptSegments(out.segments);
    normalizeLineIndexes(segments);
    const texts: string[] = [];
    for (const seg of segments) for (const l of seg.lines || []) texts.push(String(l.text || ""));
    const rep = findRepetitions(texts);
    const quality = scoreScriptQuality({ segments });
    const seconds = Math.round((Date.now() - start) / 1000);
    console.log(
      `    [${config.label}] ${texts.length} lines in ${seconds}s, repetition ${(rep.repetitionRatio * 100).toFixed(1)}%, SCORE ${quality.total}/100`
    );
    return {
      ...base,
      completed: true,
      segments,
      quality,
      repetitionRatio: rep.repetitionRatio,
      lineCount: texts.length,
      seconds,
      usage: llm.getAccumulatedUsage?.() ?? base.usage,
      movementRetries,
      jsonFailures,
    };
  } catch (err: unknown) {
    // A side that DIED is a result, not a reason to abandon the comparison —
    // "provider B cannot complete this episode" is the single most useful thing
    // an A/B can tell you, and exiting here would throw away side A's run too.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`    [${config.label}] FAILED: ${message}`);
    return {
      ...base,
      error: message,
      seconds: Math.round((Date.now() - start) / 1000),
      usage: llm.getAccumulatedUsage?.() ?? base.usage,
      movementRetries,
      jsonFailures: jsonFailures + 1,
    };
  }
}

function costOf(model: string | undefined, usage: LLMUsage): { usd: number | null; note: string } {
  const p = model ? PRICES[model] : undefined;
  if (!p) return { usd: null, note: "no configured price — tokens only" };
  return { usd: (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000, note: p.note };
}

function requireKey(provider: string, role: string): void {
  const envVar = KEY_ENV[provider];
  if (!envVar) return;
  const val = process.env[envVar];
  if (!val || val.trim().length < 20) {
    throw new Error(
      `${envVar} is missing or too short — required for the ${role} (${provider}). ` +
        `Set it in .env.coolify.local (or the environment) and re-run. Nothing was generated.`
    );
  }
}

async function main() {
  // Defaults reflect the change this harness exists to measure: the new
  // production provider against the rollback target.
  const sideA = readSide("A", { provider: "gemini", model: "gemini-3.6-flash" });
  const sideB = readSide("B", { provider: "anthropic", model: "claude-opus-5" });
  const prep: SideConfig = {
    label: "prep",
    provider: (process.env.MODEL_AB_PREP_PROVIDER || sideA.provider).trim().toLowerCase(),
    model: (process.env.MODEL_AB_PREP_MODEL || sideA.model || "").trim() || undefined,
  };

  console.log(`\nModel A/B\n  A:    ${sideA.label}\n  B:    ${sideB.label}\n  prep: ${prep.provider}/${prep.model ?? "default"}\n`);

  // Fail before spending anything if either side cannot possibly run.
  requireKey(sideA.provider, "A side");
  requireKey(sideB.provider, "B side");
  requireKey(prep.provider, "shared prep");

  const personaPrompt = fs.readFileSync(path.join(__dirname, "fixtures", "livePersonaPrompt.txt"), "utf8");

  console.log("[1] Fetching REAL headlines...");
  const items = await fetchFeedItems();
  console.log(`    ${items.length} items. Sample: "${items[0]?.title}"`);

  console.log(`[2] Shared prep (${prep.provider}/${prep.model ?? "default"} for BOTH sides): topics + enriched briefs...`);
  const prepLLM = getLLMProvider({ provider: prep.provider, model: prep.model });
  const topics = await pickTopics(prepLLM, items);
  topics.forEach((t, i) => console.log(`    ${i + 1}. ${t.title}`));
  const briefs: Brief[] = [];
  for (const t of topics) briefs.push(await buildEnrichedBrief(prepLLM, t, items));
  // ONE prompt string, used byte-identically by both sides.
  const topicsPrompts = topics.map((t, i) => topicPromptBlock(i, t, briefs[i])).join("\n---\n");
  topics.forEach((t, i) => {
    const talk = scoreTopicTalkability({ title: t.title, summary: t.summary, createdAt: new Date(), brief: briefs[i] });
    console.log(`    talkability "${t.title}": ${talk.total}/100`);
  });

  console.log("[3] Generating the SAME episode with both script models...");
  const a = await generateAndScore(sideA, topicsPrompts, personaPrompt);
  const b = await generateAndScore(sideB, topicsPrompts, personaPrompt);

  const aCost = costOf(sideA.model, a.usage);
  const bCost = costOf(sideB.model, b.usage);
  const W = 26;
  const cell = (v: string) => v.padEnd(W);

  console.log("\n================= MODEL A/B RESULTS (same topics, same briefs, same engine) =================");
  console.log(`${"AXIS".padEnd(16)}${cell(sideA.label)}${sideB.label}`);
  const axes = (a.quality ?? b.quality)?.axes;
  if (axes) {
    for (const axis of Object.keys(axes) as Array<keyof QualityReport["axes"]>) {
      const av = a.quality ? `${a.quality.axes[axis].score}/${a.quality.axes[axis].max}` : "—";
      const bv = b.quality ? `${b.quality.axes[axis].score}/${b.quality.axes[axis].max}` : "—";
      console.log(`${String(axis).padEnd(16)}${cell(av)}${bv}`);
    }
  }
  console.log(`${"TOTAL".padEnd(16)}${cell(a.quality ? `${a.quality.total}/100` : "—")}${b.quality ? `${b.quality.total}/100` : "—"}`);
  console.log(`${"completed".padEnd(16)}${cell(a.completed ? "yes" : `NO — ${a.error?.slice(0, 60)}`)}${b.completed ? "yes" : `NO — ${b.error?.slice(0, 60)}`}`);
  console.log(`${"lines".padEnd(16)}${cell(String(a.lineCount))}${b.lineCount}`);
  console.log(`${"repetition".padEnd(16)}${cell(`${(a.repetitionRatio * 100).toFixed(1)}%`)}${(b.repetitionRatio * 100).toFixed(1)}%`);
  console.log(`${"gen time".padEnd(16)}${cell(`${a.seconds}s`)}${b.seconds}s`);
  console.log(`${"tokens in/out".padEnd(16)}${cell(`${a.usage.inputTokens}/${a.usage.outputTokens}`)}${b.usage.inputTokens}/${b.usage.outputTokens}`);
  console.log(`${"requests".padEnd(16)}${cell(String(a.usage.requestCount))}${b.usage.requestCount}`);
  console.log(`${"movement retries".padEnd(16)}${cell(String(a.movementRetries))}${b.movementRetries}`);
  console.log(`${"json failures".padEnd(16)}${cell(String(a.jsonFailures))}${b.jsonFailures}`);
  console.log(
    `${"script cost".padEnd(16)}${cell(aCost.usd === null ? aCost.note : `$${aCost.usd.toFixed(3)} (${aCost.note})`)}` +
      `${bCost.usd === null ? bCost.note : `$${bCost.usd.toFixed(3)} (${bCost.note})`}`
  );

  console.log(
    "\nNOTE: the score measures SHAPE (causality, arc, restraint, repetition). It cannot tell you whether the\n" +
      "dialogue is boring or whether a host sounds like themselves. Read the transcripts before choosing a model."
  );

  const outPath = path.join(process.cwd(), "samples", "model-ab-results.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        prep: { provider: prep.provider, model: prep.model },
        topics,
        sideA: { ...sideA, ...a },
        sideB: { ...sideB, ...b },
      },
      null,
      2
    )
  );
  console.log(`\nFull transcripts + scores: ${outPath}`);

  // A side that could not complete is a failure of the run, not a tie.
  if (!a.completed || !b.completed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("Model A/B failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
