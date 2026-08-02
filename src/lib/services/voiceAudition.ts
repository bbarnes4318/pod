// BLIND LONG-FORM VOICE AUDITION
//
// What this is NOT: per-scene provider take selection. That already exists —
// `synthesizeFishDialogueScene` renders several takes of one scene, scores each
// with `analyzeSpokenPerformanceBuffer`, and keeps the best. That is a machine
// picking the best rendering of a voice it has already been told to use.
//
// What this IS: a human deciding WHICH VOICE the show is going to be, from
// several minutes of identical material, WITHOUT knowing which provider, voice
// id or model produced what they are hearing. Voice choice is the single least
// reversible decision in the product — listeners bond to a voice, and swapping
// it later is a bigger deal than changing the format. So:
//
//   1. Every candidate performs the same eight-scene pack (voiceAuditionScenes).
//   2. Voting is blind at the QUERY level, not just in the component. The
//      ballot path never reads provider/voiceId/model out of the database.
//   3. Nothing is ever promoted automatically. A winning vote is an opinion;
//      changing the production voice is an explicit, attributed, reversible act.
//
// Persistence is injectable (`VoiceAuditionStore`) so the whole flow can be
// proven without a database. The Prisma implementation is the default in the
// app; the in-memory one exists for tests and local development.

import crypto from "node:crypto";
import {
  AUDITION_SCENES,
  AUDITION_PACK_VERSION,
  validateAuditionPack,
  type AuditionScene,
} from "./voiceAuditionScenes";

/** Bump when the meaning of a score, the pack, or the promotion rules change. */
export const VOICE_AUDITION_POLICY_VERSION = 1;

// ---------------------------------------------------------------------------
// Scored dimensions
// ---------------------------------------------------------------------------

export const AUDITION_DIMENSIONS = [
  "characterFit",
  "identityConsistency",
  "listenerFatigue",
  "spontaneity",
  "intelligibility",
  "emotionalRange",
  "interruptionQuality",
  "pairChemistry",
] as const;

export type AuditionDimension = (typeof AUDITION_DIMENSIONS)[number];

export const SCORE_MIN = 1;
export const SCORE_MAX = 5;

/**
 * Every dimension is "higher is better" so a tally is a plain mean and cannot
 * be misread. `listenerFatigue` is therefore phrased as stamina: 5 means you
 * could listen to this voice for an hour, 1 means it was tiring by minute three.
 */
export const AUDITION_DIMENSION_COPY: Record<
  AuditionDimension,
  { label: string; low: string; high: string; help: string }
> = {
  characterFit: {
    label: "Character fit",
    low: "Wrong person",
    high: "Is the character",
    help: "Could this voice be the host as written, or is it a competent stranger reading their lines?",
  },
  identityConsistency: {
    label: "Identity consistency",
    low: "Drifts into another person",
    high: "Same person throughout",
    help: "Scene 8 versus scene 1. Age, accent, weight and placement should not wander.",
  },
  listenerFatigue: {
    label: "Stamina (anti-fatigue)",
    low: "Tiring by minute three",
    high: "Could listen for an hour",
    help: "The one that only a long audition can expose. Rate what you felt by the end, not the start.",
  },
  spontaneity: {
    label: "Spontaneity",
    low: "Reading aloud",
    high: "Thinking out loud",
    help: "Does the thought seem to arrive as it is spoken, or does it arrive pre-packaged?",
  },
  intelligibility: {
    label: "Intelligibility",
    low: "Had to re-listen",
    high: "Effortless",
    help: "Consonants, names, numbers, and the fast angry passages. Effort spent decoding is effort not spent listening.",
  },
  emotionalRange: {
    label: "Emotional range",
    low: "One colour",
    high: "Cold to furious to quiet",
    help: "Compare scene 2 (amused), scene 6 (angry) and scene 7 (quiet). Loud is not range.",
  },
  interruptionQuality: {
    label: "Interruption quality",
    low: "New sentence, politely queued",
    high: "Genuinely could not wait",
    help: "Scene 3. A cut-in that starts calmly is the clearest tell of synthetic conversation.",
  },
  pairChemistry: {
    label: "Pair chemistry",
    low: "Two monologues",
    high: "One conversation",
    help: "Against the same partner voice every time. Does it sound like they are in a room together?",
  },
};

export type AuditionScores = Record<AuditionDimension, number>;

export function emptyScores(value = 3): AuditionScores {
  return AUDITION_DIMENSIONS.reduce((accumulator, dimension) => {
    accumulator[dimension] = value;
    return accumulator;
  }, {} as AuditionScores);
}

export function validateScores(input: Partial<AuditionScores> | undefined): AuditionScores {
  const scores = {} as AuditionScores;
  for (const dimension of AUDITION_DIMENSIONS) {
    const raw = input?.[dimension];
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      throw new VoiceAuditionError(`Score for '${dimension}' is required.`);
    }
    const rounded = Math.round(raw);
    if (rounded < SCORE_MIN || rounded > SCORE_MAX) {
      throw new VoiceAuditionError(`Score for '${dimension}' must be ${SCORE_MIN}-${SCORE_MAX}.`);
    }
    scores[dimension] = rounded;
  }
  return scores;
}

export class VoiceAuditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceAuditionError";
  }
}

// ---------------------------------------------------------------------------
// Records (the shapes the store round-trips)
// ---------------------------------------------------------------------------

export type AuditionStatus = "draft" | "voting" | "decided" | "promoted" | "abandoned";

export interface AuditionRecord {
  id: string;
  ownerId: string | null;
  hostId: string | null;
  title: string;
  status: AuditionStatus;
  packVersion: string;
  packSceneIds: string[];
  policyVersion: number;
  blindSeed: string;
  winnerCandidateId: string | null;
  winnerSelectedAt: Date | null;
  winnerSelectedById: string | null;
  unblindedAt: Date | null;
  unblindedById: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface AuditionGenerationSettings {
  temperature?: number;
  topP?: number;
  speed?: number;
  volume?: number;
  voiceDirection?: string;
  format?: "mp3" | "wav";
  /** Stamped by addCandidate. Provenance for "who were they acting against". */
  partnerProvider?: string;
  partnerVoiceId?: string;
}

export interface AuditionMetrics {
  performanceScore: number | null;
  passed: boolean | null;
  failures: string[];
  warnings: string[];
  durationSec: number | null;
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  pauseStdDevSec: number | null;
  longestPauseSec: number | null;
  terminalFallRatio: number | null;
  medianPhrasePitchRangeSemitones: number | null;
  phraseEnergyCoefficientOfVariation: number | null;
}

/** The identity-bearing record. Only reachable through explicitly-named paths. */
export interface CandidateRecord {
  id: string;
  auditionId: string;
  /** The opaque id the voting surface uses. Carries no information. */
  ballotId: string;
  blindPosition: number;
  /** Private note for the producer ("incumbent", "fish redesign"). Never on a ballot. */
  privateLabel: string | null;
  provider: string;
  voiceId: string;
  model: string | null;
  generationSettings: AuditionGenerationSettings | null;
  audioAssetKey: string | null;
  audioAssetUrl: string | null;
  audioContentType: string | null;
  audioBytes: number | null;
  durationMs: number | null;
  renderedAt: Date | null;
  renderError: string | null;
  metrics: AuditionMetrics | null;
  createdAt: Date;
}

/**
 * EXACTLY what the ballot path is allowed to read out of the database. If a
 * column is not on this interface, the blind query does not select it.
 */
export interface BallotProjectionRow {
  ballotId: string;
  auditionId: string;
  blindPosition: number;
  audioAssetUrl: string | null;
  durationMs: number | null;
  renderError: string | null;
}

export interface VoteRecord {
  id: string;
  auditionId: string;
  candidateId: string;
  voterId: string;
  voterLabel: string | null;
  scores: AuditionScores;
  overall: number;
  notes: string | null;
  createdAt: Date;
}

export type PromotionKind = "promotion" | "rollback";
export type PromotionStatus = "active" | "rolled_back" | "reversal";

export interface PromotionRecord {
  id: string;
  hostId: string;
  kind: PromotionKind;
  auditionId: string | null;
  candidateId: string | null;
  fromProvider: string | null;
  fromVoiceId: string | null;
  fromModel: string | null;
  toProvider: string;
  toVoiceId: string;
  toModel: string | null;
  actorId: string;
  actorLabel: string | null;
  reason: string | null;
  policyVersion: number;
  status: PromotionStatus;
  revertsPromotionId: string | null;
  rolledBackAt: Date | null;
  rolledBackById: string | null;
  rolledBackReason: string | null;
  createdAt: Date;
}

export interface HostVoiceRecord {
  id: string;
  name: string;
  provider: string;
  voiceId: string;
  /**
   * Who may change this host's production voice. `null` means NOBODY CLAIMED IT
   * — a shared/system/seeded host — which is deliberately NOT "everybody owns
   * it": only an operator account may touch those. Optional on the type so a
   * fixture can leave it out; absent is read as `null`.
   */
  ownerId?: string | null;
}

/**
 * How a promotion list is narrowed. A bare string is the legacy "one host"
 * form; the object form is what owner-scoping uses, and it is applied by the
 * QUERY (a Prisma `where`), never by filtering a full table in memory.
 */
export type PromotionFilter =
  | string
  | { hostId?: string | null; hostIds?: readonly string[] | null }
  | undefined;

function normalizePromotionFilter(filter: PromotionFilter): {
  hostId?: string;
  hostIds?: readonly string[];
} {
  if (!filter) return {};
  if (typeof filter === "string") return filter ? { hostId: filter } : {};
  const out: { hostId?: string; hostIds?: readonly string[] } = {};
  if (filter.hostId) out.hostId = filter.hostId;
  if (filter.hostIds) out.hostIds = filter.hostIds;
  return out;
}

// ---------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------

export interface VoiceAuditionStore {
  createAudition(input: Omit<AuditionRecord, "createdAt"> & { createdAt?: Date }): Promise<AuditionRecord>;
  getAudition(id: string): Promise<AuditionRecord | null>;
  updateAudition(id: string, patch: Partial<AuditionRecord>): Promise<AuditionRecord>;
  listAuditions(ownerId: string | null): Promise<AuditionRecord[]>;

