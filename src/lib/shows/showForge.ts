import { z } from "zod";

export const SHOW_FORGE_PREFIX = "show-forge:v1:";
export const SHOW_FORGE_VERSION = 1 as const;

const line = z.string().trim().min(1).max(500);

export const recurringSegmentSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(80),
  purpose: z.string().trim().min(1).max(500),
  frequency: z.enum(["every_episode", "often", "occasionally"]),
}).strict();

export const storylineBeatSchema = z.object({
  title: z.string().trim().min(1).max(120),
  direction: z.string().trim().min(1).max(1000),
}).strict();

export const showStorylineSchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  premise: z.string().trim().min(1).max(1000),
  status: z.enum(["active", "paused", "resolved"]),
  priority: z.number().int().min(1).max(5),
  featuredHostIds: z.array(z.string().trim().min(1)).max(4),
  beats: z.array(storylineBeatSchema).min(2).max(12),
}).strict();

export const showBibleSchema = z.object({
  version: z.literal(SHOW_FORGE_VERSION),
  templateId: z.enum(["rivalry_room", "insider_room", "fan_court", "season_story", "custom"]),
  premise: z.string().trim().min(8).max(1500),
  audiencePromise: z.string().trim().min(8).max(1000),
  tone: z.enum(["combustible", "smart_funny", "intimate", "cinematic", "fast_loose"]),
  pointOfView: z.string().trim().min(4).max(1000),
  hostChemistry: z.string().trim().min(4).max(1000),
  openingRitual: z.string().trim().max(500),
  closingRitual: z.string().trim().max(500),
  recurringSegments: z.array(recurringSegmentSchema).min(1).max(8),
  guardrails: z.array(line).max(20),
}).strict();

export const showForgeStateSchema = z.object({
  version: z.literal(SHOW_FORGE_VERSION),
  scriptStyle: z.enum(["heated-debate", "balanced-analysis", "sports-radio"]),
  bible: showBibleSchema,
  storylines: z.array(showStorylineSchema).max(8),
}).strict();

export type ShowBible = z.infer<typeof showBibleSchema>;
export type ShowStoryline = z.infer<typeof showStorylineSchema>;
export type ShowForgeState = z.infer<typeof showForgeStateSchema>;
export type StorylineAssignment = {
  storylineId: string;
  storylineTitle: string;
  storylinePremise: string;
  beatIndex: number;
  beatCount: number;
  beatTitle: string;
  beatDirection: string;
  featuredHostIds: string[];
};

