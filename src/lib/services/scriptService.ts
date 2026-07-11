import { db } from "../db";
import { getScriptLLMProvider, getFactCheckLLMProvider } from "../providers/llm/factory";
import { withLlmStage } from "../providers/llm/costLedger";
import { reviewFactualLinesForRewrite } from "./semanticReview";
import { collectReviewerEvidence, toEvidencePanel, evidenceFingerprint } from "./evidenceContext";
import {
  ALLOWED_AUDIO_TAGS,
  normalizeDelivery,
  sanitizeAudioTags,
  stripAudioTags,
} from "../audio/speechText";
import {
  capLongPauses,
  MAX_LONG_PAUSES_PER_EPISODE,
  MIN_LINES_BETWEEN_LONG_PAUSES,
} from "../audio/pauseTiming";
import { dedupeScriptSegments, normalizeLineIndexes } from "./scriptRepetition";
import { scoreScriptQuality } from "./episodeQualityService";
import { generateOutlineDrivenScript, rewriteLineForGrounding } from "./scriptOutlineEngine";
import { selfVerifyAndCorrect } from "./scriptSelfVerify";
import { scoreTopicTalkability } from "./talkabilityService";

export interface ScriptBuildInput {
  episodeId: string;
  forceRegenerate?: boolean;
  scriptStyle?: "heated-debate" | "balanced-analysis" | "sports-radio";
  targetDurationMinutes?: number;
  maxWords?: number;
}

export interface ScriptBuildResult {
  episodeId: string;
  insertedScriptCount: number;
  skippedCount: number;
  rejectedLineCount: number;
  factualLineCount: number;
  factualLineWithEvidenceCount: number;
  unsupportedClaimCount: number;
  unsafeClaimCount: number;
  invalidSpeakerCount: number;
  version: number;
  providerError?: string;
  reasons: string[];
  scriptId?: string;
  /** FIX 1 self-verify summary (how many ungrounded lines were corrected). */
  selfVerify?: import("./scriptSelfVerify").SelfVerifyReport;
  /** FIX 3 evidence-packet audit — how rich the facts actually are. */
  evidenceAudit?: {
    topicCount: number;
    distinctRefIds: number;
    totalFactTexts: number;
    factsWithNumbers: number;
    corpusChars: number;
    samples: string[];
  };
}

import { findRumorKeyword, isGenuineFactualAssertion, RUMOR_KEYWORDS } from "./claimLanguage";
import { resolveEpisodeHosts } from "./hostCasting";
import type { AiHost } from "@prisma/client";

const VALID_EVIDENCE_TYPES = [
  "game",
  "newsItem",
  "injury",
  "oddsSnapshot",
  "teamStat",
  "playerStat",
  "research",
];

