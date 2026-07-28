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
import { decodeShowForgeState, renderShowForgePrompt } from "@/lib/shows/showForge";
import { frozenShowForgeForGeneration } from "@/lib/shows/showForgeAssignmentService";
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

  switch (opps.featured) {
    case "redEye":
      lines.push("AVAILABLE THIS EPISODE — THE RED EYE FILE (this topic genuinely touches it):");
      lines.push(`  Next layer, and ONLY this layer: ${opps.redEye.layer}`);
      lines.push("  Use it only if the conversation arrives there on its own. If it would have to be steered there, skip it.");
      if (opps.redEye.alreadyDisclosed.length > 0) {
        lines.push("  ALREADY CONFESSED — never confess any of these again, in any wording:");
        for (const d of opps.redEye.alreadyDisclosed) lines.push(`    - ${d}`);
      }
      lines.push(`  ${FICTION_BOUNDARY}`);
      break;
    case "languageRecall":
      lines.push("AVAILABLE THIS EPISODE — THE LANGUAGE LEDGER:");
      lines.push("  Zabala may bring ONE of these back, because this topic is the same kind of story he used it on. This is not a gotcha counter. It is her asking whether he still believes the sentence.");
      for (const e of opps.languageLedger.relevant.slice(-4)) {
        lines.push(`    - "${e.phrase}" (episode ${e.episodeIndex + 1}${e.context ? `, on ${e.context}` : ""}; ${e.status})`);
      }
      break;
    case "positionCallback":
      lines.push("AVAILABLE THIS EPISODE — A PRIOR POSITION:");
      lines.push("  ONE of these may return, and only if it changes the current argument — creates tension, exposes a contradiction, or pays something off. Never recall a position merely to prove the show remembers.");
      for (const p of opps.positions.relevant.slice(-4)) {
        lines.push(`    - ${p.host === "cal" ? "Cal" : "Zabala"}, episode ${p.episodeIndex + 1}: ${p.position}`);
      }
      break;
    case "none":
      lines.push("NOTHING FROM THE SEASON IS DUE THIS EPISODE.");
      lines.push("  No callback, no confession, no recalled phrase. Write the story in front of them. Do not manufacture a continuity moment to fill this space.");
      break;
  }
  lines.push("");

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
    lines.push("  Cal may still be a man with a history — that is in his voice — but he does not confess, hint at a confession, or reference the file this episode.");
    lines.push("");
  }

  if (opps.languageLedger.entries.length > 0) {
    lines.push("ON RECORD (background — do NOT work through this list):");
    for (const e of opps.languageLedger.entries.slice(-6)) {
      lines.push(`  - "${e.phrase}" — ${e.status}${e.context ? ` (${e.context})` : ""}`);
    }
    lines.push("  A phrase already marked rejected or revised is settled. Cal does not un-reject it and Zabala does not re-litigate it.");
    lines.push("");
  }

  lines.push("WHERE THEY STAND:");
  lines.push(`  ${describeRelationship(opps.relationship)}`);
  if (opps.relationship.openThread) lines.push(`  Still hanging between them: ${opps.relationship.openThread}`);
  lines.push("  Never state any of this as narration and never quantify it. It decides how they talk to each other, not what they say about each other.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The structured update the generator returns alongside the script
// ---------------------------------------------------------------------------

const ledgerReport = z.object({
  phrase: z.string().min(2).max(80),
  context: z.string().max(160).default(""),
}).strict();

const positionReport = z.object({
  host: z.enum(["cal", "zabala"]),
  topicKey: z.string().max(240).default(""),
  position: z.string().min(4).max(240),
}).strict();

export const continuityUpdateSchema = z.object({
  redEyeLayerDelivered: z.boolean().default(false),
  redEyeDisclosure: z.string().min(8).max(220).nullable().default(null),
  languageUsed: z.array(ledgerReport).max(3).default([]),
  languageResolved: z.array(z.object({ phrase: z.string().min(2).max(80), resolution: z.enum(["rejected", "revised"]) }).strict()).max(3).default([]),
  languageRecalled: z.string().min(2).max(80).nullable().default(null),
  positionsTaken: z.array(positionReport).max(4).default([]),
  positionRecalled: z.object({ host: z.enum(["cal", "zabala"]), position: z.string().min(4).max(240) }).strict().nullable().default(null),
  relationship: z.object({
    trustDelta: z.number().int().min(-2).max(2).default(0),
    calDisclosed: z.boolean().default(false),
    calRationalized: z.boolean().default(false),
    zabalaOverreached: z.boolean().default(false),
    positionChangedBy: z.enum(["cal", "zabala", "none"]).default("none"),
    openThread: z.string().max(240).nullable().default(null),
  }).strict().default({}),
}).strict();

export type ContinuityUpdate = z.infer<typeof continuityUpdateSchema>;

export interface ContinuityViolation {
  rule: string;
  detail: string;
}

export function checkContinuity(
  state: ContinuityState,
  update: ContinuityUpdate,
  ctx: ContinuityContext = EMPTY_CONTEXT
): ContinuityViolation[] {
  const v: ContinuityViolation[] = [];

  if (update.redEyeLayerDelivered) {
    if (state.redEyeStage > RED_EYE_LADDER_END) {
      v.push({ rule: "redEye:exhausted", detail: `All ${RED_EYE_LAYERS.length} authored Red Eye layers are spent. The file is closed; a new layer cannot be invented.` });
    }
    if (!rateLimitAllows(state, "redEyeLayer")) {
      const { max, window } = RATE_LIMITS.redEyeLayer;
      v.push({ rule: "redEye:cooldown", detail: `A Red Eye layer landed, but it is limited to ${max} in any ${window} episodes and that budget is spent. The confession is the heaviest thing the show owns; spending it every week makes it weightless.` });
    }
    if (!redEyeTopicEligible(ctx.topicText)) {
      v.push({ rule: "redEye:not-eligible", detail: "A Red Eye layer landed on an episode whose topics do not touch scapegoating, leaks, or an organization protecting itself. An unearned confession is a tic, not continuity." });
    }
    if (!update.redEyeDisclosure) {
      v.push({ rule: "redEye:missing-disclosure", detail: "A layer was reported as delivered but nothing new was actually admitted. Report the new admission or report no layer." });
    } else {
      const repeat = findRepeatedDisclosure(state.redEyeDisclosures, update.redEyeDisclosure);
      if (repeat) v.push({ rule: "redEye:repeat", detail: `"${update.redEyeDisclosure}" is the same confession as "${repeat}". Each layer reveals something NEW; re-confessing is how a character arc becomes a running bit.` });
    }
  } else if (update.redEyeDisclosure) {
    v.push({ rule: "redEye:disclosure-without-beat", detail: "A new admission was reported without the layer being delivered. State cannot advance on a confession that did not happen." });
  }

  if (update.languageRecalled) {
    const ledger = readLedger(state.languageLedger);
    const found = ledger.find((e) => e.phrase.toLowerCase() === update.languageRecalled!.toLowerCase());
    if (!found) {
      v.push({ rule: "language:unknown-recall", detail: `"${update.languageRecalled}" is not in the ledger. Zabala can only throw back a phrase Cal actually used on this show.` });
    } else if (!rateLimitAllows(state, "languageRecall")) {
      const { max, window } = RATE_LIMITS.languageRecall;
      v.push({ rule: "language:cooldown", detail: `A ledger recall fired, but it is limited to ${max} in any ${window} episodes. Repeated recall turns evidence of change into a catchphrase.` });
    }
  }
  for (const r of update.languageResolved) {
    const ledger = readLedger(state.languageLedger);
    const known = ledger.some((e) => e.phrase.toLowerCase() === r.phrase.toLowerCase()) || update.languageUsed.some((e) => e.phrase.toLowerCase() === r.phrase.toLowerCase());
    if (!known) v.push({ rule: "language:unknown-resolution", detail: `"${r.phrase}" was marked ${r.resolution} but is not on record and was not used this episode.` });
  }

  if (update.positionRecalled) {
    const positions = readPositions(state.positionMemory);
    const match = positions.find((p) => p.host === update.positionRecalled!.host && sameStatement(p.position, update.positionRecalled!.position));
    if (!match) {
      v.push({ rule: "position:unknown-recall", detail: `No prior episode has ${update.positionRecalled.host} taking that position. A callback to something that never happened is a fabricated season.` });
    } else {
      if (ctx.topicText && topicOverlap(match.topicKey, ctx.topicText) < POSITION_RELEVANCE_THRESHOLD) {
        v.push({ rule: "position:irrelevant-callback", detail: "A prior position was recalled on an unrelated topic. A callback is only continuity when it advances THIS conversation; otherwise it is a receipt being waved." });
      }
      if (!rateLimitAllows(state, "positionCallback")) {
        const { max, window } = RATE_LIMITS.positionCallback;
        v.push({ rule: "position:cooldown", detail: `A position callback fired, but it is limited to ${max} in any ${window} episodes.` });
      }
    }
  }

  return v;
}

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
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3));
}