  createCandidate(input: Omit<CandidateRecord, "createdAt"> & { createdAt?: Date }): Promise<CandidateRecord>;
  updateCandidate(id: string, patch: Partial<CandidateRecord>): Promise<CandidateRecord>;
  getCandidateByBallotId(auditionId: string, ballotId: string): Promise<CandidateRecord | null>;

  /**
   * BLIND PATH. Implementations MUST NOT read provider, voiceId, model,
   * generationSettings or privateLabel here. This is the projection the whole
   * blindness guarantee rests on.
   */
  listBallotProjections(auditionId: string): Promise<BallotProjectionRow[]>;

  /** UNBLIND PATH. Only reveal/promotion/rollback may call this. */
  listCandidates(auditionId: string): Promise<CandidateRecord[]>;

  upsertVote(input: Omit<VoteRecord, "id" | "createdAt"> & { id?: string; createdAt?: Date }): Promise<VoteRecord>;
  /** `voterId` narrows to one voter's own ballots IN THE QUERY (the console
   *  renders "your scores"; it must not receive everyone else's to do it). */
  listVotes(auditionId: string, voterId?: string): Promise<VoteRecord[]>;

  getHostVoice(hostId: string): Promise<HostVoiceRecord | null>;
  setHostVoice(hostId: string, voice: { provider: string; voiceId: string }): Promise<void>;
  /** The hosts an account owns. The owner-scoped promotion query is built from this. */
  listHostIdsForOwner(ownerId: string): Promise<string[]>;

