import { db } from "../db";
import { getScriptLLMProvider } from "../providers/llm/factory";
import {
  ALLOWED_AUDIO_TAGS,
  normalizeDelivery,
  sanitizeAudioTags,
  stripAudioTags,
} from "../audio/speechText";
import { dedupeScriptSegments, normalizeLineIndexes } from "./scriptRepetition";
import { scoreScriptQuality } from "./episodeQualityService";
import { generateOutlineDrivenScript } from "./scriptOutlineEngine";

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
}

// Rumor-sourcing language: banned on every line, factual or not.
const RUMOR_KEYWORDS = [
  "sources say",
  "rumored",
  "reportedly",
  "insider",
  "unnamed source",
];

// Hedging language: banned only on factual-claim lines. On opinion lines,
// "could be" / "might be" is normal spoken speculation and rejecting it
// forces unnatural declarative-only dialogue.
const PROHIBITED_KEYWORDS = [
  ...RUMOR_KEYWORDS,
  "expected to",
  "likely to",
  "could be",
  "might be",
];

const VALID_EVIDENCE_TYPES = [
  "game",
  "newsItem",
  "injury",
  "oddsSnapshot",
  "teamStat",
  "playerStat",
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

  // 3. Load Active Hosts Max Voltage & Dr. Linebreak
  const hostA = await db.aiHost.findFirst({ where: { name: "Max Voltage", isActive: true } });
  const hostB = await db.aiHost.findFirst({ where: { name: "Dr. Linebreak", isActive: true } });

  if (!hostA || !hostB) {
    const msg = "Active profiles for Max Voltage and Dr. Linebreak must exist and be active.";
    result.reasons.push(msg);
    throw new Error(msg);
  }

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

    return `
Topic #${idx + 1}: ${t.title}
Sport/League: ${t.sport} / ${t.leagueId || "N/A"}
Debate Score: ${t.debateScore}
Max Voltage Debate Stance: ${b.argumentForHostA}
Dr. Linebreak Debate Stance: ${b.argumentForHostB}
Key Grounded Facts: ${JSON.stringify(b.facts)}
Stats Evidence: ${JSON.stringify(b.stats)}
Injury Context: ${b.injuryContext || "None"}
Odds Context: ${b.oddsContext || "None"}
Suggested Counter-arguments: ${JSON.stringify(b.counterArguments)}
Unsafe Claims (DO NOT USE AS FACTS OR TRUTHS): ${JSON.stringify(unsafe)}
`;
  }).join("\n---\n");

  // 7. Formulate system and user prompts
  const systemPrompt = `You are the head writer for Take Machine, a two-host sports debate podcast. You write SPOKEN dialogue — words that will be performed out loud by voice actors, not read on a page. A listener must never suspect this show is scripted or synthetic.

Host 1: Max Voltage (ID: ${hostA.id})
- Role: ${hostA.role}
- Worldview: ${hostA.worldview}
- Speaking Style: ${hostA.speakingStyle}
- Catchphrases (use sparingly, max 2-3 per episode, never forced): ${JSON.stringify(hostA.catchphrases)}
- Likes: ${JSON.stringify(hostA.likes)}
- Dislikes: ${JSON.stringify(hostA.dislikes)}
- Argument Patterns: ${JSON.stringify(hostA.argumentPatterns)}
- Banned Phrases: ${JSON.stringify(hostA.bannedPhrases)}
- Intensity Level: ${hostA.intensityLevel}/10
- Verbal fingerprint: talks in bursts. Short sentences. Repeats words for emphasis ("He's done. DONE."). Starts sentences with "Listen," "No no no," "Are you kidding me?" Trails off when disgusted. Interrupts when he smells weakness.

Host 2: Dr. Linebreak (ID: ${hostB.id})
- Role: ${hostB.role}
- Worldview: ${hostB.worldview}
- Speaking Style: ${hostB.speakingStyle}
- Catchphrases (use sparingly, max 2-3 per episode, never forced): ${JSON.stringify(hostB.catchphrases)}
- Likes: ${JSON.stringify(hostB.likes)}
- Dislikes: ${JSON.stringify(hostB.dislikes)}
- Argument Patterns: ${JSON.stringify(hostB.argumentPatterns)}
- Banned Phrases: ${JSON.stringify(hostB.bannedPhrases)}
- Intensity Level: ${hostB.intensityLevel}/10
- Verbal fingerprint: longer, measured sentences with dry pauses. Weaponized politeness ("With respect, Max — no."). Lets Max burn out, then dissects. Occasionally amused despite himself. Never raises his voice; lowers it for the kill shot.

HOW REAL PODCAST SPEECH WORKS — follow all of these:
1. Contractions always: "he's", "don't", "that's", "would've". Nobody says "he is not clutch" out loud.
2. Backchannels and reactions: short lines like "Oh, come on.", "Wow.", "Sure, sure.", "That's— okay, fine." are GOOD lines. Use plenty of 2-6 word reaction lines between longer turns.
3. Interruptions: hosts cut each other off mid-thought. When a line is an interruption, set "isInterruption": true and have the PREVIOUS line end mid-sentence with "—" (em dash). 3-6 real interruptions per episode.
4. False starts and self-repair: "He was— look, the man played hurt." "I'm not saying— what I'm saying is..."
5. Filler where a human would breathe: "I mean", "look", "honestly", "right?", "you know what?" — sprinkled, not machine-gunned.
6. Callbacks: reference things said earlier in the episode ("There it is. The spreadsheet came out.", "You're still on the banner thing from earlier?").
7. Speaking numbers: say stats like a human — "he's shooting damn near fifty percent" not "his field goal percentage is 49.8%". Round numbers in speech; the exact figure lives in the evidence ref.
8. Vary rhythm: a heated exchange = rapid short lines. An analytical breakdown = one longer turn plus reactions. Never more than two long turns in a row.
9. Agreement happens: even rivals concede small points ("Fine. That one's real.") before pivoting. Constant disagreement sounds fake.
10. Tangents: one brief, natural 2-4 line tangent per episode (a memory, a joke, a jab) that gets pulled back with "Anyway—" or "Back to the point."

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
- Max swings; Doc counters. Max escalates emotionally; Doc deflates surgically. Doc wins on facts, Max wins on moments — neither wins outright.
- Each host concedes exactly ONE point per episode, grudgingly, and the other pounces on it.
- Max interrupts when he smells blood. Doc interrupts exactly once per episode, for a kill shot delivered quietly.
- Introduce ONE running gag in the cold open and call it back at least twice later — shorter each time.
- They know each other. Reference shared history ("You did this exact thing during the playoffs", "Here comes the folder").

SPECIFICITY OR DEATH:
- Every take must be anchored to a concrete number, name, or game from the assigned evidence. Vague takes are cut.
- Say numbers like a human: "damn near fifty percent", "thirty-one points", "lost five straight" — never read decimals aloud.
- BANNED FILLER (never say these): "at the end of the day", "it is what it is", "only time will tell", "one thing is for sure", "the numbers speak for themselves", "when it's all said and done", "love to see it", "at this point in time".

FORWARD MOTION ONLY:
- Every line must do at least one of: introduce NEW information, take a NEW angle, or genuinely react to the previous line.
- NEVER restate a stat, claim, take, or joke that has already been said — not even reworded. A callback is a jab of six words or fewer that references without repeating.
- The episode moves like an argument, not a list: stake → clash → concession or escalation → button, then ON to the next thing.

NEVER: "As an AI", referencing "the research brief", reading evidence like a report, announcing structure ("Now let's discuss topic two"), both hosts using the same phrasing, teleprompter-perfect grammar on every line.

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
          "speakerName": "Max Voltage" | "Dr. Linebreak",
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
- "pauseBefore": the gap the editor should leave before this line. "none" = jump in immediately (reactions, interruptions), "beat" = normal turn-taking (~0.3s), "breath" = thought pivot (~0.7s), "long" = dramatic beat (~1.2s, use rarely).
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
      log: (msg) => result.reasons.push(msg),
    });
  } catch (outlineErr: any) {
    console.warn(`[ScriptService] Outline-driven generation failed (${outlineErr.message}); falling back to single-shot.`);
    result.reasons.push(`Outline-driven generation failed; used single-shot fallback: ${outlineErr.message}`);
    try {
      llmResult = await llm.generateStructuredOutput<any>({
        prompt,
        systemPrompt,
        temperature,
        maxTokens,
      });
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
      if (line.speakerName !== "Max Voltage" && line.speakerName !== "Dr. Linebreak") {
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

      // Check factual claim strict rules
      if (line.isFactualClaim) {
        result.factualLineCount++;

        if (cleanEvidenceRefs.length === 0) {
          result.unsupportedClaimCount++;
          line.needsHumanReview = true;
        } else {
          result.factualLineWithEvidenceCount++;
        }

        // Prohibited keywords check - strictly reject factual lines containing these
        let hasProhibitedLanguage = false;
        for (const word of PROHIBITED_KEYWORDS) {
          if (textLower.includes(word)) {
            hasProhibitedLanguage = true;
            break;
          }
        }

        if (hasProhibitedLanguage) {
          result.unsupportedClaimCount++;
          result.rejectedLineCount++;
          unsupportedClaimsRemoved.push(line.text);
          continue; // Reject line
        }
      } else {
        // Non-factual lines: only reject rumor-sourcing language without refs.
        // Hedged opinions ("they could be in trouble") are legitimate speech.
        let hasProhibitedLanguage = false;
        for (const word of RUMOR_KEYWORDS) {
          if (textLower.includes(word)) {
            hasProhibitedLanguage = true;
            break;
          }
        }

        if (hasProhibitedLanguage && cleanEvidenceRefs.length === 0) {
          result.unsupportedClaimCount++;
          result.rejectedLineCount++;
          unsupportedClaimsRemoved.push(line.text);
          continue; // Reject line
        }
      }

      // Attach speakerHostId
      const speakerHostId = line.speakerName === "Max Voltage" ? hostA.id : hostB.id;

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
      if (line.speakerName === "Max Voltage") maxVoltageLinesCount++;
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
      if (line.speakerName === "Max Voltage") maxVoltageLinesCount++;
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

  // 11. Hard validations checks on final script structure
  if (totalLinesCount < 20) {
    const msg = `Validation failed: Total script lines are fewer than 20 (${totalLinesCount}).`;
    result.reasons.push(msg);
    throw new Error(msg);
  }

  const hostADistribution = maxVoltageLinesCount / totalLinesCount;
  const hostBDistribution = drLinebreakLinesCount / totalLinesCount;
  if (hostADistribution < 0.25 || hostBDistribution < 0.25) {
    const msg = `Validation failed: Hosts line distribution is unbalanced. Max Voltage: ${Math.round(hostADistribution * 100)}%, Dr. Linebreak: ${Math.round(hostBDistribution * 100)}%. Must be >= 25% for each.`;
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

  // Attach the 0-100 quality score so every script carries its own rubric.
  cleanContent.quality = scoreScriptQuality(cleanContent);
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
