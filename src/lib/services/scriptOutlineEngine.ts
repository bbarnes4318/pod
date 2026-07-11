// Outline-driven progressive script generation.
//
// Phase A builds a beat-sheet where every beat and every fact is assigned
// ONCE. Phase B writes the script act by act; each act call receives the
// full outline, every claim already made, and the last exchange verbatim —
// so generation can only move forward. This is the architectural fix for
// content repetition: no chunk ever writes blind, and no fact or angle is
// ever handed to two different parts of the episode.

import { LLMProvider } from "../providers/llm/interface";
import { withLlmStage } from "../providers/llm/costLedger";
import { stripAudioTags } from "../audio/speechText";
import { RewriteContext } from "./scriptSelfVerify";

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
  /** The two cast host names — the only valid speakerName values. */
  speakerNames: string[];
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
          speakerNames: args.speakerNames,
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

  // Self-verify (FIX 1) runs in scriptService AFTER generation, on whichever
  // path produced the script (outline OR single-shot fallback), so a transient
  // outline parse-failure never skips grounding.
  return { segments: rawSegments };
}

/** Ask the model to rewrite ALL flagged ungrounded lines in ONE batched call:
 *  use the correct figure from evidence, or restate the point qualitatively
 *  (the "argue without it" valve). Keeps each line's speaker, tone, and
 *  conversational feel; adds no new fabrication. One call replaces the old
 *  per-line loop (N calls); very large batches are chunked defensively.
 *  Exported so scriptService can run self-verify on both generation paths. */
