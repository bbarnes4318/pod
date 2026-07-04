// REAL-episode content-sourcing proof.
//
//   npx tsx src/scripts/testRealEpisode.ts
//
// Pulls TODAY'S real sports news from the app's configured RSS sources, then
// builds and scores TWO versions of the same episode:
//   BASELINE — briefs built only from headline + 250-char RSS summary
//              (what production briefs effectively worked from)
//   ENRICHED — full-article excerpts -> specificity-mandated rich briefs ->
//              talkability gate -> rich hand-off (the new engine)
// Both go through the identical outline-driven script engine and the same
// 0-100 rubric, so the delta is purely CONTENT SOURCING.
//
// Requires OPENAI_API_KEY (read from .env.coolify.local).

import fs from "fs";
import path from "path";
import { XMLParser } from "fast-xml-parser";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
process.env.LLM_PROVIDER = process.env.LLM_PROVIDER || "openai";

import { fetchArticleExcerpts } from "../lib/research/articleText";
import { scoreTopicTalkability } from "../lib/services/talkabilityService";
import { dedupeScriptSegments, normalizeLineIndexes, findRepetitions } from "../lib/services/scriptRepetition";
import { scoreScriptQuality } from "../lib/services/episodeQualityService";

const FEEDS = (process.env.NEWS_RSS_FEEDS ||
  "https://www.espn.com/espn/rss/news,https://www.cbssports.com/rss/headlines/")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

interface FeedItem {
  index: number;
  title: string;
  description: string;
  link: string;
  pubDate: string;
}

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

async function llmJson(systemPrompt: string, prompt: string, maxTokens = 8000, temperature = 0.6): Promise<any> {
  const { getScriptLLMProvider } = await import("../lib/providers/llm/factory");
  const llm = getScriptLLMProvider();
  return llm.generateStructuredOutput<any>({ prompt, systemPrompt, temperature, maxTokens });
}

async function pickTopics(items: FeedItem[]): Promise<any[]> {
  const listing = items
    .map((i) => `[${i.index}] ${i.title} — ${i.description || "(no summary)"} (${i.pubDate})`)
    .join("\n");
  const res = await llmJson(
    "You are the story editor for a two-host sports DEBATE podcast. You hunt for stories with conflict, stakes, surprise, and named people — not routine game recaps. Return valid JSON only.",
    `Today's real headlines:\n${listing}\n\nPick the 3 MOST DEBATE-WORTHY topics (distinct from each other, no near-duplicates). For each: {"title": "punchy debate-question title", "summary": "one paragraph: the tension and stakes", "sport": "...", "itemIndexes": [supporting item indexes, 1-4 of them]}\n\nReturn: { "topics": [ ... ] }`,
    6000,
    0.6
  );
  const topics = Array.isArray(res?.topics) ? res.topics.slice(0, 3) : [];
  if (topics.length === 0) throw new Error("Topic picker returned nothing.");
  return topics;
}

const BRIEF_SCHEMA = `{
  "mainAngle": "...", "whyMattersNow": "...",
  "keyFactsContext": [ { "text": "specific fact with numbers/names (quotes <= 20 words, attributed)", "evidenceRefs": [ { "type": "newsItem", "id": "news-<index>" } ], "confidence": "high" | "medium" } ],
  "onAirTalkingPoints": [ { "text": "...", "evidenceRefs": [ { "type": "newsItem", "id": "news-<index>" } ] } ],
  "counterArguments": [ { "host": "Max Voltage" | "Dr. Linebreak", "claim": "..." } ],
  "contrarianAngle": "...", "strongestDebateQuestion": "...", "suggestedHostTake": "...",
  "argumentForHostA": "...", "argumentForHostB": "...",
  "sourceIds": [ { "type": "newsItem", "id": "news-<index>" } ]
}`;

