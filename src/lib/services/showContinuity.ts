// The continuity engine — what turns a hundred disconnected episodes into a
// season.
//
// Design rule, from which everything here follows: THE MODEL NEVER INVENTS A
// CONTINUITY VALUE. It selects from state and reports what it used; this module
// computes the next state. A generator that could author its own continuity
// would drift, contradict itself, and re-reveal beats the audience has already
// heard — which is exactly the failure the engine exists to prevent.
//
// Every field is one of five kinds, and the kind determines the update rule:
//
//   COUNTER    monotonic, never resets, no boundary.
//   LADDER     one-shot rungs, monotonic, TERMINATES. On reaching the authored
//              end the show falls back to runners-only episodes. Nothing here
//              generates a new rung — an exhausted arc is a signal to a human,
//              not a prompt to improvise.
//   CYCLE      advances, then deliberately resets. The reset is the bit.
//   RATE LIMIT rolling window over episode indices. Stored as the indices where
//              it fired, so scarcity holds forever with no season boundary.
//   ROTATION   bounded recency — full history kept, a window does the work.
//
// There is no season concept anywhere in this file. See the ShowContinuity
// model comment for why.

import type { ShowContinuity } from "@prisma/client";

// ---------------------------------------------------------------------------
// Authored content. These are FIXED lists. Nothing at runtime appends to them.
// ---------------------------------------------------------------------------

/** The Wolverines bank. One per episode, no repeat inside WOLVERINE_WINDOW. */
export const WOLVERINES_BANK = [
  { name: "Duane Hoyt", position: "WR", detail: "The standard against which every living athlete is found wanting" },
  { name: "Petey Vandersloot", position: "K", detail: "Afraid of the ball. Mulkey calls this a mental-toughness triumph" },
  { name: "Big Ed Mazurek", position: "OL", detail: "Ran bail bonds out of the north lot. Several teammates were clients" },
  { name: "Coach Wendell Ott", position: "HC", detail: "Communicated only in nods. Mulkey claims he was the interpreter" },
  { name: "Tito Bramlett", position: "QB", detail: "Lived in the equipment room. Mulkey frames it as commitment" },
  { name: 'Randy "The Deacon" Pike', position: "LB", detail: "Preached at halftime. Attendance mandatory. Mulkey attended" },
  { name: "Marcus Ludd", position: "DB", detail: "One NFL preseason camp. Mulkey's sole proof the pipeline worked" },
  { name: "Skeeter Ganns", position: "Mascot", detail: "Mulkey's nemesis. Twenty years of beef. NEVER explain why" },
  { name: "Delbert Hoyt", position: "—", detail: "Duane's brother. Allegedly better. Never played a down" },
  { name: "Dolores Prine", position: "Ticketing", detail: "The only person who could confirm any of this. Won't return calls" },
] as const;

export const WOLVERINE_WINDOW = 6;

/** LADDER. Each rung fires once. Index === hoytStage. */
export const HOYT_LADDER = [
  "Pure catchphrase, ignored.",
  "She asks who that is. Two minutes of unverifiable answer.",
  "She tries to look him up. Nothing.",
  "She says she thinks he's made up. Mulkey is GENUINELY wounded — the first real crack.",
  'He produces "evidence": a crowd photo. He points at a blur.',
  "She finds a 2004 program. Hoyt is real, listed 5'9\" 170. She is FURIOUS about being wrong.",
  "He's an orthodontist in Tulsa. Four games, one catch, no memory of Mulkey. Mulkey only hears that Duane Hoyt is doing great, and is overjoyed.",
] as const;
export const HOYT_LADDER_END = HOYT_LADDER.length - 1;

/** LADDER. Index === badgeStage. */
export const BADGE_LADDER = [
  "He references the 2004 credential like a Super Bowl ring.",
  "He describes it, and the details change slightly from last time.",
  "He brings it in. It's a parking pass.",
  "He argues the parking pass was harder to get, for four minutes, persuasively, and she has no counter.",
] as const;
export const BADGE_LADDER_END = BADGE_LADDER.length - 1;

/** CYCLE. He climbs; when the top rung survives one episode uncaught, he
 *  backslides to "we" and it starts over. The reset is the bit. */
export const DODGE_LADDER = [
  "we",
  "the organization",
  "our group",
  "those of us who were in the building",
  "the Wolverines family",
] as const;

/** LADDER. The authored season-one beats, in order. arcBeat indexes this. */
export const ARC_BEATS = [
  "Establish. The bits land as bits. The standing wager is set.",
  "She asks who Duane Hoyt actually is. Nothing checkable.",
  "The ledger goes public: she announces the running phantom-fan total. He's proud of it.",
  '"I think Duane Hoyt is made up." He goes actually quiet, then louder than he has ever been. First time the audience feels bad for him.',
  "The badge. It's a parking pass. He wins the argument anyway.",
  "Unity episode. A front office runs a leak. Full segment, no fighting, best episode yet, neither acknowledges it after.",
  "She finds the 2004 program. Hoyt is real. She is furious about being wrong.",
  "THE CONTRACTOR EPISODE. She finds the staff directory: he's under Game Presentation, a contractor. He doesn't crumble — \"Well, sure.\" He knew, and it never mattered, because he was THERE. SHE is the one destroyed.",
  "Recovery. Never discussed. She's softer. She lets a 'we' go. He notices and says nothing.",
  "FINALE. Hoyt found. Mulkey only hears that he's doing great and announces it as the biggest call of his life. She lets him finish, and doesn't correct the attendance figure. He loses the wager in the sign-off; the last sound of the season is her laughing.",
] as const;
export const AUTHORED_ARC_LENGTH = ARC_BEATS.length;