  createPromotion(input: Omit<PromotionRecord, "createdAt"> & { createdAt?: Date }): Promise<PromotionRecord>;
  getPromotion(id: string): Promise<PromotionRecord | null>;
  updatePromotion(id: string, patch: Partial<PromotionRecord>): Promise<PromotionRecord>;
  listPromotions(filter?: PromotionFilter): Promise<PromotionRecord[]>;
}

// ---------------------------------------------------------------------------
// Rendering / analysis / audio storage ports
// ---------------------------------------------------------------------------

export interface AuditionVoiceSpec {
  provider: string;
  voiceId: string;
  model?: string | null;
  settings?: AuditionGenerationSettings | null;
}

export interface AuditionRenderInput {
  scenes: readonly AuditionScene[];
  candidate: AuditionVoiceSpec;
  /** The fixed scene partner. Same for every candidate, or chemistry is not comparable. */
  partner: AuditionVoiceSpec;
}

export interface AuditionRenderOutput {
  audioBuffer: Buffer;
  contentType: string;
  /** The model the engine actually used, if it differs from what was requested. */
  model?: string | null;
  durationMs?: number | null;
}

export interface AuditionRenderer {
  render(input: AuditionRenderInput): Promise<AuditionRenderOutput>;
}

export interface AuditionMetricsAnalyzer {
  analyze(audioBuffer: Buffer, context: { turnCount: number; format: "mp3" | "wav" }): Promise<AuditionMetrics>;
}

export interface AuditionAudioStore {
  put(input: { key: string; body: Buffer; contentType: string }): Promise<{ url: string; key: string }>;
}

export interface VoiceAuditionDeps {
  store: VoiceAuditionStore;
  renderer?: AuditionRenderer;
  analyzer?: AuditionMetricsAnalyzer;
  audio?: AuditionAudioStore;
  scenes?: readonly AuditionScene[];
  now?: () => Date;
  newId?: () => string;
}

function deps_now(deps: VoiceAuditionDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function deps_id(deps: VoiceAuditionDeps): string {
  return deps.newId ? deps.newId() : crypto.randomUUID();
}

function deps_scenes(deps: VoiceAuditionDeps): readonly AuditionScene[] {
  return deps.scenes ?? AUDITION_SCENES;
}

// ---------------------------------------------------------------------------
// Blindness
// ---------------------------------------------------------------------------

/** Keys that must never appear anywhere inside something handed to a voter. */
export const BALLOT_FORBIDDEN_KEYS = [
  "provider",
  "ttsProvider",
  "voiceId",
  "ttsVoiceId",
  "model",
  "generationSettings",
  "privateLabel",
  "candidateId",
] as const;

export interface BlindBallot {
  /** Opaque. Derived from randomness, never from the voice it stands for. */
  ballotId: string;
  auditionId: string;
  /** "Voice A", "Voice B" — assigned by a seeded shuffle, not insertion order. */
  blindLabel: string;
  position: number;
  audioUrl: string | null;
  durationSec: number | null;
  ready: boolean;
  problem: string | null;
}

export function blindLabelFor(position: number): string {
  // A..Z, then AA, AB, ... Positions are 0-based.
  let label = "";
  let n = position;
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Voice ${label}`;
}

export function toBlindBallot(row: BallotProjectionRow): BlindBallot {
  return {
    ballotId: row.ballotId,
    auditionId: row.auditionId,
    blindLabel: blindLabelFor(row.blindPosition),
    position: row.blindPosition,
    audioUrl: row.audioAssetUrl,
    durationSec: row.durationMs === null ? null : Math.round(row.durationMs / 1000),
    ready: !!row.audioAssetUrl && !row.renderError,
    problem: row.renderError,
  };
}

/**
 * Last line of defence. Throws if a payload about to reach a voter contains an
 * identity-bearing key or any of the literal secrets (voice ids, provider names,
 * model names) it is supposed to be hiding.
 */
export function assertBallotIsBlind(payload: unknown, secrets: string[] = []): void {
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((BALLOT_FORBIDDEN_KEYS as readonly string[]).includes(key)) {
        throw new VoiceAuditionError(`Blindness violation: '${path}${path ? "." : ""}${key}' would reach a voter.`);
      }
      walk(child, `${path}${path ? "." : ""}${key}`);
    }
  };
  walk(payload, "");

  const serialized = JSON.stringify(payload) ?? "";
  for (const secret of secrets) {
    const trimmed = (secret || "").trim();
    if (trimmed.length >= 3 && serialized.includes(trimmed)) {
      throw new VoiceAuditionError(`Blindness violation: the serialized ballot leaks '${trimmed}'.`);
    }
  }
}

/** A 32-hex reference id — the shape every provider voice id in this app has. */
const VOICE_ID_SHAPE = /\b[0-9a-f]{32}\b/gi;

/**
 * Error messages are the classic blindness hole: a provider SDK happily puts the
 * voice id it just rejected into the exception, and that string then travels to
 * a ballot ("problem"), to a toast, and into the page HTML. Every message this
 * module stores or returns goes through here first.
 */
export function redactVoiceSecrets(
  message: string,
  secrets: Array<string | null | undefined> = []
): string {
  let out = message ?? "";
  for (const secret of secrets) {
    const trimmed = (secret || "").trim();
    if (trimmed.length >= 3) out = out.split(trimmed).join("[redacted]");
  }
  return out.replace(VOICE_ID_SHAPE, "[redacted]");
}

/** Deterministic shuffle so ballot order does not encode who was entered first. */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const scored = items.map((item, index) => ({
    item,
    key: crypto.createHash("sha256").update(`${seed}:${index}`).digest("hex"),
  }));
  scored.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return scored.map((entry) => entry.item);
}

// ---------------------------------------------------------------------------
// Flow: create → add candidates → open voting → vote → decide
// ---------------------------------------------------------------------------

export async function createAudition(
  deps: VoiceAuditionDeps,
  input: { ownerId: string | null; hostId: string | null; title: string; notes?: string | null }
): Promise<AuditionRecord> {
  const scenes = deps_scenes(deps);
  const pack = validateAuditionPack(scenes);
  if (!pack.ok) {
    throw new VoiceAuditionError(`The audition pack is invalid: ${pack.problems.join(" ")}`);
  }
  const title = input.title.trim();
  if (!title) throw new VoiceAuditionError("Give the audition a name.");

  return deps.store.createAudition({
    id: deps_id(deps),
    ownerId: input.ownerId,
    hostId: input.hostId,
    title,
    status: "draft",
    packVersion: AUDITION_PACK_VERSION,
    packSceneIds: pack.sceneIds,
    policyVersion: VOICE_AUDITION_POLICY_VERSION,
    blindSeed: crypto.randomBytes(16).toString("hex"),
    winnerCandidateId: null,
    winnerSelectedAt: null,
    winnerSelectedById: null,
    unblindedAt: null,
    unblindedById: null,
    notes: input.notes?.trim() || null,
    createdAt: deps_now(deps),
  });
}

async function requireAudition(deps: VoiceAuditionDeps, auditionId: string): Promise<AuditionRecord> {
  const audition = await deps.store.getAudition(auditionId);
  if (!audition) throw new VoiceAuditionError("That audition no longer exists.");
  return audition;
}

export interface AddCandidateInput {
  auditionId: string;
  provider: string;
  voiceId: string;
  model?: string | null;
  settings?: AuditionGenerationSettings | null;
  privateLabel?: string | null;
  /** The fixed scene partner. Required so pair chemistry is comparable. */
  partner: AuditionVoiceSpec;
}

/**
 * Render the full pack for one candidate, measure it, store the audio, and
 * persist the identity. The rendered artifact is keyed by ballot id so that not
 * even the object storage path can be used to work out whose voice it is.
 */
export async function addCandidate(
  deps: VoiceAuditionDeps,
  input: AddCandidateInput
): Promise<CandidateRecord> {
  const audition = await requireAudition(deps, input.auditionId);
  if (audition.status !== "draft") {
    throw new VoiceAuditionError("Candidates can only be added while the audition is still a draft.");
  }
  const provider = input.provider.trim().toLowerCase();
  const voiceId = input.voiceId.trim();
  if (!provider) throw new VoiceAuditionError("A candidate needs a provider.");
  if (!voiceId) throw new VoiceAuditionError("A candidate needs a voice id.");

  const partnerProvider = input.partner.provider.trim().toLowerCase();
  const partnerVoiceId = input.partner.voiceId.trim();
  if (!partnerProvider || !partnerVoiceId) {
    throw new VoiceAuditionError("Pick the scene partner this candidate performs against.");
  }
  if (partnerVoiceId === voiceId) {
    throw new VoiceAuditionError("A candidate cannot audition against itself.");
  }

  const existing = await deps.store.listCandidates(audition.id);
  if (existing.some((candidate) => candidate.provider === provider && candidate.voiceId === voiceId)) {
    throw new VoiceAuditionError("That voice is already entered in this audition.");
  }
  // Chemistry is only comparable against a constant. A candidate rendered
  // opposite a different partner is a different experiment.
  const priorPartner = existing
    .map((candidate) => candidate.generationSettings?.partnerVoiceId)
    .find((value): value is string => !!value);
  if (priorPartner && priorPartner !== partnerVoiceId) {
    throw new VoiceAuditionError(
      "Every candidate in an audition must perform against the same scene partner."
    );
  }

  const ballotId = crypto.randomBytes(16).toString("hex");
  const scenes = deps_scenes(deps);
  const settings: AuditionGenerationSettings = { ...(input.settings ?? {}), partnerProvider, partnerVoiceId };
  const format = settings.format === "wav" ? "wav" : "mp3";

  let audioAssetKey: string | null = null;
  let audioAssetUrl: string | null = null;
  let audioContentType: string | null = null;
  let audioBytes: number | null = null;
  let durationMs: number | null = null;
  let metrics: AuditionMetrics | null = null;
  let renderError: string | null = null;
  let renderedAt: Date | null = null;
  let model = input.model ?? null;

  try {
    const renderer = deps.renderer ?? defaultAuditionRenderer();
    const rendered = await renderer.render({
      scenes,
      candidate: { provider, voiceId, model, settings },
      partner: { ...input.partner, provider: partnerProvider, voiceId: partnerVoiceId },
    });
    if (!rendered.audioBuffer?.length) throw new Error("the engine returned no audio");
    model = rendered.model ?? model;

    const analyzer = deps.analyzer ?? defaultAuditionAnalyzer();
    const turnCount = scenes.reduce((total, scene) => total + scene.turns.length, 0);
    metrics = await analyzer.analyze(rendered.audioBuffer, { turnCount, format });
    durationMs = rendered.durationMs ?? (metrics.durationSec === null ? null : Math.round(metrics.durationSec * 1000));

    const audio = deps.audio ?? defaultAuditionAudioStore();
    // Key by ballot id ONLY — a key containing the voice id would unblind the
    // audition to anyone who can read a network tab.
    const key = `voice-auditions/${audition.id}/${ballotId}.${format}`;
    const stored = await audio.put({
      key,
      body: rendered.audioBuffer,
      contentType: rendered.contentType || (format === "wav" ? "audio/wav" : "audio/mpeg"),
    });
    audioAssetKey = stored.key;
    audioAssetUrl = stored.url;
    audioContentType = rendered.contentType || null;
    audioBytes = rendered.audioBuffer.length;
    renderedAt = deps_now(deps);
  } catch (error) {
    renderError = redactVoiceSecrets(error instanceof Error ? error.message : String(error), [
      provider,
      voiceId,
      model,
      partnerProvider,
      partnerVoiceId,
      input.privateLabel,
    ]);
  }

  return deps.store.createCandidate({
    id: deps_id(deps),
    auditionId: audition.id,
    ballotId,
    blindPosition: existing.length,
    privateLabel: input.privateLabel?.trim() || null,
    provider,
    voiceId,
    model,
    generationSettings: settings,
    audioAssetKey,
    audioAssetUrl,
    audioContentType,
    audioBytes,
    durationMs,
    renderedAt,
    renderError,
    metrics,
    createdAt: deps_now(deps),
  });
}

/**
 * Lock the field and shuffle the blind order. After this, candidates cannot be
 * added — a late entry would be voted on by fewer people than the rest.
 */
export async function openVoting(deps: VoiceAuditionDeps, auditionId: string): Promise<AuditionRecord> {
  const audition = await requireAudition(deps, auditionId);
  if (audition.status === "voting") return audition;
  if (audition.status !== "draft") throw new VoiceAuditionError("This audition has already been decided.");

  const candidates = await deps.store.listCandidates(auditionId);
  const ready = candidates.filter((candidate) => candidate.audioAssetUrl && !candidate.renderError);
  if (ready.length < 2) {
    throw new VoiceAuditionError("A blind audition needs at least two candidates that rendered successfully.");
  }

  const order = seededShuffle(candidates, audition.blindSeed);
  for (let position = 0; position < order.length; position++) {
    await deps.store.updateCandidate(order[position].id, { blindPosition: position });
  }
  return deps.store.updateAudition(auditionId, { status: "voting" });
}

/**
 * THE BLIND READ. Everything a voter is allowed to see. Nothing here was ever
 * read out of the identity columns, and the result is checked before returning.
 */
export async function getBallots(deps: VoiceAuditionDeps, auditionId: string): Promise<BlindBallot[]> {
  const rows = await deps.store.listBallotProjections(auditionId);
  const ballots = rows
    .slice()
    .sort((left, right) => left.blindPosition - right.blindPosition)
    .map(toBlindBallot);
  assertBallotIsBlind(ballots);
  return ballots;
}

export interface CastVoteInput {
  auditionId: string;
  ballotId: string;
  voterId: string;
  voterLabel?: string | null;
  scores: Partial<AuditionScores>;
  overall: number;
  notes?: string | null;
}

/**
 * A vote is cast against a BALLOT id. The voter never names a candidate, and
 * the resolution from ballot to candidate happens server-side.
 */
export async function castVote(deps: VoiceAuditionDeps, input: CastVoteInput): Promise<VoteRecord> {
  const audition = await requireAudition(deps, input.auditionId);
  if (audition.status !== "voting") {
    throw new VoiceAuditionError("Voting is not open on this audition.");
  }
  const scores = validateScores(input.scores);
  const overall = Math.round(input.overall);
  if (!Number.isFinite(overall) || overall < SCORE_MIN || overall > SCORE_MAX) {
    throw new VoiceAuditionError(`Overall must be ${SCORE_MIN}-${SCORE_MAX}.`);
  }
  const candidate = await deps.store.getCandidateByBallotId(input.auditionId, input.ballotId);
  if (!candidate) throw new VoiceAuditionError("That ballot does not belong to this audition.");
  if (!input.voterId) throw new VoiceAuditionError("A vote must be attributable to someone.");

  return deps.store.upsertVote({
    auditionId: audition.id,
    candidateId: candidate.id,
    voterId: input.voterId,
    voterLabel: input.voterLabel?.trim() || null,
    scores,
    overall,
    notes: input.notes?.trim() || null,
    createdAt: deps_now(deps),
  });
}

export interface BlindTallyRow {
  ballotId: string;
  blindLabel: string;
  position: number;
  voteCount: number;
  overallMean: number | null;
  dimensionMeans: Record<AuditionDimension, number | null>;
  /** Mean across the eight dimensions — the ranking key when overall ties. */
  compositeMean: number | null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** The standings, still blind. Producers watch this while voting is open. */
export async function tallyAudition(deps: VoiceAuditionDeps, auditionId: string): Promise<BlindTallyRow[]> {
  const [rows, votes, candidates] = await Promise.all([
    deps.store.listBallotProjections(auditionId),
    deps.store.listVotes(auditionId),
    deps.store.listCandidates(auditionId),
  ]);
  // candidateId -> ballotId is resolved server-side and never returned.
  const ballotIdByCandidate = new Map(candidates.map((candidate) => [candidate.id, candidate.ballotId]));
  const byBallot = new Map<string, VoteRecord[]>();
  for (const vote of votes) {
    const ballotId = ballotIdByCandidate.get(vote.candidateId);
    if (!ballotId) continue;
    const bucket = byBallot.get(ballotId) ?? [];
    bucket.push(vote);
    byBallot.set(ballotId, bucket);
  }

  const tally = rows
    .slice()
    .sort((left, right) => left.blindPosition - right.blindPosition)
    .map((row) => {
      const bucket = byBallot.get(row.ballotId) ?? [];
      const dimensionMeans = AUDITION_DIMENSIONS.reduce((accumulator, dimension) => {
        accumulator[dimension] = mean(bucket.map((vote) => vote.scores[dimension]));
        return accumulator;
      }, {} as Record<AuditionDimension, number | null>);
      const composite = mean(
        AUDITION_DIMENSIONS.map((dimension) => dimensionMeans[dimension]).filter(
          (value): value is number => value !== null
        )
      );
      return {
        ballotId: row.ballotId,
        blindLabel: blindLabelFor(row.blindPosition),
        position: row.blindPosition,
        voteCount: bucket.length,
        overallMean: mean(bucket.map((vote) => vote.overall)),
        dimensionMeans,
        compositeMean: composite,
      };
    });

  assertBallotIsBlind(tally);
  return tally;
}

/**
 * Record which ballot won. THIS DOES NOT CHANGE ANY PRODUCTION VOICE, and it
 * deliberately does not unblind the audition either — a producer can select the
 * winner and still not know what they picked.
 */
export async function selectWinner(
  deps: VoiceAuditionDeps,
  input: { auditionId: string; ballotId: string; actorId: string }
): Promise<AuditionRecord> {
  const audition = await requireAudition(deps, input.auditionId);
  if (audition.status !== "voting" && audition.status !== "decided") {
    throw new VoiceAuditionError("Open voting before choosing a winner.");
  }
  if (!input.actorId) throw new VoiceAuditionError("Selecting a winner must be attributable to someone.");
  const candidate = await deps.store.getCandidateByBallotId(input.auditionId, input.ballotId);
  if (!candidate) throw new VoiceAuditionError("That ballot does not belong to this audition.");

  return deps.store.updateAudition(audition.id, {
    status: "decided",
    winnerCandidateId: candidate.id,
    winnerSelectedAt: deps_now(deps),
    winnerSelectedById: input.actorId,
  });
}

export interface RevealedCandidate {
  ballotId: string;
  blindLabel: string;
  privateLabel: string | null;
  provider: string;
  voiceId: string;
  model: string | null;
  generationSettings: AuditionGenerationSettings | null;
  metrics: AuditionMetrics | null;
  durationMs: number | null;
  audioUrl: string | null;
  isWinner: boolean;
}

/** Unblind. Only legal once a winner has been chosen, and it is recorded. */
export async function revealAudition(
  deps: VoiceAuditionDeps,
  input: { auditionId: string; actorId: string }
): Promise<{ audition: AuditionRecord; candidates: RevealedCandidate[] }> {
  const audition = await requireAudition(deps, input.auditionId);
  if (!audition.winnerCandidateId) {
    throw new VoiceAuditionError("Choose a winner before unblinding — otherwise the vote is no longer blind.");
  }
  const updated = audition.unblindedAt
    ? audition
    : await deps.store.updateAudition(audition.id, {
        unblindedAt: deps_now(deps),
        unblindedById: input.actorId,
      });
  const candidates = await deps.store.listCandidates(audition.id);
  return {
    audition: updated,
    candidates: candidates
      .slice()
      .sort((left, right) => left.blindPosition - right.blindPosition)
      .map((candidate) => ({
        ballotId: candidate.ballotId,
        blindLabel: blindLabelFor(candidate.blindPosition),
        privateLabel: candidate.privateLabel,
        provider: candidate.provider,
        voiceId: candidate.voiceId,
        model: candidate.model,
        generationSettings: candidate.generationSettings,
        metrics: candidate.metrics,
        durationMs: candidate.durationMs,
        audioUrl: candidate.audioAssetUrl,
        isWinner: candidate.id === updated.winnerCandidateId,
      })),
  };
}

// ---------------------------------------------------------------------------
// Promotion and rollback
//
// An active production voice is NEVER replaced by this module as a side effect
// of anything. `promoteWinner` is the only writer of a host's voice here, it
// requires a named actor, and it requires the caller to re-state the winning
// ballot id — so a promotion cannot happen because a page re-rendered.
// ---------------------------------------------------------------------------

export interface PromoteWinnerInput {
  auditionId: string;
  /** Defaults to the audition's host. Passing it explicitly is encouraged. */
  hostId?: string;
  /** Must equal the winning ballot. The producer is confirming what they picked. */
  acknowledgedBallotId: string;
  actorId: string;
  actorLabel?: string | null;
  reason?: string | null;
}

export async function promoteWinner(
  deps: VoiceAuditionDeps,
  input: PromoteWinnerInput
): Promise<{ promotion: PromotionRecord; audition: AuditionRecord }> {
  const audition = await requireAudition(deps, input.auditionId);
  if (!audition.winnerCandidateId) {
    throw new VoiceAuditionError("Nothing has won this audition yet.");
  }
  if (!input.actorId) {
    throw new VoiceAuditionError("A promotion must record who performed it.");
  }
  const hostId = (input.hostId || audition.hostId || "").trim();
  if (!hostId) throw new VoiceAuditionError("Say which host this voice is being promoted onto.");

  const candidates = await deps.store.listCandidates(audition.id);
  const winner = candidates.find((candidate) => candidate.id === audition.winnerCandidateId);
  if (!winner) throw new VoiceAuditionError("The winning candidate no longer exists.");
  if (winner.ballotId !== input.acknowledgedBallotId) {
    throw new VoiceAuditionError(
      "Promotion confirmation does not match the winning ballot. Nothing was changed."
    );
  }

  const host = await deps.store.getHostVoice(hostId);
  if (!host) throw new VoiceAuditionError("That host no longer exists.");

  // Refuse a no-op promotion: an audit trail full of "changed X to X" rows makes
  // real rollbacks harder to find.
  if (host.provider === winner.provider && host.voiceId === winner.voiceId) {
    throw new VoiceAuditionError(`${host.name} is already using this voice.`);
  }

  const now = deps_now(deps);
  const promotion = await deps.store.createPromotion({
    id: deps_id(deps),
    hostId,
    kind: "promotion",
    auditionId: audition.id,
    candidateId: winner.id,
    fromProvider: host.provider,
    fromVoiceId: host.voiceId,
    fromModel: null,
    toProvider: winner.provider,
    toVoiceId: winner.voiceId,
    toModel: winner.model,
    actorId: input.actorId,
    actorLabel: input.actorLabel?.trim() || null,
    reason: input.reason?.trim() || null,
    policyVersion: VOICE_AUDITION_POLICY_VERSION,
    status: "active",
    revertsPromotionId: null,
    rolledBackAt: null,
    rolledBackById: null,
    rolledBackReason: null,
    createdAt: now,
  });

  await deps.store.setHostVoice(hostId, { provider: winner.provider, voiceId: winner.voiceId });
  const updated = await deps.store.updateAudition(audition.id, {
    status: "promoted",
    unblindedAt: audition.unblindedAt ?? now,
    unblindedById: audition.unblindedById ?? input.actorId,
  });
  return { promotion, audition: updated };
}

export interface RollbackResult {
  promotion: PromotionRecord;
  reversal: PromotionRecord | null;
  restored: { provider: string; voiceId: string } | null;
  alreadyRolledBack: boolean;
}

/**
 * Put the previous voice back and record the reversal. Safe to call twice: the
 * second call reports that it was already reverted and changes nothing.
 */
export async function rollbackPromotion(
  deps: VoiceAuditionDeps,
  input: { promotionId: string; actorId: string; actorLabel?: string | null; reason?: string | null }
): Promise<RollbackResult> {
  const promotion = await deps.store.getPromotion(input.promotionId);
  if (!promotion) throw new VoiceAuditionError("That promotion is not in the history.");
  if (promotion.kind !== "promotion") {
    throw new VoiceAuditionError("Only a promotion can be rolled back; this row is itself a reversal.");
  }
  if (!input.actorId) throw new VoiceAuditionError("A rollback must record who performed it.");

  if (promotion.status === "rolled_back") {
    return { promotion, reversal: null, restored: null, alreadyRolledBack: true };
  }
  if (!promotion.fromVoiceId || !promotion.fromProvider) {
    throw new VoiceAuditionError(
      "This promotion has no recorded previous voice, so it cannot be rolled back automatically."
    );
  }

  // Rolling back an older promotion while a newer one is live would silently
  // discard the newer decision. Make the operator unwind in order.
  const history = await deps.store.listPromotions(promotion.hostId);
  const newerActive = history.find(
    (row) =>
      row.kind === "promotion" &&
      row.status === "active" &&
      row.id !== promotion.id &&
      // `>=` on purpose: two promotions sharing a timestamp cannot be ordered,
      // and guessing wrong would silently discard the live decision.
      row.createdAt.getTime() >= promotion.createdAt.getTime()
  );
  if (newerActive) {
    throw new VoiceAuditionError("A newer promotion is live for this host. Roll that back first.");
  }

  const now = deps_now(deps);
  const updated = await deps.store.updatePromotion(promotion.id, {
    status: "rolled_back",
    rolledBackAt: now,
    rolledBackById: input.actorId,
    rolledBackReason: input.reason?.trim() || null,
  });

  const reversal = await deps.store.createPromotion({
    id: deps_id(deps),
    hostId: promotion.hostId,
    kind: "rollback",
    auditionId: promotion.auditionId,
    candidateId: promotion.candidateId,
    fromProvider: promotion.toProvider,
    fromVoiceId: promotion.toVoiceId,
    fromModel: promotion.toModel,
    toProvider: promotion.fromProvider,
    toVoiceId: promotion.fromVoiceId,
    toModel: promotion.fromModel,
    actorId: input.actorId,
    actorLabel: input.actorLabel?.trim() || null,
    reason: input.reason?.trim() || null,
    policyVersion: VOICE_AUDITION_POLICY_VERSION,
    status: "reversal",
    revertsPromotionId: promotion.id,
    rolledBackAt: null,
    rolledBackById: null,
    rolledBackReason: null,
    createdAt: now,
  });

  await deps.store.setHostVoice(promotion.hostId, {
    provider: promotion.fromProvider,
    voiceId: promotion.fromVoiceId,
  });

  return {
    promotion: updated,
    reversal,
    restored: { provider: promotion.fromProvider, voiceId: promotion.fromVoiceId },
    alreadyRolledBack: false,
  };
}

export async function listPromotionHistory(
  deps: VoiceAuditionDeps,
  filter?: PromotionFilter
): Promise<PromotionRecord[]> {
  const rows = await deps.store.listPromotions(filter);
  return rows.slice().sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

// ---------------------------------------------------------------------------
// AUTHORIZATION
//
// Everything below is the answer to "who is allowed to touch this row". It lives
// in the service, not in the server actions, for two reasons:
//
//   · The actions used to each re-derive the rule, and one of them (promotion
//     history) simply forgot to, which handed every signed-in account the voice
//     change log of every other account.
//   · A rule that needs a database to execute cannot be proved. These take an
//     injected store, so the whole matrix runs offline in
//     `testVoiceAuditionAuthz.ts`.
//
// The rule mirrors `ownerScope`/`canViewOwned` exactly:
//   signed out            → nothing
//   operator (isOwnerAccount: role ADMIN or an OWNER_EMAILS address) → everything
//   everyone else         → strictly rows they own. An `ownerId` of null means
//                           "unclaimed", NOT "shared with everyone", so a system
//                           host is operator-only.
//
// A row you do not own is reported with the SAME message as a row that does not
// exist. Guessing ids must not be a way to learn what exists.
// ---------------------------------------------------------------------------

export interface AuditionViewer {
  id: string;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  /**
   * Resolved ONCE by the caller using the project's single admin rule
   * (`isOwnerAccount` in entitlementService: role ADMIN, or an email listed in
   * OWNER_EMAILS). It is passed in rather than recomputed here so this module
   * stays free of a database import — and so there is no second definition of
   * "admin" to drift from the first.
   */
  isAdmin: boolean;
}

export type AuthzResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const AUTHZ_SIGN_IN_REQUIRED = "Please sign in to run a voice audition.";
export const AUTHZ_AUDITION_UNAVAILABLE = "That audition is not available.";
export const AUTHZ_HOST_UNAVAILABLE = "That host is not available.";
export const AUTHZ_PROMOTION_UNAVAILABLE = "That promotion is not available.";

function deny<T>(error: string): AuthzResult<T> {
  return { ok: false, error };
}

/** True when this viewer may act on an owned record. Mirrors `canViewOwned`. */
export function viewerOwns(
  viewer: AuditionViewer | null | undefined,
  record: { ownerId?: string | null } | null | undefined
): boolean {
  if (!viewer || !record) return false;
  if (viewer.isAdmin) return true;
  return !!record.ownerId && record.ownerId === viewer.id;
}

export function actorLabelFor(viewer: AuditionViewer): string {
  return viewer.name || viewer.email || viewer.id;
}

/** Signed in at all. Every guarded operation starts here. */
export function requireViewer(viewer: AuditionViewer | null | undefined): AuthzResult<AuditionViewer> {
  if (!viewer?.id) return deny(AUTHZ_SIGN_IN_REQUIRED);
  return { ok: true, value: viewer };
}

export async function authorizeAudition(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  auditionId: string
): Promise<AuthzResult<AuditionRecord>> {
  const gate = requireViewer(viewer);
  if (!gate.ok) return gate;
  const audition = auditionId ? await deps.store.getAudition(auditionId) : null;
  // Missing and not-mine are the same answer on purpose.
  if (!audition || !viewerOwns(gate.value, audition)) return deny(AUTHZ_AUDITION_UNAVAILABLE);
  return { ok: true, value: audition };
}

export async function authorizeHost(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  hostId: string
): Promise<AuthzResult<HostVoiceRecord>> {
  const gate = requireViewer(viewer);
  if (!gate.ok) return gate;
  const host = hostId ? await deps.store.getHostVoice(hostId) : null;
  // `ownerId: null` (shared/system host) falls through to operators only.
  if (!host || !viewerOwns(gate.value, { ownerId: host.ownerId ?? null })) {
    return deny(AUTHZ_HOST_UNAVAILABLE);
  }
  return { ok: true, value: host };
}

/** A promotion belongs to whoever owns the host whose voice it changed. */
export async function authorizePromotion(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  promotionId: string
): Promise<AuthzResult<{ promotion: PromotionRecord; host: HostVoiceRecord }>> {
  const gate = requireViewer(viewer);
  if (!gate.ok) return gate;
  const promotion = promotionId ? await deps.store.getPromotion(promotionId) : null;
  if (!promotion) return deny(AUTHZ_PROMOTION_UNAVAILABLE);
  const host = await authorizeHost(deps, gate.value, promotion.hostId);
  // Deliberately reports the promotion message, not the host one: which of the
  // two was refused is itself information.
  if (!host.ok) return deny(AUTHZ_PROMOTION_UNAVAILABLE);
  return { ok: true, value: { promotion, host: host.value } };
}

// ---------------------------------------------------------------------------
// Guarded operations — the ONLY entry points a server action should call.
// ---------------------------------------------------------------------------

/** Identity-free view of the voice change log. Rollback needs an id, not a voice. */
export interface PromotionSummary {
  id: string;
  hostId: string;
  kind: PromotionKind;
  status: PromotionStatus;
  auditionId: string | null;
  actorLabel: string | null;
  reason: string | null;
  createdAt: string;
  rolledBackAt: string | null;
  rolledBackReason: string | null;
  revertsPromotionId: string | null;
  canRollback: boolean;
}

/**
 * Drops fromProvider/toProvider/fromVoiceId/toVoiceId/toModel/candidateId. The
 * ledger still holds them — a rollback reads them server-side — but a browser
 * never needs them to know that a voice was changed, by whom, and when.
 */
export function toPromotionSummary(promotion: PromotionRecord): PromotionSummary {
  return {
    id: promotion.id,
    hostId: promotion.hostId,
    kind: promotion.kind,
    status: promotion.status,
    auditionId: promotion.auditionId,
    actorLabel: promotion.actorLabel,
    reason: promotion.reason,
    createdAt: promotion.createdAt.toISOString(),
    rolledBackAt: promotion.rolledBackAt?.toISOString() ?? null,
    rolledBackReason: promotion.rolledBackReason,
    revertsPromotionId: promotion.revertsPromotionId,
    canRollback: promotion.kind === "promotion" && promotion.status === "active",
  };
}

function guardFailure<T>(error: unknown): AuthzResult<T> {
  const message =
    error instanceof VoiceAuditionError
      ? error.message
      : error instanceof Error
        ? error.message
        : "That didn't work. Try again.";
  return deny(redactVoiceSecrets(message));
}

export async function guardedListAuditions(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null
): Promise<AuthzResult<AuditionRecord[]>> {
  const gate = requireViewer(viewer);
  if (!gate.ok) return gate;
  // Operators see the whole deployment; everyone else gets a query scoped to
  // their own id before it reaches the database.
  const rows = await deps.store.listAuditions(gate.value.isAdmin ? null : gate.value.id);
  return { ok: true, value: rows };
}

export async function guardedGetBallots(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  auditionId: string
): Promise<AuthzResult<{ ballots: BlindBallot[]; tally: BlindTallyRow[] }>> {
  const gate = await authorizeAudition(deps, viewer, auditionId);
  if (!gate.ok) return gate;
  try {
    const [ballots, tally] = await Promise.all([
      getBallots(deps, gate.value.id),
      tallyAudition(deps, gate.value.id),
    ]);
    return { ok: true, value: { ballots, tally } };
  } catch (error) {
    return guardFailure(error);
  }
}

export async function guardedOpenVoting(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  auditionId: string
): Promise<AuthzResult<AuditionStatus>> {
  const gate = await authorizeAudition(deps, viewer, auditionId);
  if (!gate.ok) return gate;
  try {
    const opened = await openVoting(deps, gate.value.id);
    return { ok: true, value: opened.status };
  } catch (error) {
    return guardFailure(error);
  }
}

export async function guardedCastVote(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  input: { auditionId: string; ballotId: string; scores: Partial<AuditionScores>; overall: number; notes?: string | null }
): Promise<AuthzResult<BlindTallyRow[]>> {
  const gate = await authorizeAudition(deps, viewer, input.auditionId);
  if (!gate.ok) return gate;
  try {
    await castVote(deps, {
      auditionId: gate.value.id,
      // Resolved against THIS audition, so a ballot id from another audition is
      // rejected even when the caller owns both.
      ballotId: input.ballotId,
      voterId: viewer!.id,
      voterLabel: actorLabelFor(viewer!),
      scores: input.scores,
      overall: input.overall,
      notes: input.notes ?? null,
    });
    return { ok: true, value: await tallyAudition(deps, gate.value.id) };
  } catch (error) {
    return guardFailure(error);
  }
}

export async function guardedSelectWinner(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  input: { auditionId: string; ballotId: string }
): Promise<AuthzResult<{ selected: true }>> {
  const gate = await authorizeAudition(deps, viewer, input.auditionId);
  if (!gate.ok) return gate;
  try {
    await selectWinner(deps, {
      auditionId: gate.value.id,
      ballotId: input.ballotId,
      actorId: viewer!.id,
    });
    return { ok: true, value: { selected: true } };
  } catch (error) {
    return guardFailure(error);
  }
}

export async function guardedReveal(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  auditionId: string
): Promise<AuthzResult<RevealedCandidate[]>> {
  const gate = await authorizeAudition(deps, viewer, auditionId);
  if (!gate.ok) return gate;
  try {
    const revealed = await revealAudition(deps, { auditionId: gate.value.id, actorId: viewer!.id });
    return { ok: true, value: revealed.candidates };
  } catch (error) {
    return guardFailure(error);
  }
}

/**
 * Promotion is the dangerous verb, so it is gated TWICE: on the audition being
 * yours, and on the host being yours. A system host (`ownerId: null`) is an
 * operator-only target — an ordinary account cannot repoint the shared voice.
 */
export async function guardedPromote(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  input: { auditionId: string; acknowledgedBallotId: string; hostId?: string | null; reason?: string | null }
): Promise<AuthzResult<{ promotionId: string }>> {
  const auditionGate = await authorizeAudition(deps, viewer, input.auditionId);
  if (!auditionGate.ok) return auditionGate;
  const hostGate = await authorizeHost(
    deps,
    viewer,
    (input.hostId || auditionGate.value.hostId || "").trim()
  );
  if (!hostGate.ok) return hostGate;
  try {
    const { promotion } = await promoteWinner(deps, {
      auditionId: auditionGate.value.id,
      hostId: hostGate.value.id,
      acknowledgedBallotId: input.acknowledgedBallotId,
      actorId: viewer!.id,
      actorLabel: actorLabelFor(viewer!),
      reason: input.reason ?? null,
    });
    return { ok: true, value: { promotionId: promotion.id } };
  } catch (error) {
    return guardFailure(error);
  }
}

export async function guardedRollback(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  input: { promotionId: string; reason?: string | null }
): Promise<AuthzResult<{ alreadyRolledBack: boolean; hostName: string }>> {
  const gate = await authorizePromotion(deps, viewer, input.promotionId);
  if (!gate.ok) return gate;
  try {
    const result = await rollbackPromotion(deps, {
      promotionId: gate.value.promotion.id,
      actorId: viewer!.id,
      actorLabel: actorLabelFor(viewer!),
      reason: input.reason ?? null,
    });
    // `result.restored` holds the voice that came back. It stays on the server:
    // the operator asked to undo a change, not to be told an engine identity.
    return {
      ok: true,
      value: { alreadyRolledBack: result.alreadyRolledBack, hostName: gate.value.host.name },
    };
  } catch (error) {
    return guardFailure(error);
  }
}

/**
 * The defect that started this: no hostId used to mean "every promotion on the
 * deployment". Now it means "every promotion on hosts you own", built as a
 * scoped query — and a hostId you do not own is refused rather than answered.
 */
export async function guardedPromotionHistory(
  deps: VoiceAuditionDeps,
  viewer: AuditionViewer | null,
  hostId?: string | null
): Promise<AuthzResult<PromotionSummary[]>> {
  const gate = requireViewer(viewer);
  if (!gate.ok) return gate;

  let filter: PromotionFilter;
  if (hostId) {
    const host = await authorizeHost(deps, gate.value, hostId);
    if (!host.ok) return deny(host.error);
    filter = { hostId: host.value.id };
  } else if (gate.value.isAdmin) {
    filter = undefined;
  } else {
    const ownedHostIds = await deps.store.listHostIdsForOwner(gate.value.id);
    if (ownedHostIds.length === 0) return { ok: true, value: [] };
    filter = { hostIds: ownedHostIds };
  }

  try {
    const rows = await listPromotionHistory(deps, filter);
    const summaries = rows.map(toPromotionSummary);
    // Same last line of defence the ballots get.
    assertBallotIsBlind(summaries);
    return { ok: true, value: summaries };
  } catch (error) {
    return guardFailure(error);
  }
}

// ---------------------------------------------------------------------------
// Default adapters
//
// Loaded lazily so that importing this module (in a test, or in a server
// component that only reads the store) does not drag in ffmpeg, the TTS
// factory or object storage.
// ---------------------------------------------------------------------------

export function defaultAuditionRenderer(): AuditionRenderer {
  return {
    async render(input: AuditionRenderInput): Promise<AuditionRenderOutput> {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const { getTTSProvider } = await import("../providers/tts/factory");
      const { runFfmpeg, masterToMp3, getFileDurationMs } = await import("../audio/assembly");

      const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
      const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";
      const token = crypto.randomBytes(8).toString("hex");
      const workDir = path.join(os.tmpdir(), `voice-audition-${process.pid}-${token}`);
      fs.mkdirSync(workDir, { recursive: true });

      const turns = input.scenes.flatMap((scene) =>
        scene.turns.map((turn) => ({ ...turn, direction: scene.direction }))
      );
      const clips: string[] = [];

      try {
        for (let index = 0; index < turns.length; index++) {
          const turn = turns[index];
          const voice = turn.role === "candidate" ? input.candidate : input.partner;
          const settings = voice.settings ?? {};
          const previous = turns.slice(0, index).reverse().find((item) => item.role === turn.role);
          const next = turns.slice(index + 1).find((item) => item.role === turn.role);
          const result = await getTTSProvider(voice.provider).synthesizeSpeech({
            text: turn.text,
            voiceId: voice.voiceId,
            speakerName: turn.role === "candidate" ? "Candidate" : "Partner",
            seatIndex: turn.role === "candidate" ? 0 : 1,
            tone: turn.tone,
            energy: turn.energy,
            isInterruption: turn.isInterruption,
            previousText: previous?.text,
            nextText: next?.text,
            voiceDirection: settings.voiceDirection
              ? `${settings.voiceDirection} ${turn.direction}`
              : turn.direction,
            speed: settings.speed,
            volume: settings.volume,
            temperature: settings.temperature,
            topP: settings.topP,
            format: "mp3",
          });
          if (!result.audioBuffer?.length) throw new Error(`turn ${index} returned no audio`);
          const clip = path.join(workDir, `${String(index).padStart(3, "0")}.mp3`);
          fs.writeFileSync(clip, result.audioBuffer);
          clips.push(clip);
        }

        const concatList = path.join(workDir, "concat.txt");
        fs.writeFileSync(
          concatList,
          clips.map((clip) => `file '${clip.replace(/'/g, "'\\''")}'`).join("\n")
        );
        const joined = path.join(workDir, "joined.mp3");
        await runFfmpeg(ffmpegPath, [
          "-y", "-f", "concat", "-safe", "0", "-i", concatList,
          "-c:a", "libmp3lame", "-b:a", "192k", joined,
        ]);
        const mastered = path.join(workDir, "audition.mp3");
        await masterToMp3(ffmpegPath, joined, mastered, { targetLufs: -16, bitrate: "192k" });

        return {
          audioBuffer: fs.readFileSync(mastered),
          contentType: "audio/mpeg",
          model: input.candidate.model ?? null,
          durationMs: await getFileDurationMs(ffprobePath, mastered),
        };
      } finally {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    },
  };
}

