// Outline-driven progressive script generation.
//
// Phase A builds a beat-sheet where every beat and every fact is assigned
// ONCE. Phase B writes the script act by act; each act call receives the
// full outline, every claim already made, and the last exchange verbatim —
// so generation can only move forward. This is the architectural fix for
// content repetition: no chunk ever writes blind, and no fact or angle is
// ever handed to two different parts of the episode.

import { LLMProvider } from "../providers/llm/interface";
import { stripAudioTags } from "../audio/speechText";

export interface OutlineBeat {
  beatIndex: number;
  segmentType: "cold_open" | "intro" | "topic" | "transition" | "closing";
  title: string;
  goal: string;
  angle: string;
  topicId?: string;
  factRefs: { type: string; id: string }[];
  escalation?: string;
  callback?: string;
}

export interface OutlineDrivenArgs {
  systemPrompt: string;
  episodeTitle: string;
  topicsPrompts: string;
  targetDuration: number;
  version: number;
  temperature: number;
  maxTokens: number;
  log: (msg: string) => void;
}

export async function generateOutlineDrivenScript(
  llm: LLMProvider,
  args: OutlineDrivenArgs
): Promise<{ segments: any[] }> {
  const beats = await generateEpisodeOutline(llm, args);
  args.log(`Outline: ${beats.length} beats, each fact assigned once.`);

  // Group beats into acts of up to 4 beats
  const acts: OutlineBeat[][] = [];
  for (let i = 0; i < beats.length; i += 4) {
    acts.push(beats.slice(i, i + 4));
  }

  const totalLineTarget = Math.min(80, Math.max(40, Math.round(args.targetDuration * 4.5)));
  const rawSegments: any[] = [];
  const claimsSoFar: string[] = [];
  const lastLines: { speakerName: string; text: string }[] = [];
  let linesWritten = 0;

  for (let actIdx = 0; actIdx < acts.length; actIdx++) {
    const remainingActs = acts.length - actIdx;
    const linesTarget = Math.max(6, Math.ceil((totalLineTarget - linesWritten) / remainingActs));

    let actSegments: any[] | null = null;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        actSegments = await generateActSegments(llm, {
          systemPrompt: args.systemPrompt,
          episodeTitle: args.episodeTitle,
          topicsPrompts: args.topicsPrompts,
          beats,
          actBeats: acts[actIdx],
          actNumber: actIdx + 1,
          actCount: acts.length,
          claimsSoFar,
          lastLines,
          linesTarget,
          temperature: args.temperature,
          maxTokens: args.maxTokens,
        });
        break;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[ScriptOutline] Act ${actIdx + 1} attempt ${attempt} failed: ${err.message}`);
      }
    }
    if (!actSegments) {
      throw new Error(`Act ${actIdx + 1} generation failed twice: ${lastErr?.message}`);
    }

    // Update running memory from this act's output
    for (const seg of actSegments) {
      if (!seg || !Array.isArray(seg.lines)) continue;
      for (const line of seg.lines) {
        if (!line || typeof line.text !== "string") continue;
        linesWritten++;
        lastLines.push({ speakerName: line.speakerName, text: line.text });
        const spoken = stripAudioTags(line.text);
        if (line.isFactualClaim || spoken.length > 60) {
          claimsSoFar.push(spoken.slice(0, 140));
        }
      }
    }
    while (lastLines.length > 8) lastLines.shift();
    if (claimsSoFar.length > 60) claimsSoFar.splice(0, claimsSoFar.length - 60);

    rawSegments.push(...actSegments);
    args.log(
      `Act ${actIdx + 1}/${acts.length}: ${actSegments.reduce((n, s) => n + (s.lines?.length || 0), 0)} lines.`
    );
  }

  return { segments: rawSegments };
}

async function generateEpisodeOutline(llm: LLMProvider, args: OutlineDrivenArgs): Promise<OutlineBeat[]> {
  const prompt = [
    `You are the showrunner planning episode "${args.episodeTitle}" (target ${args.targetDuration} minutes).`,
    ``,
    `TOPICS & EVIDENCE:`,
    args.topicsPrompts,
    ``,
    `Build the episode beat sheet. Rules:`,
    `- 10 to 14 beats total. Beat 1 MUST be "cold_open" (start mid-argument on the single hottest take of the episode). Last beat MUST be "closing".`,
    `- Every topic is covered by 2-4 topic beats that ESCALATE: stake out -> clash -> concede-or-escalate -> button. A beat never re-covers ground from an earlier beat.`,
    `- Assign each evidence fact to AT MOST ONE beat via factRefs (use the ids from the evidence above). A fact is used once in the whole episode, period.`,
    `- Include exactly one short tangent beat (type "transition") that humanizes the hosts.`,
    `- Plan one running gag: introduce it in the cold_open beat's "callback" field, and note the 2 later beats that call it back.`,
    `- Every beat's "angle" must be a specific, surprising, arguable take — not a summary.`,
    ``,
    `Return valid JSON only:`,
    `{`,
    `  "beats": [`,
    `    {`,
    `      "beatIndex": 0,`,
    `      "segmentType": "cold_open" | "intro" | "topic" | "transition" | "closing",`,
    `      "title": "short beat title",`,
    `      "goal": "what this beat accomplishes in the argument arc",`,
    `      "angle": "the specific take/tension driving this beat",`,
    `      "topicId": "topic id if applicable",`,
    `      "factRefs": [ { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat", "id": "..." } ],`,
    `      "escalation": "how this beat raises stakes vs the previous one",`,
    `      "callback": "optional running-gag or callback note"`,
    `    }`,
    `  ]`,
    `}`,
  ].join("\n");

  const res = await llm.generateStructuredOutput<any>({
    prompt,
    systemPrompt: args.systemPrompt,
    temperature: Math.min(args.temperature, 0.7),
    maxTokens: Math.min(args.maxTokens, 8000),
  });

  const beats: OutlineBeat[] = Array.isArray(res?.beats) ? res.beats : [];
  if (beats.length < 6) {
    throw new Error(`Outline returned only ${beats.length} beats.`);
  }
  beats.forEach((b, i) => (b.beatIndex = i));
  if (beats[0].segmentType !== "cold_open") beats[0].segmentType = "cold_open";
  if (beats[beats.length - 1].segmentType !== "closing") beats[beats.length - 1].segmentType = "closing";

  // Enforce fact-used-once across beats
  const seenFacts = new Set<string>();
  for (const beat of beats) {
    beat.factRefs = (Array.isArray(beat.factRefs) ? beat.factRefs : []).filter((ref) => {
      if (!ref || !ref.type || !ref.id) return false;
      const key = `${ref.type}:${ref.id}`;
      if (seenFacts.has(key)) return false;
      seenFacts.add(key);
      return true;
    });
  }

  return beats;
}

