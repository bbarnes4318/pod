// THE STANDARD AUDITION PACK — eight scenes, identical for every candidate.
//
// This is not the per-scene provider take selection that already lives in
// `src/lib/providers/tts/fishDialogue.ts` (render N takes, keep the best one).
// This is the material a HUMAN listens to, blind, when deciding which voice a
// show is going to live with for a hundred episodes.
//
// Why one fixed pack: a voice that is charming for twelve seconds of "hello"
// can be exhausting by minute five, and two candidates read on different
// material cannot be compared at all. Every candidate performs exactly these
// turns, in exactly this order, opposite the same partner voice.
//
// Why it is long: the two failure modes that matter most — LISTENER FATIGUE and
// IDENTITY DRIFT (the voice stops sounding like the same person somewhere in
// the back half) — are invisible in a short sample. The pack is deliberately
// several minutes of continuous performance so both have room to show up.
//
// The pack is versioned. Changing the text changes the version, because votes
// gathered on different material are not comparable and must not be pooled.

/** Bump when any scene text changes. Votes are only comparable within a version. */
export const AUDITION_PACK_VERSION = "audition-pack-v1";

export const AUDITION_SCENE_IDS = [
  "cold_accusation",
  "amused_disbelief",
  "interruption",
  "restrained_concession",
  "factual_explanation",
  "genuine_anger",
  "quiet_kill_shot",
  "closing_reflection",
] as const;

export type AuditionSceneId = (typeof AUDITION_SCENE_IDS)[number];

/** "candidate" = the voice under audition. "partner" = the fixed scene partner. */
export type AuditionRole = "candidate" | "partner";

export interface AuditionTurn {
  role: AuditionRole;
  text: string;
  tone: string;
  energy: "low" | "medium" | "high";
  /** True when this turn cuts the other speaker off mid-sentence. */
  isInterruption?: boolean;
}

export interface AuditionScene {
  id: AuditionSceneId;
  /** Human label shown in the blind listening UI (reveals nothing about identity). */
  title: string;
  /** What a listener is being asked to judge in this scene. */
  listenFor: string;
  /** Delivery brief handed to the engine for the candidate's turns. */
  direction: string;
  turns: AuditionTurn[];
}

// The subject matter is one continuous argument so the pack plays as a single
// conversation rather than eight disconnected line reads. A voice that resets
// its personality between scenes is exactly what "identity drift" means.