export function defaultAuditionAnalyzer(): AuditionMetricsAnalyzer {
  return {
    async analyze(audioBuffer, context): Promise<AuditionMetrics> {
      const { analyzeSpokenPerformanceBuffer } = await import("../audio/spokenPerformanceQa");
      // Never strict here: a long audition is judged by a human, and a hard QA
      // failure must not stop the recording from reaching the listening panel.
      const report = await analyzeSpokenPerformanceBuffer(audioBuffer, {
        expectedTurnCount: context.turnCount,
        format: context.format,
        strict: false,
      });
      return {
        performanceScore: report.score,
        passed: report.passed,
        failures: report.failures,
        warnings: report.warnings,
        durationSec: report.metrics.durationSec,
        integratedLufs: report.metrics.integratedLufs,
        loudnessRangeLu: report.metrics.loudnessRangeLu,
        pauseStdDevSec: report.metrics.pauseStdDevSec,
        longestPauseSec: report.metrics.longestPauseSec,
        terminalFallRatio: report.metrics.terminalFallRatio,
        medianPhrasePitchRangeSemitones: report.metrics.medianPhrasePitchRangeSemitones,
        phraseEnergyCoefficientOfVariation: report.metrics.phraseEnergyCoefficientOfVariation,
      };
    },
  };
}