interface ActArgs {
  systemPrompt: string;
  episodeTitle: string;
  topicsPrompts: string;
  beats: OutlineBeat[];
  actBeats: OutlineBeat[];
  actNumber: number;
  actCount: number;
  claimsSoFar: string[];
  lastLines: { speakerName: string; text: string }[];
  linesTarget: number;
  temperature: number;
  maxTokens: number;
}

async function generateActSegments(llm: LLMProvider, args: ActArgs): Promise<any[]> {
  const firstNow = args.actBeats[0]?.beatIndex ?? 0;
  const lastNow = firstNow + args.actBeats.length - 1;
  const outlineRecap = args.beats
    .map((b, i) => {
      const marker = i < firstNow ? "[DONE] " : i > lastNow ? "[LATER] " : ">>> NOW: ";
      return `${marker}${i + 1}. ${b.segmentType} — ${b.title} — ${b.angle}`;
    })
    .join("\n");

  const beatsDetail = args.actBeats
    .map((b) =>
      [
        `Beat ${b.beatIndex + 1} (${b.segmentType}) — ${b.title}`,
        `  Goal: ${b.goal}`,
        `  Angle: ${b.angle}`,
        `  Escalation: ${b.escalation || "n/a"}`,
        `  Callback note: ${b.callback || "n/a"}`,
        `  TopicId: ${b.topicId || "n/a"}`,
        `  Assigned facts (ONLY these may introduce new factual claims; each used once): ${JSON.stringify(b.factRefs)}`,
      ].join("\n")
    )
    .join("\n\n");

  const claimsBlock = args.claimsSoFar.length
    ? args.claimsSoFar.map((c) => `- ${c}`).join("\n")
    : "(nothing yet — this is the start of the episode)";

  const lastExchange = args.lastLines.length
    ? args.lastLines.map((l) => `${l.speakerName}: ${l.text}`).join("\n")
    : "(episode has not started — open cold, mid-argument, no greetings)";

  const prompt = [
    `You are writing ACT ${args.actNumber} of ${args.actCount} of "${args.episodeTitle}".`,
    ``,
    `FULL EPISODE OUTLINE (for orientation — write ONLY the ">>> NOW" beats):`,
    outlineRecap,
    ``,
    `BEATS TO WRITE NOW:`,
    beatsDetail,
    ``,
    `TOPIC EVIDENCE (reference for exact ids/values; use ONLY facts assigned to your beats above):`,
    args.topicsPrompts,
    ``,
    `ALREADY SAID — DO NOT RESTATE ANY OF THIS, NOT EVEN REWORDED (callbacks = six words or fewer, referencing without repeating):`,
    claimsBlock,
    ``,
    `THE LAST EXCHANGE (continue naturally mid-flow from here; no re-greetings, no recaps):`,
    lastExchange,
    ``,
    `Write about ${args.linesTarget} dialogue lines covering ONLY your beats, in order. Forward motion only.`,
    ``,
    `EVIDENCE DISCIPLINE (the fact-checker rejects violations):`,
    `- Every line that states a number, stat, record, contract detail, injury, or event as true MUST set "isFactualClaim": true AND carry that fact's ref from your beats' assigned facts in "evidenceRefs". No ref = the line gets flagged.`,
    `- Predictions, hot takes, and judgments are "isFactualClaim": false with empty evidenceRefs.`,
    ``,
    `Return valid JSON only:`,
    `{`,
    `  "segments": [`,
    `    {`,
    `      "type": "cold_open" | "intro" | "topic" | "transition" | "closing",`,
    `      "title": "Segment Title",`,
    `      "topicId": "optional",`,
    `      "lines": [`,
    `        {`,
    `          "lineIndex": 0,`,
    `          "speakerName": "Max Voltage" | "Dr. Linebreak",`,
    `          "text": "spoken text, optionally with inline audio tags like [laughs]",`,
    `          "tone": "heated | sarcastic | analytical | dismissive | amused | incredulous | conceding | excited | reflective | setup | transition",`,
    `          "energy": "low" | "medium" | "high",`,
    `          "pauseBefore": "none" | "beat" | "breath" | "long",`,
    `          "isInterruption": true | false,`,
    `          "evidenceRefs": [ { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat", "id": "..." } ],`,
    `          "isFactualClaim": true | false,`,
    `          "needsHumanReview": false`,
    `        }`,
    `      ]`,
    `    }`,
    `  ]`,
    `}`,
  ].join("\n");

  const res = await llm.generateStructuredOutput<any>({
    prompt,
    systemPrompt: args.systemPrompt,
    temperature: args.temperature,
    maxTokens: args.maxTokens,
  });

  const segments = Array.isArray(res?.segments) ? res.segments : [];
  const lineCount = segments.reduce(
    (n: number, s: any) => n + (Array.isArray(s?.lines) ? s.lines.length : 0),
    0
  );
  if (lineCount === 0) {
    throw new Error("Act returned zero lines.");
  }
  return segments;
}
