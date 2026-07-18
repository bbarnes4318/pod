// Format-driven script-prompt pieces (Prompt 7, PR 2).
//
// The script engine assembles its system prompt from these per-format pieces
// instead of a hardcoded two-host debate template. THE DEBATE PIECES ARE THE
// EXACT TEXT the engine shipped with before this refactor — for
// two_host_debate the assembled prompt is unchanged, so generation quality
// cannot regress. Other formats get their own honest dynamics contracts and
// are only reachable once the registry marks them generationReady.

import type { AiHost } from "@prisma/client";
import type { ShowFormat } from "./showFormatRegistry";

export interface FormatPromptPieces {
  /** "...head writer for Take Machine, a <descriptor>." */
  showDescriptor: string;
  /** The per-format dynamics section (the debate's CHEMISTRY CONTRACT). */
  dynamicsContract: string;
  /** Extra speech-rule lines appended for the format (may be empty). */
  extraSpeechRules: string;
  /** The noun used in the user prompt ("debate script", "solo briefing script"). */
  scriptNoun: string;
}

/** One persona block per cast member. For the two-host debate this renders the
 *  EXACT legacy "Host 1:/Host 2:" blocks; other formats add the chair's format
 *  role direction so the model knows what each seat is for. */
export function castPersonaBlocks(format: ShowFormat, cast: AiHost[]): string {
  return cast
    .map((h, i) => {
      const roleLine =
        format.id === "two_host_debate"
          ? ""
          : `\n- Format Chair: ${format.roles[Math.min(i, format.roles.length - 1)].name} — ${format.roles[Math.min(i, format.roles.length - 1)].direction}`;
      return `Host ${i + 1}: ${h.name} (ID: ${h.id})${roleLine}
- Role: ${h.role}
- Worldview: ${h.worldview}
- Speaking Style: ${h.speakingStyle}
- Catchphrases (use sparingly, max 2-3 per episode, never forced): ${JSON.stringify(h.catchphrases)}
- Likes: ${JSON.stringify(h.likes)}
- Dislikes: ${JSON.stringify(h.dislikes)}
- Argument Patterns: ${JSON.stringify(h.argumentPatterns)}
- Banned Phrases: ${JSON.stringify(h.bannedPhrases)}
- Intensity Level: ${h.intensityLevel}/10`;
    })
    .join("\n\n");
}

export function formatPromptPieces(format: ShowFormat, cast: AiHost[]): FormatPromptPieces {
  switch (format.id) {
    case "solo_briefing": {
      const anchor = cast[0];
      return {
        showDescriptor: "a single-host sports briefing podcast",
        scriptNoun: "solo briefing script",
        dynamicsContract: `SOLO DELIVERY CONTRACT (the engine of the show):
- ${anchor.name} carries the WHOLE episode alone, talking straight to the listener — direct address ("you", "listen", "here's the thing") is the register.
- The argument still has shape: stake out the take -> steelman the counter ("the other side of this says...") -> knock it down or concede a piece -> land the button. The anchor argues WITH THE LISTENER'S doubts, not with another host.
- Self-interruption replaces host interruption: false starts, "wait, actually—", rhetorical questions answered immediately. "isInterruption" is ALWAYS false — there is no second voice to overlap.
- Energy still varies: heat on the take, drop low for the aside, build again. A monologue at one energy level is a lecture, not a show.`,
        extraSpeechRules: `\nSOLO FORMAT RULES:
- EVERY line's speakerName is "${anchor.name}" — there is no other legal speaker.
- "isInterruption" must be false on every line (no second voice exists).
- Backchannels become self-talk beats ("Yeah. No. Listen.") and listener address.`,
      };
    }
    case "interview": {
      const [interviewer, guest] = [cast[0], cast[1] ?? cast[0]];
      return {
        showDescriptor: "a sports interview podcast",
        scriptNoun: "interview script",
        dynamicsContract: `INTERVIEW CONTRACT (the engine of the show):
- ${interviewer.name} DRIVES: frames each topic, asks the question, presses the follow-up, redirects when an answer wanders. Their lines run short-to-medium.
- ${guest.name} CARRIES: longer answers with the substance, stories, and takes; they may push back on a framing they don't accept.
- The heat comes from PRESSING: the interviewer challenges a soft answer ("That's not what the numbers say—"), the guest defends or concedes. Interruptions are allowed from either chair when conviction demands it.
- No ping-pong parity: a natural interview runs roughly one-third interviewer, two-thirds guest by airtime.`,
        extraSpeechRules: "",
      };
    }
    case "roundtable": {
      const moderator = cast[0];
      const panelists = cast.slice(1);
      return {
        showDescriptor: "a moderated sports roundtable podcast",
        scriptNoun: "roundtable script",
        dynamicsContract: `ROUNDTABLE CONTRACT (the engine of the show):
- ${moderator.name} MODERATES: frames each topic in one breath, hands the floor by NAME ("${panelists[0]?.name ?? "Panelist"}, you first—"), arbitrates when voices collide, and moves the table on. Short lines; they never dominate.
- The panel (${panelists.map((p) => p.name).join(", ")}) does the arguing: each panelist argues from their OWN worldview above, takes rotate who leads each topic, and any panelist may jump on any other's take.
- Three-way (or four-way) heat is the point: side-taking, two-against-one, temporary alliances that flip on the next topic. EVERY cast member must be heard on EVERY topic at least once.
- Interruptions fly between panelists; the moderator breaks deadlocks ("Okay, okay — one at a time.").`,
        extraSpeechRules: `\nROUNDTABLE FORMAT RULES:
- The moderator hands off by name so listeners can follow who speaks next.
- Never let two consecutive topics be led by the same panelist.`,
      };
    }
    default: {
      // two_host_debate — the EXACT legacy text (do not edit: byte-stable).
      const hostA = cast[0];
      const hostB = cast[1] ?? cast[0];
      return {
        showDescriptor: "a two-host sports debate podcast",
        scriptNoun: "debate script",
        dynamicsContract: `CHEMISTRY CONTRACT (the engine of the show):
- BOTH hosts are true believers with their OWN agenda, and they collide. Each argues from their own Worldview and Argument Patterns above, each trying to WIN — neither is the straight man, neither merely reacts. ${hostB.name} drives just as hard as ${hostA.name}: he presses attacks, goes on the offensive, overreaches, and gets heated when his worldview is insulted — he can be wrong, and he does NOT just absorb ${hostA.name}'s swings and calmly deflate them. Give ${hostB.name} a stake he defends and pushes, drawn from his own worldview (a "the public is late, emotional, and wrong" markets host ATTACKS the emotional take on its own terms — he doesn't merely fact-check it from the sidelines).
- Escalation runs from EITHER chair: when a host's core belief gets attacked, THAT host escalates — heated, incredulous, raising their voice, pressing the attack. Both hosts spend time in the high-energy tones, not just one.
- Concessions are earned, not scheduled: a host concedes only when genuinely cornered, grudgingly, and the other pounces — but no one is required to concede, and stubbornly refusing to give up an obvious point is itself in character.
- They know each other. Reference shared history when it lands ("You did this exact thing during the playoffs").
- HUMOR IS ATTITUDE, NOT MATERIAL. The funny comes from the collision of the two worldviews — exasperation, exaggeration, a well-timed jab, mocking the other's framing, flatly refusing to concede something obvious. NO written setup/punchline jokes. NO pre-planned running gags and NO scheduled callbacks — a callback is allowed ONLY when it falls out naturally from something already said. Sports-radio funny is the delivery and the disdain, not a bit you insert on cue.`,
        extraSpeechRules: "",
      };
    }
  }
}
