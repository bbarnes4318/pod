// Wiring the continuity engine into generation, and enforcing it.
//
// Three hard rules shape this file:
//
//   1. The generator SELECTS from state and REPORTS what it used. It never
//      invents a continuity value. Every value written back here is computed
//      from the previous state plus a bounded, validated delta.
//   2. Updates are written ONLY after the fact-check gate passes. A rejected
//      script must not advance the season — otherwise a failed generation
//      burns a Red Eye layer, and the next episode silently skips a layer
//      nobody ever heard.
//   3. NOTHING IS MANDATORY. An episode that uses no continuity device at all
//      is valid and produces zero violations. The guards exist to stop the
//      generator from inventing, repeating, or misusing continuity — never to
//      force a device into an episode that did not earn it.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { PRODUCED_OR_LATER } from "@/lib/episodeStatus";
import {
  EMPTY_CONTEXT,
  EMPTY_CONTINUITY,
  LEDGER_PHRASES,
  POSITION_RELEVANCE_THRESHOLD,
  RATE_LIMITS,
  RED_EYE_LADDER_END,
  RED_EYE_LAYERS,
  continuityOpportunities,
  describeRelationship,
  normalizeTopicKey,
  rateLimitAllows,
  readLedger,
  readPositions,
  redEyeTopicEligible,
  topicOverlap,
  type ContinuityContext,
  type ContinuityOpportunities,
  type ContinuityState,
  type LedgerEntry,
  type PositionEntry,
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

const FICTION_BOUNDARY =
  "Cal's career history is FICTIONAL and COMPOSITE. Never attach it to a real player, a real team, " +
  "a real executive, or a real event. Never present it as evidence about the story being discussed. " +
  "Never imply Cal has private knowledge about any real person. It is character history, not reporting.";

/**
 * Render continuity state as prompt text.
 *
 * Deliberately phrased as PERMISSION, never as a requirement. The word
 * "required" does not appear in this block and must not be reintroduced: the
 * previous engine's mandatory-device language is what produced episodes that
 * sounded like a checklist being worked through. The model is given a closed
 * list of things it MAY use, and an explicit, unembarrassed permission to use
 * none of them.
 */
export function renderContinuityBlock(opps: ContinuityOpportunities): string {
  const lines: string[] = [];

  lines.push("=== SHOW CONTINUITY (episode " + (opps.episodeIndex + 1) + ") ===");
  lines.push(
    "This show has a memory. Everything below is OPTIONAL. You may only SELECT from these values — " +
      "never invent a continuity value, a new Red Eye layer, a prior position, or a phrase Cal has not " +
      "actually used on this show. At most ONE of these may carry real weight in this episode, and using " +
      "NONE is a legitimate, frequently correct choice: a strong episode about the story in front of them " +
      "beats a weak episode that services the season."
  );
  lines.push("");

  // --- What may carry weight this episode ---
  switch (opps.featured) {
    case "redEye":
      lines.push("AVAILABLE THIS EPISODE — THE RED EYE FILE (this topic genuinely touches it):");
      lines.push(`  Next layer, and ONLY this layer: ${opps.redEye.layer}`);
      lines.push(
        "  Use it only if the conversation arrives there on its own. If it would have to be steered there, skip it."
      );
      if (opps.redEye.alreadyDisclosed.length > 0) {
        lines.push("  ALREADY CONFESSED — never confess any of these again, in any wording:");
        for (const d of opps.redEye.alreadyDisclosed) lines.push(`    - ${d}`);
      }
      lines.push(`  ${FICTION_BOUNDARY}`);
      break;
    case "languageRecall":
      lines.push("AVAILABLE THIS EPISODE — THE LANGUAGE LEDGER:");
      lines.push(
        "  Zabala may bring ONE of these back, because this topic is the same kind of story he used it on. " +
          "This is not a gotcha counter. It is her asking whether he still believes the sentence."
      );
      for (const e of opps.languageLedger.relevant.slice(-4)) {
        lines.push(`    - "${e.phrase}" (episode ${e.episodeIndex + 1}${e.context ? `, on ${e.context}` : ""}; ${e.status})`);
      }
      break;
    case "positionCallback":
      lines.push("AVAILABLE THIS EPISODE — A PRIOR POSITION:");
      lines.push(
        "  ONE of these may return, and only if it changes the current argument — creates tension, exposes " +
          "a contradiction, or pays something off. Never recall a position merely to prove the show remembers."
      );
      for (const p of opps.positions.relevant.slice(-4)) {
        lines.push(`    - ${p.host === "cal" ? "Cal" : "Zabala"}, episode ${p.episodeIndex + 1}: ${p.position}`);
      }
      break;
    case "none":
      lines.push("NOTHING FROM THE SEASON IS DUE THIS EPISODE.");
      lines.push(
        "  No callback, no confession, no recalled phrase. Write the story in front of them. " +
          "Do not manufacture a continuity moment to fill this space."
      );
      break;
  }
  lines.push("");

  // --- Why the heavy device is unavailable, when it is ---
  if (opps.featured !== "redEye") {
    const why =
      opps.redEye.blockedBy === "exhausted"
        ? "every authored layer has been revealed; the file is closed and nothing new about it may be invented"
        : opps.redEye.blockedBy === "topic"
          ? "this episode is not about scapegoating, leaks, or an organization protecting itself"
          : opps.redEye.blockedBy === "cooldown"
            ? `it was used too recently (available again in ${opps.redEye.cooldownEpisodes} episode(s))`
            : "it is not due";
    lines.push(`THE RED EYE FILE IS NOT AVAILABLE: ${why}.`);
    lines.push(
      "  Cal may still be a man with a history — that is in his voice — but he does not confess, hint at a " +
        "confession, or reference the file this episode."
    );
    lines.push("");
  }

  // --- Background the writer should know, but must not service ---
  if (opps.languageLedger.entries.length > 0) {
    lines.push("ON RECORD (background — do NOT work through this list):");
    for (const e of opps.languageLedger.entries.slice(-6)) {
      lines.push(`  - "${e.phrase}" — ${e.status}${e.context ? ` (${e.context})` : ""}`);
    }
    lines.push(
      "  A phrase already marked rejected or revised is settled. Cal does not un-reject it and Zabala does not re-litigate it."
    );
    lines.push("");
  }

  lines.push("WHERE THEY STAND:");
  lines.push(`  ${describeRelationship(opps.relationship)}`);
  if (opps.relationship.openThread) {
    lines.push(`  Still hanging between them: ${opps.relationship.openThread}`);
  }
  lines.push(
    "  Never state any of this as narration and never quantify it. It decides how they talk to each other, not what they say about each other."
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The structured update the generator returns alongside the script
// ---------------------------------------------------------------------------

const ledgerReport = z
  .object({
    phrase: z.string().min(2).max(80),
    context: z.string().max(160).default(""),
  })
  .strict();

const positionReport = z
  .object({
    host: z.enum(["cal", "zabala"]),
    topicKey: z.string().max(240).default(""),
    position: z.string().min(4).max(240),
  })
  .strict();

/**
 * Bounded by construction. Note what is NOT here: no absolute totals, no
 * arbitrary stage numbers, no free-text history about anything except the ONE
 * new Red Eye layer (append-only, checked against what has already been
 * confessed).
 *
 * EVERY FIELD DEFAULTS TO EMPTY. An episode that used no continuity device
 * reports an object of defaults and passes every guard — that is the point.
 */
export const continuityUpdateSchema = z
  .object({
    /** Did the Red Eye layer actually land? Advances the ladder by AT MOST one. */
    redEyeLayerDelivered: z.boolean().default(false),
    /** The NEW thing he admitted, in one sentence. Required when a layer lands. */
    redEyeDisclosure: z.string().min(8).max(220).nullable().default(null),
    /** Institutional phrases Cal reached for this episode. */
    languageUsed: z.array(ledgerReport).max(3).default([]),
    /** Phrases he later took back or rewrote, by exact phrase. */
    languageResolved: z
      .array(z.object({ phrase: z.string().min(2).max(80), resolution: z.enum(["rejected", "revised"]) }).strict())
      .max(3)
      .default([]),
    /** A phrase Zabala pulled back out of the ledger. Must already be on record. */
    languageRecalled: z.string().min(2).max(80).nullable().default(null),
    /** Positions either host actually argued, worth remembering. */
    positionsTaken: z.array(positionReport).max(4).default([]),
    /** A prior position brought back. Must already be in position memory. */
    positionRecalled: z
      .object({ host: z.enum(["cal", "zabala"]), position: z.string().min(4).max(240) })
      .strict()
      .nullable()
      .default(null),
    /** Compact relationship movement. Bounded so nothing can be inflated. */
    relationship: z
      .object({
        trustDelta: z.number().int().min(-2).max(2).default(0),
        calDisclosed: z.boolean().default(false),
        calRationalized: z.boolean().default(false),
        zabalaOverreached: z.boolean().default(false),
        positionChangedBy: z.enum(["cal", "zabala", "none"]).default("none"),
        openThread: z.string().max(240).nullable().default(null),
      })
      .strict()
      .default({}),
  })
  .strict();

export type ContinuityUpdate = z.infer<typeof continuityUpdateSchema>;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export interface ContinuityViolation {
  rule: string;
  detail: string;
}

/**
 * Validate a generated episode's continuity report against the state it was
 * generated from. Returns every violation; an empty array means the script may
 * advance the season.
 *
 * There is no "missing device" rule and there must never be one. The only
 * things rejected here are invention, repetition, and misuse.
 */
export function checkContinuity(
  state: ContinuityState,
  update: ContinuityUpdate,
  ctx: ContinuityContext = EMPTY_CONTEXT
): ContinuityViolation[] {
  const v: ContinuityViolation[] = [];

  // 1. The Red Eye File.
  if (update.redEyeLayerDelivered) {
    if (state.redEyeStage > RED_EYE_LADDER_END) {
      v.push({
        rule: "redEye:exhausted",
        detail: `All ${RED_EYE_LAYERS.length} authored Red Eye layers are spent. The file is closed; a new layer cannot be invented.`,
      });
    }
    if (!rateLimitAllows(state, "redEyeLayer")) {
      const { max, window } = RATE_LIMITS.redEyeLayer;
      v.push({
        rule: "redEye:cooldown",
        detail: `A Red Eye layer landed, but it is limited to ${max} in any ${window} episodes and that budget is spent. The confession is the heaviest thing the show owns; spending it every week makes it weightless.`,
      });
    }
    if (!redEyeTopicEligible(ctx.topicText)) {
      v.push({
        rule: "redEye:not-eligible",
        detail:
          "A Red Eye layer landed on an episode whose topics do not touch scapegoating, leaks, or an organization protecting itself. " +
          "An unearned confession is a tic, not continuity.",
      });
    }
    if (!update.redEyeDisclosure) {
      v.push({
        rule: "redEye:missing-disclosure",
        detail: "A layer was reported as delivered but nothing new was actually admitted. Report the new admission or report no layer.",
      });
    } else {
      const repeat = findRepeatedDisclosure(state.redEyeDisclosures, update.redEyeDisclosure);
      if (repeat) {
        v.push({
          rule: "redEye:repeat",
          detail: `"${update.redEyeDisclosure}" is the same confession as "${repeat}". Each layer reveals something NEW; re-confessing is how a character arc becomes a running bit.`,
        });
      }
    }
  } else if (update.redEyeDisclosure) {
    v.push({
      rule: "redEye:disclosure-without-beat",
      detail: "A new admission was reported without the layer being delivered. State cannot advance on a confession that did not happen.",
    });
  }

  // 2. The Language Ledger: recall must reference something actually on record.
  if (update.languageRecalled) {
    const ledger = readLedger(state.languageLedger);
    const found = ledger.find((e) => e.phrase.toLowerCase() === update.languageRecalled!.toLowerCase());
    if (!found) {
      v.push({
        rule: "language:unknown-recall",
        detail: `"${update.languageRecalled}" is not in the ledger. Zabala can only throw back a phrase Cal actually used on this show.`,
      });
    } else if (!rateLimitAllows(state, "languageRecall")) {
      const { max, window } = RATE_LIMITS.languageRecall;
      v.push({
        rule: "language:cooldown",
        detail: `A ledger recall fired, but it is limited to ${max} in any ${window} episodes. Repeated recall turns evidence of change into a catchphrase.`,
      });
    }
  }
  for (const r of update.languageResolved) {
    const ledger = readLedger(state.languageLedger);
    const known =
      ledger.some((e) => e.phrase.toLowerCase() === r.phrase.toLowerCase()) ||
      update.languageUsed.some((e) => e.phrase.toLowerCase() === r.phrase.toLowerCase());
    if (!known) {
      v.push({
        rule: "language:unknown-resolution",
        detail: `"${r.phrase}" was marked ${r.resolution} but is not on record and was not used this episode.`,
      });
    }
  }

  // 3. Position callbacks must be real AND relevant.
  if (update.positionRecalled) {
    const positions = readPositions(state.positionMemory);
    const match = positions.find(
      (p) => p.host === update.positionRecalled!.host && sameStatement(p.position, update.positionRecalled!.position)
    );
    if (!match) {
      v.push({
        rule: "position:unknown-recall",
        detail: `No prior episode has ${update.positionRecalled.host} taking that position. A callback to something that never happened is a fabricated season.`,
      });
    } else {
      if (ctx.topicText && topicOverlap(match.topicKey, ctx.topicText) < POSITION_RELEVANCE_THRESHOLD) {
        v.push({
          rule: "position:irrelevant-callback",
          detail:
            "A prior position was recalled on an unrelated topic. A callback is only continuity when it advances THIS conversation; otherwise it is a receipt being waved.",
        });
      }
      if (!rateLimitAllows(state, "positionCallback")) {
        const { max, window } = RATE_LIMITS.positionCallback;
        v.push({
          rule: "position:cooldown",
          detail: `A position callback fired, but it is limited to ${max} in any ${window} episodes.`,
        });
      }
    }
  }

  return v;
}

/**
 * Repeat detection for Red Eye confessions.
 *
 * Deliberately conservative in the OPPOSITE direction from a contradiction
 * check: here a false negative (letting a near-repeat through) costs one dull
 * episode, while a false positive blocks a legitimate new layer. The bar is
 * high token overlap on the content words, which catches a re-worded version of
 * the same admission without catching a genuinely new one that happens to share
 * vocabulary with it.
 */
export function findRepeatedDisclosure(established: string[], candidate: string): string | null {
  const cand = contentTokens(candidate);
  if (cand.size === 0) return null;
  for (const prior of established) {
    const p = contentTokens(prior);
    if (p.size === 0) continue;
    let shared = 0;
    for (const w of cand) if (p.has(w)) shared++;
    if (shared / Math.max(cand.size, p.size) >= 0.7) return prior;
  }
  return null;
}

function contentTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

/** Two statements are "the same position" when their content words mostly agree. */
function sameStatement(a: string, b: string): boolean {
  const A = contentTokens(a);
  const B = contentTokens(b);
  if (A.size === 0 || B.size === 0) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(A.size, B.size) >= 0.5;
}

// ---------------------------------------------------------------------------
// Applying updates — ONLY after the fact-check gate passes
// ---------------------------------------------------------------------------

const LEDGER_CAP = 40;
const POSITION_CAP = 60;

/** The next state, computed from the previous state plus a validated delta.
 *  Pure, so the arithmetic is testable without a database. */
export function nextContinuityState(
  state: ContinuityState,
  update: ContinuityUpdate
): ContinuityState {
  const episodeIndex = state.episodeCount;

  // LADDER: advances by at most one layer and clamps at the authored end.
  const advanced = update.redEyeLayerDelivered && state.redEyeStage <= RED_EYE_LADDER_END;
  const redEyeStage = advanced ? state.redEyeStage + 1 : state.redEyeStage;
  const redEyeDisclosures =
    advanced && update.redEyeDisclosure
      ? [...state.redEyeDisclosures, update.redEyeDisclosure]
      : state.redEyeDisclosures;

  // LOG: append what he said, then apply any resolutions on top, so a phrase
  // used and taken back inside one episode lands as "rejected" rather than
  // leaving a stale "used" row behind it.
  const ledger: LedgerEntry[] = [...readLedger(state.languageLedger)];
  for (const used of update.languageUsed) {
    ledger.push({
      phrase: used.phrase.trim(),
      episodeIndex,
      context: used.context.trim(),
      status: "used",
    });
  }
  for (const res of update.languageResolved) {
    for (const entry of ledger) {
      if (entry.phrase.toLowerCase() === res.phrase.toLowerCase()) entry.status = res.resolution;
    }
  }

  const positions: PositionEntry[] = [...readPositions(state.positionMemory)];
  for (const p of update.positionsTaken) {
    positions.push({
      host: p.host,
      episodeIndex,
      topicKey: normalizeTopicKey(p.topicKey || p.position),
      position: p.position.trim(),
    });
  }

  // RATE LIMITS: append this episode's index for each device that fired.
  const appendFiring = (log: number[], fired: boolean) => (fired ? [...log, episodeIndex] : log);

  const rel = update.relationship;
  return {
    episodeCount: state.episodeCount + 1,
    redEyeStage,
    redEyeDisclosures,
    redEyeFirings: appendFiring(state.redEyeFirings, advanced),
    languageLedger: ledger.slice(-LEDGER_CAP),
    languageRecallFirings: appendFiring(state.languageRecallFirings, update.languageRecalled !== null),
    positionMemory: positions.slice(-POSITION_CAP),
    positionCallbackFirings: appendFiring(state.positionCallbackFirings, update.positionRecalled !== null),
    trustLevel: clamp(state.trustLevel + rel.trustDelta, -5, 5),
    calDisclosureCount: state.calDisclosureCount + (rel.calDisclosed ? 1 : 0),
    calRationalizationCount: state.calRationalizationCount + (rel.calRationalized ? 1 : 0),
    zabalaOverreachCount: state.zabalaOverreachCount + (rel.zabalaOverreached ? 1 : 0),
    positionChangeCount: state.positionChangeCount + (rel.positionChangedBy === "none" ? 0 : 1),
    // An open thread persists until something replaces it. Silence does not
    // close it — a thread that quietly evaporates is the same as no memory.
    openThread: rel.openThread ?? state.openThread,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------------
// TWO-PHASE COMMIT
//
// Writing continuity when fact-check passes is too early. A script can clear
// fact-check and then die in audio generation, and the increment has already
// burned a Red Eye layer — episode N+1 opens at layer 4 having never delivered
// layer 3, with nothing to reconcile it.
//
// So:
//   PHASE 1 (fact-check passes) — record what the episode CLAIMED on the
//     episode row. Nothing global moves.
//   PHASE 2 (the audio exists)  — fold every produced episode's claim, in
//     order, and write the result to ShowContinuity.
//
// The fold is the source of truth; the ShowContinuity row is a cache of it.
// That is what makes a failed generation, a deleted episode, or a bug in the
// increment logic recoverable rather than silent permanent damage.
// ---------------------------------------------------------------------------

/**
 * The terminal boundary continuity commits on: the final audio exists, so this
 * episode is going to be heard.
 *
 * This is NOT a copy of the produced-or-later set — it IS that set, imported
 * from the single canonical definition in @/lib/episodeStatus. Season
 * progression depends on this boundary, and a duplicated literal would fail
 * silently in both directions: add a status to the ladder and continuity either
 * commits too early or stops committing, with nothing raised.
 *
 * Deliberately NOT gated on `published`: publishing is an operator decision,
 * and gating narrative progression on it would let unpublished episodes pile up
 * and re-deliver the same layer, producing near-duplicate episodes.
 */
export const CONTINUITY_COMMITTED_STATUSES = [...PRODUCED_OR_LATER] as const;

/**
 * PHASE 1. Record what this episode claimed. Validates against the state the
 * episode was generated from and refuses to store a violating claim, so a bad
 * script never enters the fold.
 */
export async function recordEpisodeContinuityClaim(
  episodeId: string,
  rawUpdate: unknown,
  ctx: ContinuityContext = EMPTY_CONTEXT
): Promise<{ ok: true; update: ContinuityUpdate } | { ok: false; violations: ContinuityViolation[] }> {
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

  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    select: { id: true, podcastId: true },
  });
  if (!episode) {
    return { ok: false, violations: [{ rule: "episode:missing", detail: `No episode '${episodeId}'.` }] };
  }
  // Standalone episodes have no podcast and therefore no continuity.
  if (!episode.podcastId) return { ok: true, update: parsed.data };

  const state = await foldContinuity(episode.podcastId, episodeId);
  const violations = checkContinuity(state, parsed.data, ctx);
  if (violations.length > 0) return { ok: false, violations };

  await db.episode.update({
    where: { id: episodeId },
    data: { continuityUpdate: parsed.data as object },
  });
  return { ok: true, update: parsed.data };
}

/**
 * Re-derive continuity by folding every PRODUCED episode's stored claim in
 * creation order. This is the source of truth.
 *
 * `excludeEpisodeId` lets a not-yet-produced episode compute the state it is
 * being generated against without counting itself.
 */
export async function foldContinuity(
  podcastId: string,
  excludeEpisodeId?: string
): Promise<ContinuityState> {
  const episodes = await db.episode.findMany({
    where: {
      podcastId,
      status: { in: [...CONTINUITY_COMMITTED_STATUSES] },
      continuityUpdate: { not: Prisma.JsonNull },
      ...(excludeEpisodeId ? { id: { not: excludeEpisodeId } } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, continuityUpdate: true },
  });

  let state: ContinuityState = { ...EMPTY_CONTINUITY };
  for (const ep of episodes) {
    const parsed = continuityUpdateSchema.safeParse(ep.continuityUpdate);
    if (!parsed.success) {
      // A stored claim that no longer parses (schema changed under it) is
      // skipped rather than silently mis-folded, and said out loud.
      console.warn(
        `[Continuity] Episode ${ep.id} has a stored claim that no longer validates; skipping it in the fold. ` +
          `Continuity for podcast ${podcastId} will be short by this episode until it is repaired.`
      );
      continue;
    }
    state = nextContinuityState(state, parsed.data);
  }
  return state;
}

/** The subset of ContinuityState that maps 1:1 onto ShowContinuity columns. */
function toRow(s: ContinuityState) {
  return {
    episodeCount: s.episodeCount,
    redEyeStage: s.redEyeStage,
    redEyeDisclosures: s.redEyeDisclosures,
    redEyeFirings: s.redEyeFirings,
    languageLedger: s.languageLedger as Prisma.InputJsonValue,
    languageRecallFirings: s.languageRecallFirings,
    positionMemory: s.positionMemory as Prisma.InputJsonValue,
    positionCallbackFirings: s.positionCallbackFirings,
    trustLevel: s.trustLevel,
    calDisclosureCount: s.calDisclosureCount,
    calRationalizationCount: s.calRationalizationCount,
    zabalaOverreachCount: s.zabalaOverreachCount,
    positionChangeCount: s.positionChangeCount,
    openThread: s.openThread,
  };
}

/**
 * PHASE 2. Recompute from the fold and write the cache. Idempotent — running it
 * twice is the same as running it once, which is what makes it safe to call
 * from a retried job, and safe as the repair path after an episode is deleted.
 */
export async function commitContinuity(podcastId: string): Promise<ContinuityState> {
  const folded = await foldContinuity(podcastId);
  const row = toRow(folded);
  await db.showContinuity.upsert({
    where: { podcastId },
    create: { podcastId, ...row },
    update: row,
  });
  return folded;
}

/**
 * Repair path. An episode being deleted or rolled back does not subtract — it
 * recomputes, because subtraction cannot restore a consumed ladder layer's
 * position relative to the ones after it.
 */
export async function reconcileContinuity(podcastId: string): Promise<{
  drifted: boolean;
  before: ContinuityState | null;
  after: ContinuityState;
}> {
  const before = (await db.showContinuity.findUnique({ where: { podcastId } })) as ContinuityState | null;
  const after = await commitContinuity(podcastId);
  const drifted = before ? JSON.stringify(normalizeForCompare(before)) !== JSON.stringify(normalizeForCompare(after)) : true;
  if (drifted && before) {
    console.warn(
      `[Continuity] Podcast ${podcastId} had drifted from the fold and was repaired. ` +
        `episodeCount ${before.episodeCount} -> ${after.episodeCount}, redEyeStage ${before.redEyeStage} -> ${after.redEyeStage}.`
    );
  }
  return { drifted, before, after };
}

/** Compare only the continuity fields, in a stable key order. */
export function normalizeForCompare(s: ContinuityState): ContinuityState {
  return {
    episodeCount: s.episodeCount,
    redEyeStage: s.redEyeStage,
    redEyeDisclosures: s.redEyeDisclosures,
    redEyeFirings: s.redEyeFirings,
    languageLedger: readLedger(s.languageLedger),
    languageRecallFirings: s.languageRecallFirings,
    positionMemory: readPositions(s.positionMemory),
    positionCallbackFirings: s.positionCallbackFirings,
    trustLevel: s.trustLevel,
    calDisclosureCount: s.calDisclosureCount,
    calRationalizationCount: s.calRationalizationCount,
    zabalaOverreachCount: s.zabalaOverreachCount,
    positionChangeCount: s.positionChangeCount,
    openThread: s.openThread,
  };
}

/**
 * The single place the generation system prompt is composed.
 *
 * Exists so the composition is testable and so there is exactly ONE way to
 * build the prompt that goes to the model. A previous edit left the composed
 * prompt computed but unused at both call sites, and every test still passed
 * because none of them asserted the prompt reaches the LLM.
 *
 * `null` block (kill switch off, or a standalone episode with no podcast)
 * returns the base prompt BYTE-IDENTICALLY — that identity is what makes the
 * kill switch a true no-op rather than a subtly different prompt.
 */
export function composeGenerationSystemPrompt(base: string, continuityBlock: string | null): string {
  if (!continuityBlock) return base;
  return `${base}\n\n${continuityBlock}`;
}

/** Convenience: state + this episode's optional devices + the prompt block. */
export async function continuityForGeneration(
  podcastId: string | null | undefined,
  ctx: ContinuityContext = EMPTY_CONTEXT
) {
  const row = await getOrCreateContinuity(podcastId);
  if (!row) return null;
  const opportunities = continuityOpportunities(row as ContinuityState, ctx);
  return {
    state: row as ContinuityState,
    context: ctx,
    opportunities,
    promptBlock: renderContinuityBlock(opportunities),
  };
}

export { RED_EYE_LAYERS, LEDGER_PHRASES };
export type { RateLimitKey };
