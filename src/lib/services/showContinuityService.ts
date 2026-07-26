// Wiring the continuity engine into generation (Task 4) and enforcing it
// (Task 5).
//
// Two hard rules shape this file:
//
//   1. The generator SELECTS from state and REPORTS what it used. It never
//      invents a continuity value. Every number written back here is computed
//      from the previous state plus a bounded, validated delta.
//   2. Updates are written ONLY after the fact-check gate passes. A rejected
//      script must not advance the season — otherwise a failed generation
//      burns an arc beat, a Wolverine, and a rate-limited device, and the
//      next episode silently skips a rung nobody ever heard.

import { z } from "zod";
import { db } from "@/lib/db";
import {
  ARC_BEATS,
  AUTHORED_ARC_LENGTH,
  BADGE_LADDER_END,
  DODGE_LADDER,
  HOYT_LADDER_END,
  RATE_LIMITS,
  WOLVERINES_BANK,
  WOLVERINE_WINDOW,
  eligibleRunners,
  eligibleWolverines,
  rateLimitAllows,
  type ContinuityState,
  type EligibleRunners,
  type RateLimitKey,
} from "./showContinuity";

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

/** Get (or lazily create) the continuity row for a podcast. Standalone
 *  episodes have no podcastId and therefore no continuity — they generate
 *  exactly as they do today, which is why this returns null rather than
 *  throwing. */
export async function getOrCreateContinuity(podcastId: string | null | undefined) {
  if (!podcastId) return null;
  const existing = await db.showContinuity.findUnique({ where: { podcastId } });
  if (existing) return existing;
  return db.showContinuity.create({ data: { podcastId } });
}

// ---------------------------------------------------------------------------
// The prompt block
// ---------------------------------------------------------------------------

/**
 * Render continuity state + this episode's eligible runners as prompt text.
 *
 * Deliberately phrased as SELECTION instructions, never as "remember that…".
 * The model is given a closed list of legal choices; anything it would have to
 * invent is either absent from the list or explicitly forbidden.
 */
