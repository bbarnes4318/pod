// Script-model A/B on the SAME episode, built from LIVE headlines.
//
//   npm run test:model-ab
//
// Real RSS stories are fetched once, topics picked once, enriched briefs built
// once (all by ONE prep model, so the source material is identical), then the
// identical outline-driven script engine runs twice — once per script model.
// Both scripts are scored with the same rubric, and per-side token usage is
// reported.
//
// THIS SCRIPT IS THE LIVE-MATERIAL COMPARISON. For per-ROLE experiments on a
// fixed packet (dialogue / outline / verification, with seeded ground truth for
// the verifier), use:
//
//   npm run test:role-experiments -- --experiment dialogue
//
// Providers are configurable so this no longer hard-requires OpenAI. Defaults:
// prep = the global legacy provider, side A = the current script model, side B =
// the frontier dialogue primary (NVIDIA Mistral Medium 3.5). Override with
// AB_PREP_PROVIDER / AB_PREP_MODEL, AB_A_PROVIDER / AB_A_MODEL, AB_B_PROVIDER /
// AB_B_MODEL. A side whose credential is missing is reported as skipped.

import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });

import { fetchArticleExcerpts } from "../lib/research/articleText";
import { scoreTopicTalkability } from "../lib/services/talkabilityService";
import { dedupeScriptSegments, normalizeLineIndexes, findRepetitions } from "../lib/services/scriptRepetition";
import { scoreScriptQuality } from "../lib/services/episodeQualityService";
import { getLLMProvider } from "../lib/providers/llm/factory";
import { providerCredentialPresent, resolveLegacyFamily } from "../lib/providers/llm/routing";
import { MODEL_IDS } from "../lib/providers/llm/capabilities";
import { LLMProvider } from "../lib/providers/llm/interface";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";

const FEEDS = (process.env.NEWS_RSS_FEEDS ||
  "https://www.espn.com/espn/rss/news,https://www.cbssports.com/rss/headlines/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// $/1M tokens, OPERATOR-SUPPLIED only: LLM_PRICE_<PROVIDER>_IN / _OUT. No rate
// is hardcoded and none is guessed — an unpriced side reports tokens and
// "unpriced" rather than a confident dollar figure that is simply wrong. Hosted
// NVIDIA and Z.ai endpoints are free, so they are always unpriced.
function priceFor(provider: string): { in: number; out: number } | null {
  const p = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const inRate = Number(process.env[`LLM_PRICE_${p}_IN`]);
  const outRate = Number(process.env[`LLM_PRICE_${p}_OUT`]);
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return null;
  return { in: inRate, out: outRate };
}

interface Side {
  key: string;
  label: string;
  provider: string;
  model?: string;
}

/** prep + the two script models, from env with sensible defaults. */
function resolveSides(): { prep: Side; a: Side; b: Side } {
  const globalCfg = resolveLegacyFamily("global");
  const scriptCfg = resolveLegacyFamily("script");
  const mk = (key: string, provider: string, model: string | undefined): Side => ({
    key,
    label: model ? `${provider}/${model}` : provider,
    provider,
    model,
  });
  return {
    prep: mk(
      "prep",
      (process.env.AB_PREP_PROVIDER || globalCfg.provider).toLowerCase(),
      process.env.AB_PREP_MODEL || globalCfg.model
    ),
    a: mk(
      "a",
      (process.env.AB_A_PROVIDER || scriptCfg.provider).toLowerCase(),
      process.env.AB_A_MODEL || scriptCfg.model
    ),
    b: mk(
      "b",
      (process.env.AB_B_PROVIDER || "nvidia").toLowerCase(),
      process.env.AB_B_MODEL || MODEL_IDS.nvidia.mistral
    ),
  };
}

interface FeedItem { index: number; title: string; description: string; link: string; pubDate: string; }

function textOf(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return String(v["#text"] ?? v.__cdata ?? "");
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
    } catch (err: any) {
      console.warn(`  feed failed (${feed}): ${err.message}`);
    }
  }
  return items.slice(0, 28);
}

async function pickTopics(llm: LLMProvider, items: FeedItem[]): Promise<any[]> {
  const listing = items.map((i) => `[${i.index}] ${i.title} — ${i.description || "(no summary)"} (${i.pubDate})`).join("\n");
  const res = await llm.generateStructuredOutput<any>({
    systemPrompt: "You are the story editor for a two-host sports DEBATE podcast. You hunt for stories with conflict, stakes, surprise, and named people — not routine game recaps. Return valid JSON only.",
    prompt: `Today's real headlines:\n${listing}\n\nPick the 2 MOST DEBATE-WORTHY topics (distinct from each other). For each: {"title": "punchy debate-question title", "summary": "one paragraph: the tension and stakes", "sport": "...", "itemIndexes": [supporting item indexes, 1-4 of them]}\n\nReturn: { "topics": [ ... ] }`,
    temperature: 0.6,
    maxTokens: 6000,
  });
  const topics = Array.isArray(res?.topics) ? res.topics.slice(0, 2) : [];
  if (topics.length === 0) throw new Error("Topic picker returned nothing.");
  return topics;
}