/** RATE LIMITS. `max` firings within the last `window` episodes. */
export const RATE_LIMITS = {
  nuclearOption: { max: 2, window: 20, label: '"You weren\'t there"' },
  coldOpenFullRun: { max: 1, window: 20, label: "She lets him finish the cold open" },
  uncorrectedLedger: { max: 1, window: 20, label: "She lets an attendance figure go uncorrected" },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;

/** Which ContinuityState field stores each rate-limited device's firing log. */
const RATE_LIMIT_FIELD = {
  nuclearOption: "nuclearOptionFirings",
  coldOpenFullRun: "coldOpenFullRuns",
  uncorrectedLedger: "uncorrectedLedgerRuns",
} as const satisfies Record<RateLimitKey, string>;

// ---------------------------------------------------------------------------
// Pure helpers — no database, unit-testable.
// ---------------------------------------------------------------------------

/** A continuity row's shape without requiring a real Prisma row (tests). */
export type ContinuityState = Pick<
  ShowContinuity,
  | "episodeCount" | "phantomFansTotal" | "lastAttendanceClaim" | "lastAttendanceReal"
  | "weCount" | "weCountThisEpisode" | "currentDodge"
  | "hoytStage" | "hoytFactsEstablished" | "arcBeat" | "badgeStage"
  | "wolverinesInvoked" | "lastWolverineUsed"
  | "nuclearOptionFirings" | "coldOpenFullRuns" | "uncorrectedLedgerRuns"
  | "wagerTerms" | "wagerLeader" | "wagerPot"
>;

export const EMPTY_CONTINUITY: ContinuityState = {
  episodeCount: 0,
  phantomFansTotal: 0,
  lastAttendanceClaim: null,
  lastAttendanceReal: null,
  weCount: 0,
  weCountThisEpisode: 0,
  currentDodge: null,
  hoytStage: 0,
  hoytFactsEstablished: [],
  arcBeat: 0,
  badgeStage: 0,
  wolverinesInvoked: [],
  lastWolverineUsed: null,
  nuclearOptionFirings: [],
  coldOpenFullRuns: [],
  uncorrectedLedgerRuns: [],
  wagerTerms: null,
  wagerLeader: null,
  wagerPot: 0,
};

/**
 * RATE LIMIT check. True when the device may fire on the episode about to be
 * generated (index = state.episodeCount, 0-based).
 *
 * The window is measured from the UPCOMING episode's index, so a firing at
 * index 0 with window 20 blocks again until index 20 — scarcity that holds
 * forever with no boundary and no reset job.
 */
export function rateLimitAllows(state: ContinuityState, key: RateLimitKey): boolean {
  const { max, window } = RATE_LIMITS[key];
  const firings = state[RATE_LIMIT_FIELD[key]] ?? [];
  const upcoming = state.episodeCount;
  const recent = firings.filter((i) => i > upcoming - window);
  return recent.length < max;
}

/** Episodes remaining until a maxed-out rate-limited device is available. */
export function rateLimitCooldown(state: ContinuityState, key: RateLimitKey): number {
  if (rateLimitAllows(state, key)) return 0;
  const { window } = RATE_LIMITS[key];
  const firings = [...(state[RATE_LIMIT_FIELD[key]] ?? [])].sort((a, b) => a - b);
  const recent = firings.filter((i) => i > state.episodeCount - window);
  // Available once the OLDEST blocking firing falls out of the window.
  return Math.max(0, recent[0] + window - state.episodeCount);
}

/** ROTATION. Wolverines not used within the last WOLVERINE_WINDOW episodes. */
export function eligibleWolverines(state: ContinuityState): string[] {
  const recent = new Set(state.wolverinesInvoked.slice(-WOLVERINE_WINDOW));
  const eligible = WOLVERINES_BANK.map((w) => w.name).filter((n) => !recent.has(n));
  // The bank (10) is larger than the window (6), so this can never empty. The
  // guard is here so a future bank/window edit fails loudly instead of
  // silently starving the runner.
  if (eligible.length === 0) {
    throw new Error(
      `Wolverines bank exhausted: every one of ${WOLVERINES_BANK.length} was used inside the last ` +
        `${WOLVERINE_WINDOW} episodes. The bank must be larger than the no-repeat window.`
    );
  }
  return eligible;
}

/** LADDER exhaustion. An exhausted arc is reported, never improvised past. */
export interface LadderStatus {
  key: "arc" | "hoyt" | "badge";
  current: number;
  end: number;
  exhausted: boolean;
  /** The beat text for the CURRENT rung, or null once exhausted. */
  beat: string | null;
}

export function ladderStatuses(state: ContinuityState): LadderStatus[] {
  return [
    {
      key: "arc", current: state.arcBeat, end: AUTHORED_ARC_LENGTH - 1,
      exhausted: state.arcBeat >= AUTHORED_ARC_LENGTH,
      beat: state.arcBeat < AUTHORED_ARC_LENGTH ? ARC_BEATS[state.arcBeat] : null,
    },
    {
      key: "hoyt", current: state.hoytStage, end: HOYT_LADDER_END,
      exhausted: state.hoytStage > HOYT_LADDER_END,
      beat: state.hoytStage <= HOYT_LADDER_END ? HOYT_LADDER[state.hoytStage] : null,
    },
    {
      key: "badge", current: state.badgeStage, end: BADGE_LADDER_END,
      exhausted: state.badgeStage > BADGE_LADDER_END,
      beat: state.badgeStage <= BADGE_LADDER_END ? BADGE_LADDER[state.badgeStage] : null,
    },
  ];
}

/** True when every authored ladder is spent — the show is runners-only until a
 *  human authors more beats. This is a REPORT, not a trigger for generation. */
export function arcExhausted(state: ContinuityState): boolean {
  return ladderStatuses(state).every((l) => l.exhausted);
}

// ---------------------------------------------------------------------------
// The eligible-runners list handed to the generator.
// ---------------------------------------------------------------------------

export interface EligibleRunners {
  episodeIndex: number;
  /** Every episode. */
  attendanceFigure: { required: true; phantomFansTotal: number; lastClaim: number | null };
  /** Every episode, 1-3 times. */
  pronounHunt: { required: true; minPerEpisode: number; maxPerEpisode: number; currentDodge: string; nextDodge: string | null; lifetimeWeCount: number };
  /** Every episode, exactly once. */
  duaneHoyt: { required: true; stage: number; beat: string | null; establishedFacts: string[]; exhausted: boolean };
  /** One per episode, rotated. */
  wolverine: { required: true; eligible: string[] };
  /** Every episode, mandatory. */
  unityBeat: { required: true; note: string };
  /** Only when a rung is due. */
  arcBeat: { available: boolean; index: number; beat: string | null; exhausted: boolean };
  badge: { available: boolean; stage: number; beat: string | null; exhausted: boolean };
  /** Rate-limited devices, with cooldowns for the ones that are blocked. */
  rateLimited: Array<{ key: RateLimitKey; label: string; allowed: boolean; cooldownEpisodes: number }>;
  wager: { terms: string | null; leader: string | null; pot: number };
  /** True when every ladder is spent: runners-only episode, by design. */
  allLaddersExhausted: boolean;
}

export function eligibleRunners(state: ContinuityState): EligibleRunners {
  const ladders = ladderStatuses(state);
  const arc = ladders.find((l) => l.key === "arc")!;
  const hoyt = ladders.find((l) => l.key === "hoyt")!;
  const badge = ladders.find((l) => l.key === "badge")!;

  const dodgeIndex = Math.max(0, DODGE_LADDER.indexOf((state.currentDodge ?? DODGE_LADDER[0]) as (typeof DODGE_LADDER)[number]));
  const nextDodge = dodgeIndex + 1 < DODGE_LADDER.length ? DODGE_LADDER[dodgeIndex + 1] : null;

  return {
    episodeIndex: state.episodeCount,
    attendanceFigure: {
      required: true,
      phantomFansTotal: state.phantomFansTotal,
      lastClaim: state.lastAttendanceClaim,
    },
    pronounHunt: {
      required: true,
      minPerEpisode: 1,
      maxPerEpisode: 3,
      currentDodge: DODGE_LADDER[dodgeIndex],
      nextDodge,
      lifetimeWeCount: state.weCount,
    },
    duaneHoyt: {
      required: true,
      stage: state.hoytStage,
      beat: hoyt.beat,
      establishedFacts: state.hoytFactsEstablished,
      exhausted: hoyt.exhausted,
    },
    wolverine: { required: true, eligible: eligibleWolverines(state) },
    unityBeat: {
      required: true,
      note:
        "The leak launderers. She hates them for carrying water for ownership; he hates them because in nineteen years not one ever quoted him. Same enemy, different reason, and neither has noticed the other's reason.",
    },
    arcBeat: { available: !arc.exhausted, index: state.arcBeat, beat: arc.beat, exhausted: arc.exhausted },
    badge: { available: !badge.exhausted, stage: state.badgeStage, beat: badge.beat, exhausted: badge.exhausted },
    rateLimited: (Object.keys(RATE_LIMITS) as RateLimitKey[]).map((key) => ({
      key,
      label: RATE_LIMITS[key].label,
      allowed: rateLimitAllows(state, key),
      cooldownEpisodes: rateLimitCooldown(state, key),
    })),
    wager: { terms: state.wagerTerms, leader: state.wagerLeader, pot: state.wagerPot },
    allLaddersExhausted: arcExhausted(state),
  };
}