export async function rewriteLinesForGrounding(
  llm: LLMProvider,
  items: RewriteContext[],
  systemPrompt: string
): Promise<Map<number, { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean }>> {
  const out = new Map<number, { text: string; evidenceRefs?: any[]; isFactualClaim?: boolean }>();
  if (items.length === 0) return out;

  // Keep each batched response comfortably under output limits.
  const CHUNK = 15;
  for (let i = 0; i < items.length; i += CHUNK) {
    const chunk = items.slice(i, i + CHUNK);

    const lineBlocks = chunk.map((ctx) => {
      const figs = ctx.unsupportedFigures
        .map(
          (f) =>
            `  - "${f.surface}" (${f.value}) is NOT in the evidence${
              f.evidenceSays.length ? `; the evidence's numbers are: ${f.evidenceSays.join(", ")}` : ""
            }`
        )
        .join("\n");
      const attrs = ctx.unsupportedAttributions
        .map((n) => `  - "${n}" is presented as saying/doing something specific, but is NOT in the evidence (fabricated attribution — remove or make it a general reference)`)
        .join("\n");
      const semantic = ctx.semanticReason
        ? `\n  SEMANTIC REVIEWER FLAG (fix exactly this): ${ctx.semanticReason}\n  - If a real figure is attached to the WRONG subject/team, move it to the subject the evidence attributes it to, or drop it.\n  - If the line is MORE precise than the evidence, reduce it to exactly what the evidence supports, or go qualitative.`
        : "";
      return `LINE ${ctx.line.lineIndex} — SPEAKER: ${ctx.line.speakerName}
  CURRENT TEXT: ${JSON.stringify(ctx.line.text)}
  VIOLATIONS:
${figs || "  (no figure violations)"}
${attrs}${semantic}
  EVIDENCE FOR THIS LINE (the only facts it may state as true):
  ${ctx.evidenceText || "(no specific evidence for this line — go qualitative: assert no figure and no named-person quote/action)"}`;
    });

    const prompt = `${chunk.length} line(s) of the podcast script state specifics that are NOT supported by their evidence. Rewrite EACH listed line so every number and every named-person attribution is supported by that line's evidence — OR restate the point qualitatively (conviction, memory, rhetoric — no invented figure or quote). Keep each line's SAME speaker, tone, energy, and conversational feel (fragments, interruptions, attitude, an ending "—" if it was an interruption). Introduce NO new fabrications. Do not touch any line not listed.

${lineBlocks.join("\n\n")}

Return valid JSON only:
{ "rewrites": [ { "lineIndex": <number from LINE header>, "text": "the rewritten spoken line", "isFactualClaim": true | false, "evidenceRefs": [ { "type": "game|newsItem|injury|oddsSnapshot|teamStat|playerStat", "id": "..." } ] } ] }
- One rewrites entry per listed line, keyed by its lineIndex.
- Keep a real figure only if it is in that line's evidence -> isFactualClaim true + the matching evidenceRefs.
- Go qualitative (no specific figure/quote) -> isFactualClaim false + evidenceRefs [].`;

    try {
      const res = await withLlmStage("script:selfverify-rewrite", () =>
        llm.generateStructuredOutput<any>({
          prompt,
          systemPrompt,
          temperature: 0.6,
          maxTokens: Math.min(300 * chunk.length + 600, 8000),
        })
      );
      const rewrites = Array.isArray(res?.rewrites) ? res.rewrites : [];
      const requested = new Set(chunk.map((c) => c.line.lineIndex));
      for (const rw of rewrites) {
        if (!requested.has(rw?.lineIndex)) continue; // never touch unlisted lines
        if (typeof rw?.text !== "string" || !rw.text.trim()) continue;
        out.set(rw.lineIndex, {
          text: rw.text,
          evidenceRefs: Array.isArray(rw.evidenceRefs) ? rw.evidenceRefs : undefined,
          isFactualClaim: typeof rw.isFactualClaim === "boolean" ? rw.isFactualClaim : undefined,
        });
      }
    } catch (err: any) {
      console.warn(`[SelfVerify] batched rewrite failed: ${err?.message}`);
      // Chunk failure = those lines stay unrewritten this round; the
      // deterministic re-check and the fact-check gate still catch them.
    }
  }
  return out;
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
    `- GROUND EVERY BEAT IN THE SUPPLIED EVIDENCE: a beat may only rely on numbers, names, records, and dates that actually appear in the evidence above. Where a topic's evidence is qualitative — a story, a mood, a controversy — with no hard stats, plan a QUALITATIVE beat ("Louie's fury at the sweep", "the booing turns personal"); do NOT plan a beat whose angle demands a figure the evidence doesn't supply. A beat that needs an unsupplied stat is what forces the writer to invent one — that is the failure we are preventing.`,
    `- Include exactly one short tangent beat (type "transition") that humanizes the hosts.`,
    `- Do NOT plan jokes, bits, or running gags — humor is NOT outlined; it emerges from the two hosts clashing as the script is written. Use "callback" only for a genuine thematic thread worth revisiting, never a scheduled punchline.`,
    `- Every beat's "angle" is a specific, arguable take. "Specific" means anchored to a REAL supplied fact when one exists; where the evidence is qualitative, the angle is a specific emotional/narrative tension — still arguable, never an invented statistic.`,
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

  const res = await withLlmStage("script:outline", () =>
    llm.generateStructuredOutput<any>({
      prompt,
      systemPrompt: args.systemPrompt,
      temperature: Math.min(args.temperature, 0.7),
      maxTokens: Math.min(args.maxTokens, 8000),
    })
  );

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
  speakerNames: string[];
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
        `  Assigned facts (ONLY these may introduce new factual claims — introduce each ONCE, but every later line that leans on one must still carry its ref): ${JSON.stringify(b.factRefs)}`,
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
    `Write about ${args.linesTarget} dialogue lines covering ONLY your beats, in order.`,
    `FORWARD MOTION is about the ARGUMENT advancing — NOT every line carrying a new fact. Reactions, pushback, short fragments, and building lines move the argument without introducing a new claim, and they are REQUIRED for the show to sound like two people talking, not two essays traded back and forth.`,
    ``,
    `WRITE A CONVERSATION, NOT ALTERNATING SPEECHES:`,
    `- Give one speaker TWO or THREE lines in a row when they're building, self-correcting, or piling on ("And another thing—"). Do NOT hand the mic back after every single line — strict ping-pong is the #1 robotic tell.`,
    `- Jam short reactive FRAGMENTS from the other host between the longer turns: "Oh, come on.", "That's not—", "Wait.", "Hold on.", plus overlapping agreement "Yeah, and—", "Right, right—".`,
    `- REAL INTERRUPTIONS: when a host can't take it, they cut the other off. The interrupting line sets "isInterruption": true AND the line immediately BEFORE it MUST end mid-sentence with a "—" (em dash) — no "—" on the previous line means the audio overlap mis-fires, so never set isInterruption without it. BOTH hosts interrupt, as often as the heat warrants — there is no quota.`,
    `- Both hosts DRIVE: each pushes their own worldview and can get heated, incredulous, or exasperated. Neither is the calm foil who only deflates — if a host's core belief is attacked, that host escalates.`,
    ``,
    `DELIVERY & PERFORMANCE (set these per line — they drive the voice acting AND the pacing; do not leave them flat):`,
    `- "energy": VARY it across the act. An all-"high" run is exhausting and fake — drop to "low"/"medium" for setups, analysis, and concessions; spike "high" on the clashes. Both hosts range across energies; neither sits on one.`,
    `- "pauseBefore": VARY the pacing — do NOT default everything to "none"/"beat". "none" = a genuine jump-in (reaction or interruption) ONLY; "beat" = normal turn-taking (~0.3s); "breath" = a thought pivot (~0.7s); "long" = a dramatic beat (~1.2s). Use "long" on the single heaviest moment of your section — across the whole episode there should be at least 2-3 "long" pauses; a script with zero "long" pauses reads like a metronome.`,
    `- "tone": match the REAL emotion of the line; BOTH hosts must range across their tones (heated, excited, sarcastic, dismissive, amused, incredulous, conceding, analytical, reflective) — a host stuck on only "analytical"/"dismissive"/"sarcastic" reads as a foil, not a person.`,
    ``,
    `GROUNDING — THE ONE UNBREAKABLE RULE (read twice; it outranks every other instruction here):`,
    `- EVERY number, name, date, score, record, streak, salary, and statistic a host states as fact MUST come verbatim from the supplied evidence (your beats' assigned facts / the TOPIC EVIDENCE above). If it is not in the evidence, it does not exist — do not say it, do not round it, do not inflate it, do not "remember" it, do not derive a new figure from it.`,
    `- If the evidence lacks a specific the argument wants, the host ARGUES WITHOUT IT. Conviction, memory, rhetoric, and qualitative claims are fully allowed; invented specifics are not. Say "they've been rotten since June" — NOT "5-and-15 since June eighteenth" unless that exact figure is supplied. Say "they've stunk for years" — NOT "three straight 100-loss seasons" unless it's supplied. A vivid, unnumbered take beats a fabricated stat every single time.`,
    `- Do NOT embellish a real fact into a bigger one: if your evidence says three home runs, the host says three — never "five", never "most since 2018". Matching the evidence exactly is mandatory; exaggerating a supplied number IS fabrication and fails the fact check.`,
    `- BIND EVERY FIGURE TO ITS SUBJECT: a stat belongs to whichever team/player the evidence attributes it to — never transplant it onto another. If the evidence says the ORIOLES are 39-48 and nine under .500, a host must NOT say the YANKEES are 39-48 — that's a fabrication even though the number is real. Attach each figure to the exact subject the evidence names.`,
    `- NAMED-PERSON ATTRIBUTION IS RADIOACTIVE (legal exposure): never put a quote, statement, thought, or specific action on a real named person unless the evidence contains it — no invented "Boone pulled him", "Michael Kay called it a disaster", "the GM promised a move". A GENERAL reference to a public figure is fine ("Boone's bullpen management", "the skipper's on the hot seat"); a fabricated quote or specific action is not, and fails the fact check.`,
    `- The "Unsafe claims" list in your system prompt is RADIOACTIVE: never state any of those claims or numbers in any form — reworded, partial, or as a host's memory. The fact-checker knows that list and fails on contact.`,
    ``,
    `EVIDENCE MECHANICS:`,
    `- A line that states a SUPPLIED number/stat/record/injury/event as true sets "isFactualClaim": true AND carries that fact's ref from your assigned facts in "evidenceRefs". No ref on a factual line = flagged.`,
    `- RE-USING a ref is fine and expected: when a later line riffs on, restates, or derives from a supplied fact ("that's barely half of..."), it still carries that fact's ref. "Used once" limits the WORDING, never the ref.`,
    `- "isFactualClaim": false (empty evidenceRefs) for anything that is NOT a specific checkable assertion: reactions ("Oh, come on."), rhetoric, insults, qualitative claims ("they've been terrible"), predictions, hot takes, and judgments. When torn between a vivid qualitative claim (false) and inventing a number (forbidden), choose the qualitative claim.`,
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
    `          "speakerName": ${(args.speakerNames.length ? args.speakerNames : ["Host A", "Host B"]).map((n) => JSON.stringify(n)).join(" | ")},`,
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

  const res = await withLlmStage("script:acts", () =>
    llm.generateStructuredOutput<any>({
      prompt,
      systemPrompt: args.systemPrompt,
      temperature: args.temperature,
      maxTokens: args.maxTokens,
    })
  );

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