async function buildEnrichedBrief(llm: LLMProvider, topic: any, items: FeedItem[]): Promise<any> {
  const supporting = (topic.itemIndexes || []).map((i: number) => items[i]).filter(Boolean);
  const excerpts = await fetchArticleExcerpts(supporting.map((s: FeedItem) => s.link), { maxArticles: 3, maxCharsPerArticle: 2400 });
  const evidence = supporting
    .map((s: FeedItem) => {
      const ex = excerpts.find((e) => e.url === s.link);
      return `news-${s.index}: "${s.title}" (${s.pubDate})\nRSS summary: ${s.description}\nARTICLE TEXT:\n${ex?.ok ? ex.excerpt : "(fetch failed — use RSS summary only)"}`;
    })
    .join("\n\n---\n\n");
  console.log(`    enrichment: ${excerpts.filter((e) => e.ok).length}/${supporting.length} full articles fetched`);

  return llm.generateStructuredOutput<any>({
    systemPrompt: `You prepare fact-grounded debate briefs for a sports podcast. Use ONLY the supplied evidence. Mine the ARTICLE TEXT for exact numbers, dates, records, and who-said-what. Quotes at most 20 words, attributed, never longer verbatim passages. Every keyFactsContext item must carry a concrete number or named person. Surface CONFLICT and stakes. Aim for 8-12 keyFactsContext items. Return valid JSON only.`,
    prompt: `Topic: ${topic.title}\nSummary: ${topic.summary}\n\nEVIDENCE:\n${evidence}\n\nReturn JSON: { "mainAngle": "...", "whyMattersNow": "...", "keyFactsContext": [ { "text": "...", "evidenceRefs": [ { "type": "newsItem", "id": "news-<index>" } ], "confidence": "high" } ], "onAirTalkingPoints": [ { "text": "...", "evidenceRefs": [] } ], "counterArguments": [ { "host": "Zabala" | "Mulkey", "claim": "..." } ], "contrarianAngle": "...", "strongestDebateQuestion": "...", "suggestedHostTake": "...", "argumentForHostA": "...", "argumentForHostB": "...", "sourceIds": [ { "type": "newsItem", "id": "news-<index>" } ] }`,
    temperature: 0.4,
    maxTokens: 10000,
  });
}

function topicPromptBlock(idx: number, topic: any, brief: any): string {
  const lines = [``, `Topic #${idx + 1}: ${topic.title}`, `Sport/League: ${topic.sport || "N/A"}`];
  if (brief.mainAngle) lines.push(`Main Angle: ${brief.mainAngle}`);
  if (brief.whyMattersNow) lines.push(`Why It Matters RIGHT NOW: ${brief.whyMattersNow}`);
  if (brief.strongestDebateQuestion) lines.push(`Strongest Debate Question: ${brief.strongestDebateQuestion}`);
  if (brief.contrarianAngle) lines.push(`Contrarian Angle (use it): ${brief.contrarianAngle}`);
  if (brief.suggestedHostTake) lines.push(`Suggested Host Take: ${brief.suggestedHostTake}`);
  lines.push(
    `Zabala Debate Stance: ${brief.argumentForHostA || ""}`,
    `Mulkey Debate Stance: ${brief.argumentForHostB || ""}`,
    `Key Grounded Facts: ${JSON.stringify(brief.keyFactsContext || [])}`,
    `On-Air Talking Points: ${JSON.stringify(brief.onAirTalkingPoints || [])}`,
    `Suggested Counter-arguments: ${JSON.stringify(brief.counterArguments || [])}`,
    `Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): []`,
    ``
  );
  return lines.join("\n");
}

async function generateAndScore(label: string, llm: LLMProvider, topicsPrompts: string, systemPrompt: string) {
  const start = Date.now();
  const out = await generateOutlineDrivenScript(llm, {
      speakerNames: ["Zabala", "Mulkey"],
    systemPrompt,
    episodeTitle: `Model A/B test (${label})`,
    topicsPrompts,
    targetDuration: 10,
    version: 1,
    temperature: 0.85, // ignored by models that reject sampling params
    maxTokens: 16000,
    log: (m) => console.log(`    [${label}] ${m}`),
  });
  const { segments } = dedupeScriptSegments(out.segments);
  normalizeLineIndexes(segments);
  const texts: string[] = [];
  for (const seg of segments) for (const l of seg.lines || []) texts.push(String(l.text || ""));
  const rep = findRepetitions(texts);
  const quality = scoreScriptQuality({ segments });
  const secs = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`    [${label}] ${texts.length} lines in ${secs}s, repetition ${(rep.repetitionRatio * 100).toFixed(1)}%, SCORE ${quality.total}/100`);
  return { segments, quality, rep, seconds: Number(secs) };
}

