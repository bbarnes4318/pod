// Casting intelligence for the Talent Studio: pure functions over the fields a
// host already stores. No model call, no network, no clock, no randomness —
// the same hosts always produce the same read, the same recommendations and
// the same ranking, and every line names the stored values it came from.
//
// Everything scored here is a HEURISTIC. The UI says so. Nothing in this file
// feeds episode generation or the auto-caster; it only advises a person.

import { ROLE_PRESETS, defaultHostStudioSettings, type HostStudioSettings } from "./hostStudioProfile";

export const TRAIT_LABELS = {
  energy: { calm: "Calm", conversational: "Conversational", big: "Big energy" },
  pace: { easy: "Easy", natural: "Natural", fast: "Fast" },
  humor: { serious: "Serious", dry: "Dry humor", playful: "Playful" },
  interruptions: { waits: "Waits", sometimes: "Sometimes", jumps_in: "Jumps in" },
  concessions: { gracious: "Gracious", thoughtful: "Thoughtful", stubborn: "Stubborn" },
  finish: { none: "No punch line", sharp: "Sharp", theatrical: "Big finish" },
  pressure: { louder_faster: "Louder + faster", quieter_sharper: "Quieter + sharper", louder_slower: "Louder + slower" },
  pauses: { tight: "Tight", natural: "Natural", spacious: "Spacious" },
} as const;

/** The same test the rest of the Studio uses for "this host can speak". */
export function isRealVoiceId(voiceId: string): boolean {
  return /^[0-9a-f]{32}$/i.test(voiceId);
}

export function roleLabel(settings: HostStudioSettings): string {
  return settings.rolePreset === "custom"
    ? settings.customRole.trim() || ROLE_PRESETS.custom.label
    : ROLE_PRESETS[settings.rolePreset].label;
}

/** One line describing how the host behaves, built only from stored choices. */
export function personalityRead(settings: HostStudioSettings): string {
  const t = TRAIT_LABELS;
  const interrupts = settings.interruptions === "waits" ? "lets the other host finish"
    : settings.interruptions === "jumps_in" ? "jumps in" : "cuts in sometimes";
  const concedes = settings.concessions === "gracious" ? "concedes graciously"
    : settings.concessions === "stubborn" ? "concedes grudgingly" : "thinks a concession through";
  const pressure = settings.pressure === "louder_faster" ? "louder and faster"
    : settings.pressure === "louder_slower" ? "louder and slower" : "quieter and sharper";
  return `${t.energy[settings.energy]}, ${t.pace[settings.pace].toLowerCase()} pace, ${t.humor[settings.humor].toLowerCase()}. `
    + `${interrupts[0].toUpperCase()}${interrupts.slice(1)}, ${concedes}, gets ${pressure} under pressure.`;
}

// ---------------------------------------------------------------------------
// Personality recommendations
// ---------------------------------------------------------------------------

export interface PersonalityRecommendation {
  id: string;
  /** "gap" = something stored is empty or still the default. "tension" = two
   *  stored choices pull against each other. Neither blocks saving. */
  kind: "gap" | "tension";
  title: string;
  /** The stored facts this is based on, verbatim enough to check by eye. */
  basis: string[];
  suggestion: string;
}