export const SHOW_TEMPLATES: Record<ShowBible["templateId"], Omit<ShowBible, "version" | "templateId">> = {
  rivalry_room: {
    premise: "Two true believers enter every episode with different standards for what winning, loyalty, and accountability should mean.",
    audiencePromise: "Every episode gives the listener a real argument with stakes, movement, and a verdict worth arguing about afterward.",
    tone: "combustible",
    pointOfView: "Judge every story through the human cost of decisions, not a generic recap of the news.",
    hostChemistry: "Friendly rivals who know exactly where the other person's argument is weakest and enjoy pressing it.",
    openingRitual: "Open in the middle of the hottest disagreement, then reveal what triggered it.",
    closingRitual: "Each host gives a one-sentence verdict; the other gets one final response.",
    recurringSegments: [
      { id: "receipts", name: "Bring the Receipts", purpose: "Each host identifies the strongest grounded fact supporting the argument.", frequency: "every_episode" },
      { id: "verdict", name: "The Verdict", purpose: "End the central argument with two clear, competing conclusions.", frequency: "every_episode" },
    ],
    guardrails: ["Never manufacture disagreement when the hosts genuinely agree.", "Never turn the hosts into interchangeable analysts."],
  },
  insider_room: {
    premise: "The show explains why organizations make the choices they make—and who pays when those choices fail.",
    audiencePromise: "Listeners leave understanding the incentives, fear, ego, and consequences hiding behind the official story.",
    tone: "intimate",
    pointOfView: "Look past public language to the decision structure and the people affected by it.",
    hostChemistry: "One host understands institutional logic; the other refuses to let institutional logic erase human consequences.",
    openingRitual: "Begin with the official explanation, then puncture the part that does not add up.",
    closingRitual: "Name the decision-maker, the tradeoff, and what happens next.",
    recurringSegments: [
      { id: "official-story", name: "The Official Story", purpose: "State the public explanation in one clean sentence before challenging it.", frequency: "often" },
      { id: "who-pays", name: "Who Pays?", purpose: "Identify who absorbs the consequence of the decision.", frequency: "every_episode" },
    ],
    guardrails: ["Never claim private access or real-world insider knowledge.", "Never invent motives for named real people."],
  },
  fan_court: {
    premise: "Sports decisions are put on trial from the perspective of the people who spend their money, time, and loyalty on the team.",
    audiencePromise: "Every episode makes the fan's case clearly, challenges it fairly, and delivers a memorable ruling.",
    tone: "smart_funny",
    pointOfView: "The fan is not background scenery; the fan is the constituency every decision must answer to.",
    hostChemistry: "One host prosecutes the decision, one host defends it, and both are allowed to switch sides when the evidence earns it.",
    openingRitual: "Read the charge in one sentence and let the defense interrupt immediately.",
    closingRitual: "Deliver a guilty, not guilty, or complicated ruling with one reason.",
    recurringSegments: [
      { id: "charge", name: "The Charge", purpose: "Name the decision being judged and the harm alleged.", frequency: "every_episode" },
      { id: "cross", name: "Cross-Examination", purpose: "Force the strongest version of the opposing case into the open.", frequency: "often" },
    ],
    guardrails: ["Never use fake legal facts or present the format as real legal advice.", "Humor comes from attitude, not scripted courtroom clichés."],
  },
  season_story: {
    premise: "Each episode stands alone while also advancing a larger season-long question about power, identity, pressure, or change.",
    audiencePromise: "Listeners get a complete episode today and a meaningful reason to return for the next chapter.",
    tone: "cinematic",
    pointOfView: "Treat current stories as chapters in a larger human pattern without forcing false connections.",
    hostChemistry: "The hosts investigate the season question from different emotional and analytical angles.",
    openingRitual: "Open on a vivid consequence, then connect it to the season question.",
    closingRitual: "Resolve today's argument and leave one honest question open for the next chapter.",
    recurringSegments: [
      { id: "chapter", name: "Where We Are", purpose: "Orient the listener to the season question without recapping old episodes at length.", frequency: "often" },
      { id: "turn", name: "The Turn", purpose: "Identify what changed because of today's story.", frequency: "every_episode" },
    ],
    guardrails: ["A storyline beat may shape interpretation but may never fabricate a real-world event.", "Do not service the season arc when the current story does not support it."],
  },
  custom: {
    premise: "A distinctive recurring show with a clear reason to exist beyond summarizing today's headlines.",
    audiencePromise: "Listeners know what they will consistently get here that they cannot get from a generic sports recap.",
    tone: "fast_loose",
    pointOfView: "Every story is filtered through the show's declared standard and audience promise.",
    hostChemistry: "The cast has complementary agendas and recognizable relationships, not assigned generic roles.",
    openingRitual: "Start with the most alive moment, not housekeeping.",
    closingRitual: "Finish with a changed position, a verdict, or a consequential open question.",
    recurringSegments: [
      { id: "signature", name: "Signature Segment", purpose: "A repeatable segment that expresses the show's unique point of view.", frequency: "often" },
    ],
    guardrails: ["Never sound like a generic news summary.", "Never force a recurring segment when it does not fit the episode."],
  },
};

export function templateBible(templateId: ShowBible["templateId"]): ShowBible {
  return showBibleSchema.parse({ version: SHOW_FORGE_VERSION, templateId, ...SHOW_TEMPLATES[templateId] });
}

export function defaultShowForgeState(): ShowForgeState {
  return showForgeStateSchema.parse({
    version: SHOW_FORGE_VERSION,
    scriptStyle: "heated-debate",
    bible: templateBible("rivalry_room"),
    storylines: [],
  });
}

export function encodeShowForgeState(input: ShowForgeState): string {
  return SHOW_FORGE_PREFIX + JSON.stringify(showForgeStateSchema.parse(input));
}