export function defaultAuditionAudioStore(): AuditionAudioStore {
  return {
    async put(input) {
      const { getStorageProvider } = await import("../providers/storage/factory");
      const stored = await getStorageProvider().putObject(input);
      return { url: stored.url, key: stored.key };
    },
  };
}

// ---------------------------------------------------------------------------
// Prisma store (production default)
//
// The client is passed in rather than imported so that this module never pulls
// a database connection into a test process.
// ---------------------------------------------------------------------------

interface Delegate {
  create(args: unknown): Promise<unknown>;
  update(args: unknown): Promise<unknown>;
  upsert?(args: unknown): Promise<unknown>;
  findUnique(args: unknown): Promise<unknown>;
  findFirst?(args: unknown): Promise<unknown>;
  findMany(args: unknown): Promise<unknown[]>;
}

export interface VoiceAuditionPrismaClient {
  voiceAudition: Delegate;
  voiceAuditionCandidate: Delegate;
  voiceAuditionVote: Delegate;
  voicePromotion: Delegate;
  aiHost: Delegate;
}

type Row = Record<string, unknown>;

function asDate(value: unknown, fallback?: Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return fallback ?? new Date(0);
}

function asNullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : asDate(value);
}

function mapAudition(row: Row): AuditionRecord {
  return {
    id: String(row.id),
    ownerId: (row.ownerId as string | null) ?? null,
    hostId: (row.hostId as string | null) ?? null,
    title: String(row.title ?? ""),
    status: (row.status as AuditionStatus) ?? "draft",
    packVersion: String(row.packVersion ?? ""),
    packSceneIds: Array.isArray(row.packSceneIds) ? (row.packSceneIds as string[]) : [],
    policyVersion: Number(row.policyVersion ?? VOICE_AUDITION_POLICY_VERSION),
    blindSeed: String(row.blindSeed ?? ""),
    winnerCandidateId: (row.winnerCandidateId as string | null) ?? null,
    winnerSelectedAt: asNullableDate(row.winnerSelectedAt),
    winnerSelectedById: (row.winnerSelectedById as string | null) ?? null,
    unblindedAt: asNullableDate(row.unblindedAt),
    unblindedById: (row.unblindedById as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    createdAt: asDate(row.createdAt),
  };
}

function mapCandidate(row: Row): CandidateRecord {
  return {
    id: String(row.id),
    auditionId: String(row.auditionId),
    ballotId: String(row.ballotId),
    blindPosition: Number(row.blindPosition ?? 0),
    privateLabel: (row.privateLabel as string | null) ?? null,
    provider: String(row.provider ?? ""),
    voiceId: String(row.voiceId ?? ""),
    model: (row.model as string | null) ?? null,
    generationSettings: (row.generationSettings as AuditionGenerationSettings | null) ?? null,
    audioAssetKey: (row.audioAssetKey as string | null) ?? null,
    audioAssetUrl: (row.audioAssetUrl as string | null) ?? null,
    audioContentType: (row.audioContentType as string | null) ?? null,
    audioBytes: row.audioBytes === null || row.audioBytes === undefined ? null : Number(row.audioBytes),
    durationMs: row.durationMs === null || row.durationMs === undefined ? null : Number(row.durationMs),
    renderedAt: asNullableDate(row.renderedAt),
    renderError: (row.renderError as string | null) ?? null,
    metrics: (row.metrics as AuditionMetrics | null) ?? null,
    createdAt: asDate(row.createdAt),
  };
}

function mapVote(row: Row): VoteRecord {
  const scores = {} as AuditionScores;
  for (const dimension of AUDITION_DIMENSIONS) scores[dimension] = Number(row[dimension] ?? 0);
  return {
    id: String(row.id),
    auditionId: String(row.auditionId),
    candidateId: String(row.candidateId),
    voterId: String(row.voterId ?? ""),
    voterLabel: (row.voterLabel as string | null) ?? null,
    scores,
    overall: Number(row.overall ?? 0),
    notes: (row.notes as string | null) ?? null,
    createdAt: asDate(row.createdAt),
  };
}

function mapPromotion(row: Row): PromotionRecord {
  return {
    id: String(row.id),
    hostId: String(row.hostId),
    kind: (row.kind as PromotionKind) ?? "promotion",
    auditionId: (row.auditionId as string | null) ?? null,
    candidateId: (row.candidateId as string | null) ?? null,
    fromProvider: (row.fromProvider as string | null) ?? null,
    fromVoiceId: (row.fromVoiceId as string | null) ?? null,
    fromModel: (row.fromModel as string | null) ?? null,
    toProvider: String(row.toProvider ?? ""),
    toVoiceId: String(row.toVoiceId ?? ""),
    toModel: (row.toModel as string | null) ?? null,
    actorId: String(row.actorId ?? ""),
    actorLabel: (row.actorLabel as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    policyVersion: Number(row.policyVersion ?? VOICE_AUDITION_POLICY_VERSION),
    status: (row.status as PromotionStatus) ?? "active",
    revertsPromotionId: (row.revertsPromotionId as string | null) ?? null,
    rolledBackAt: asNullableDate(row.rolledBackAt),
    rolledBackById: (row.rolledBackById as string | null) ?? null,
    rolledBackReason: (row.rolledBackReason as string | null) ?? null,
    createdAt: asDate(row.createdAt),
  };
}

function auditionWriteData(input: Partial<AuditionRecord>): Row {
  const data: Row = {};
  const keys: (keyof AuditionRecord)[] = [
    "id", "ownerId", "hostId", "title", "status", "packVersion", "packSceneIds",
    "policyVersion", "blindSeed", "winnerCandidateId", "winnerSelectedAt",
    "winnerSelectedById", "unblindedAt", "unblindedById", "notes", "createdAt",
  ];
  for (const key of keys) if (input[key] !== undefined) data[key] = input[key];
  return data;
}

function candidateWriteData(input: Partial<CandidateRecord>): Row {
  const data: Row = {};
  const keys: (keyof CandidateRecord)[] = [
    "id", "auditionId", "ballotId", "blindPosition", "privateLabel", "provider",
    "voiceId", "model", "generationSettings", "audioAssetKey", "audioAssetUrl",
    "audioContentType", "audioBytes", "durationMs", "renderedAt", "renderError",
    "metrics", "createdAt",
  ];
  for (const key of keys) if (input[key] !== undefined) data[key] = input[key];
  return data;
}

function promotionWriteData(input: Partial<PromotionRecord>): Row {
  const data: Row = {};
  const keys: (keyof PromotionRecord)[] = [
    "id", "hostId", "kind", "auditionId", "candidateId", "fromProvider", "fromVoiceId",
    "fromModel", "toProvider", "toVoiceId", "toModel", "actorId", "actorLabel", "reason",
    "policyVersion", "status", "revertsPromotionId", "rolledBackAt", "rolledBackById",
    "rolledBackReason", "createdAt",
  ];
  for (const key of keys) if (input[key] !== undefined) data[key] = input[key];
  return data;
}

/**
 * THE BLIND SELECT. These are the only candidate columns the ballot path reads.
 * Adding `provider`, `voiceId` or `model` here would defeat the whole feature,
 * which is why it is a named constant rather than an inline object.
 */
export const BALLOT_SELECT = {
  ballotId: true,
  auditionId: true,
  blindPosition: true,
  audioAssetUrl: true,
  durationMs: true,
  renderError: true,
} as const;

export function createPrismaVoiceAuditionStore(client: VoiceAuditionPrismaClient): VoiceAuditionStore {
  return {
    async createAudition(input) {
      const row = await client.voiceAudition.create({ data: auditionWriteData(input) });
      return mapAudition(row as Row);
    },
    async getAudition(id) {
      const row = await client.voiceAudition.findUnique({ where: { id } });
      return row ? mapAudition(row as Row) : null;
    },
    async updateAudition(id, patch) {
      const row = await client.voiceAudition.update({ where: { id }, data: auditionWriteData(patch) });
      return mapAudition(row as Row);
    },
    async listAuditions(ownerId) {
      const rows = await client.voiceAudition.findMany({
        where: ownerId ? { ownerId } : {},
        orderBy: { createdAt: "desc" },
      });
      return rows.map((row) => mapAudition(row as Row));
    },

    async createCandidate(input) {
      const row = await client.voiceAuditionCandidate.create({ data: candidateWriteData(input) });
      return mapCandidate(row as Row);
    },
    async updateCandidate(id, patch) {
      const row = await client.voiceAuditionCandidate.update({ where: { id }, data: candidateWriteData(patch) });
      return mapCandidate(row as Row);
    },
    async getCandidateByBallotId(auditionId, ballotId) {
      const row = await client.voiceAuditionCandidate.findUnique({ where: { ballotId } });
      const candidate = row ? mapCandidate(row as Row) : null;
      return candidate && candidate.auditionId === auditionId ? candidate : null;
    },

    async listBallotProjections(auditionId) {
      const rows = await client.voiceAuditionCandidate.findMany({
        where: { auditionId },
        select: BALLOT_SELECT,
        orderBy: { blindPosition: "asc" },
      });
      return rows.map((row) => {
        const r = row as Row;
        return {
          ballotId: String(r.ballotId),
          auditionId: String(r.auditionId),
          blindPosition: Number(r.blindPosition ?? 0),
          audioAssetUrl: (r.audioAssetUrl as string | null) ?? null,
          durationMs: r.durationMs === null || r.durationMs === undefined ? null : Number(r.durationMs),
          renderError: (r.renderError as string | null) ?? null,
        };
      });
    },
    async listCandidates(auditionId) {
      const rows = await client.voiceAuditionCandidate.findMany({
        where: { auditionId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((row) => mapCandidate(row as Row));
    },

    async upsertVote(input) {
      const dimensionData = AUDITION_DIMENSIONS.reduce((accumulator, dimension) => {
        accumulator[dimension] = input.scores[dimension];
        return accumulator;
      }, {} as Row);
      const shared: Row = {
        ...dimensionData,
        overall: input.overall,
        notes: input.notes,
        voterLabel: input.voterLabel,
      };
      const row = await client.voiceAuditionVote.upsert!({
        where: { candidateId_voterId: { candidateId: input.candidateId, voterId: input.voterId } },
        create: {
          id: input.id ?? crypto.randomUUID(),
          auditionId: input.auditionId,
          candidateId: input.candidateId,
          voterId: input.voterId,
          ...shared,
        },
        update: shared,
      });
      return mapVote(row as Row);
    },
    async listVotes(auditionId, voterId) {
      const rows = await client.voiceAuditionVote.findMany({
        where: voterId ? { auditionId, voterId } : { auditionId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map((row) => mapVote(row as Row));
    },

    async getHostVoice(hostId) {
      const row = (await client.aiHost.findUnique({
        where: { id: hostId },
        // ownerId is selected because every caller has to decide whether this
        // viewer may touch the host; a host read without its owner is unusable.
        select: { id: true, name: true, ttsProvider: true, ttsVoiceId: true, ownerId: true },
      })) as Row | null;
      if (!row) return null;
      return {
        id: String(row.id),
        name: String(row.name ?? ""),
        provider: String(row.ttsProvider ?? ""),
        voiceId: String(row.ttsVoiceId ?? ""),
        ownerId: (row.ownerId as string | null) ?? null,
      };
    },
    async setHostVoice(hostId, voice) {
      await client.aiHost.update({
        where: { id: hostId },
        data: { ttsProvider: voice.provider, ttsVoiceId: voice.voiceId },
      });
    },
    async listHostIdsForOwner(ownerId) {
      const rows = await client.aiHost.findMany({ where: { ownerId }, select: { id: true } });
      return rows.map((row) => String((row as Row).id));
    },

    async createPromotion(input) {
      const row = await client.voicePromotion.create({ data: promotionWriteData(input) });
      return mapPromotion(row as Row);
    },
    async getPromotion(id) {
      const row = await client.voicePromotion.findUnique({ where: { id } });
      return row ? mapPromotion(row as Row) : null;
    },
    async updatePromotion(id, patch) {
      const row = await client.voicePromotion.update({ where: { id }, data: promotionWriteData(patch) });
      return mapPromotion(row as Row);
    },
    async listPromotions(filter) {
      const { hostId, hostIds } = normalizePromotionFilter(filter);
      // Owner scoping is a WHERE, not a post-filter: rows outside the scope are
      // never loaded into the process that answers the browser.
      const where: Row = {};
      if (hostId) where.hostId = hostId;
      else if (hostIds) where.hostId = { in: [...hostIds] };
      const rows = await client.voicePromotion.findMany({ where, orderBy: { createdAt: "desc" } });
      return rows.map((row) => mapPromotion(row as Row));
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory store — tests and local development.
//
// The real Postgres in this environment is unreachable, and a feature whose
// correctness rests on "the query does not select the voice id" deserves to be
// proven rather than asserted. This fake implements the same port, including
// the blind projection, so the flow can be executed end to end offline.
// ---------------------------------------------------------------------------

export interface InMemoryVoiceAuditionStore extends VoiceAuditionStore {
  /** Inspection hooks for tests. Not part of the port. */
  __hosts: Map<string, HostVoiceRecord>;
  __auditions: Map<string, AuditionRecord>;
  __candidates: Map<string, CandidateRecord>;
  __votes: Map<string, VoteRecord>;
  __promotions: Map<string, PromotionRecord>;
  __hostWrites: Array<{ hostId: string; provider: string; voiceId: string; at: Date }>;
}

export function createInMemoryVoiceAuditionStore(
  hosts: HostVoiceRecord[] = []
): InMemoryVoiceAuditionStore {
  const hostMap = new Map(hosts.map((host) => [host.id, { ...host }]));
  const auditions = new Map<string, AuditionRecord>();
  const candidates = new Map<string, CandidateRecord>();
  const votes = new Map<string, VoteRecord>();
  const promotions = new Map<string, PromotionRecord>();
  const hostWrites: Array<{ hostId: string; provider: string; voiceId: string; at: Date }> = [];

  const clone = <T>(value: T): T => (value === null || typeof value !== "object" ? value : { ...value }) as T;

  return {
    __hosts: hostMap,
    __auditions: auditions,
    __candidates: candidates,
    __votes: votes,
    __promotions: promotions,
    __hostWrites: hostWrites,

    async createAudition(input) {
      const record: AuditionRecord = { ...input, createdAt: input.createdAt ?? new Date() };
      auditions.set(record.id, record);
      return clone(record);
    },
    async getAudition(id) {
      const found = auditions.get(id);
      return found ? clone(found) : null;
    },
    async updateAudition(id, patch) {
      const found = auditions.get(id);
      if (!found) throw new VoiceAuditionError("Audition not found.");
      const next = { ...found, ...patch };
      auditions.set(id, next);
      return clone(next);
    },
    async listAuditions(ownerId) {
      return [...auditions.values()]
        .filter((audition) => (ownerId ? audition.ownerId === ownerId : true))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .map(clone);
    },

    async createCandidate(input) {
      const record: CandidateRecord = { ...input, createdAt: input.createdAt ?? new Date() };
      candidates.set(record.id, record);
      return clone(record);
    },
    async updateCandidate(id, patch) {
      const found = candidates.get(id);
      if (!found) throw new VoiceAuditionError("Candidate not found.");
      const next = { ...found, ...patch };
      candidates.set(id, next);
      return clone(next);
    },
    async getCandidateByBallotId(auditionId, ballotId) {
      const found = [...candidates.values()].find(
        (candidate) => candidate.ballotId === ballotId && candidate.auditionId === auditionId
      );
      return found ? clone(found) : null;
    },

    async listBallotProjections(auditionId) {
      // Deliberately constructs the row field by field. Spreading the record
      // here is exactly the bug this port exists to make impossible.
      return [...candidates.values()]
        .filter((candidate) => candidate.auditionId === auditionId)
        .sort((left, right) => left.blindPosition - right.blindPosition)
        .map((candidate) => ({
          ballotId: candidate.ballotId,
          auditionId: candidate.auditionId,
          blindPosition: candidate.blindPosition,
          audioAssetUrl: candidate.audioAssetUrl,
          durationMs: candidate.durationMs,
          renderError: candidate.renderError,
        }));
    },
    async listCandidates(auditionId) {
      return [...candidates.values()]
        .filter((candidate) => candidate.auditionId === auditionId)
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map(clone);
    },

    async upsertVote(input) {
      const key = `${input.candidateId}:${input.voterId}`;
      const existing = votes.get(key);
      const record: VoteRecord = {
        id: existing?.id ?? input.id ?? crypto.randomUUID(),
        auditionId: input.auditionId,
        candidateId: input.candidateId,
        voterId: input.voterId,
        voterLabel: input.voterLabel,
        scores: { ...input.scores },
        overall: input.overall,
        notes: input.notes,
        createdAt: existing?.createdAt ?? input.createdAt ?? new Date(),
      };
      votes.set(key, record);
      return clone(record);
    },
    async listVotes(auditionId, voterId) {
      return [...votes.values()]
        .filter((vote) => vote.auditionId === auditionId)
        .filter((vote) => (voterId ? vote.voterId === voterId : true))
        .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
        .map((vote) => ({ ...vote, scores: { ...vote.scores } }));
    },

    async getHostVoice(hostId) {
      const found = hostMap.get(hostId);
      return found ? clone(found) : null;
    },
    async setHostVoice(hostId, voice) {
      const found = hostMap.get(hostId);
      if (!found) throw new VoiceAuditionError("Host not found.");
      hostMap.set(hostId, { ...found, provider: voice.provider, voiceId: voice.voiceId });
      hostWrites.push({ hostId, provider: voice.provider, voiceId: voice.voiceId, at: new Date() });
    },
    async listHostIdsForOwner(ownerId) {
      return [...hostMap.values()]
        .filter((host) => !!host.ownerId && host.ownerId === ownerId)
        .map((host) => host.id);
    },

    async createPromotion(input) {
      const record: PromotionRecord = { ...input, createdAt: input.createdAt ?? new Date() };
      promotions.set(record.id, record);
      return clone(record);
    },
    async getPromotion(id) {
      const found = promotions.get(id);
      return found ? clone(found) : null;
    },
    async updatePromotion(id, patch) {
      const found = promotions.get(id);
      if (!found) throw new VoiceAuditionError("Promotion not found.");
      const next = { ...found, ...patch };
      promotions.set(id, next);
      return clone(next);
    },
    async listPromotions(filter) {
      const { hostId, hostIds } = normalizePromotionFilter(filter);
      const allowed = hostIds ? new Set(hostIds) : null;
      return [...promotions.values()]
        .filter((promotion) => (hostId ? promotion.hostId === hostId : true))
        .filter((promotion) => (allowed ? allowed.has(promotion.hostId) : true))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .map(clone);
    },
  };
}