async function buildEnrichedBrief(topic: any, items: FeedItem[]): Promise<any> {
  const supporting = (topic.itemIndexes || []).map((i: number) => items[i]).filter(Boolean);
  const excerpts = await fetchArticleExcerpts(supporting.map((s: FeedItem) => s.link), {
    maxArticles: 3,
    maxCharsPerArticle: 2400,
  });
  const evidence = supporting
    .map((s: FeedItem, i: number) => {
      const ex = excerpts.find((e) => e.url === s.link);
      return `news-${s.index}: "${s.title}" (${s.pubDate})\nRSS summary: ${s.description}\nARTICLE TEXT:\n${ex?.ok ? ex.excerpt : "(fetch failed — use RSS summary only)"}`;
    })
    .join("\n\n---\n\n");
  console.log(`    enrichment: ${excerpts.filter((e) => e.ok).length}/${supporting.length} full articles fetched`);

  return llmJson(
    `You prepare fact-grounded debate briefs for a sports podcast. Use ONLY the supplied evidence. Mine the ARTICLE TEXT for exact numbers, dates, records, and who-said-what. Quotes at most 20 words, attributed, never longer verbatim passages. Every keyFactsContext item must carry a concrete number or named person. Surface CONFLICT and stakes. Aim for 8-12 keyFactsContext items. Return valid JSON only.`,
    `Topic: ${topic.title}\nSummary: ${topic.summary}\n\nEVIDENCE:\n${evidence}\n\nReturn JSON: ${BRIEF_SCHEMA}`,
    10000,
    0.4
  );
}

async function buildBaselineBrief(topic: any, items: FeedItem[]): Promise<any> {
  const supporting = (topic.itemIndexes || []).map((i: number) => items[i]).filter(Boolean);
  const evidence = supporting
    .map((s: FeedItem) => `news-${s.index}: "${s.title}" — ${s.description || "(no summary)"} (${s.pubDate})`)
    .join("\n");
  // Old-style thin brief: headline-level input, old flat schema.
  return llmJson(
    "You prepare debate briefs for a sports podcast from the supplied headlines. Use only supplied evidence. Return valid JSON only.",
    `Topic: ${topic.title}\nSummary: ${topic.summary}\n\nEVIDENCE (headlines):\n${evidence}\n\nReturn JSON: { "facts": [ { "text": "...", "evidenceRefs": [ { "type": "newsItem", "id": "news-<index>" } ] } ], "stats": [], "counterArguments": [ { "host": "...", "claim": "..." } ], "argumentForHostA": "...", "argumentForHostB": "...", "sourceIds": [ { "type": "newsItem", "id": "news-<index>" } ] }`,
    6000,
    0.4
  );
}

function topicPromptBlock(idx: number, topic: any, brief: any, rich: boolean): string {
  const lines = [``, `Topic #${idx + 1}: ${topic.title}`, `Sport/League: ${topic.sport || "N/A"}`];
  if (rich) {
    if (brief.mainAngle) lines.push(`Main Angle: ${brief.mainAngle}`);
    if (brief.whyMattersNow) lines.push(`Why It Matters RIGHT NOW: ${brief.whyMattersNow}`);
    if (brief.strongestDebateQuestion) lines.push(`Strongest Debate Question: ${brief.strongestDebateQuestion}`);
    if (brief.contrarianAngle) lines.push(`Contrarian Angle (use it): ${brief.contrarianAngle}`);
    if (brief.suggestedHostTake) lines.push(`Suggested Host Take: ${brief.suggestedHostTake}`);
  }
  lines.push(
    `Max Voltage Debate Stance: ${brief.argumentForHostA || ""}`,
    `Dr. Linebreak Debate Stance: ${brief.argumentForHostB || ""}`,
    `Key Grounded Facts: ${JSON.stringify(rich ? brief.keyFactsContext || [] : brief.facts || [])}`,
    `On-Air Talking Points: ${JSON.stringify(rich ? brief.onAirTalkingPoints || [] : brief.stats || [])}`,
    `Suggested Counter-arguments: ${JSON.stringify(brief.counterArguments || [])}`,
    `Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): []`,
    ``
  );
  return lines.join("\n");
}

async function generateAndScore(label: string, topicsPrompts: string, systemPrompt: string) {
  const { getScriptLLMProvider } = await import("../lib/providers/llm/factory");
  const { generateOutlineDrivenScript } = await import("../lib/services/scriptOutlineEngine");
  const llm = getScriptLLMProvider();
  const start = Date.now();
  const out = await generateOutlineDrivenScript(llm, {
    systemPrompt,
    episodeTitle: `Real-material test (${label})`,
    topicsPrompts,
    targetDuration: 10,
    version: 1,
    temperature: 0.85,
    maxTokens: 16000,
    log: (m) => console.log(`    [${label}] ${m}`),
  });
  const { segments } = dedupeScriptSegments(out.segments);
  normalizeLineIndexes(segments);
  const texts: string[] = [];
  for (const seg of segments) for (const l of seg.lines || []) texts.push(String(l.text || ""));
  const rep = findRepetitions(texts);
  const quality = scoreScriptQuality({ segments });
  console.log(`    [${label}] ${texts.length} lines in ${((Date.now() - start) / 1000).toFixed(0)}s, repetition ${(rep.repetitionRatio * 100).toFixed(1)}%, SCORE ${quality.total}/100`);
  return { segments, quality, rep };
}

