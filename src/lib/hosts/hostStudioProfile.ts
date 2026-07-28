import { z } from "zod";
import { hostPerformanceProfileSchema, type HostPerformanceProfile } from "./performanceProfile";

export const HOST_STUDIO_SETTINGS_VERSION = 1 as const;

export const ROLE_PRESETS = {
  fan_champion: {
    label: "Fan champion",
    role: "The fan's advocate who judges every decision by what it costs the audience",
    lens: "You measure decisions by what they do to the people who pay, watch, and care.",
  },
  insider: {
    label: "Former insider",
    role: "A former insider who explains the human motives behind organizational decisions",
    lens: "You look for fear, incentives, ego, timing, and the choices people believed they had.",
  },
  skeptic: {
    label: "Skeptic",
    role: "A sharp skeptic who challenges easy stories and unsupported certainty",
    lens: "You look for the weak assumption, missing evidence, or convenient story everyone else accepted.",
  },
  storyteller: {
    label: "Storyteller",
    role: "A vivid storyteller who makes the stakes concrete without turning the show into narration",
    lens: "You make an argument memorable through specific people, moments, and consequences.",
  },
  custom: {
    label: "Something else",
    role: "A distinct podcast host with a clear point of view",
    lens: "You bring a clear personal standard to every argument.",
  },
} as const;

export type RolePreset = keyof typeof ROLE_PRESETS;
export type EnergySetting = "calm" | "conversational" | "big";
export type PaceSetting = "easy" | "natural" | "fast";
export type HumorSetting = "serious" | "dry" | "playful";
export type InterruptionSetting = "waits" | "sometimes" | "jumps_in";
export type ConcessionSetting = "gracious" | "thoughtful" | "stubborn";
export type FinishSetting = "none" | "sharp" | "theatrical";
export type PressureSetting = "louder_faster" | "quieter_sharper" | "louder_slower";
export type PauseSetting = "tight" | "natural" | "spacious";
export type FishCreativitySetting = "steady" | "natural" | "expressive";

export const hostStudioSettingsSchema = z.object({
  version: z.literal(HOST_STUDIO_SETTINGS_VERSION),
  rolePreset: z.enum(["fan_champion", "insider", "skeptic", "storyteller", "custom"]),
  customRole: z.string().max(500).default(""),
  belief: z.string().min(1).max(4000),
  energy: z.enum(["calm", "conversational", "big"]),
  pace: z.enum(["easy", "natural", "fast"]),
  humor: z.enum(["serious", "dry", "playful"]),
  interruptions: z.enum(["waits", "sometimes", "jumps_in"]),
  concessions: z.enum(["gracious", "thoughtful", "stubborn"]),
  finish: z.enum(["none", "sharp", "theatrical"]),
  pressure: z.enum(["louder_faster", "quieter_sharper", "louder_slower"]),
  pauses: z.enum(["tight", "natural", "spacious"]),
  fishCreativity: z.enum(["steady", "natural", "expressive"]),
  castPriority: z.number().int().min(1).max(10),
  argumentPatterns: z.array(z.string().min(1).max(500)).max(20),
  bannedPhrases: z.array(z.string().min(1).max(300)).max(30),
  prohibitedTraits: z.array(z.string().min(1).max(100)).max(20),
  catchphrases: z.array(z.string().min(1).max(200)).max(12),
  extraInstructions: z.string().max(2000).default(""),
});

export type HostStudioSettings = z.infer<typeof hostStudioSettingsSchema>;

export interface HostStudioSource {
  role?: string | null;
  worldview?: string | null;
  speakingStyle?: string | null;
  intensityLevel?: number | null;
  argumentPatterns?: unknown;
  bannedPhrases?: unknown;
  catchphrases?: unknown;
  performanceProfile?: unknown;
  studioSettings?: unknown;
}

export interface CompiledHostStudioProfile {
  role: string;
  worldview: string;
  speakingStyle: string;
  intensityLevel: number;
  argumentPatterns: string[];
  bannedPhrases: string[];
  catchphrases: string[];
  performanceProfile: HostPerformanceProfile;
  studioSettings: HostStudioSettings;
}

const uniqueLines = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))];
};

export function defaultHostStudioSettings(): HostStudioSettings {
  return {
    version: HOST_STUDIO_SETTINGS_VERSION,
    rolePreset: "custom",
    customRole: "A distinct co-host with a clear point of view",
    belief: "Say what this host believes about the world and what standard they use to judge a story.",
    energy: "conversational",
    pace: "natural",
    humor: "dry",
    interruptions: "sometimes",
    concessions: "thoughtful",
    finish: "sharp",
    pressure: "quieter_sharper",
    pauses: "natural",
    fishCreativity: "natural",
    castPriority: 5,
    argumentPatterns: ["Answer what the other host actually said before adding a new point"],
    bannedPhrases: [],
    prohibitedTraits: ["script-reader cadence", "generic analyst voice"],
    catchphrases: [],
    extraInstructions: "",
  };
}

