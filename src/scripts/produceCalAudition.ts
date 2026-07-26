// Full-episode creative audition for Cal "Red Eye" Mercer.
//
//   npm run audition:cal
//
// Generates a complete ~10-minute episode through the ACTUAL production script
// engine — the same outline-driven generator, the same format prompt pieces, the
// same persona blocks, and the same continuity block that a real episode gets —
// and writes the transcript plus a listening-review worksheet.
//
// WHY THIS EXISTS SEPARATELY FROM THE TEST SUITE
//
// The deterministic quality scorer measures shape: causal turns, an unresolved
// opening, a position that moves, restraint. It cannot tell you whether Cal is
// BORING. A script can score well and still be a man calmly explaining process
// for ten minutes, and that failure is invisible to every automated check in
// this repository. So this produces an artifact a person has to read, with the
// twelve questions that decide whether the character works printed underneath.
//
// REQUIREMENTS: a live LLM key (ANTHROPIC_API_KEY). No database — the cast is
// built from the authored roster, so this runs anywhere the key does.
//
// The topic material below is FICTIONAL. Every club, person, and figure in it is
// invented, deliberately: the audition has to exercise the Red Eye topic gate,
// and using a real story to do that would invite the model to attach Cal's
// fictional history to real people.

import fs from "node:fs";
import path from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: path.join(process.cwd(), ".env.coolify.local") });
dotenv.config();

import { SEED_HOSTS } from "../lib/hosts/roster";
import { getShowFormat, DEFAULT_FORMAT_ID } from "../lib/formats/showFormatRegistry";
import { formatPromptPieces, castPersonaBlocks } from "../lib/formats/formatScriptPrompts";
import { generateOutlineDrivenScript } from "../lib/services/scriptOutlineEngine";
import {
  composeGenerationSystemPrompt,
  renderContinuityBlock,
} from "../lib/services/showContinuityService";
import { continuityOpportunities, EMPTY_CONTINUITY } from "../lib/services/showContinuity";
import { scoreScriptQuality } from "../lib/services/episodeQualityService";
import { getScriptLLMProvider } from "../lib/providers/llm/factory";

const TARGET_MINUTES = 10;

// --- Fictional evidence ----------------------------------------------------
//
// Shaped like a real research brief so the grounding rules bite exactly as they
// would in production, and chosen to sit squarely inside the Red Eye topic gate
// (a firing framed as a culture problem, with a leak attached).

const EVIDENCE_IDS = ["newsItem:n1", "newsItem:n2", "newsItem:n3", "teamStat:s1", "teamStat:s2"];

const TOPICS_PROMPT = `TOPIC 1 — Riverton Vale dismiss head coach Marcus Deane; club statement cites "a culture problem"
Summary: The Riverton Vale organization dismissed head coach Marcus Deane on Tuesday. Its twelve-paragraph statement did not mention the roster, and named two players — forwards Anton Sarr and Petr Molnar — as sources of "a culture problem" in the dressing room.
EVIDENCE (every figure a host states as fact must come from here, with its ref):
- [newsItem:n1] Riverton Vale's official statement on the dismissal of head coach Marcus Deane runs twelve paragraphs, does not use the word "roster", and names Anton Sarr and Petr Molnar as contributors to "a culture problem".
- [newsItem:n2] Anton Sarr and Petr Molnar both signed with Riverton Vale in February, eleven weeks before the dismissal.
- [newsItem:n3] Two people described as being inside the club, who were not named in the report, told a local outlet the dressing room had "split into camps" before February.
- [teamStat:s1] Riverton Vale's record after the February trade deadline was 4 wins and 19 losses.
- [teamStat:s2] Riverton Vale's record before the February trade deadline was 21 wins and 14 losses.

Zabala Debate Stance: The club wrote twelve paragraphs to avoid one sentence about who assembled the roster, and it picked the two cheapest names in the building to carry it.
Mercer Debate Stance: The decision that failed was made before February, and the statement is a room protecting the people who made it — which is not the same as those people being stupid.`;