async function main() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.length < 20) {
    console.error("No OPENAI_API_KEY available — cannot run the real-episode test.");
    process.exit(1);
  }
  const personaPrompt = fs.readFileSync(path.join(__dirname, "fixtures", "livePersonaPrompt.txt"), "utf8");

  console.log(`[1] Fetching REAL headlines from ${FEEDS.length} configured feeds...`);
  const items = await fetchFeedItems();
  console.log(`    ${items.length} items fetched. Sample: "${items[0]?.title}"`);
  if (items.length < 6) throw new Error("Too few feed items to build an episode.");

  console.log("[2] Story editor picking the most debate-worthy topics...");
  const topics = await pickTopics(items);
  topics.forEach((t, i) => console.log(`    ${i + 1}. ${t.title}`));
  const chosen = topics.slice(0, 2);

  console.log("[3] Building briefs — BASELINE (headline-only) vs ENRICHED (full-article)...");
  const baselineBriefs: any[] = [];
  const enrichedBriefs: any[] = [];
  for (const t of chosen) {
    baselineBriefs.push(await buildBaselineBrief(t, items));
    enrichedBriefs.push(await buildEnrichedBrief(t, items));
  }

  console.log("[4] Talkability (source-material quality) — the content gate's view:");
  const talkability = { baseline: [] as number[], enriched: [] as number[] };
  chosen.forEach((t, i) => {
    const bScore = scoreTopicTalkability({ title: t.title, summary: t.summary, createdAt: new Date(), brief: baselineBriefs[i] });
    const eScore = scoreTopicTalkability({ title: t.title, summary: t.summary, createdAt: new Date(), brief: enrichedBriefs[i] });
    talkability.baseline.push(bScore.total);
    talkability.enriched.push(eScore.total);
    console.log(`    "${t.title}"`);
    console.log(`      BASELINE ${bScore.total}/100 | ENRICHED ${eScore.total}/100 (specificity ${bScore.axes.specificity.score} -> ${eScore.axes.specificity.score})`);
  });

  const baselinePrompts = chosen.map((t, i) => topicPromptBlock(i, t, baselineBriefs[i], false)).join("\n---\n");
  const enrichedPrompts = chosen.map((t, i) => topicPromptBlock(i, t, enrichedBriefs[i], true)).join("\n---\n");

  console.log("[5] Generating BOTH episodes through the identical script engine...");
  const baseline = await generateAndScore("BASELINE", baselinePrompts, personaPrompt);
  const enriched = await generateAndScore("ENRICHED", enrichedPrompts, personaPrompt);

  console.log("\n================= REAL-EPISODE RESULTS =================");
  console.log(`Source talkability:  baseline avg ${Math.round(talkability.baseline.reduce((a, b) => a + b, 0) / talkability.baseline.length)} -> enriched avg ${Math.round(talkability.enriched.reduce((a, b) => a + b, 0) / talkability.enriched.length)}`);
  console.log(`\n${"AXIS".padEnd(14)}${"BASELINE".padEnd(12)}ENRICHED`);
  for (const axis of Object.keys(enriched.quality.axes)) {
    const b = (baseline.quality.axes as any)[axis];
    const e = (enriched.quality.axes as any)[axis];
    console.log(`${axis.padEnd(14)}${`${b.score}/${b.max}`.padEnd(12)}${e.score}/${e.max}`);
  }
  console.log(`${"TOTAL".padEnd(14)}${`${baseline.quality.total}/100`.padEnd(12)}${enriched.quality.total}/100`);
  console.log(`repetition     ${(baseline.rep.repetitionRatio * 100).toFixed(1)}%        ${(enriched.rep.repetitionRatio * 100).toFixed(1)}%`);

  const outPath = path.join(process.cwd(), "samples", "real-episode-script.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ topics: chosen, talkability, baseline: { quality: baseline.quality }, enriched: { quality: enriched.quality, segments: enriched.segments } }, null, 2)
  );
  console.log(`\nEnriched transcript + scores saved: ${outPath}`);
}

main().catch((err) => {
  console.error("Real-episode test failed:", err);
  process.exit(1);
});
