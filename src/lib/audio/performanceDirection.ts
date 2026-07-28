// Format- and role-aware performance direction.
//
// Replaces the old universal direction that described EVERY voice as "a
// sports debate podcast host mid-episode, talking to your co-host" regardless
// of the actual show format. Direction is now compiled from:
//   - the registered show format + the cast member's chair (role),
//   - the host's persona fields + validated performance profile,
//   - the current scene type and the speaker's function in it.
//
// The compiled string is ONLY sent to engines whose verified capabilities
// declare supportsNaturalLanguageDirection (OpenAI `instructions`). Fish also
// distills the Delivery style sentence into a short inline scene cue; it must
// never replace a character with a generic chair-A/chair-B temperament.

import { getShowFormat } from "@/lib/formats/showFormatRegistry";
import type { DialogueSceneType } from "@/lib/providers/tts/sceneTypes";
import type { HostPerformanceProfile } from "@/lib/hosts/performanceProfile";

export const PERFORMANCE_DIRECTION_VERSION = 2;

/** What this chair is DOING in the conversation — the verb, not the persona.
 *
 * IMPORTANT: chair assignment must never invent temperament. The previous
 * chair_b direction called every second host an "analytical counterweight" who
 * should hold emotion back. That overrode every authored seat-B character and
 * is why roster after roster sounded like the same calm script reader. Both
 * debate chairs are now equal protagonists; their actual contrast comes from
 * the host profile, not their array index. */
const ROLE_FUNCTION: Record<string, string> = {
  // two_host_debate
  chair_a: "You are an equal protagonist in the argument. Push your own agenda, answer what your co-host actually said, and let your authored personality decide how pressure sounds.",
  chair_b: "You are an equal protagonist in the argument, never the designated analyst, fact-checker, calm one, or straight man. Push your own agenda, attack from your own worldview, and let your authored personality decide how pressure sounds.",
  // solo_commentary
  anchor: "You are alone with the listener: direct address, varied energy, no dialogue mannerisms.",
  // sports_radio
  lead_host: "You run the show: tease topics, set pace, hand off naturally. Conversational, not adversarial by default.",
  co_host: "You ride along: quick reactions, color, short natural interjections; agree as often as you argue.",
  producer_or_update_host: "You drop factual resets and headlines: crisp, informative, in and out.",
  // news_roundup
  news_anchor: "You deliver the news: headline first, then facts, cleanly separated from interpretation. Steady, credible, never performative.",
  analyst: "You explain what a story means: implications and context in plain language, not a re-read of the facts.",
  // host_and_expert
  host: "You ask grounded questions and follow-ups that respond to the previous answer; you sound genuinely curious, never scripted.",
  expert: "You explain with evidence, at a measured pace; you are a specialist explaining, not a hot-take host performing.",
  // three_person_panel / rapid_fire
  moderator: "You control traffic: frame, arbitrate, keep time. You never dominate the substance.",
  panelist_one: "You open with a position and defend it directly against the other panelist.",
  panelist_two: "You counter the other panelist directly, not through the moderator.",
  respondent_one: "You answer fast and short — immediate, decisive, no wind-up.",
  respondent_two: "You answer fast and short — immediate, decisive, no wind-up.",
  respondent_three: "You answer fast and short — immediate, decisive, no wind-up.",
  // interview
  interviewer: "You drive the structure but the guest is the show: your questions sound interested in the answer, not in the next question.",
  guest: "You carry the substance: longer answers, personal texture, real pauses to think.",
  // documentary
  narrator: "You carry a continuous narrative: measured, intimate, with momentum across sentences — one unbroken story, not isolated lines.",
  secondary_narrator: "You share the narration: same continuity, complementary tone.",
  character_voice: "You read verified excerpts with clear framing; restrained, never theatrical.",
  // betting_desk
  desk_host: "You frame each market plainly and keep the numbers honest; energetic but precise.",
  odds_analyst: "You explain data and movement with disciplined uncertainty language; never certain, never salesy.",
  contrarian: "You challenge the desk's assumptions with a skeptic's relish, still grounded in the numbers.",
};

/** Scene-type shading applied on top of the role function. */
const SCENE_SHADING: Record<DialogueSceneType, string> = {
  cold_open: "This is the cold open: arrive mid-energy, hook fast, no throat-clearing.",
  conversation: "Mid-conversation flow: react to what was just said before adding your own point.",
  argument_escalation: "The disagreement is building: intensity rises across the exchange, not within every line.",
  argument_resolution: "The argument is landing: let concessions and conclusions breathe.",
  transition: "You are moving the show to the next block: brief, forward-leaning.",
  news_block: "Factual block: clarity first; keep interpretation clearly marked as such.",
  host_expert_exchange: "Question-and-explanation rhythm: questions curious, answers unhurried.",
  interview_exchange: "Interview rhythm: space for the guest; follow-ups grow from the last answer.",
  documentary_narration: "Narrative continuity: each sentence hands momentum to the next.",
  rapid_fire: "Rapid fire: instant answers, clipped, no rambling.",
  closing: "The close: energy settles; land the goodbye like the end of a real conversation.",
};

export interface DirectionInput {
  formatId: string;
  /** ShowFormatRole.id for this speaker's chair. */
  roleId: string;
  host: { name: string; speakingStyle?: string | null };
  profile: HostPerformanceProfile;
  sceneType: DialogueSceneType;
}

/**
 * Compile the natural-language direction for one speaker in one scene.
 * Deterministic; safe for engines with an instructions parameter. Falls back
 * to a neutral podcast-speaker function for unknown roles — NEVER to the old
 * sports-debate default.
 */
export function buildPerformanceDirection(input: DirectionInput): string {
  const format = getShowFormat(input.formatId);
  const role = format?.roles.find((r) => r.id === input.roleId);
  const roleFunction =
    ROLE_FUNCTION[input.roleId] ??
    (role ? role.direction : "You are one voice in a professional podcast conversation; sound like a person talking, not a text being read.");

  const parts: string[] = [];
  parts.push(`You are "${input.host.name}" on a ${format ? format.displayName.toLowerCase() : "podcast"} episode.`);
  parts.push(roleFunction);
  if (input.host.speakingStyle?.trim()) parts.push(`Delivery style: ${input.host.speakingStyle.trim()}`);
  parts.push(SCENE_SHADING[input.sceneType]);
  // Range, not volume: the ceiling is reached only at genuine peaks.
  parts.push(
    `Your intensity ranges ${input.profile.baselineIntensity}/10 at baseline up to ${input.profile.peakIntensity}/10 at genuine peaks — most sentences sit near baseline.`
  );
  // Differing anger signatures keep a two-voice fight legible in mono. Volume
  // and pace are independent axes, so there are three, not two.
  parts.push(
    input.profile.angerStyle === "slower_quieter"
      ? "When genuinely angry you get SLOWER and QUIETER and more precise — never louder."
      : input.profile.angerStyle === "louder_slower"
        ? "When genuinely angry you get LOUDER and SLOWER — you stretch words out and hold the ends of them. You never speed up; the volume does the work."
        : "When genuinely angry you get louder and faster."
  );
  if (input.profile.prohibitedTraits.length > 0) {
    parts.push(`Never: ${input.profile.prohibitedTraits.join(", ")}.`);
  }
  return parts.join(" ");
}