const nearest = <T>(value: number, choices: Array<[number, T]>): T =>
  choices.reduce((best, item) => Math.abs(item[0] - value) < Math.abs(best[0] - value) ? item : best)[1];

export function settingsFromHost(source: HostStudioSource): HostStudioSettings {
  const stored = hostStudioSettingsSchema.safeParse(source.studioSettings);
  if (stored.success) return stored.data;

  const defaults = defaultHostStudioSettings();
  const profile = hostPerformanceProfileSchema.safeParse(source.performanceProfile);
  if (!profile.success) {
    return {
      ...defaults,
      customRole: source.role?.trim() || defaults.customRole,
      belief: source.worldview?.trim() || defaults.belief,
      castPriority: Math.max(1, Math.min(10, Math.round(source.intensityLevel ?? defaults.castPriority))),
      argumentPatterns: uniqueLines(source.argumentPatterns),
      bannedPhrases: uniqueLines(source.bannedPhrases),
      catchphrases: uniqueLines(source.catchphrases),
      extraInstructions: source.speakingStyle?.trim() || "",
    };
  }

  const p = profile.data;
  return {
    ...defaults,
    customRole: source.role?.trim() || defaults.customRole,
    belief: source.worldview?.trim() || defaults.belief,
    energy: nearest(p.baselineIntensity, [[3, "calm"], [5, "conversational"], [7, "big"]]),
    pace: nearest(p.baselinePace, [[0.92, "easy"], [1, "natural"], [1.12, "fast"]]),
    humor: p.sarcasmBehavior === "never" ? "serious" : p.sarcasmBehavior === "open" ? "playful" : "dry",
    interruptions: p.interruptionBehavior === "never" ? "waits" : p.interruptionBehavior === "assertive" ? "jumps_in" : "sometimes",
    concessions: p.concessionBehavior === "gracious" ? "gracious" : p.concessionBehavior === "grudging" ? "stubborn" : "thoughtful",
    finish: p.killShotBehavior === "never" ? "none" : p.killShotBehavior === "theatrical" ? "theatrical" : "sharp",
    pressure: p.angerStyle === "louder_faster" ? "louder_faster" : p.angerStyle === "louder_slower" ? "louder_slower" : "quieter_sharper",
    pauses: p.preferredPauseStyle,
    fishCreativity: nearest(p.providerOverrides.fish?.temperature ?? 0.82, [[0.7, "steady"], [0.82, "natural"], [0.93, "expressive"]]),
    castPriority: Math.max(1, Math.min(10, Math.round(source.intensityLevel ?? defaults.castPriority))),
    argumentPatterns: uniqueLines(source.argumentPatterns),
    bannedPhrases: uniqueLines(source.bannedPhrases),
    prohibitedTraits: uniqueLines(p.prohibitedTraits),
    catchphrases: uniqueLines(source.catchphrases),
    extraInstructions: "",
  };
}

const energyMap = {
  calm: { baseline: 3, peak: 6, words: "calm and grounded", cue: "calm" },
  conversational: { baseline: 5, peak: 8, words: "conversational and alive", cue: "conversational" },
  big: { baseline: 6, peak: 9, words: "big, energetic, and emotionally present", cue: "high energy" },
} as const;

const paceMap = {
  easy: { baseline: 0.92, peak: 1.05, words: "easy-paced" },
  natural: { baseline: 1.0, peak: 1.16, words: "naturally paced" },
  fast: { baseline: 1.1, peak: 1.3, words: "fast and immediate" },
} as const;

const creativityMap = {
  steady: { temperature: 0.7, topP: 0.76 },
  natural: { temperature: 0.82, topP: 0.86 },
  expressive: { temperature: 0.93, topP: 0.93 },
} as const;

