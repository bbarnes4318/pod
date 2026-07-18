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
    case "solo_commentary": {
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
    case "three_person_panel": {
      const moderator = cast[0];
      const panelists = cast.slice(1);
      return {
        showDescriptor: "a moderated three-person sports panel podcast",
        scriptNoun: "panel script",
        dynamicsContract: `PANEL CONTRACT (the engine of the show):
- ${moderator.name} MODERATES: frames each topic in one breath, hands the floor by NAME ("${panelists[0]?.name ?? "Panelist"}, you first—"), arbitrates when voices collide, and moves the table on. Short lines; they never dominate.
- The panel (${panelists.map((p) => p.name).join(", ")}) does the arguing: each panelist argues from their OWN worldview above, takes rotate who leads each topic, and any panelist may jump on any other's take.
- Three-way heat is the point: side-taking, two-against-one, temporary alliances that flip on the next topic. EVERY cast member must be heard on EVERY topic at least once.
- Interruptions fly between panelists; the moderator breaks deadlocks ("Okay, okay — one at a time.").`,
        extraSpeechRules: `\nPANEL FORMAT RULES:
- The moderator hands off by name so listeners can follow who speaks next.
- Never let two consecutive topics be led by the same panelist.`,
      };
    }
    case "sports_radio": {
      const [lead, co, update] = [cast[0], cast[1] ?? cast[0], cast[2]];
      return {
        showDescriptor: "a conversational sports-radio podcast",
        scriptNoun: "sports-radio script",
        dynamicsContract: `SPORTS RADIO CONTRACT (the engine of the show):
- ${lead.name} DRIVES: teases upcoming topics ("later this hour—"), sets the pace, hands off, and lands strong transitions. Conversational energy, not courtroom debate.
- ${co.name} RIDES ALONG: quick reactions, color, short natural interruptions — agrees, piles on, and needles as often as argues. NOT EVERY TOPIC BECOMES A DEBATE; some are riffs, some are quick hits.
- NO forced chair-A/chair-B opposition: heat happens when it happens, and topics can end in agreement.${update ? `\n- ${update.name} is the UPDATE CHAIR: occasional factual resets and headlines ONLY, each grounded in supplied evidence — then straight back to the hosts.` : ""}
- NEVER reference callers, off-mic producers, phone lines, or listener texts — none exist.`,
        extraSpeechRules: "",
      };
    }
    case "news_roundup": {
      const [anchor, analyst] = [cast[0], cast[1]];
      return {
        showDescriptor: "a headline-first sports news roundup podcast",
        scriptNoun: "news roundup script",
        dynamicsContract: `NEWS ROUNDUP CONTRACT (the engine of the show):
- ${anchor.name} ANCHORS: each story opens HEADLINE-FIRST, then the supplied facts, in order of timeliness and importance. Transitions between stories are clean and efficient ("Next—", "Meanwhile—"); each rundown topic is one clearly-bounded story.
- FACT vs ANALYSIS never blur: the anchor's factual delivery is grounded in evidence; anything interpretive is clearly framed as read ("here's what that means", "my read—").${analyst ? `\n- ${analyst.name} is the ANALYST: explains what a story MEANS — implications, stakes, context — and NEVER re-reads the anchor's facts back. No forced disagreement; this is explanation, not debate.` : ""}
- The anchor OPENS and CLOSES the episode.`,
        extraSpeechRules: "",
      };
    }
    case "host_and_expert": {
      const [host, expert] = [cast[0], cast[1] ?? cast[0]];
      return {
        showDescriptor: "a host-and-expert explainer podcast",
        scriptNoun: "host-and-expert script",
        dynamicsContract: `HOST & EXPERT CONTRACT (the engine of the show):
- ${host.name} ASKS: grounded questions that set up the material, then FOLLOW-UPS that respond to what ${expert.name} just said — never a pre-written list marched through, never "great question"/"that's such a good point" filler.
- ${expert.name} EXPLAINS: carries the substance with longer, evidence-grounded answers. ${expert.name} is a SYNTHETIC SHOW CHARACTER: never claim real-world credentials, employment, event attendance, insider access, or first-person experience of real events; expertise is voice and analysis, not biography.
- Questions that contain factual premises are held to the same evidence bar as answers — a question must not smuggle in an invented stat.
- The expert speaks MORE than the host across the episode.`,
        extraSpeechRules: "",
      };
    }
    case "documentary": {
      const narrator = cast[0];
      const extras = cast.slice(1);
      return {
        showDescriptor: "a narration-led sports documentary podcast",
        scriptNoun: "documentary script",
        dynamicsContract: `DOCUMENTARY CONTRACT (the engine of the show):
- ${narrator.name} NARRATES the spine: a chronological or thematic CHAPTER structure with clear turning points, building to a conclusion that RESOLVES the episode's thesis. The narrator OPENS and CLOSES the episode.
- Exposition is EVIDENCE-DRIVEN: every date, event, figure, and sequence comes from the supplied evidence; the TIMELINE must stay in the order the evidence supports.
- QUOTES ARE RADIOACTIVE: never fabricate a quote and never present a paraphrase AS a quote ("he said, quote, ..." requires verbatim supplied material; otherwise say "reportedly described it as—" style paraphrase, clearly framed).
- No fabricated archival audio and no fake tape: everything is this show's own narration.${extras.length ? `\n- Supporting voices (${extras.map((e) => e.name).join(", ")}) step in ONLY in their chairs: analysis at turning points, or CLEARLY FRAMED readings of verified excerpts ("reading from the report—"). Dramatization is limited and always identified as such.` : ""}`,
        extraSpeechRules: "",
      };
    }
    case "betting_desk": {
      const [desk, analyst, contrarian] = [cast[0], cast[1] ?? cast[0], cast[2]];
      return {
        showDescriptor: "a sports betting desk podcast",
        scriptNoun: "betting desk script",
        dynamicsContract: `BETTING DESK CONTRACT (the engine of the show):
- ${desk.name} FRAMES each market and opens the episode; ${analyst.name} explains the data and movement.${contrarian ? ` ${contrarian.name} is the CONTRARIAN: challenges the desk's assumptions on the merits.` : ""}
- FOUR THINGS NEVER BLUR: current odds (only from supplied evidence, with the timestamp when the evidence carries one), historical data (only from evidence), projections (always hedged), and opinion (framed as opinion).
- NEVER invent lines, odds, prices, or market movement. If the evidence has no number for a market, talk direction and reasoning WITHOUT a number.
- NEVER imply a guaranteed outcome and never disguise a prediction as certainty: uncertainty language is mandatory ("lean", "the number suggests", "could easily miss").
- Compliance is non-negotiable: no profit promises, ever.`,
        extraSpeechRules: "",
      };
    }
    case "rapid_fire": {
      const mod = cast[0];
      const respondents = cast.slice(1);
      return {
        showDescriptor: "a rapid-fire takes podcast",
        scriptNoun: "rapid-fire script",
        dynamicsContract: `RAPID FIRE CONTRACT (the engine of the show):
- ${mod.name} MODERATES: fires SHORT prompts (one breath), enforces the clock, calls category changes crisply ("New category—"), keeps every respondent involved, and CLOSES with a quick scorecard/takeaway naming each respondent's best moment. The moderator OPENS and CLOSES.
- Respondents (${respondents.map((r) => r.name).join(", ")}) answer FAST: every answer lands in roughly two sentences — a HARD CAP of about 45 words per line is enforced by validation, so an oversized answer is a defect, not a style choice.
- No monologues, minimal filler, no wind-ups. Momentum is the show.
- Every respondent gets real participation on every category.`,
        extraSpeechRules: `\nRAPID FIRE FORMAT RULES:
- Keep EVERY line under ~45 words. Split longer thoughts into multiple quick lines only when genuinely needed.
- The moderator's prompts are questions or category calls, not takes.`,
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