function sameStatement(a: string, b: string): boolean {
  const A = contentTokens(a);
  const B = contentTokens(b);
  if (A.size === 0 || B.size === 0) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(A.size, B.size) >= 0.5;
}

const LEDGER_CAP = 40;
const POSITION_CAP = 60;

export function nextContinuityState(state: ContinuityState, update: ContinuityUpdate): ContinuityState {
  const episodeIndex = state.episodeCount;
  const advanced = update.redEyeLayerDelivered && state.redEyeStage <= RED_EYE_LADDER_END;
  const redEyeStage = advanced ? state.redEyeStage + 1 : state.redEyeStage;
  const redEyeDisclosures = advanced && update.redEyeDisclosure ? [...state.redEyeDisclosures, update.redEyeDisclosure] : state.redEyeDisclosures;

  const ledger: LedgerEntry[] = [...readLedger(state.languageLedger)];
  for (const used of update.languageUsed) ledger.push({ phrase: used.phrase.trim(), episodeIndex, context: used.context.trim(), status: "used" });
  for (const res of update.languageResolved) {
    for (const entry of ledger) if (entry.phrase.toLowerCase() === res.phrase.toLowerCase()) entry.status = res.resolution;
  }

  const positions: PositionEntry[] = [...readPositions(state.positionMemory)];
  for (const p of update.positionsTaken) positions.push({ host: p.host, episodeIndex, topicKey: normalizeTopicKey(p.topicKey || p.position), position: p.position.trim() });
  const appendFiring = (log: number[], fired: boolean) => fired ? [...log, episodeIndex] : log;
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
    openThread: rel.openThread ?? state.openThread,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export const CONTINUITY_COMMITTED_STATUSES = [...PRODUCED_OR_LATER] as const;

export async function recordEpisodeContinuityClaim(
  episodeId: string,
  rawUpdate: unknown,
  ctx: ContinuityContext = EMPTY_CONTEXT
): Promise<{ ok: true; update: ContinuityUpdate } | { ok: false; violations: ContinuityViolation[] }> {
  const parsed = continuityUpdateSchema.safeParse(rawUpdate);
  if (!parsed.success) {
    return { ok: false, violations: parsed.error.issues.map((i) => ({ rule: "update:malformed", detail: `${i.path.join(".") || "(root)"}: ${i.message}` })) };
  }
  const episode = await db.episode.findUnique({ where: { id: episodeId }, select: { id: true, podcastId: true } });
  if (!episode) return { ok: false, violations: [{ rule: "episode:missing", detail: `No episode '${episodeId}'.` }] };
  if (!episode.podcastId) return { ok: true, update: parsed.data };
  const state = await foldContinuity(episode.podcastId, episodeId);
  const violations = checkContinuity(state, parsed.data, ctx);
  if (violations.length > 0) return { ok: false, violations };
  await db.episode.update({ where: { id: episodeId }, data: { continuityUpdate: parsed.data as object } });
  return { ok: true, update: parsed.data };
}

export async function foldContinuity(podcastId: string, excludeEpisodeId?: string): Promise<ContinuityState> {
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
      console.warn(`[Continuity] Episode ${ep.id} has a stored claim that no longer validates; skipping it in the fold. Continuity for podcast ${podcastId} will be short by this episode until it is repaired.`);
      continue;
    }
    state = nextContinuityState(state, parsed.data);
  }
  return state;
}

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