export function compileHostStudioProfile(input: HostStudioSettings): CompiledHostStudioProfile {
  const settings = hostStudioSettingsSchema.parse(input);
  const preset = ROLE_PRESETS[settings.rolePreset];
  const role = settings.rolePreset === "custom" && settings.customRole.trim()
    ? settings.customRole.trim()
    : preset.role;

  const energy = energyMap[settings.energy];
  const pace = paceMap[settings.pace];
  const humorWords = settings.humor === "serious" ? "serious, without forced jokes" : settings.humor === "playful" ? "openly playful" : "dryly funny";
  const humorCue = settings.humor === "serious" ? "serious" : settings.humor === "playful" ? "playful" : "dry humor";
  const interruptionWords = settings.interruptions === "waits"
    ? "lets the other host finish"
    : settings.interruptions === "jumps_in"
      ? "jumps in when a point cannot stand"
      : "occasionally cuts in when the moment earns it";
  const interruptionCue = settings.interruptions === "waits"
    ? "waits for the other host"
    : settings.interruptions === "jumps_in"
      ? "jumps in naturally"
      : "cuts in sometimes";
  const concessionWords = settings.concessions === "gracious"
    ? "concedes clearly when persuaded"
    : settings.concessions === "stubborn"
      ? "concedes grudgingly and only in a short phrase"
      : "thinks through a concession without turning it into a lecture";
  const pressureWords = settings.pressure === "louder_faster"
    ? "Under pressure, gets louder and faster."
    : settings.pressure === "louder_slower"
      ? "Under pressure, gets louder and slower, stretching important words."
      : "Under pressure, gets quieter, shorter, and sharper.";
  const finishWords = settings.finish === "none"
    ? "does not hunt for a closing punch line"
    : settings.finish === "theatrical"
      ? "lands a big theatrical finishing line only when the argument earns it"
      : "lands short, sharp finishing lines";

  // Fish scene rendering distills the FIRST sentence into its per-speaker cue
  // and caps it. Keep the acoustic sentence well under that limit so the most
  // important guard — never reading or announcing — cannot be truncated.
  const firstSentence = `${pace.words}; ${energy.cue}; ${humorCue}; ${interruptionCue}; talks to the other host, never reads or announces.`;
  const extra = settings.extraInstructions.trim();
  const speakingStyle = [
    firstSentence,
    `${energy.words}; ${humorWords}; ${interruptionWords}.`,
    `${concessionWords}; ${finishWords}.`,
    pressureWords,
    extra,
  ].filter(Boolean).join(" ");

  const worldview = `${settings.belief.trim()} ${preset.lens}`.trim();
  const creativity = creativityMap[settings.fishCreativity];
  const performanceProfile = hostPerformanceProfileSchema.parse({
    version: 1,
    baselinePace: pace.baseline,
    maxEscalationPace: pace.peak,
    baselineIntensity: energy.baseline,
    peakIntensity: energy.peak,
    vocalTextureNotes: firstSentence.slice(0, 300),
    accentNotes: "",
    sarcasmBehavior: settings.humor === "serious" ? "never" : settings.humor === "playful" ? "open" : "dry",
    laughBehavior: settings.humor === "serious" ? "rare" : settings.humor === "playful" ? "natural" : "rare",
    concessionBehavior: settings.concessions === "gracious" ? "gracious" : settings.concessions === "stubborn" ? "grudging" : "analytical",
    interruptionBehavior: settings.interruptions === "waits" ? "never" : settings.interruptions === "jumps_in" ? "assertive" : "rare",
    killShotBehavior: settings.finish === "none" ? "never" : settings.finish === "theatrical" ? "theatrical" : "measured",
    angerStyle: settings.pressure === "quieter_sharper" ? "slower_quieter" : settings.pressure,
    preferredPauseStyle: settings.pauses,
    maxCueDensity: settings.interruptions === "jumps_in" || settings.energy === "big" ? 2 : 1,
    prohibitedTraits: settings.prohibitedTraits,
    providerOverrides: { fish: creativity },
  });

  const generatedPatterns = [
    settings.interruptions === "jumps_in" ? "Interrupt when the other host's premise cannot stand" : "Respond directly to the previous point before changing direction",
    settings.concessions === "stubborn" ? "Concede in one short phrase, then name what still does not follow" : "Let a real concession change the next point",
    settings.finish === "sharp" ? "Prefer a short concrete finishing line over a summary paragraph" : null,
  ].filter((value): value is string => !!value);

  return {
    role,
    worldview,
    speakingStyle,
    intensityLevel: settings.castPriority,
    argumentPatterns: [...new Set([...settings.argumentPatterns, ...generatedPatterns])],
    bannedPhrases: [...new Set(settings.bannedPhrases)],
    catchphrases: [...new Set(settings.catchphrases)],
    performanceProfile,
    studioSettings: settings,
  };
}

export function previewDirectionFor(settings: HostStudioSettings): string {
  const compiled = compileHostStudioProfile(settings);
  return `Delivery style: ${compiled.speakingStyle} Never: ${compiled.performanceProfile.prohibitedTraits.join(", ") || "generic script reading"}.`;
}