export async function generateScriptForEpisode(input: ScriptBuildInput): Promise<ScriptBuildResult> {
  const result: ScriptBuildResult = {
    episodeId: input.episodeId,
    insertedScriptCount: 0,
    skippedCount: 0,
    rejectedLineCount: 0,
    factualLineCount: 0,
    factualLineWithEvidenceCount: 0,
    unsupportedClaimCount: 0,
    unsafeClaimCount: 0,
    invalidSpeakerCount: 0,
    version: 0,
    reasons: [],
  };

  const scriptStyle = input.scriptStyle || "heated-debate";
  const targetDuration = input.targetDurationMinutes || 12;
  const maxWords = input.maxWords || 2200;

  // 1. Load Episode and Validate
  const ep = await db.episode.findUnique({
    where: { id: input.episodeId },
    include: {
      topics: {
        include: {
          topic: {
            include: {
              researchBrief: true,
            },
          },
        },
        orderBy: {
          orderIndex: "asc",
        },
      },
    },
  });

  if (!ep) {
    const msg = `Episode with ID ${input.episodeId} not found.`;
    result.reasons.push(msg);
    throw new Error(msg);
  }

  if (ep.status !== "draft" && ep.status !== "script_draft") {
    const msg = `Script generation can only run for episodes in 'draft' or 'script_draft' status. Current status: ${ep.status}`;
    result.reasons.push(msg);
    throw new Error(msg);
  }

  if (ep.topics.length === 0) {
    const msg = `Episode has no topics linked.`;
    result.reasons.push(msg);
    throw new Error(msg);
  }

  // 2. Validate Topic and ResearchBrief quality
  for (const et of ep.topics) {
    const t = et.topic;
    if (t.status !== "used") {
      const msg = `Topic candidate '${t.title}' status is not 'used'.`;
      result.reasons.push(msg);
      throw new Error(msg);
    }

    const brief = t.researchBrief;
    if (!brief) {
      const msg = `Topic candidate '${t.title}' is missing its ResearchBrief.`;
      result.reasons.push(msg);
      throw new Error(msg);
    }

    const facts = Array.isArray(brief.facts) ? brief.facts : [];
    const sourceIds = Array.isArray(brief.sourceIds) ? brief.sourceIds : [];
    if (facts.length === 0 || sourceIds.length === 0) {
      const msg = `Topic candidate '${t.title}' has empty facts or sourceIds in ResearchBrief.`;
      result.reasons.push(msg);
      throw new Error(msg);
    }

    if (!brief.argumentForHostA?.trim() || !brief.argumentForHostB?.trim()) {
      const msg = `Topic candidate '${t.title}' is missing host arguments in ResearchBrief.`;
      result.reasons.push(msg);
      throw new Error(msg);
    }
  }

  // 2b. PRE-GENERATION CONTENT GATE — don't write a mediocre episode on weak
  // material. Score each topic's source richness; block (default) or warn
  // below threshold. A perfect pipeline on boring topics is still boring.
  const gateMode = (process.env.CONTENT_GATE_MODE || "block").toLowerCase();
  const gateMin = Number(process.env.CONTENT_GATE_MIN) || 50;
  const talkabilityReports = ep.topics.map((et) => {
    const report = scoreTopicTalkability({
      title: et.topic.title,
      summary: et.topic.summary,
      createdAt: et.topic.createdAt,
      brief: et.topic.researchBrief as any,
    });
    return { title: et.topic.title, report };
  });
  const avgTalkability =
    talkabilityReports.reduce((a, r) => a + r.report.total, 0) / Math.max(1, talkabilityReports.length);
  for (const tr of talkabilityReports) {
    result.reasons.push(
      `Talkability '${tr.title}': ${tr.report.total}/100 (${Object.entries(tr.report.axes)
        .map(([k, v]: [string, any]) => `${k} ${v.score}/${v.max}`)
        .join(", ")})`
    );
  }
  if (avgTalkability < gateMin) {
    const weakest = [...talkabilityReports].sort((a, b) => a.report.total - b.report.total)[0];
    const msg = `Content gate: source material scores ${Math.round(avgTalkability)}/100 talkability (minimum ${gateMin}). Weakest topic: '${weakest?.title}' at ${weakest?.report.total}. Enrich the research brief (regenerate it with the research provider configured) or pick stronger topics instead of generating a mediocre episode.`;
    result.reasons.push(msg);
    if (gateMode !== "warn") {
      throw new Error(msg);
    }
    console.warn(`[ScriptService] ${msg} (CONTENT_GATE_MODE=warn — proceeding)`);
  }

  // 3. Cast the hosts. The episode's saved hostIds (from its podcast config
  // or standalone build) win; the classic duo is the fallback. A debate
  // needs exactly two voices — a single selected host gets paired with the
  // best available sparring partner.
  const savedHostIds: string[] = Array.isArray((ep as any).hostIds) ? ((ep as any).hostIds as string[]) : [];
  if (savedHostIds.length > 2) {
    result.reasons.push(`Host casting: ${savedHostIds.length} hosts pinned; the debate format uses the first two.`);
  }
  let hostA: AiHost;
  let hostB: AiHost;
  try {
    ({ hostA, hostB } = await resolveEpisodeHosts({ hostIds: savedHostIds }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Two active host profiles are required to generate a debate script.";
    result.reasons.push(msg);
    throw new Error(msg);
  }
  result.reasons.push(`Host casting: ${hostA.name} vs ${hostB.name}${savedHostIds.length > 0 ? " (episode cast)" : " (default: most-intense active pair)"}.`);

  // Every host speaks through its own profile fields (worldview, speakingStyle,
  // catchphrases, argument patterns) — pulled dynamically from the AiHost record
  // below. No name-gated prompt logic: renaming a host never changes generation.

  // 4. Verify Versioning & Duplicate Check
  const existingScripts = await db.script.findMany({
    where: { episodeId: ep.id },
    orderBy: { version: "desc" },
  });

  if (existingScripts.length > 0 && !input.forceRegenerate) {
    result.skippedCount = 1;
    const msg = `A script already exists for this episode. Skipping generation.`;
    result.reasons.push(msg);
    return result;
  }

  const nextVersion = existingScripts.length > 0 ? existingScripts[0].version + 1 : 1;
  result.version = nextVersion;

  // 5. Guard against stub LLM provider
  if (process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER) {
    const msg = "LLM provider is stub. Real script generation disabled.";
    result.reasons.push(msg);
    throw new Error(msg);
  }

  // 6. Gather allowed evidence source refs & warnings
  const allowedSourceRefs = new Set<string>();
  const unsafeClaimsList: string[] = [];
  // The reviewer evidence corpus is built by the SHARED collectReviewerEvidence
  // so the generation-time self-verify reviewer and the fact-check gate reviewer
  // receive byte-identical evidence (see evidenceContext.ts).
  const { evidenceTexts, evidenceByRefId } = collectReviewerEvidence(
    ep.topics.map((et) => ({ researchBrief: et.topic.researchBrief }))
  );

  const topicsPrompts = ep.topics.map((et, idx) => {
    const t = et.topic;
    const b = t.researchBrief!;

    // Collect allowed sourceRefs
    const sourceIds = Array.isArray(b.sourceIds) ? (b.sourceIds as any[]) : [];
    for (const src of sourceIds) {
      if (src && typeof src === "object" && src.type && src.id) {
        allowedSourceRefs.add(`${src.type}:${src.id}`);
      }
    }

    // Collect unsafe claims to warn about
    const unsafe = Array.isArray(b.unsafeClaims) ? (b.unsafeClaims as any[]) : [];
    for (const uc of unsafe) {
      if (uc && typeof uc === "object" && uc.claim) {
        unsafeClaimsList.push(uc.claim);
      }
    }

    // Forward EVERYTHING the research pass produced. The rich editorial
    // fields (angle, talking points, contrarian take, debate question) are
    // the showrunner's ammunition — dropping them here was why real episodes
    // read thinner than the research warranted.
    const richBrief = b as any;
    const richLines: string[] = [
      ``,
      `Topic #${idx + 1}: ${t.title}`,
      `Sport/League: ${t.sport} / ${t.leagueId || "N/A"}`,
      `Debate Score: ${t.debateScore}`,
    ];
    if (richBrief.mainAngle) richLines.push(`Main Angle: ${richBrief.mainAngle}`);
    if (richBrief.whyMattersNow) richLines.push(`Why It Matters RIGHT NOW: ${richBrief.whyMattersNow}`);
    if (richBrief.strongestDebateQuestion) richLines.push(`Strongest Debate Question: ${richBrief.strongestDebateQuestion}`);
    if (richBrief.contrarianAngle) richLines.push(`Contrarian Angle (use it): ${richBrief.contrarianAngle}`);
    if (richBrief.suggestedHostTake) richLines.push(`Suggested Host Take: ${richBrief.suggestedHostTake}`);
    richLines.push(
      `${hostA.name} Debate Stance: ${b.argumentForHostA}`,
      `${hostB.name} Debate Stance: ${b.argumentForHostB}`,
      `Key Grounded Facts: ${JSON.stringify(
        Array.isArray(richBrief.keyFactsContext) && richBrief.keyFactsContext.length > 0
          ? richBrief.keyFactsContext
          : b.facts
      )}`,
      `On-Air Talking Points: ${JSON.stringify(
        Array.isArray(richBrief.onAirTalkingPoints) && richBrief.onAirTalkingPoints.length > 0
          ? richBrief.onAirTalkingPoints
          : b.stats
      )}`,
      `Injury Context: ${b.injuryContext || "None"}`,
      `Odds Context: ${b.oddsContext || "None"}`,
      `Suggested Counter-arguments: ${JSON.stringify(b.counterArguments)}`,
      `Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): ${JSON.stringify(unsafe)}`,
      ``
    );
    return richLines.join("\n");
  }).join("\n---\n");

  // FIX 3 — audit how rich the evidence packet actually is (reported, not acted
  // on here): a model asked to sustain a long argument off a handful of facts
  // will invent to fill space.
  const numberRe = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|thirty|forty|fifty|hundred|thousand)\b/i;
  result.evidenceAudit = {
    topicCount: ep.topics.length,
    distinctRefIds: evidenceByRefId.size,
    totalFactTexts: evidenceTexts.length,
    factsWithNumbers: evidenceTexts.filter((t) => numberRe.test(t)).length,
    corpusChars: evidenceTexts.join(" ").length,
    samples: evidenceTexts.slice(0, 80),
  };

  // 7. Formulate system and user prompts
  const systemPrompt = `You are the head writer for Take Machine, a two-host sports debate podcast. You write SPOKEN dialogue — words that will be performed out loud by voice actors, not read on a page. A listener must never suspect this show is scripted or synthetic.

Host 1: ${hostA.name} (ID: ${hostA.id})
- Role: ${hostA.role}
- Worldview: ${hostA.worldview}
- Speaking Style: ${hostA.speakingStyle}
- Catchphrases (use sparingly, max 2-3 per episode, never forced): ${JSON.stringify(hostA.catchphrases)}
- Likes: ${JSON.stringify(hostA.likes)}
- Dislikes: ${JSON.stringify(hostA.dislikes)}
- Argument Patterns: ${JSON.stringify(hostA.argumentPatterns)}
- Banned Phrases: ${JSON.stringify(hostA.bannedPhrases)}
- Intensity Level: ${hostA.intensityLevel}/10

Host 2: ${hostB.name} (ID: ${hostB.id})
- Role: ${hostB.role}
- Worldview: ${hostB.worldview}
- Speaking Style: ${hostB.speakingStyle}
- Catchphrases (use sparingly, max 2-3 per episode, never forced): ${JSON.stringify(hostB.catchphrases)}
- Likes: ${JSON.stringify(hostB.likes)}
- Dislikes: ${JSON.stringify(hostB.dislikes)}
- Argument Patterns: ${JSON.stringify(hostB.argumentPatterns)}
- Banned Phrases: ${JSON.stringify(hostB.bannedPhrases)}
- Intensity Level: ${hostB.intensityLevel}/10

HOW REAL PODCAST SPEECH WORKS — follow all of these:
1. Contractions always: "he's", "don't", "that's", "would've". Nobody says "he is not clutch" out loud.
2. Backchannels and reactions: short lines like "Oh, come on.", "Wow.", "Sure, sure.", "That's— okay, fine." are GOOD lines. Use plenty of 2-6 word reaction lines between longer turns.
3. Interruptions from conviction: hosts cut each other off mid-thought the moment they can't take what they're hearing — from EITHER chair, as often as the heat warrants (not on a quota). EVERY line with "isInterruption": true MUST have the PREVIOUS line end mid-sentence with a "—" (em dash); that em dash is how the audio engine overlaps the two voices, so an interruption whose previous line doesn't end in "—" is a defect. Aim for 4-8 real interruptions across the episode. Also jam in overlapping agreement ("Yeah, and—", "Right, right—") and reactive fragments ("Oh, come on.", "That's not—", "Wait, wait.") between the longer turns.
4. False starts and self-repair: "He was— look, the man played hurt." "I'm not saying— what I'm saying is..."
5. Filler where a human would breathe: "I mean", "look", "honestly", "right?", "you know what?" — sprinkled, not machine-gunned.
6. Callbacks: reference things said earlier in the episode ("There it is. The spreadsheet came out.", "You're still on the banner thing from earlier?").
7. Speaking numbers: say stats like a human — "he's shooting damn near fifty percent" not "his field goal percentage is 49.8%". Round numbers in speech; the exact figure lives in the evidence ref.
8. Vary rhythm and let a host BUILD: a heated exchange = rapid short lines, sometimes two or three IN A ROW from the same host as they pile on, self-correct, or talk themselves hotter ("And another thing—"). An analytical breakdown = one longer turn plus reactions. Don't hand the mic back after every single line — strict ping-pong is a robotic tell; it's good for one host to hold the floor for two or three consecutive lines when they're on a roll. Cap only genuinely LONG turns: never more than two long turns in a row.
9. Agreement happens: even rivals concede small points ("Fine. That one's real.") before pivoting — but only when genuinely cornered, never on a schedule. Constant disagreement sounds fake; so does a scheduled concession.
10. Tangents happen naturally: a host may veer for a beat — a memory, a grievance, a shot at the other — then snap back with "Anyway—" or "Back to the point." Don't force one and don't script it; let it fall out of the argument if it wants to.

AUDIO DELIVERY TAGS: you may place these inline in "text", in square brackets, where a performance cue belongs: ${JSON.stringify([...ALLOWED_AUDIO_TAGS])}.
Example: "text": "[laughs] Okay, okay. [sighs] Walk me through the math, professor."
Use 0-2 tags per line, only where a real person would actually laugh/sigh/whisper. Most lines need none. NEVER use sound-effect tags.

EPISODE SHAPE:
- cold_open: start mid-argument, in medias res, on the hottest take of the episode. No greetings, no "welcome to the show". Hook in the first five seconds.
- intro: THEN back off, quick show welcome with energy, banter beat, tease the topics in one breath each.
- topic segments: the meat. Real debate arcs: stake out positions -> clash -> concede/escalate -> land a button (a punchline or a hard disagreement to break on).
- transition: one or two lines, conversational ("Alright, next thing. And this one's gonna make you mad.").
- closing: wind down, lower energy, quick verdict recap from each host, one last jab, out.

CHEMISTRY CONTRACT (the engine of the show):
- BOTH hosts are true believers with their OWN agenda, and they collide. Each argues from their own Worldview and Argument Patterns above, each trying to WIN — neither is the straight man, neither merely reacts. ${hostB.name} drives just as hard as ${hostA.name}: he presses attacks, goes on the offensive, overreaches, and gets heated when his worldview is insulted — he can be wrong, and he does NOT just absorb ${hostA.name}'s swings and calmly deflate them. Give ${hostB.name} a stake he defends and pushes, drawn from his own worldview (a "the public is late, emotional, and wrong" markets host ATTACKS the emotional take on its own terms — he doesn't merely fact-check it from the sidelines).
- Escalation runs from EITHER chair: when a host's core belief gets attacked, THAT host escalates — heated, incredulous, raising their voice, pressing the attack. Both hosts spend time in the high-energy tones, not just one.
- Concessions are earned, not scheduled: a host concedes only when genuinely cornered, grudgingly, and the other pounces — but no one is required to concede, and stubbornly refusing to give up an obvious point is itself in character.
- They know each other. Reference shared history when it lands ("You did this exact thing during the playoffs").
- HUMOR IS ATTITUDE, NOT MATERIAL. The funny comes from the collision of the two worldviews — exasperation, exaggeration, a well-timed jab, mocking the other's framing, flatly refusing to concede something obvious. NO written setup/punchline jokes. NO pre-planned running gags and NO scheduled callbacks — a callback is allowed ONLY when it falls out naturally from something already said. Sports-radio funny is the delivery and the disdain, not a bit you insert on cue.

GROUNDING — THE ONE UNBREAKABLE RULE (this outranks every "be specific" instruction below):
- Every number, name, date, score, record, streak, salary, and statistic a host states as fact MUST come from the supplied evidence. If it is not in the evidence, it does not exist: do not say it, do not round it, do not inflate it, do not "remember" it, do not derive a new figure from it.
- When the evidence lacks a specific the argument wants, the host ARGUES WITHOUT IT. Conviction, memory, rhetoric, and qualitative claims are fully allowed — invented specifics are not. "They've been rotten since June" is great; "5-and-15 since June eighteenth" is fabrication unless that exact fact is supplied. "They've stunk for years" is great; "three straight 100-loss seasons" is fabrication unless it's supplied. A vivid unnumbered take always beats a made-up stat.
- NEVER inflate or embellish a real fact into a bigger one: if the evidence says three home runs, it's three — never "five", never "most since 2018". Exaggerating a supplied number IS fabrication and fails the fact check.
- BIND EVERY FIGURE TO ITS SUBJECT: a number belongs to whichever team/player the evidence attributes it to — never transplant it. If the evidence says the ORIOLES are 39-48 and nine games under .500, you may NOT say the YANKEES are 39-48 — that is a fabrication even though the figure is real. State each stat about the exact subject the evidence names, or don't state it.
- NAMED-PERSON ATTRIBUTION IS RADIOACTIVE (legal exposure, not just accuracy): you may NOT put words, quotes, thoughts, or specific actions on a real named person unless the evidence contains them. Never invent that "Boone pulled the pitcher", "Michael Kay said it's an awful stretch", or "the GM guaranteed a trade". You MAY reference a public figure generally ("Boone's bullpen management has been a talking point", "the manager's on the hot seat") — a general reference carries no invented quote or specific action. Fabricated attributions to named people fail the fact check as unsupported_attribution.

SPECIFICITY FROM EVIDENCE:
- A take lands hardest on a concrete number, name, or game you actually HAVE — reach for the supplied evidence first. But specificity must come FROM the evidence; a take you can't ground stays qualitative and convicted, it is NOT padded with an invented number and it is NOT cut.
- Say the numbers you DO have like a human: "damn near fifty percent", "thirty-one points", "lost five straight" — never read decimals aloud.
- BANNED FILLER (never say these): "at the end of the day", "it is what it is", "only time will tell", "one thing is for sure", "the numbers speak for themselves", "when it's all said and done", "love to see it", "at this point in time".

FORWARD MOTION ONLY:
- Every line must do at least one of: introduce NEW information, take a NEW angle, or genuinely react to the previous line.
- NEVER restate a stat, claim, take, or joke that has already been said — not even reworded. A callback is a jab of six words or fewer that references without repeating.
- The episode moves like an argument, not a list: stake → clash → concession or escalation → button, then ON to the next thing.

NEVER: "As an AI", referencing "the research brief", reading evidence like a report, announcing structure ("Now let's discuss topic two"), both hosts using the same phrasing, teleprompter-perfect grammar on every line.

FACT vs OPINION — the "isFactualClaim" field (get this right; the fact-checker now TRUSTS this flag and only checks lines set to true):
- "isFactualClaim": true ONLY when the line asserts a specific, checkable fact about the world: a stat, score, result, record, streak, date, injury, transaction, quote, or event presented as TRUE. Every such line MUST carry the matching evidenceRefs from the allowed list — a factual line with empty evidenceRefs is a defect.
- "isFactualClaim": false for everything that is NOT a checkable assertion: reactions ("Oh, come on.", "That's everything!"), rhetoric and rhetorical questions, insults, qualitative claims ("they've been terrible", "he's washed"), predictions, hot takes, hypotheticals, and judgments ("he's likely to win MVP", "worst signing of the summer"). These need NO evidenceRefs (attach one only when the take leans directly on an assigned fact).
- Setting isFactualClaim:true on a reaction/opinion, or false on a real stat, both break the fact-checker — classify by whether the line makes a SPECIFIC CHECKABLE ASSERTION, nothing else.
- If a line mixes a real stat with a take ("thirty-one a night, and he's still getting snubbed"), the stat makes it factual: isFactualClaim: true + the stat's evidence ref.
- NEVER attribute claims to reporting or anonymous sources — no "sources say", "reportedly", "rumored", "insiders", "unnamed source". Argue from the assigned evidence instead.

Allowed typed evidence refs: ${Array.from(allowedSourceRefs).join(", ")}
Expected evidenceRefs JSON structure for lines: { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat", "id": "abc123" }

Unsafe claims (DO NOT USE AS FACTS OR TRUTHS):
${unsafeClaimsList.map((c) => `- "${c}"`).join("\n")}
`;

  const prompt = `Write a complete debate script for the episode: "${ep.title}"
Style: ${scriptStyle}
Target Duration: ${targetDuration} minutes
Max Word Count: ${maxWords} words
IMPORTANT: You MUST generate at least 50 distinct back-and-forth dialogue lines across all segments to meet the target duration. Do not be overly brief.

Topics & Evidence:
${topicsPrompts}

Approximate segment timings structure:
1. Cold open (30-45s) - segment type "cold_open"
2. Intro (30s) - segment type "intro"
3. Topic debates in order (each 3-4 mins) - segment type "topic"
4. Transitions between topics - segment type "transition"
5. Closing (30-45s) - segment type "closing"

You MUST return valid JSON matching this schema:
{
  "episodeTitle": "...",
  "version": ${nextVersion},
  "estimatedDurationMinutes": ${targetDuration},
  "segments": [
    {
      "type": "cold_open" | "intro" | "topic" | "transition" | "closing",
      "title": "Segment Title",
      "topicId": "optional-topic-id-from-above",
      "lines": [
        {
          "lineIndex": 0,
          "speakerName": "${hostA.name}" | "${hostB.name}",
          "text": "spoken text here, optionally with inline audio tags like [laughs]",
          "tone": "heated | sarcastic | analytical | dismissive | amused | incredulous | conceding | excited | reflective | setup | transition",
          "energy": "low" | "medium" | "high",
          "pauseBefore": "none" | "beat" | "breath" | "long",
          "isInterruption": true | false,
          "evidenceRefs": [
            { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat", "id": "matching-source-id" }
          ],
          "isFactualClaim": true | false,
          "needsHumanReview": false
        }
      ]
    }
  ],
  "safety": {
    "unsupportedClaimsRemoved": [],
    "unsafeClaimsAvoided": [],
    "requiresHumanReview": true
  }
}

Delivery field meanings:
- "energy": how much vocal intensity this line is performed with. Vary it across the episode — an all-"high" episode is exhausting and fake.
- "pauseBefore": the gap the editor should leave before this line. "none" = jump in immediately (reactions, interruptions), "beat" = normal turn-taking (~0.3s), "breath" = thought pivot (~0.45s), "long" = dramatic beat (~0.6s). "long" is RARE by definition: at most 2-3 per episode, never two close together — the editor downgrades any excess to "breath".
- "isInterruption": true only when this line cuts the previous speaker off (previous line should end with "—").
`;

  // 8. Generate the script: outline-first, then act-by-act with running
  // memory. A single mega-call has no protection against the model circling
  // back over the same points; the outline assigns every beat and fact ONCE,
  // and each act call receives what has already been said so it can only
  // move forward. Falls back to single-shot generation if outlining fails.
  const llm = getScriptLLMProvider();
  const temperature = Number(process.env.SCRIPT_GEN_TEMPERATURE) || 0.85;
  const maxTokens = Number(process.env.SCRIPT_GEN_MAX_TOKENS) || 16000;
  let llmResult: any;

  try {
    llmResult = await generateOutlineDrivenScript(llm, {
      systemPrompt,
      episodeTitle: ep.title,
      topicsPrompts,
      targetDuration,
      version: nextVersion,
      temperature,
      maxTokens,
      speakerNames: [hostA.name, hostB.name],
      log: (msg) => result.reasons.push(msg),
    });
  } catch (outlineErr: any) {
    console.warn(`[ScriptService] Outline-driven generation failed (${outlineErr.message}); falling back to single-shot.`);
    result.reasons.push(`Outline-driven generation failed; used single-shot fallback: ${outlineErr.message}`);
    try {
      llmResult = await withLlmStage("script:single-shot-fallback", () =>
        llm.generateStructuredOutput<any>({
          prompt,
          systemPrompt,
          temperature,
          maxTokens,
        })
      );
    } catch (err: any) {
      result.providerError = err.message;
      const msg = `LLM call failed: ${err.message}`;
      result.reasons.push(msg);
      throw new Error(msg);
    }
  }

  // 9. Validation Loop
  if (!llmResult || typeof llmResult !== "object") {
    throw new Error("LLM did not return a valid object.");
  }

  if (!Array.isArray(llmResult.segments)) {
    throw new Error("Returned JSON is missing a 'segments' array.");
  }

  // FIX 1 — self-verify BEFORE persist, on WHICHEVER path produced the script
  // (outline OR single-shot fallback). Every factual line is run through the
  // same verifier the fact-check gate uses; each ungrounded figure/attribution
  // is sent back to the model to rewrite (correct figure, or qualitative
  // restatement) up to N times. Best-effort: a self-verify error never blocks
  // generation — the gate still catches anything left.
  try {
    // Semantic pass reviewer: reuse the gate reviewer (one batched call per
    // round) to catch subject-mismatch / over-precision the deterministic check
    // can't. Its own provider instance so we can meter its tokens.
    const reviewProvider = getFactCheckLLMProvider();
    const evidencePanelItems = toEvidencePanel(evidenceTexts);
    result.reasons.push(`Self-verify reviewer evidence: ${JSON.stringify(evidenceFingerprint(evidenceTexts))}.`);
    const usageOf = (p: any) =>
      typeof p?.getAccumulatedUsage === "function" ? p.getAccumulatedUsage() : { inputTokens: 0, outputTokens: 0, requestCount: 0 };
    const before = { llm: usageOf(llm), rev: usageOf(reviewProvider), t: Date.now() };

    const sv = await selfVerifyAndCorrect(llmResult.segments, {
      evidenceByRefId,
      fullEvidenceText: evidenceTexts.join("  "),
      hostNames: [hostA.name, hostB.name],
      maxAttempts: Number(process.env.SCRIPT_SELFVERIFY_MAX_ATTEMPTS) || 3,
      rewrite: (ctx) => rewriteLineForGrounding(llm, ctx, systemPrompt),
      maxSemanticRounds: Number(process.env.SCRIPT_SELFVERIFY_SEMANTIC_ROUNDS) || 2,
      semanticReview: (reviewLines) =>
        withLlmStage("script:selfverify-semantic", () =>
          reviewFactualLinesForRewrite(reviewProvider, {
            reviewLines,
            evidencePanelItems,
            unsafeClaims: unsafeClaimsList,
            rumorKeywords: RUMOR_KEYWORDS as unknown as string[],
          })
        ),
    });

    const after = { llm: usageOf(llm), rev: usageOf(reviewProvider) };
    sv.latencyMs = Date.now() - before.t;
    sv.tokensDelta = {
      inputTokens: after.llm.inputTokens - before.llm.inputTokens + (after.rev.inputTokens - before.rev.inputTokens),
      outputTokens: after.llm.outputTokens - before.llm.outputTokens + (after.rev.outputTokens - before.rev.outputTokens),
      requestCount: after.llm.requestCount - before.llm.requestCount + (after.rev.requestCount - before.rev.requestCount),
    };
    result.selfVerify = sv;
    result.reasons.push(
      `Self-verify: deterministic ${sv.linesCorrected}/${sv.linesWithViolations} corrected (${sv.linesUnresolved} unresolved); ` +
        `semantic ${sv.semantic.linesCorrected}/${sv.semantic.linesFlagged} corrected over ${sv.semantic.rounds} round(s) (${sv.semantic.linesUnresolved} unresolved); ` +
        `+${sv.latencyMs}ms, +${sv.tokensDelta.outputTokens} out / ${sv.tokensDelta.inputTokens} in tokens across ${sv.tokensDelta.requestCount} calls.`
    );
  } catch (svErr: any) {
    console.warn(`[ScriptService] self-verify failed: ${svErr?.message}`);
    result.reasons.push(`Self-verify skipped (error): ${svErr?.message}`);
  }

  const cleanSegments: any[] = [];
  let totalLinesCount = 0;
  let maxVoltageLinesCount = 0;
  let drLinebreakLinesCount = 0;

  const unsupportedClaimsRemoved: string[] = [];
  const unsafeClaimsAvoided: string[] = [];

  for (const segment of llmResult.segments) {
    if (!segment || typeof segment !== "object" || !Array.isArray(segment.lines)) {
      throw new Error(`Segment is missing a 'lines' array.`);
    }

    if (segment.lines.length === 0) {
      throw new Error(`Segment '${segment.title || ""}' has no lines.`);
    }

    const cleanLines: any[] = [];

    for (const line of segment.lines) {
      // Confirm structure
      if (
        line.speakerName === undefined ||
        line.text === undefined ||
        line.lineIndex === undefined ||
        line.tone === undefined ||
        line.isFactualClaim === undefined ||
        !Array.isArray(line.evidenceRefs)
      ) {
        throw new Error(`Line is missing required fields (speakerName, text, lineIndex, tone, isFactualClaim, or evidenceRefs).`);
      }

      // Check speakerName
      if (line.speakerName !== hostA.name && line.speakerName !== hostB.name) {
        result.invalidSpeakerCount++;
        result.rejectedLineCount++;
        continue; // Reject line
      }

      // Keep only whitelisted delivery tags, then run all content checks on
      // the tag-free text so a bracket tag can't split a banned phrase.
      const sanitizedText = sanitizeAudioTags(String(line.text));
      const spokenContent = stripAudioTags(sanitizedText);

      if (!spokenContent) {
        result.rejectedLineCount++;
        continue; // Tag-only or empty line
      }

      const textLower = spokenContent.toLowerCase();

      // Check unsafe claims check
      let isUnsafe = false;
      for (const uc of unsafeClaimsList) {
        if (textLower.includes(uc.toLowerCase())) {
          isUnsafe = true;
          unsafeClaimsAvoided.push(line.text);
          break;
        }
      }

      if (isUnsafe) {
        result.unsafeClaimCount++;
        result.rejectedLineCount++;
        continue; // Reject line
      }

      // Clean evidenceRefs for every single line
      const cleanEvidenceRefs = (line.evidenceRefs || [])
        .filter((ref: any) => {
          if (!ref || typeof ref !== "object" || !ref.type || !ref.id) return false;
          if (!VALID_EVIDENCE_TYPES.includes(ref.type)) return false;
          return allowedSourceRefs.has(`${ref.type}:${ref.id}`);
        })
        .map((ref: any) => ({
          type: ref.type,
          id: ref.id,
        }));

      // Fact vs opinion: hold only genuine factual assertions to the
      // evidence bar. A ref-less line in clear opinion/prediction framing is
      // opinion even if the model marked it isFactualClaim — hot takes are
      // the format. Speculative hedging never rejects a line; only
      // fabricated-sourcing language does.
      const genuineFactual = isGenuineFactualAssertion(
        { isFactualClaim: line.isFactualClaim, evidenceRefs: cleanEvidenceRefs },
        textLower
      );

      if (genuineFactual) {
        result.factualLineCount++;

        if (cleanEvidenceRefs.length === 0) {
          result.unsupportedClaimCount++;
          line.needsHumanReview = true;
        } else {
          result.factualLineWithEvidenceCount++;
        }

        // Fabricated sourcing stated as fact: reject the line outright.
        if (findRumorKeyword(textLower)) {
          result.unsupportedClaimCount++;
          result.rejectedLineCount++;
          unsupportedClaimsRemoved.push(line.text);
          continue; // Reject line
        }
      } else {
        // Opinion/non-factual lines: only reject rumor-sourcing language
        // without refs. Hedged opinions ("they could be in trouble") are
        // legitimate speech.
        if (findRumorKeyword(textLower) && cleanEvidenceRefs.length === 0) {
          result.unsupportedClaimCount++;
          result.rejectedLineCount++;
          unsupportedClaimsRemoved.push(line.text);
          continue; // Reject line
        }
      }

      // Attach speakerHostId
      const speakerHostId = line.speakerName === hostA.name ? hostA.id : hostB.id;

      const delivery = normalizeDelivery(line);

      // Add to clean lines (saving only cleanEvidenceRefs)
      cleanLines.push({
        lineIndex: line.lineIndex,
        speakerHostId,
        speakerName: line.speakerName,
        text: sanitizedText,
        tone: line.tone,
        energy: delivery.energy,
        pauseBefore: delivery.pauseBefore,
        isInterruption: delivery.isInterruption,
        evidenceRefs: cleanEvidenceRefs,
        isFactualClaim: line.isFactualClaim,
        needsHumanReview: line.needsHumanReview || false,
      });

      // Track distribution
      if (line.speakerName === hostA.name) maxVoltageLinesCount++;
      else drLinebreakLinesCount++;
      totalLinesCount++;
    }

    if (cleanLines.length > 0) {
      cleanSegments.push({
        type: segment.type,
        title: segment.title,
        topicId: segment.topicId,
        lines: cleanLines,
      });
    }
  }

  // 10b. HARD ANTI-REPETITION GATE — drop any line that substantially
  // repeats earlier content (trigram similarity), then re-count.
  const dedup = dedupeScriptSegments(cleanSegments);
  const finalSegments = dedup.segments;
  result.rejectedLineCount += dedup.removedCount;

  if (dedup.report.repetitionRatio > 0.35) {
    const msg = `Validation failed: model output was degenerate — ${dedup.removedCount} of ${dedup.report.totalLines} lines (${Math.round(dedup.report.repetitionRatio * 100)}%) repeated earlier content.`;
    result.reasons.push(msg);
    throw new Error(msg);
  }
  if (dedup.removedCount > 0) {
    result.reasons.push(`Repetition gate removed ${dedup.removedCount} near-duplicate line(s) (${Math.round(dedup.report.repetitionRatio * 100)}% of output).`);
  }

  // Recompute counts from the deduplicated script
  totalLinesCount = 0;
  maxVoltageLinesCount = 0;
  drLinebreakLinesCount = 0;
  for (const seg of finalSegments) {
    for (const line of seg.lines) {
      if (line.speakerName === hostA.name) maxVoltageLinesCount++;
      else drLinebreakLinesCount++;
      totalLinesCount++;
    }
  }

  // 10c. GLOBAL LINE NUMBERING — never trust the model's lineIndex values.
  // Models restart numbering per segment; AudioSegments are keyed by
  // (scriptId, lineIndex), and colliding indexes cause ONE audio clip to be
  // stitched in for every colliding line — i.e. the same sentence repeated
  // dozens of times in the final episode. Assign a unique global index here.
  const { hadCollisions } = normalizeLineIndexes(finalSegments);
  if (hadCollisions) {
    result.reasons.push("Normalized non-unique lineIndex numbering from the model (audio-repetition guard).");
  }

  // 10d. INTERRUPTION CUE GUARD — every isInterruption line needs the PREVIOUS
  // line to end mid-sentence with "—" or the renderer's overlap mis-fires
  // (planConversationTimeline keys the negative-gap overlap off the flag, and
  // the em dash is what sells the cut-off in the text/TTS). Walk the whole
  // script in order and repair any interruption whose predecessor doesn't end
  // in an em dash; drop the flag on the very first line (nothing to cut into).
  {
    const flat: any[] = [];
    for (const seg of finalSegments) for (const l of seg.lines) flat.push(l);
    let repaired = 0;
    for (let i = 0; i < flat.length; i++) {
      if (flat[i].isInterruption !== true) continue;
      if (i === 0) { flat[i].isInterruption = false; continue; }
      const prev = flat[i - 1];
      const prevText = sanitizeAudioTags(String(prev.text));
      if (!/[—–-]\s*$/.test(stripAudioTags(prevText))) {
        // End the predecessor mid-sentence: strip any trailing terminal
        // punctuation/whitespace, then append the em dash.
        prev.text = prevText.replace(/[\s.?!,;:]+$/u, "") + "—";
        repaired++;
      }
    }
    if (repaired > 0) {
      result.reasons.push(`Interruption cue guard: appended "—" to ${repaired} predecessor line(s) so every isInterruption overlaps correctly.`);
    }
  }

  // 10e. LONG-PAUSE BUDGET — a dramatic beat is rare by definition, but models
  // overuse "long" (v10 shipped enough of them to read as dead air). Enforce
  // the budget structurally: at most MAX_LONG_PAUSES_PER_EPISODE per script,
  // never two within MIN_LINES_BETWEEN_LONG_PAUSES lines; excess downgrades
  // to "breath".
  {
    const flat: any[] = [];
    for (const seg of finalSegments) for (const l of seg.lines) flat.push(l);
    const capped = capLongPauses(flat);
    if (capped.downgraded > 0) {
      result.reasons.push(
        `Long-pause budget: downgraded ${capped.downgraded} excess "long" pause(s) to "breath" (kept ${capped.kept}, max ${MAX_LONG_PAUSES_PER_EPISODE}, min spacing ${MIN_LINES_BETWEEN_LONG_PAUSES} lines).`
      );
    }
  }

  // 11. Hard validations checks on final script structure
  if (totalLinesCount < 20) {
    const msg = `Validation failed: Total script lines are fewer than 20 (${totalLinesCount}).`;
    result.reasons.push(msg);
    throw new Error(msg);
  }

  const hostADistribution = maxVoltageLinesCount / totalLinesCount;
  const hostBDistribution = drLinebreakLinesCount / totalLinesCount;
  // Loosened from 25% to 20% so natural runs (a host holding the floor for two
  // or three consecutive lines) don't trip the balance gate — a two-hander can
  // legitimately run 80/20 across an episode without one host disappearing.
  if (hostADistribution < 0.2 || hostBDistribution < 0.2) {
    const msg = `Validation failed: Hosts line distribution is unbalanced. ${hostA.name}: ${Math.round(hostADistribution * 100)}%, ${hostB.name}: ${Math.round(hostBDistribution * 100)}%. Must be >= 20% for each.`;
    result.reasons.push(msg);
    throw new Error(msg);
  }

  if (result.factualLineCount > 0) {
    const factualSuccessRate = result.factualLineWithEvidenceCount / result.factualLineCount;
    if (factualSuccessRate < 0.7) {
      const msg = `Validation warning: Fewer than 70% of original factual lines had valid evidence references. Success Rate: ${Math.round(factualSuccessRate * 100)}% (${result.factualLineWithEvidenceCount}/${result.factualLineCount})`;
      result.reasons.push(msg);
    }
  }

  // Build clean JSON schema content object
  const cleanContent: any = {
    episodeTitle: ep.title,
    version: nextVersion,
    estimatedDurationMinutes: targetDuration,
    segments: finalSegments,
    safety: {
      unsupportedClaimsRemoved,
      unsafeClaimsAvoided,
      repetitionRemovedCount: dedup.removedCount,
      repetitionRatio: Number(dedup.report.repetitionRatio.toFixed(4)),
      requiresHumanReview: true,
    },
  };

  // Attach the 0-100 quality score so every script carries its own rubric,
  // plus the source-material talkability that fed it (for regression tracking).
  cleanContent.quality = scoreScriptQuality(cleanContent);
  cleanContent.sourceTalkability = {
    average: Math.round(avgTalkability),
    topics: talkabilityReports.map((t) => ({ title: t.title, total: t.report.total })),
  };
  result.reasons.push(
    `Quality score: ${cleanContent.quality.total}/100 (${Object.entries(cleanContent.quality.axes)
      .map(([k, v]: [string, any]) => `${k} ${v.score}/${v.max}`)
      .join(", ")})`
  );

  // 12. Build PlainText from validated JSON content ONLY
  const plainText = finalSegments
    .map((seg) => {
      const label = `[${seg.type.toUpperCase()}${seg.title ? ` — ${seg.title}` : ""}]`;
      const dialogue = seg.lines
        .map((line: any) => `${line.speakerName}:\n${stripAudioTags(line.text)}`)
        .join("\n\n");
      return `${label}\n\n${dialogue}`;
    })
    .join("\n\n");

  if (!plainText.trim()) {
    const msg = "Validation failed: Generated plainText is empty.";
    result.reasons.push(msg);
    throw new Error(msg);
  }

  // 13. Save atomically in a Prisma Transaction
  const savedScript = await db.$transaction(async (tx) => {
    // Create Script
    const script = await tx.script.create({
      data: {
        episodeId: ep.id,
        version: nextVersion,
        content: cleanContent as any,
        plainText,
        status: "draft",
      },
    });

    // Update Episode status to script_draft
    await tx.episode.update({
      where: { id: ep.id },
      data: { status: "script_draft" },
    });

    return script;
  });

  result.insertedScriptCount = 1;
  result.scriptId = savedScript.id;
  result.reasons.push(`Script version ${nextVersion} generated and saved successfully.`);

  return result;
}