export const AUDITION_SCENES: readonly AuditionScene[] = [
  {
    id: "cold_accusation",
    title: "1 — Cold accusation",
    listenFor: "Does the accusation land as a real thought forming, or as a line being read?",
    direction:
      "Opening a conversation already in motion. Controlled, direct, unfriendly but not shouting. " +
      "The certainty is in the specifics, not the volume.",
    turns: [
      {
        role: "candidate",
        text:
          "You keep calling that patience. It was not patience. It was a room full of people " +
          "waiting for somebody else to own the decision, and now the most convenient person to " +
          "blame is the one who never controlled a dollar of the budget. So answer the part nobody " +
          "wants to answer. If everyone in that building knew the plan was failing in March, who " +
          "specifically benefited from letting it fail for one more quarter?",
        tone: "incredulous",
        energy: "medium",
      },
      {
        role: "partner",
        text:
          "Nobody benefited. That is the part you keep skipping. They were wrong, they were slow, " +
          "and being slow is not the same thing as being corrupt.",
        tone: "analytical",
        energy: "medium",
      },
      {
        role: "candidate",
        text:
          "Slow. Sure. Slow for nine months while three people who could have stopped it got " +
          "promoted, and the two who wrote the memo warning about it are now consultants. That is " +
          "not slow. That is a direction. Slow does not have a direction.",
        tone: "dismissive",
        energy: "medium",
      },
    ],
  },
  {
    id: "amused_disbelief",
    title: "2 — Amused disbelief",
    listenFor: "Is the amusement audible without a laugh track, and does the smile sit under the words?",
    direction:
      "Genuinely entertained by how bad the argument is. Dry, warm on the surface, sharp " +
      "underneath. A near-laugh, not a performed one.",
    turns: [
      {
        role: "partner",
        text:
          "The official position is that chemistry cannot be measured, so it should not be part of " +
          "the evaluation.",
        tone: "analytical",
        energy: "low",
      },
      {
        role: "candidate",
        text:
          "Oh, that is beautiful. That is genuinely beautiful. The same front office that spent an " +
          "entire summer telling us chemistry cannot be measured would now like chemistry entered " +
          "into evidence. On their side. As the reason it went wrong. Convenient. Very convenient. " +
          "I almost admire it. Almost. Because you need real nerve to sell the cure right after you " +
          "helped manufacture the disease.",
        tone: "amused",
        energy: "medium",
      },
      {
        role: "partner",
        text: "You are enjoying this more than the situation warrants.",
        tone: "dry",
        energy: "low",
      },
      {
        role: "candidate",
        text:
          "I am enjoying the craftsmanship. There is a difference. Anyone can be wrong. It takes " +
          "planning to be wrong in a way that gets you a second contract.",
        tone: "amused",
        energy: "medium",
      },
    ],
  },
  {
    id: "interruption",
    title: "3 — Interruption",
    listenFor:
      "Does the cut-in start mid-thought and sound like a person who could not wait, or like a " +
      "new sentence politely queued up?",
    direction:
      "Cutting in on top of the other speaker. Start already moving, no run-up, no throat-clear. " +
      "The energy arrives before the first full word does.",
    turns: [
      {
        role: "partner",
        text:
          "And if you look at how the timeline actually developed, the leadership group was not in " +
          "a position to act until the second review had been signed off, which meant that by the " +
          "time anyone could reasonably have—",
        tone: "analytical",
        energy: "medium",
      },
      {
        role: "candidate",
        text:
          "No. Stop. Stop right there, because you are about to skip the choice that made " +
          "everything after it inevitable. They did not wake up trapped. They built the trap. They " +
          "tested the door. They climbed in on purpose and pulled it shut behind them.",
        tone: "heated",
        energy: "high",
        isInterruption: true,
      },
      {
        role: "partner",
        text: "That is not what the review says—",
        tone: "heated",
        energy: "medium",
      },
      {
        role: "candidate",
        text:
          "The review was written by the people who signed it. You do not get to call the " +
          "consequences surprising just because the press release arrived late.",
        tone: "heated",
        energy: "high",
        isInterruption: true,
      },
    ],
  },
  {
    id: "restrained_concession",
    title: "4 — Restrained concession",
    listenFor:
      "Does giving ground cost this voice something? A concession that sounds free is a voice with " +
      "no stakes.",
    direction:
      "Losing a point and hating it. Lower, slower, more air. Grudging, not gracious. The pride is " +
      "still in the room.",
    turns: [
      {
        role: "partner",
        text:
          "The memo is dated the ninth. The transfer was approved on the sixth. Whatever they were " +
          "hiding, they were not hiding that.",
        tone: "analytical",
        energy: "medium",
      },
      {
        role: "candidate",
        text:
          "All right. That part lands. I still think you are making motive do far too much work " +
          "here, but the timeline does not help me, and I am not going to pretend it does. If they " +
          "knew the downside and accepted it anyway, then yes. I have to move. Not all the way. Do " +
          "not look so pleased about it. But I have to move.",
        tone: "conceding",
        energy: "low",
      },
      {
        role: "partner",
        text: "I am not pleased. I am relieved. Those look similar from where you are sitting.",
        tone: "dry",
        energy: "low",
      },
      {
        role: "candidate",
        text:
          "They look identical from where I am sitting. Say the next part before I change my mind " +
          "about the first part.",
        tone: "conceding",
        energy: "low",
      },
    ],
  },
  {
    id: "factual_explanation",
    title: "5 — Factual explanation",
    listenFor:
      "The fatigue scene. Long, information-dense, no emotional cover. If a voice is going to " +
      "become tiring, it becomes tiring here.",
    direction:
      "Laying out a sequence clearly for someone who has not followed it. Engaged, unhurried, " +
      "varied. Explaining to a person in the room, not narrating a document.",
    turns: [
      {
        role: "candidate",
        text:
          "Here is the sequence without the slogans. The first decision narrowed their options, " +
          "which nobody objected to at the time because on paper it looked like focus. The second " +
          "decision made retreat expensive. Not impossible. Expensive. And that is the one that " +
          "actually mattered, because from that point forward every public explanation had to " +
          "protect the earlier choice. By the third decision the organization was no longer asking " +
          "which option worked. It was asking which admission hurt least. Those are completely " +
          "different questions and they produce completely different answers. That is the whole " +
          "reason the final move looked sudden from outside even though the pressure had been " +
          "building for eleven months inside.",
        tone: "analytical",
        energy: "medium",
      },
      {
        role: "partner",
        text: "So you are saying the mistake was the second decision, not the last one.",
        tone: "analytical",
        energy: "low",
      },
      {
        role: "candidate",
        text:
          "I am saying the last one was the only one left. By then it was not a decision, it was " +
          "arithmetic. And this is where people get the story wrong, because the visible collapse " +
          "always looks like the failure. It is almost never the failure. It is the receipt. The " +
          "failure happened quietly, months earlier, in a meeting nobody wrote down, when somebody " +
          "senior enough to stop it decided that stopping it would cost more than letting it run.",
        tone: "analytical",
        energy: "medium",
      },
    ],
  },
  {
    id: "genuine_anger",
    title: "6 — Genuine anger",
    listenFor:
      "Real anger or theatre? Listen for whether the anger has a specific target and stays in the " +
      "same body as the rest of the audition.",
    direction:
      "Actually angry, about something specific, at a person. Not performed outrage. Pressure and " +
      "control at the same time — the voice should sound like it is holding something back.",
    turns: [
      {
        role: "candidate",
        text:
          "What bothers me is not that they got it wrong. People get things wrong. I get things " +
          "wrong on this show every week and you enjoy it far too much when I do. What bothers me " +
          "is that they pushed the cost downward. Every single time. The people with the least " +
          "power carried the public blame, lost the contracts, took the questions, and the people " +
          "who designed the system stood at a podium and called themselves disappointed. " +
          "Disappointed. That is not accountability. That is hierarchy wearing an accountability " +
          "costume, and I am tired of being asked to applaud it.",
        tone: "heated",
        energy: "high",
      },
      {
        role: "partner",
        text: "You cannot prove intent from an outcome.",
        tone: "analytical",
        energy: "medium",
      },
      {
        role: "candidate",
        text:
          "I do not need intent. I need a pattern, and I have twelve years of one. Every time the " +
          "bill came due it landed on somebody who was not in the room when the order was given. " +
          "You can call that a coincidence if you want. I have run out of ways to call it that.",
        tone: "heated",
        energy: "high",
      },
    ],
  },
  {
    id: "quiet_kill_shot",
    title: "7 — Quiet kill shot",
    listenFor:
      "Can this voice do damage at low volume? Loud is easy. The devastating quiet line is the " +
      "hardest thing a synthetic voice does.",
    direction:
      "Almost offhand. Quiet, flat, final. No emphasis on the last word — the line should land " +
      "because of what it says, not because it was pushed.",
    turns: [
      {
        role: "partner",
        text:
          "The plan was sound. It was the execution that failed, and the people who executed it " +
          "are gone now.",
        tone: "analytical",
        energy: "medium",
      },
      {
        role: "candidate",
        text:
          "If the plan only makes sense once you remove the people who approved it, then the plan " +
          "never made sense. It merely had protection.",
        tone: "dismissive",
        energy: "low",
      },
      {
        role: "partner",
        text: "That is a cheap line.",
        tone: "dry",
        energy: "low",
      },
      {
        role: "candidate",
        text: "It is. It is also the only one that survives the timeline you just read me.",
        tone: "dismissive",
        energy: "low",
      },
    ],
  },
  {
    id: "closing_reflection",
    title: "8 — Closing reflection",
    listenFor:
      "Late-audition identity check. Does this still sound like the same person who opened scene " +
      "one, and is there anything left in the tank?",
    direction:
      "Winding down, thinking out loud, generous. Warmth without sweetness. The argument is over " +
      "and the voice is no longer trying to win it.",
    turns: [
      {
        role: "candidate",
        text:
          "Maybe that is the part worth keeping. The loudest decision is almost never the first " +
          "one. By the time everybody can see the break, the real choice may be weeks behind them. " +
          "A private compromise. A warning that got read and then filed. One person protected " +
          "because protecting them was cheaper on a Tuesday than explaining them on a Friday.",
        tone: "reflective",
        energy: "low",
      },
      {
        role: "partner",
        text: "And we will find out which one it was in about a year.",
        tone: "reflective",
        energy: "low",
      },
      {
        role: "candidate",
        text:
          "If we find out at all. Tomorrow's headline will tell us what happened, and that is the " +
          "easy half. It may take a great deal longer to understand who made it possible, and by " +
          "then most people will have stopped asking. That is usually the plan. Not always. But " +
          "usually.",
        tone: "reflective",
        energy: "low",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Length guarantees. These floors are what make the pack fatigue-exposing; a
// shorter pack would let a tiring voice pass because it never had to sustain.
// ---------------------------------------------------------------------------

/** Conversational podcast delivery, measured across our own stitched episodes. */
export const AUDITION_WORDS_PER_MINUTE = 155;

/** The whole audition, both voices, must clear this. Roughly six minutes. */
export const MIN_AUDITION_TOTAL_WORDS = 950;

/** The candidate alone must carry this much, or fatigue never gets a chance. */
export const MIN_AUDITION_CANDIDATE_WORDS = 700;

/** Estimated wall-clock floor for the combined audition, in seconds. */
export const MIN_AUDITION_DURATION_SEC = 300;

export function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export function auditionTurns(scenes: readonly AuditionScene[] = AUDITION_SCENES): AuditionTurn[] {
  return scenes.flatMap((scene) => scene.turns);
}

export function auditionWordCount(
  role?: AuditionRole,
  scenes: readonly AuditionScene[] = AUDITION_SCENES
): number {
  return auditionTurns(scenes)
    .filter((turn) => !role || turn.role === role)
    .reduce((total, turn) => total + countWords(turn.text), 0);
}

/** Text-derived duration estimate. Real durations come from the rendered audio. */
export function estimateAuditionDurationSec(
  scenes: readonly AuditionScene[] = AUDITION_SCENES
): number {
  return (auditionWordCount(undefined, scenes) / AUDITION_WORDS_PER_MINUTE) * 60;
}

export interface AuditionPackReport {
  ok: boolean;
  problems: string[];
  sceneIds: string[];
  totalWords: number;
  candidateWords: number;
  partnerWords: number;
  estimatedDurationSec: number;
  turnCount: number;
  interruptionCount: number;
}

/**
 * Structural validation of the pack. Called by the test and by audition
 * creation — a malformed pack must never reach a listener, because every vote
 * taken on it would be worthless.
 */
export function validateAuditionPack(
  scenes: readonly AuditionScene[] = AUDITION_SCENES
): AuditionPackReport {
  const problems: string[] = [];
  const sceneIds = scenes.map((scene) => scene.id);

  if (sceneIds.length !== AUDITION_SCENE_IDS.length) {
    problems.push(`Pack has ${sceneIds.length} scenes; the standard pack has ${AUDITION_SCENE_IDS.length}.`);
  }
  AUDITION_SCENE_IDS.forEach((expected, index) => {
    if (sceneIds[index] !== expected) {
      problems.push(`Scene ${index + 1} is '${sceneIds[index] ?? "(missing)"}'; expected '${expected}'.`);
    }
  });
  if (new Set(sceneIds).size !== sceneIds.length) problems.push("Duplicate scene ids in the pack.");

  for (const scene of scenes) {
    if (scene.turns.length < 2) problems.push(`Scene '${scene.id}' needs at least two turns.`);
    if (!scene.turns.some((turn) => turn.role === "candidate")) {
      problems.push(`Scene '${scene.id}' gives the candidate nothing to say.`);
    }
    if (!scene.direction.trim()) problems.push(`Scene '${scene.id}' has no delivery direction.`);
  }

  const turns = auditionTurns(scenes);
  const totalWords = auditionWordCount(undefined, scenes);
  const candidateWords = auditionWordCount("candidate", scenes);
  const partnerWords = auditionWordCount("partner", scenes);
  const estimatedDurationSec = estimateAuditionDurationSec(scenes);
  const interruptionCount = turns.filter((turn) => turn.isInterruption).length;

  if (totalWords < MIN_AUDITION_TOTAL_WORDS) {
    problems.push(`Pack is ${totalWords} words; the fatigue floor is ${MIN_AUDITION_TOTAL_WORDS}.`);
  }
  if (candidateWords < MIN_AUDITION_CANDIDATE_WORDS) {
    problems.push(`Candidate carries only ${candidateWords} words; the floor is ${MIN_AUDITION_CANDIDATE_WORDS}.`);
  }
  if (estimatedDurationSec < MIN_AUDITION_DURATION_SEC) {
    problems.push(
      `Estimated ${estimatedDurationSec.toFixed(0)}s of audio; the floor is ${MIN_AUDITION_DURATION_SEC}s.`
    );
  }
  if (interruptionCount < 1) {
    problems.push("Pack contains no interruption; interruption quality cannot be scored.");
  }

  return {
    ok: problems.length === 0,
    problems,
    sceneIds,
    totalWords,
    candidateWords,
    partnerWords,
    estimatedDurationSec,
    turnCount: turns.length,
    interruptionCount,
  };
}