async function main() {
  const outDir = path.join(process.cwd(), "artifacts");
  fs.mkdirSync(outDir, { recursive: true });

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. This audition calls the real script engine and cannot be faked;\n" +
        "set the key (or put it in .env.coolify.local) and re-run. Nothing was generated."
    );
    process.exit(1);
  }

  // The production cast, built from the authored roster rather than the
  // database, so this runs without a Postgres. Shapes match what
  // castPersonaBlocks reads.
  const cast = SEED_HOSTS.map((h, i) => ({ ...h, id: `audition-host-${i}` })) as never[];
  const format = getShowFormat(DEFAULT_FORMAT_ID)!;
  const pieces = formatPromptPieces(format, cast);

  // A show a few episodes in, with a Red Eye layer available: the topic is
  // squarely inside the gate, so this is the episode where the heaviest device
  // is on the table and the model still has to earn it.
  const state = { ...EMPTY_CONTINUITY, episodeCount: 5 };
  const opportunities = continuityOpportunities(state, { topicText: TOPICS_PROMPT });
  const continuityBlock = renderContinuityBlock(opportunities);

  const basePrompt = `You are the head writer for Take Machine, ${pieces.showDescriptor}. You write SPOKEN dialogue — words that will be performed out loud by voice actors, not read on a page. A listener must never suspect this show is scripted or synthetic.

${castPersonaBlocks(format, cast)}

${pieces.dynamicsContract}${pieces.extraSpeechRules}

GROUNDING — THE ONE UNBREAKABLE RULE:
- Every number, name, date, score, record, and statistic a host states as fact MUST come from the supplied evidence, and MUST carry its ref. If it is not in the evidence it does not exist.
- NEITHER HOST HAS INSIDE INFORMATION ABOUT THIS STORY. Cal's career history is fictional and composite; he may draw on how organizations behave, but he may not claim knowledge of what anyone in THIS story said, decided, or intended.
- Allowed typed evidence refs: ${EVIDENCE_IDS.join(", ")}
- Expected evidenceRefs structure: { "type": "newsItem" | "teamStat", "id": "n1" }`;

  const systemPrompt = composeGenerationSystemPrompt(basePrompt, continuityBlock);

  console.log(`Featured continuity device this episode: ${opportunities.featured}`);
  console.log(`Generating ~${TARGET_MINUTES} minutes through the production engine...\n`);

  const llm = getScriptLLMProvider();
  const result = await generateOutlineDrivenScript(llm, {
    systemPrompt,
    episodeTitle: "Twelve Paragraphs",
    topicsPrompts: TOPICS_PROMPT,
    targetDuration: TARGET_MINUTES,
    version: 1,
    temperature: Number(process.env.SCRIPT_GEN_TEMPERATURE) || 0.85,
    maxTokens: Number(process.env.SCRIPT_GEN_MAX_TOKENS) || 16000,
    speakerNames: SEED_HOSTS.map((h) => h.name),
    log: (msg) => console.log(`  ${msg}`),
  });

  const score = scoreScriptQuality(result);
  const lines = (result.segments || []).flatMap((s: { lines?: unknown[] }) => s.lines ?? []);
  const wordCount = lines.reduce(
    (n: number, l) => n + String((l as { text?: string }).text ?? "").split(/\s+/).filter(Boolean).length,
    0
  );

  const transcript = (result.segments || [])
    .map((seg: { type?: string; title?: string; lines?: { speakerName?: string; text?: string; energy?: string; pauseBefore?: string }[] }) => {
      const head = `\n### ${seg.type}${seg.title ? ` — ${seg.title}` : ""}\n`;
      const body = (seg.lines ?? [])
        .map((l) => `**${l.speakerName}:** ${l.text}  \n_(${l.energy} energy, ${l.pauseBefore} before)_`)
        .join("\n\n");
      return head + body;
    })
    .join("\n");

  const md = `# Cal Mercer — full-episode audition: "Twelve Paragraphs"

Generated by \`npm run audition:cal\` through the production script engine
(\`generateOutlineDrivenScript\`), with the real format prompt pieces, the real
persona blocks, and the real continuity block.

- Target: ~${TARGET_MINUTES} minutes. Written: **${wordCount} words** (~${Math.round(wordCount / 150)} min at Cal's pace).
- Featured continuity device: **${opportunities.featured}**${opportunities.featured === "redEye" ? ` (Red Eye layer ${opportunities.redEye.stage + 1} offered)` : ""}.
- Deterministic quality score: **${score.total}/100** — repetition ${score.axes.repetition.score}/25, specificity ${score.axes.specificity.score}/15, personality ${score.axes.personality.score}/15, flow ${score.axes.flow.score}/20, arc ${score.axes.arc.score}/15, delivery ${score.axes.delivery.score}/10.

> All topic material is FICTIONAL. No real club, person, or event appears in it.

---

## Listening review

**Do not approve the character on the score alone.** The scorer measures shape;
it cannot tell you whether he is boring. Answer all twelve, in writing, and
rewrite any scene whose answer is weak before approving.

1. What unanswered question exists in the first 20 seconds?
2. Why should the listener care?
3. Can a reader identify each host without speaker labels?
4. Where does the conversation materially change direction?
5. Does either host revise, concede, or complicate a position?
6. Is Cal compelling *without* telling a long story?
7. Is the Red Eye material earned, or artificially inserted?
8. Where is the funniest moment, and does it arise naturally?
9. Where is the most emotionally revealing moment?
10. Does the ending pay off the opening?
11. Which lines could be moved to another episode without anyone noticing?
12. Is there any point where Cal becomes sleepy, professorial, or generic?

### Hard rejects

- Cal shouts, or his angriest moment is his loudest.
- Cal answers more than one question with an anecdote.
- Any line asserts insider knowledge of this story.
- A confession arrives that the conversation did not walk into.
- Cal is only reacting to Zabala — he never sets the terms.

---

## Transcript
${transcript}

---

## Score detail

${Object.entries(score.axes)
  .map(([k, v]) => `- **${k}** ${v.score}/${v.max} — ${v.detail}`)
  .join("\n")}
`;

  const outFile = path.join(outDir, "cal-audition.md");
  fs.writeFileSync(outFile, md, "utf8");
  const jsonFile = path.join(outDir, "cal-audition.json");
  fs.writeFileSync(jsonFile, JSON.stringify(result, null, 2), "utf8");

  console.log(`\nScore: ${score.total}/100 (${wordCount} words)`);
  for (const [k, v] of Object.entries(score.axes)) console.log(`  ${k}: ${v.score}/${v.max} — ${v.detail}`);
  console.log(`\nWrote ${outFile}`);
  console.log(`Wrote ${jsonFile}`);
  console.log("\nREAD IT END TO END before approving. The score cannot tell you whether he is boring.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