export async function commitContinuity(podcastId: string): Promise<ContinuityState> {
  const folded = await foldContinuity(podcastId);
  const row = toRow(folded);
  await db.showContinuity.upsert({ where: { podcastId }, create: { podcastId, ...row }, update: row });
  return folded;
}

export async function reconcileContinuity(podcastId: string): Promise<{ drifted: boolean; before: ContinuityState | null; after: ContinuityState }> {
  const before = (await db.showContinuity.findUnique({ where: { podcastId } })) as ContinuityState | null;
  const after = await commitContinuity(podcastId);
  const drifted = before ? JSON.stringify(normalizeForCompare(before)) !== JSON.stringify(normalizeForCompare(after)) : true;
  if (drifted && before) {
    console.warn(`[Continuity] Podcast ${podcastId} had drifted from the fold and was repaired. episodeCount ${before.episodeCount} -> ${after.episodeCount}, redEyeStage ${before.redEyeStage} -> ${after.redEyeStage}.`);
  }
  return { drifted, before, after };
}

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

export function composeGenerationSystemPrompt(base: string, continuityBlock: string | null): string {
  if (!continuityBlock) return base;
  return `${base}\n\n${continuityBlock}`;
}

/**
 * The writer receives two complementary kinds of memory here:
 *  - the generic Show Forge bible/season arc authored by the customer; and
 *  - the legacy evidence-checked Cal/Zabala continuity devices.
 *
 * A real episode first reserves and freezes its Show Forge beat inside that
 * episode's immutable configuration snapshot. The current podcast config is
 * only a fallback for test doubles or legacy generation paths that cannot be
 * matched to a draft episode.
 */