export function personalityRecommendations(settings: HostStudioSettings): PersonalityRecommendation[] {
  const t = TRAIT_LABELS;
  const d = defaultHostStudioSettings();
  const out: PersonalityRecommendation[] = [];
  const belief = settings.belief.trim();

  if (belief === d.belief) {
    out.push({
      id: "belief-default", kind: "gap", title: "The belief is still the placeholder text",
      basis: ["Belief is the unedited starter sentence."],
      suggestion: "Write what this host believes and the standard they judge a story by. It is the main thing the script writer reads.",
    });
  } else if (belief.length < 60) {
    out.push({
      id: "belief-thin", kind: "gap", title: "The belief is very short",
      basis: [`Belief is ${belief.length} characters.`],
      suggestion: "Add what they would argue for and what they refuse to accept. One or two more sentences is enough.",
    });
  }

  if (settings.rolePreset === "custom" && (!settings.customRole.trim() || settings.customRole.trim() === d.customRole)) {
    out.push({
      id: "role-generic", kind: "gap", title: "The role is the generic default",
      basis: [`Role type is "Something else" and the description is ${settings.customRole.trim() ? "the starter text" : "empty"}.`],
      suggestion: "Pick a role type, or describe their job on the show in one line.",
    });
  }

  const ownPatterns = settings.argumentPatterns.filter((line) => !d.argumentPatterns.includes(line));
  if (ownPatterns.length === 0) {
    out.push({
      id: "habits-missing", kind: "gap", title: "No argument habits of their own",
      basis: [settings.argumentPatterns.length === 0 ? "\"They often…\" is empty." : "\"They often…\" holds only the starter line."],
      suggestion: "Add two or three habits (how they challenge, what they ask, what they reach for). Habits are what make two hosts sound different on the page.",
    });
  }

  if (settings.bannedPhrases.length === 0) {
    out.push({
      id: "banned-empty", kind: "gap", title: "No phrases are ruled out",
      basis: ["\"Never say…\" is empty."],
      suggestion: "List the filler this host would never use. It is the cheapest way to stop generic lines.",
    });
  }

  if (settings.prohibitedTraits.length === 0) {
    out.push({
      id: "delivery-guard-empty", kind: "gap", title: "No delivery guard",
      basis: ["\"Never sound like…\" is empty."],
      suggestion: "Name what the voice must not sound like (an announcer, a narrator).",
    });
  }

  const banned = new Set(settings.bannedPhrases.map((phrase) => phrase.trim().toLowerCase()));
  const clash = settings.catchphrases.filter((phrase) => banned.has(phrase.trim().toLowerCase()));
  if (clash.length > 0) {
    out.push({
      id: "phrase-clash", kind: "tension", title: "A favorite phrase is also banned",
      basis: clash.map((phrase) => `"${phrase}" is in both "Favorite phrases" and "Never say…".`),
      suggestion: "Remove it from one list. As stored, the script writer is told to use it and to never use it.",
    });
  }

  if (settings.catchphrases.length > 4) {
    out.push({
      id: "catchphrase-heavy", kind: "tension", title: "A lot of favorite phrases",
      basis: [`${settings.catchphrases.length} favorite phrases are stored.`],
      suggestion: "Keep the one or two that are really theirs. Many catchphrases tend to read as a gimmick.",
    });
  }

  if (settings.finish === "theatrical" && settings.catchphrases.length === 0) {
    out.push({
      id: "finish-no-signature", kind: "gap", title: "Big finish, no signature line",
      basis: [`Finish is "${t.finish.theatrical}".`, "\"Favorite phrases\" is empty."],
      suggestion: "Optional: give them one line they land arguments with.",
    });
  }

  if (settings.pace === "fast" && settings.pauses === "spacious") {
    out.push({
      id: "pace-vs-pauses", kind: "tension", title: "Fast speech with spacious pauses",
      basis: [`Speaking speed is "${t.pace.fast}".`, `Pauses are "${t.pauses.spacious}".`],
      suggestion: "These pull against each other in delivery. Choose natural pauses, or slow the pace.",
    });
  }

  if (settings.humor === "serious" && settings.finish === "theatrical") {
    out.push({
      id: "serious-vs-theatrical", kind: "tension", title: "Serious host, theatrical finish",
      basis: [`Humor is "${t.humor.serious}".`, `Finish is "${t.finish.theatrical}".`],
      suggestion: "If the big finish is the point, keep it. Otherwise a short, sharp finish fits a serious host better.",
    });
  }

  if (settings.energy === "calm" && settings.pressure === "louder_faster") {
    out.push({
      id: "calm-vs-escalation", kind: "tension", title: "Calm host who gets louder and faster",
      basis: [`Energy is "${t.energy.calm}".`, `Under pressure is "${t.pressure.louder_faster}".`],
      suggestion: "A wide swing can work, but check it in the Under pressure preview. Quieter + sharper is the closer fit for a calm host.",
    });
  }

  if (settings.interruptions === "jumps_in" && settings.concessions === "stubborn" && settings.finish === "theatrical" && settings.energy === "big") {
    out.push({
      id: "all-max", kind: "tension", title: "Every dial is at its strongest setting",
      basis: [
        `Energy "${t.energy.big}", interruptions "${t.interruptions.jumps_in}", concessions "${t.concessions.stubborn}", finish "${t.finish.theatrical}".`,
      ],
      suggestion: "This host will dominate a two-host show. Cast them with a partner who waits and concedes, or soften one dial.",
    });
  }

  if (settings.interruptions === "waits" && settings.concessions === "gracious" && settings.finish === "none" && settings.energy === "calm") {
    out.push({
      id: "no-friction", kind: "tension", title: "Nothing here creates friction",
      basis: [
        `Energy "${t.energy.calm}", interruptions "${t.interruptions.waits}", concessions "${t.concessions.gracious}", finish "${t.finish.none}".`,
      ],
      suggestion: "A two-host show needs something to push against. Give them a sharp finish, or cast a partner who jumps in.",
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Readiness (what Final review shows before saving)
// ---------------------------------------------------------------------------

export interface ReadinessIssue {
  id: string;
  /** "blocker" stops this save. "warning" is saved but worth knowing. */
  level: "blocker" | "warning";
  text: string;
}

export function talentReadiness(input: {
  name: string;
  settings: HostStudioSettings;
  /** Will the host have a real voice once this save completes? */
  willHaveVoice: boolean;
  voiceSource: string;
}): ReadinessIssue[] {
  const issues: ReadinessIssue[] = [];
  if (!input.name.trim()) issues.push({ id: "name", level: "blocker", text: "The host has no name." });
  if (!input.settings.belief.trim()) issues.push({ id: "belief", level: "blocker", text: "\"What do they believe?\" is empty." });
  if (!input.willHaveVoice) {
    issues.push({ id: "voice", level: "warning", text: "No voice yet. The host can be saved, but cannot be put on air or voiced until one is added." });
  } else if (!input.voiceSource) {
    issues.push({ id: "provenance", level: "warning", text: "Voice provenance is undocumented: nothing records who owns or licensed this voice." });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Complementary casting
// ---------------------------------------------------------------------------

export interface CastingProfile {
  id: string;
  name: string;
  settings: HostStudioSettings;
  ttsVoiceId: string;
}

export interface CastingReason {
  /** Points this fact added to or took from the score. */
  effect: number;
  /** A sentence naming both hosts' stored values. */
  text: string;
}

export interface CastingFit {
  hostId: string;
  name: string;
  /** 0–100. A heuristic for sorting, not a measurement of anything. */
  score: number;
  reasons: CastingReason[];
}

const ORDER = {
  energy: ["calm", "conversational", "big"],
  pace: ["easy", "natural", "fast"],
  humor: ["serious", "dry", "playful"],
} as const;

// With every rule in a pair's favour the effects sum to 90, so the best
// possible pair scores exactly 100. The floor is clamped at 0.
export const BASE_SCORE = 10;

/** How well `partner` complements `host` in a two-host show. Symmetric. */
export function castingFit(host: CastingProfile, partner: CastingProfile): CastingFit {
  const t = TRAIT_LABELS;
  const a = host.settings;
  const b = partner.settings;
  const reasons: CastingReason[] = [];
  const add = (effect: number, text: string) => { if (effect !== 0) reasons.push({ effect, text }); };
  const pair = (left: string, right: string) => `${host.name} is "${left}", ${partner.name} is "${right}"`;

  // Contrast on the ordered dials: one step apart is some contrast, two is a lot.
  const steps = <K extends keyof typeof ORDER>(key: K) =>
    Math.abs((ORDER[key] as readonly string[]).indexOf(a[key]) - (ORDER[key] as readonly string[]).indexOf(b[key]));
  const energy = steps("energy");
  add(energy * 10, `Energy contrast: ${pair(t.energy[a.energy], t.energy[b.energy])}.`);
  if (energy === 0) add(-5, `Same energy: both are "${t.energy[a.energy]}".`);
  add(steps("pace") * 5, `Pace contrast: ${pair(t.pace[a.pace], t.pace[b.pace])}.`);
  add(steps("humor") * 5, `Humor contrast: ${pair(t.humor[a.humor], t.humor[b.humor])}.`);

  if (a.pressure !== b.pressure) add(8, `They escalate differently: ${pair(t.pressure[a.pressure], t.pressure[b.pressure])}.`);

  // Role balance.
  if (a.rolePreset !== b.rolePreset) {
    add(15, `Different jobs on the show: ${pair(ROLE_PRESETS[a.rolePreset].label, ROLE_PRESETS[b.rolePreset].label)}.`);
  } else if (a.rolePreset !== "custom") {
    add(-10, `Same job on the show: both are "${ROLE_PRESETS[a.rolePreset].label}".`);
  } else if (a.customRole.trim().toLowerCase() === b.customRole.trim().toLowerCase()) {
    add(-10, "Same job on the show: both have the same custom role description.");
  }

  // Who drives. Two interrupters talk over each other; two waiters stall.
  if (a.interruptions === "jumps_in" && b.interruptions === "jumps_in") {
    add(-10, `Both are "${t.interruptions.jumps_in}": they will talk over each other.`);
  } else if (a.interruptions === "waits" && b.interruptions === "waits") {
    add(-6, `Both are "${t.interruptions.waits}": nobody drives the exchange.`);
  } else if (a.interruptions !== b.interruptions) {
    add(8, `One drives, one gives room: ${pair(t.interruptions[a.interruptions], t.interruptions[b.interruptions])}.`);
  }

  // Can an argument resolve?
  if (a.concessions === "stubborn" && b.concessions === "stubborn") {
    add(-10, `Both concede as "${t.concessions.stubborn}": arguments have no way to resolve.`);
  } else if (a.concessions !== b.concessions) {
    add(6, `They concede differently: ${pair(t.concessions[a.concessions], t.concessions[b.concessions])}.`);
  }

  if (a.finish === "theatrical" && b.finish === "theatrical") {
    add(-5, `Both go for a "${t.finish.theatrical}": the closing lines compete.`);
  }

  // Voice. Only the stored voice id is known — not how the voice sounds.
  const hostVoice = isRealVoiceId(host.ttsVoiceId);
  const partnerVoice = isRealVoiceId(partner.ttsVoiceId);
  if (!hostVoice || !partnerVoice) {
    const missing = [host, partner].filter((item) => !isRealVoiceId(item.ttsVoiceId)).map((item) => item.name);
    add(-15, `${missing.join(" and ")} ${missing.length > 1 ? "have" : "has"} no voice yet and cannot be cast until one is created.`);
  } else if (host.ttsVoiceId.toLowerCase() === partner.ttsVoiceId.toLowerCase()) {
    add(-25, "They share the same stored voice: listeners could not tell them apart.");
  } else {
    add(10, "They have different stored voices.");
  }

  if (a.castPriority !== b.castPriority) {
    const lead = a.castPriority > b.castPriority ? host : partner;
    add(3, `Clear lead chair: casting priority ${a.castPriority} vs ${b.castPriority}, so ${lead.name} leads.`);
  } else {
    add(-2, `Same casting priority (${a.castPriority}): the lead chair is a tie.`);
  }

  const total = BASE_SCORE + reasons.reduce((sum, reason) => sum + reason.effect, 0);
  return {
    hostId: partner.id,
    name: partner.name,
    score: Math.max(0, Math.min(100, total)),
    // Biggest effects first, in either direction; ties keep rule order.
    reasons: reasons.map((reason, index) => ({ reason, index }))
      .sort((x, y) => Math.abs(y.reason.effect) - Math.abs(x.reason.effect) || x.index - y.index)
      .map((entry) => entry.reason),
  };
}

/** Every other host, best complement first. Ties break on name, then id. */
export function rankCastingPartners(host: CastingProfile, others: CastingProfile[]): CastingFit[] {
  return others
    .filter((other) => other.id !== host.id)
    .map((other) => castingFit(host, other))
    .sort((x, y) => y.score - x.score || x.name.localeCompare(y.name) || x.hostId.localeCompare(y.hostId));
}
