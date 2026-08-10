// Format-driven script-prompt pieces (Prompt 7, PR 2).
//
// The script engine assembles its system prompt from these per-format pieces
// instead of a hardcoded two-host debate template. Other formats get their own
// honest dynamics contracts and are only reachable once the registry marks
// them generationReady.

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

/** One persona block per cast member. Character records may still contain old
 * signature-language arrays for history/admin display, but literal lines are
 * never handed to the writer as dialogue ammunition. A phrase list plus a
 * numeric usage allowance is a scheduled verbal tic, not characterization. */
export function castPersonaBlocks(format: ShowFormat, cast: AiHost[]): string {
  return cast
    .map((h, i) => {
      const roleLine =
        format.id === "two_host_debate"
          ? ""
          : `\n- Format Chair: ${format.roles[Math.min(i, format.roles.length - 1)].name} — ${format.roles[Math.min(i, format.roles.length - 1)].direction}`;
      const legacySignatureNote = Array.isArray(h.catchphrases) && h.catchphrases.length > 0
        ? " Legacy signature lines may exist in the database; they are reference metadata only and must never be quoted, paraphrased, scheduled, or used as dialogue."
        : "";
      // `bannedPhrases` below is ADVICE TO THE MODEL, not a gate. It is
      // interpolated into the prompt and nothing downstream rejects a script
      // for containing one of these strings. The only real enforcement of the
      // antithesis frames ("that's not X, that's Y" and its cousins) is the
      // antithesis pass in scriptService — which is exactly why that pass
      // hard-fails in production instead of warning. Adding a phrase here does
      // not block it; it only asks.
      return `Host ${i + 1}: ${h.name} (ID: ${h.id})${roleLine}
- Role: ${h.role}
- Worldview: ${h.worldview}
- Speaking Style: ${h.speakingStyle}
- Signature lines: NONE.${legacySignatureNote} Humor and identity must come from what this host notices, wants, avoids, and how they react now.
- Production metadata is SILENT: never speak host numbers, chair labels, IDs, line numbers, segment names, quoted nicknames from the profile, or role labels. Never say "line one", "line two", "host one", "host two", "chair A", or "chair B" as a show device.
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
- The argument still has shape: stake out the take -> steelman the counter ("the other side of this says...") -> knock it down or concede a piece -> land the button. The anchor argues with the listener's doubts. There is no second host to push against.
- Self-interruption replaces host interruption: false starts, "wait, actually—", rhetorical questions answered immediately. "isInterruption" is ALWAYS false — there is no second voice to overlap.
- Energy still varies: heat on the take, drop low for the aside, build again. A monologue at one energy level puts people to sleep. Move.`,
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
- ${lead.name} DRIVES: teases upcoming topics ("later this hour—"), sets the pace, hands off, and lands strong transitions. Keep the energy conversational throughout.
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
- FACT vs ANALYSIS never blur: the anchor's factual delivery is grounded in evidence; anything interpretive is clearly framed as read ("here's what that means", "my read—").${analyst ? `\n- ${analyst.name} is the ANALYST: explains what a story MEANS — implications, stakes, context — and NEVER re-reads the anchor's facts back. No forced disagreement. The analyst explains.` : ""}
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
- ${expert.name} EXPLAINS: carries the substance with longer, evidence-grounded answers. ${expert.name} is a SYNTHETIC SHOW CHARACTER: never claim real-world credentials, employment, event attendance, insider access, or first-person experience of real events; expertise lives in voice and analysis. Invent no biography.
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
- Respondents (${respondents.map((r) => r.name).join(", ")}) answer FAST: every answer lands in roughly two sentences — a HARD CAP of about 45 words per line is enforced by validation, so validation rejects oversized answers.
- No monologues, minimal filler, no wind-ups. Momentum is the show.
- Every respondent gets real participation on every category.`,
        extraSpeechRules: `\nRAPID FIRE FORMAT RULES:
- Keep EVERY line under ~45 words. Split longer thoughts into multiple quick lines only when genuinely needed.
- The moderator asks questions and calls categories. The moderator withholds their own take.`,
      };
    }
    default: {
      const hostA = cast[0];
      const hostB = cast[1] ?? cast[0];
      return {
        showDescriptor: "a two-host sports debate podcast",
        scriptNoun: "debate script",
        dynamicsContract: `CHEMISTRY CONTRACT (the engine of the show):
- BOTH hosts are true believers with their OWN agenda, and they collide. Each argues from their own Worldview and Argument Patterns above, each trying to WIN — neither is the straight man, neither merely reacts. ${hostB.name} drives just as hard as ${hostA.name}: he presses attacks, goes on the offensive, overreaches, and gets heated when his worldview is insulted — he can be wrong, and he does NOT just absorb ${hostA.name}'s swings and calmly deflate them. Give ${hostB.name} a stake he defends and pushes, drawn from his own worldview.
- Escalation runs from EITHER chair: when a host's core belief gets attacked, THAT host escalates. ESCALATION IS PRESSURE, NOT VOLUME. Read each host's Speaking Style for which direction theirs moves — one may get louder and faster; another may get quieter, shorter, and more exact. Never make a host shout to signal that they care, and never treat the quieter host as the calm one who merely reacts.
- Concessions must be earned in the moment: a host concedes only when genuinely cornered and the other pounces — but no one is required to concede, and stubbornly refusing to give up an obvious point is itself in character.
- They know each other. Reference shared history only when it genuinely changes the current exchange.
- HUMOR COMES FROM ATTITUDE. Never write a setup and a punchline. The funny comes from the collision of the two worldviews — exasperation, exaggeration, a well-timed jab, mocking the other's framing, flatly refusing to concede something obvious. NO pre-planned running gags, signature-line drops, or scheduled callbacks.
- SENTENCE SHAPE — the hard one. Do NOT build lines out of balanced negation. Banned shapes:
  "That's not X, that's Y" / "That wasn't X. That was Y." / "Same X. New Y." /
  "You just described X" / "X, not Y." / "This isn't about X, it's about Y." / "Not a X, a Y."
  You may use this shape ONCE in the entire episode, never in the first six lines, and only
  when the host has actually earned it. Every other line carries its meaning some other way:
  a number, a name, a thing that happened, a question, an interruption, or a flat refusal.
- When a host would reach for a definition, make them reach for a concrete image or consequence instead.`,
        extraSpeechRules: "",
      };
    }
  }
}