export async function continuityForGeneration(
  podcastId: string | null | undefined,
  ctx: ContinuityContext = EMPTY_CONTEXT
) {
  const row = await getOrCreateContinuity(podcastId);
  if (!row || !podcastId) return null;
  const opportunities = continuityOpportunities(row as ContinuityState, ctx);
  const legacyBlock = renderContinuityBlock(opportunities);

  const frozen = await frozenShowForgeForGeneration(podcastId, ctx.topicText || "").catch((error) => {
    console.error(`[ShowForge] Failed to reserve a frozen episode beat for podcast ${podcastId}: ${(error as Error).message}`);
    return null;
  });

  let showForge: { prompt: string; assignment: unknown } | null = frozen
    ? { prompt: frozen.prompt, assignment: frozen.assignment }
    : null;
  if (!showForge) {
    const editorial = await db.podcastEditorialConfig.findUnique({
      where: { podcastId },
      select: { scriptStyle: true },
    }).catch(() => null);
    const decoded = decodeShowForgeState(editorial?.scriptStyle);
    const rendered = decoded.state ? renderShowForgePrompt(decoded.state, opportunities.episodeIndex) : null;
    showForge = rendered ? { prompt: rendered.prompt, assignment: rendered.assignment } : null;
  }

  const promptBlock = showForge ? `${showForge.prompt}\n\n${legacyBlock}` : legacyBlock;
  return {
    state: row as ContinuityState,
    context: ctx,
    opportunities,
    showForgeAssignment: showForge?.assignment ?? null,
    showForgeExecution: frozen?.execution ?? null,
    promptBlock,
  };
}

export { RED_EYE_LAYERS, LEDGER_PHRASES };
export type { RateLimitKey };