function costOf(side: Side, usage: { inputTokens: number; outputTokens: number }): { usd: number | null; note: string } {
  const p = priceFor(side.provider);
  if (!p) {
    return { usd: null, note: `unpriced — set LLM_PRICE_${side.provider.toUpperCase()}_IN/_OUT for an estimate` };
  }
  return {
    usd: (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000,
    note: "operator-configured rate",
  };
}

function money(c: { usd: number | null; note: string }): string {
  return c.usd === null ? `unpriced (${c.note})` : `$${c.usd.toFixed(3)} (${c.note})`;
}

async function main() {
  const sides = resolveSides();
  for (const side of [sides.prep, sides.a, sides.b]) {
    if (!providerCredentialPresent(side.provider)) {
      const k = side.key.toUpperCase();
      console.error(
        `Cannot run: the ${side.key} side is ${side.label} but no usable credential is set for '${side.provider}'.\n` +
          `Set it, or point this side elsewhere with AB_${k}_PROVIDER / AB_${k}_MODEL.`
      );
      process.exit(1);
    }
  }

  const personaPrompt = fs.readFileSync(path.join(__dirname, "fixtures", "livePersonaPrompt.txt"), "utf8");

  console.log("[1] Fetching REAL headlines...");
  const items = await fetchFeedItems();
  console.log(`    ${items.length} items. Sample: "${items[0]?.title}"`);

  console.log(`[2] Shared prep (${sides.prep.label} for BOTH sides): topics + enriched briefs...`);
  const prepLLM = getLLMProvider({ provider: sides.prep.provider, model: sides.prep.model });
  const topics = await pickTopics(prepLLM, items);
  topics.forEach((t, i) => console.log(`    ${i + 1}. ${t.title}`));
  const briefs: any[] = [];
  for (const t of topics) briefs.push(await buildEnrichedBrief(prepLLM, t, items));
  const topicsPrompts = topics.map((t, i) => topicPromptBlock(i, t, briefs[i])).join("\n---\n");
  topics.forEach((t, i) => {
    const talk = scoreTopicTalkability({ title: t.title, summary: t.summary, createdAt: new Date(), brief: briefs[i] });
    console.log(`    talkability "${t.title}": ${talk.total}/100`);
  });

  console.log("[3] Generating the SAME episode with both script models...");
  const aLLM = getLLMProvider({ provider: sides.a.provider, model: sides.a.model });
  const a = await generateAndScore(sides.a.label, aLLM, topicsPrompts, personaPrompt);

  const bLLM = getLLMProvider({ provider: sides.b.provider, model: sides.b.model });
  const b = await generateAndScore(sides.b.label, bLLM, topicsPrompts, personaPrompt);

  const aUsage = aLLM.getAccumulatedUsage!();
  const bUsage = bLLM.getAccumulatedUsage!();
  const aCost = costOf(sides.a, aUsage);
  const bCost = costOf(sides.b, bUsage);

  const w = Math.max(26, sides.a.label.length + 2);
  console.log("\n================= MODEL A/B RESULTS (same topics, same briefs, same engine) =================");
  console.log(`${"AXIS".padEnd(14)}${sides.a.label.padEnd(w)}${sides.b.label}`);
  for (const axis of Object.keys(a.quality.axes)) {
    const x = (a.quality.axes as any)[axis];
    const y = (b.quality.axes as any)[axis];
    console.log(`${axis.padEnd(14)}${`${x.score}/${x.max}`.padEnd(w)}${y.score}/${y.max}`);
  }
  console.log(`${"TOTAL".padEnd(14)}${`${a.quality.total}/100`.padEnd(w)}${b.quality.total}/100`);
  console.log(`${"repetition".padEnd(14)}${`${(a.rep.repetitionRatio * 100).toFixed(1)}%`.padEnd(w)}${(b.rep.repetitionRatio * 100).toFixed(1)}%`);
  console.log(`${"gen time".padEnd(14)}${`${a.seconds}s`.padEnd(w)}${b.seconds}s`);
  console.log(`${"tokens in/out".padEnd(14)}${`${aUsage.inputTokens}/${aUsage.outputTokens}`.padEnd(w)}${bUsage.inputTokens}/${bUsage.outputTokens}`);
  console.log(`${"script cost".padEnd(14)}${money(aCost).padEnd(w)}${money(bCost)}`);

  const outPath = path.join(process.cwd(), "samples", "model-ab-results.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    topics,
    prep: sides.prep.label,
    sideA: { label: sides.a.label, quality: a.quality, usage: aUsage, costUsd: aCost.usd, segments: a.segments },
    sideB: { label: sides.b.label, quality: b.quality, usage: bUsage, costUsd: bCost.usd, segments: b.segments },
  }, null, 2));
  console.log(`\nFull transcripts + scores: ${outPath}`);
}

main().catch((err) => {
  console.error("Model A/B failed:", err);
  process.exit(1);
});