export function decodeShowForgeState(value: unknown): { state: ShowForgeState | null; legacyScriptStyle: string | null } {
  if (typeof value !== "string" || !value.startsWith(SHOW_FORGE_PREFIX)) {
    const legacy = typeof value === "string" && value.trim() ? value.trim() : null;
    return { state: null, legacyScriptStyle: legacy };
  }
  try {
    const parsed = showForgeStateSchema.safeParse(JSON.parse(value.slice(SHOW_FORGE_PREFIX.length)));
    return parsed.success ? { state: parsed.data, legacyScriptStyle: parsed.data.scriptStyle } : { state: null, legacyScriptStyle: null };
  } catch {
    return { state: null, legacyScriptStyle: null };
  }
}

export function storylineSequence(storylines: ShowStoryline[]): StorylineAssignment[] {
  const active = storylines
    .filter((storyline) => storyline.status === "active")
    .sort((a, b) => b.priority - a.priority || a.title.localeCompare(b.title));
  const sequence: StorylineAssignment[] = [];
  const longest = Math.max(0, ...active.map((storyline) => storyline.beats.length));
  for (let beatIndex = 0; beatIndex < longest; beatIndex++) {
    for (const storyline of active) {
      const beat = storyline.beats[beatIndex];
      if (!beat) continue;
      sequence.push({
        storylineId: storyline.id,
        storylineTitle: storyline.title,
        storylinePremise: storyline.premise,
        beatIndex,
        beatCount: storyline.beats.length,
        beatTitle: beat.title,
        beatDirection: beat.direction,
        featuredHostIds: storyline.featuredHostIds,
      });
    }
  }
  return sequence;
}

export function selectStorylineAssignment(state: ShowForgeState, episodeIndex: number): StorylineAssignment | null {
  const sequence = storylineSequence(state.storylines);
  return sequence[Math.max(0, Math.trunc(episodeIndex))] ?? null;
}

const toneLabel: Record<ShowBible["tone"], string> = {
  combustible: "combustible and argumentative",
  smart_funny: "smart, funny, and specific",
  intimate: "intimate, revealing, and human",
  cinematic: "cinematic, consequential, and chapter-driven",
  fast_loose: "fast, loose, and conversational",
};

export function renderShowForgePrompt(state: ShowForgeState, episodeIndex: number): { prompt: string; assignment: StorylineAssignment | null } {
  const { bible } = state;
  const assignment = selectStorylineAssignment(state, episodeIndex);
  const recurring = bible.recurringSegments
    .map((segment) => `- ${segment.name} (${segment.frequency.replace("_", " ")}): ${segment.purpose}`)
    .join("\n");
  const lines = [
    `=== THIS SHOW'S CREATIVE BIBLE ===`,
    `Premise: ${bible.premise}`,
    `Audience promise: ${bible.audiencePromise}`,
    `Point of view: ${bible.pointOfView}`,
    `Tone: ${toneLabel[bible.tone]}.`,
    `Host chemistry: ${bible.hostChemistry}`,
    bible.openingRitual ? `Opening ritual: ${bible.openingRitual}` : "",
    bible.closingRitual ? `Closing ritual: ${bible.closingRitual}` : "",
    `Recurring segment library (use only when it fits naturally):\n${recurring}`,
    bible.guardrails.length ? `Show guardrails:\n${bible.guardrails.map((rule) => `- ${rule}`).join("\n")}` : "",
  ].filter(Boolean);

  if (assignment) {
    lines.push(
      "",
      `=== STORYLINE BEAT FOR EPISODE ${episodeIndex + 1} ===`,
      `Arc: ${assignment.storylineTitle}`,
      `Arc premise: ${assignment.storylinePremise}`,
      `Beat ${assignment.beatIndex + 1} of ${assignment.beatCount}: ${assignment.beatTitle}`,
      `Creative direction: ${assignment.beatDirection}`,
      "Execution rule: let this beat change the hosts' relationship, framing, or conclusion. It may NEVER create a real-world fact, quote, event, source, or private knowledge. The supplied evidence remains the only factual authority.",
    );
  } else {
    lines.push("", "No season beat is scheduled. Deliver a complete standalone episode inside the show bible.");
  }

  return { prompt: lines.join("\n"), assignment };
}
