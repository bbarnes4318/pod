// Script-model A/B: gpt-5.5 vs claude-opus-4-8 on the SAME episode.
//
//   npx tsx src/scripts/testModelAB.ts
//
// Real RSS stories are fetched once, topics picked once, enriched briefs
// built once (all with gpt-5.5, so the source material is identical), then
// the identical outline-driven script engine runs twice — once per script
// model. Both scripts are scored with the same rubric, and per-side token
// usage/cost is reported.
//
// Requires OPENAI_API_KEY and ANTHROPIC_API_KEY (read from .env.coolify.local).

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
import { LLMProvider } from "../lib/providers/llm/interface";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";

const FEEDS = (process.env.NEWS_RSS_FEEDS ||
  "https://www.espn.com/espn/rss/news,https://www.cbssports.com/rss/headlines/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// $/1M tokens. Opus 4.8 prices are Anthropic's published rates.
// gpt-5.5 rates are an assumption — override via env if yours differ.
const PRICES: Record<string, { in: number; out: number; note: string }> = {
  "claude-opus-4-8": { in: 5, out: 25, note: "published" },
  "gpt-5.5": {
    in: Number(process.env.GPT55_PRICE_IN) || 1.25,
    out: Number(process.env.GPT55_PRICE_OUT) || 10,
    note: process.env.GPT55_PRICE_IN ? "env-configured" : "assumed — set GPT55_PRICE_IN/OUT to correct",
  },
};

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
    prompt: `Topic: ${topic.title}\nSummary: ${topic.summary}\n\nEVIDENCE:\n${evidence}\n\nReturn JSON: { "mainAngle": "...", "whyMattersNow": "...", "keyFactsContext": [ { "text": "...", "evidenceRefs": [ { "type": "newsItem", "id": "news-<index>" } ], "confidence": "high" } ], "onAirTalkingPoints": [ { "text": "...", "evidenceRefs": [] } ], "counterArguments": [ { "host": "Max Voltage" | "Dr. Linebreak", "claim": "..." } ], "contrarianAngle": "...", "strongestDebateQuestion": "...", "suggestedHostTake": "...", "argumentForHostA": "...", "argumentForHostB": "...", "sourceIds": [ { "type": "newsItem", "id": "news-<index>" } ] }`,
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
    `Max Voltage Debate Stance: ${brief.argumentForHostA || ""}`,
    `Dr. Linebreak Debate Stance: ${brief.argumentForHostB || ""}`,
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
      speakerNames: ["Max Voltage", "Dr. Linebreak"],
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

function costOf(model: string, usage: { inputTokens: number; outputTokens: number }): { usd: number; note: string } {
  const p = PRICES[model] || { in: 0, out: 0, note: "unknown model — tokens only" };
  return { usd: (usage.inputTokens * p.in + usage.outputTokens * p.out) / 1_000_000, note: p.note };
}

async function main() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length < 20) {
    console.error("OPENAI_API_KEY missing — cannot run the A/B.");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.length < 20) {
    console.error("ANTHROPIC_API_KEY missing — cannot run the Opus side. Set it in .env.coolify.local and re-run.");
    process.exit(1);
  }

  const personaPrompt = fs.readFileSync(path.join(__dirname, "fixtures", "livePersonaPrompt.txt"), "utf8");

  console.log("[1] Fetching REAL headlines...");
  const items = await fetchFeedItems();
  console.log(`    ${items.length} items. Sample: "${items[0]?.title}"`);

  console.log("[2] Shared prep (gpt-5.5 for both sides): topics + enriched briefs...");
  const prepLLM = getLLMProvider({ provider: "openai", model: "gpt-5.5" });
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
  const gptLLM = getLLMProvider({ provider: "openai", model: "gpt-5.5" });
  const gpt = await generateAndScore("gpt-5.5", gptLLM, topicsPrompts, personaPrompt);

  const opusLLM = getLLMProvider({ provider: "anthropic", model: "claude-opus-4-8" });
  const opus = await generateAndScore("opus-4.8", opusLLM, topicsPrompts, personaPrompt);

  const gptUsage = gptLLM.getAccumulatedUsage!();
  const opusUsage = opusLLM.getAccumulatedUsage!();
  const gptCost = costOf("gpt-5.5", gptUsage);
  const opusCost = costOf("claude-opus-4-8", opusUsage);

  console.log("\n================= MODEL A/B RESULTS (same topics, same briefs, same engine) =================");
  console.log(`${"AXIS".padEnd(14)}${"gpt-5.5".padEnd(12)}claude-opus-4-8`);
  for (const axis of Object.keys(opus.quality.axes)) {
    const g = (gpt.quality.axes as any)[axis];
    const o = (opus.quality.axes as any)[axis];
    console.log(`${axis.padEnd(14)}${`${g.score}/${g.max}`.padEnd(12)}${o.score}/${o.max}`);
  }
  console.log(`${"TOTAL".padEnd(14)}${`${gpt.quality.total}/100`.padEnd(12)}${opus.quality.total}/100`);
  console.log(`${"repetition".padEnd(14)}${`${(gpt.rep.repetitionRatio * 100).toFixed(1)}%`.padEnd(12)}${(opus.rep.repetitionRatio * 100).toFixed(1)}%`);
  console.log(`${"gen time".padEnd(14)}${`${gpt.seconds}s`.padEnd(12)}${opus.seconds}s`);
  console.log(`${"tokens in/out".padEnd(14)}${`${gptUsage.inputTokens}/${gptUsage.outputTokens}`.padEnd(12)}${opusUsage.inputTokens}/${opusUsage.outputTokens}`);
  console.log(`${"script cost".padEnd(14)}${`$${gptCost.usd.toFixed(3)} (${gptCost.note})`.padEnd(24)}$${opusCost.usd.toFixed(3)} (${opusCost.note})`);

  const outPath = path.join(process.cwd(), "samples", "model-ab-results.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    topics,
    gpt55: { quality: gpt.quality, usage: gptUsage, costUsd: gptCost.usd, segments: gpt.segments },
    opus48: { quality: opus.quality, usage: opusUsage, costUsd: opusCost.usd, segments: opus.segments },
  }, null, 2));
  console.log(`\nFull transcripts + scores: ${outPath}`);
}

main().catch((err) => {
  console.error("Model A/B failed:", err);
  process.exit(1);
});