export function renderContinuityBlock(runners: EligibleRunners): string {
  const lines: string[] = [];

  lines.push("=== SHOW CONTINUITY (episode " + (runners.episodeIndex + 1) + ") ===");
  lines.push(
    "These are running bits with PERSISTENT state. You may only SELECT from the values below. " +
      "Never invent a continuity value, a new arc beat, a new Wolverine, or a new fact about Duane Hoyt."
  );
  lines.push("");

  // --- Every episode ---
  lines.push("REQUIRED THIS EPISODE:");
  lines.push(
    `1. ATTENDANCE FIGURE — Mulkey announces an inflated crowd figure with absurd precision, unprompted. ` +
      `Running phantom-fan total so far: ${runners.attendanceFigure.phantomFansTotal.toLocaleString()}. ` +
      (runners.attendanceFigure.lastClaim !== null
        ? `His last claim was ${runners.attendanceFigure.lastClaim.toLocaleString()} — do not reuse that number. `
        : "") +
      `Zabala looks it up live and reads the real number flat. Never round.`
  );
  lines.push(
    `2. PRONOUN HUNT — he says "we" about a franchise that never employed him, ${runners.pronounHunt.minPerEpisode}-${runners.pronounHunt.maxPerEpisode} times. ` +
      `She does NOT lecture; she says the word back as a question. His current dodge rung is "${runners.pronounHunt.currentDodge}"` +
      (runners.pronounHunt.nextDodge
        ? `; if pushed he escalates to "${runners.pronounHunt.nextDodge}".`
        : `, which is the top of the ladder — she stops catching it because it is too sad and too perfect, and the audience notices she let it go.`) +
      ` Lifetime count: ${runners.pronounHunt.lifetimeWeCount}.`
  );
  lines.push(
    runners.duaneHoyt.exhausted
      ? `3. DUANE HOYT — the arc is COMPLETE. He may still be invoked as a catchphrase, but nothing new about him may be revealed or discovered.`
      : `3. DUANE HOYT — exactly once. Current beat: ${runners.duaneHoyt.beat}`
  );
  if (runners.duaneHoyt.establishedFacts.length > 0) {
    lines.push(
      `   ESTABLISHED HOYT FACTS — these are settled and MUST NOT be contradicted:\n` +
        runners.duaneHoyt.establishedFacts.map((f) => `     - ${f}`).join("\n")
    );
  }
  lines.push(
    `4. ONE WOLVERINE from the bank, chosen from these (the rest are too recent): ` +
      runners.wolverine.eligible.join(", ") + "."
  );
  lines.push(`5. UNITY BEAT — mandatory. ${runners.unityBeat.note}`);
  lines.push("");

  // --- Conditional ---
  if (runners.arcBeat.available) {
    lines.push(`ARC BEAT DUE THIS EPISODE (beat ${runners.arcBeat.index + 1} of ${AUTHORED_ARC_LENGTH}):`);
    lines.push(`  ${runners.arcBeat.beat}`);
    lines.push("");
  }
  if (runners.badge.available && runners.badge.beat) {
    lines.push(`THE BADGE (stage ${runners.badge.stage}): ${runners.badge.beat}`);
    lines.push("");
  }

  // --- Rate limits ---
  const blocked = runners.rateLimited.filter((r) => !r.allowed);
  const open = runners.rateLimited.filter((r) => r.allowed);
  if (open.length > 0) {
    lines.push("AVAILABLE, BUT RARE — use at most one, and only if the episode genuinely earns it:");
    for (const r of open) lines.push(`  - ${r.label}`);
  }
  if (blocked.length > 0) {
    lines.push("FORBIDDEN THIS EPISODE (used too recently):");
    for (const r of blocked) {
      lines.push(`  - ${r.label} — unavailable for another ${r.cooldownEpisodes} episode(s).`);
    }
  }
  lines.push("");

  if (runners.wager.terms) {
    lines.push(
      `STANDING WAGER: ${runners.wager.terms} Leader: ${runners.wager.leader ?? "nobody yet"}. Pot: ${runners.wager.pot}.`
    );
    lines.push("");
  }

  if (runners.allLaddersExhausted) {
    lines.push(
      "NOTE: every authored arc beat has been used. This is a RUNNERS-ONLY episode — the recurring bits carry it. " +
        "Do NOT invent a new arc beat, reveal, or escalation to fill the gap."
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The structured update the generator returns alongside the script
// ---------------------------------------------------------------------------

/**
 * Bounded by construction. Note what is NOT here: no absolute totals, no
 * arbitrary stage numbers, no free-text facts about anything except Hoyt (and
 * those are append-only and checked against the established set). The model
 * reports what it DID; this module decides what that means for state.
 */
export const continuityUpdateSchema = z
  .object({
    /** The inflated figure he announced, and the real one she read back. */
    attendanceClaimed: z.number().int().min(0).max(1_000_000).nullable().default(null),
    attendanceReal: z.number().int().min(0).max(1_000_000).nullable().default(null),
    /** How many times he said "we". Capped at the per-episode maximum. */
    weSaidCount: z.number().int().min(0).max(3).default(0),
    /** Which dodge rung he ended the episode on. Must be a known rung. */
    endedOnDodge: z.enum(DODGE_LADDER).nullable().default(null),
    /** True when the top dodge rung went uncaught — triggers the backslide. */
    topDodgeUncaught: z.boolean().default(false),
    /** Did the Hoyt beat land? Advances the ladder by AT MOST one rung. */
    hoytBeatDelivered: z.boolean().default(false),
    /** New settled facts about Hoyt. Append-only; never contradicting. */
    hoytFactsAdded: z.array(z.string().min(1).max(200)).max(3).default([]),
    /** Which Wolverine was invoked. Must be from the eligible list. */
    wolverineUsed: z.string().min(1).nullable().default(null),
    /** Did the authored arc beat land? Advances by AT MOST one rung. */
    arcBeatDelivered: z.boolean().default(false),
    badgeBeatDelivered: z.boolean().default(false),
    /** Which rate-limited devices fired this episode. */
    rateLimitedFired: z.array(z.enum(["nuclearOption", "coldOpenFullRun", "uncorrectedLedger"])).default([]),
    /** Was the mandatory unity beat present? */
    unityBeatPresent: z.boolean().default(false),
    wagerTerms: z.string().max(300).nullable().default(null),
    wagerLeader: z.string().max(120).nullable().default(null),
    wagerPotDelta: z.number().int().min(0).max(100).default(0),
  })
  .strict();

export type ContinuityUpdate = z.infer<typeof continuityUpdateSchema>;

// ---------------------------------------------------------------------------
// Guards (Task 5)
// ---------------------------------------------------------------------------

export interface ContinuityViolation {
  rule: string;
  detail: string;
}

/**
 * Validate a generated episode's continuity report against the state it was
 * generated from. Returns every violation; an empty array means the script may
 * advance the season.
 */
export function checkContinuity(
  state: ContinuityState,
  update: ContinuityUpdate
): ContinuityViolation[] {
  const v: ContinuityViolation[] = [];

  // 1. Wolverine rotation.
  if (update.wolverineUsed) {
    const known = WOLVERINES_BANK.some((w) => w.name === update.wolverineUsed);
    if (!known) {
      v.push({
        rule: "wolverine:unknown",
        detail: `'${update.wolverineUsed}' is not in the Wolverines bank. The bank is fixed; the generator may not invent a teammate.`,
      });
    } else if (!eligibleWolverines(state).includes(update.wolverineUsed)) {
      const recent = state.wolverinesInvoked.slice(-WOLVERINE_WINDOW);
      v.push({
        rule: "wolverine:repeat",
        detail: `'${update.wolverineUsed}' was used inside the last ${WOLVERINE_WINDOW} episodes (recent: ${recent.join(", ")}). Pick one that is off cooldown.`,
      });
    }
  }

  // 2. Established Hoyt facts must not be contradicted. The generator may only
  //    ADD facts; a repeat of an existing fact is fine, a negation is not.
  for (const fact of update.hoytFactsAdded) {
    const contradiction = findHoytContradiction(state.hoytFactsEstablished, fact);
    if (contradiction) {
      v.push({
        rule: "hoyt:contradiction",
        detail: `New Hoyt fact "${fact}" contradicts the established "${contradiction}". Established facts are settled — she catches contradictions, that is her whole thing.`,
      });
    }
  }
  if (update.hoytFactsAdded.length > 0 && state.hoytStage > HOYT_LADDER_END) {
    v.push({
      rule: "hoyt:exhausted",
      detail: "The Hoyt arc is complete; no new facts about him may be established.",
    });
  }

  // 3. The unity beat is mandatory, every episode.
  if (!update.unityBeatPresent) {
    v.push({
      rule: "unity:missing",
      detail: "The unity beat is mandatory in every episode. Two people who only fight are exhausting.",
    });
  }

  // 4. Rate-limited devices.
  for (const key of update.rateLimitedFired) {
    if (!rateLimitAllows(state, key as RateLimitKey)) {
      const { max, window, label } = RATE_LIMITS[key as RateLimitKey];
      v.push({
        rule: `rateLimit:${key}`,
        detail: `${label} fired, but it is limited to ${max} in any ${window} episodes and that budget is spent.`,
      });
    }
  }

  // 5. Ladders may advance by at most one rung, and never past their end.
  if (update.arcBeatDelivered && state.arcBeat >= AUTHORED_ARC_LENGTH) {
    v.push({
      rule: "arc:exhausted",
      detail: `All ${AUTHORED_ARC_LENGTH} authored arc beats are spent. This must be a runners-only episode — a new beat cannot be invented.`,
    });
  }
  if (update.badgeBeatDelivered && state.badgeStage > BADGE_LADDER_END) {
    v.push({ rule: "badge:exhausted", detail: "The badge ladder is complete." });
  }

  // 6. Attendance: the claim must exceed the real figure. He inflates; he has
  //    never once rounded and never once undersold.
  if (update.attendanceClaimed !== null && update.attendanceReal !== null) {
    if (update.attendanceClaimed <= update.attendanceReal) {
      v.push({
        rule: "attendance:not-inflated",
        detail: `Claimed ${update.attendanceClaimed} but the real figure is ${update.attendanceReal}. The bit is that he INFLATES.`,
      });
    }
    if (update.attendanceClaimed % 10 === 0) {
      v.push({
        rule: "attendance:rounded",
        detail: `${update.attendanceClaimed} is a round number. The joke is the precision — he has never once rounded.`,
      });
    }
  }
  if (update.attendanceClaimed !== null && update.attendanceClaimed === state.lastAttendanceClaim) {
    v.push({
      rule: "attendance:repeat",
      detail: `${update.attendanceClaimed} is the same figure as last episode. Each night gets its own invented number.`,
    });
  }

  return v;
}

/**
 * Contradiction detection for Hoyt facts.
 *
 * Deliberately conservative: it flags a NEGATION of an established fact, not
 * mere similarity. A false positive here blocks a legitimate script, so the
 * bar is a direct polarity flip on an otherwise-matching statement rather than
 * anything resembling semantic inference.
 */
export function findHoytContradiction(established: string[], candidate: string): string | null {
  const cand = polarity(candidate);

  for (const fact of established) {
    const f = polarity(fact);
    // A contradiction requires OPPOSITE polarity on an otherwise-matching
    // claim. That polarity requirement is what keeps false positives near
    // zero: elaborating on a fact ("...in the rain") never flips polarity, so
    // it can never be mistaken for a contradiction no matter how similar.
    if (cand.negated !== f.negated && (cand.core === f.core || overlapRatio(cand.core, f.core) >= 0.75)) {
      return fact;
    }
  }
  return null;
}

const NEGATORS = /\b(not|never|no|none|isn'?t|wasn'?t|aren'?t|weren'?t|didn'?t|doesn'?t|don'?t|hasn'?t|hadn'?t|haven'?t|cannot|can'?t|won'?t)\b/g;
/** Auxiliaries carry no content but do change surface form ("did not catch" vs
 *  "caught"), so they are stripped before comparison. */
const AUXILIARIES = /\b(did|does|do|has|have|had|is|was|were|are|am|be|been|being|will|would|can|could)\b/g;

function polarity(s: string): { negated: boolean; core: string } {
  const norm = s.toLowerCase().replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  const negated = new RegExp(NEGATORS.source).test(norm);
  const core = norm
    .replace(NEGATORS, " ")
    .replace(AUXILIARIES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { negated, core };
}

function overlapRatio(a: string, b: string): number {
  const A = new Set(a.split(" ").filter((w) => w.length > 2));
  const B = new Set(b.split(" ").filter((w) => w.length > 2));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(A.size, B.size);
}

// ---------------------------------------------------------------------------
// Applying updates — ONLY after the fact-check gate passes
// ---------------------------------------------------------------------------

/** The next state, computed from the previous state plus a validated delta.
 *  Pure, so the arithmetic is testable without a database. */
export function nextContinuityState(
  state: ContinuityState,
  update: ContinuityUpdate
): ContinuityState {
  const episodeIndex = state.episodeCount;

  // CYCLE: the dodge ladder climbs, then backslides to "we" once the top rung
  // survives an episode uncaught. The reset is the bit.
  const currentDodge = update.topDodgeUncaught
    ? DODGE_LADDER[0]
    : update.endedOnDodge ?? state.currentDodge;

  // LADDERS advance by at most one rung and clamp at their authored end.
  const hoytStage =
    update.hoytBeatDelivered && state.hoytStage <= HOYT_LADDER_END
      ? state.hoytStage + 1
      : state.hoytStage;
  const arcBeat =
    update.arcBeatDelivered && state.arcBeat < AUTHORED_ARC_LENGTH
      ? state.arcBeat + 1
      : state.arcBeat;
  const badgeStage =
    update.badgeBeatDelivered && state.badgeStage <= BADGE_LADDER_END
      ? state.badgeStage + 1
      : state.badgeStage;

  // COUNTER: phantom fans accumulate forever. Getting absurd is the joke.
  const phantom =
    update.attendanceClaimed !== null && update.attendanceReal !== null
      ? Math.max(0, update.attendanceClaimed - update.attendanceReal)
      : 0;

  // RATE LIMITS: append this episode's index for each device that fired.
  const appendFiring = (log: number[], key: RateLimitKey) =>
    update.rateLimitedFired.includes(key) ? [...log, episodeIndex] : log;

  return {
    episodeCount: state.episodeCount + 1,
    phantomFansTotal: state.phantomFansTotal + phantom,
    lastAttendanceClaim: update.attendanceClaimed ?? state.lastAttendanceClaim,
    lastAttendanceReal: update.attendanceReal ?? state.lastAttendanceReal,
    weCount: state.weCount + update.weSaidCount,
    weCountThisEpisode: 0, // CYCLE: reset at the episode boundary
    currentDodge,
    hoytStage,
    hoytFactsEstablished: [...state.hoytFactsEstablished, ...update.hoytFactsAdded],
    arcBeat,
    badgeStage,
    wolverinesInvoked: update.wolverineUsed
      ? [...state.wolverinesInvoked, update.wolverineUsed]
      : state.wolverinesInvoked,
    lastWolverineUsed: update.wolverineUsed ?? state.lastWolverineUsed,
    nuclearOptionFirings: appendFiring(state.nuclearOptionFirings, "nuclearOption"),
    coldOpenFullRuns: appendFiring(state.coldOpenFullRuns, "coldOpenFullRun"),
    uncorrectedLedgerRuns: appendFiring(state.uncorrectedLedgerRuns, "uncorrectedLedger"),
    wagerTerms: update.wagerTerms ?? state.wagerTerms,
    wagerLeader: update.wagerLeader ?? state.wagerLeader,
    wagerPot: state.wagerPot + update.wagerPotDelta,
  };
}

/**
 * Persist a validated continuity update.
 *
 * MUST be called only after the fact-check gate passes. Refuses to write when
 * the update violates continuity, so a rejected script cannot advance the
 * season — that would burn an arc beat, a Wolverine and a rate-limited device
 * on an episode nobody ever hears.
 */
export async function applyContinuityUpdate(
  podcastId: string,
  rawUpdate: unknown
): Promise<{ ok: true; state: ContinuityState } | { ok: false; violations: ContinuityViolation[] }> {
  const parsed = continuityUpdateSchema.safeParse(rawUpdate);
  if (!parsed.success) {
    return {
      ok: false,
      violations: parsed.error.issues.map((i) => ({
        rule: "update:malformed",
        detail: `${i.path.join(".") || "(root)"}: ${i.message}`,
      })),
    };
  }

  const row = await getOrCreateContinuity(podcastId);
  if (!row) {
    return { ok: false, violations: [{ rule: "continuity:missing", detail: `No podcast '${podcastId}'.` }] };
  }

  const violations = checkContinuity(row, parsed.data);
  if (violations.length > 0) return { ok: false, violations };

  const next = nextContinuityState(row, parsed.data);
  await db.showContinuity.update({ where: { podcastId }, data: next });
  return { ok: true, state: next };
}

/** Convenience: state + this episode's eligible runners + the prompt block. */
export async function continuityForGeneration(podcastId: string | null | undefined) {
  const row = await getOrCreateContinuity(podcastId);
  if (!row) return null;
  const runners = eligibleRunners(row);
  return { state: row as ContinuityState, runners, promptBlock: renderContinuityBlock(runners) };
}

export { ARC_BEATS };
