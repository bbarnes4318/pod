// The authored show-format catalog — the DATA the format seeder writes.
//
// This file is to formats what src/lib/hosts/roster.ts is to hosts: the
// definitions live here so they can be asserted without standing up a
// database, and prisma/seed.ts is the WRITER.
//
// A format describes THE SHOW — its rundown, its clock, its devices. It never
// describes THE PEOPLE. No host name, voice, catchphrase, or persona text
// belongs in this file, and nothing here is ever written to an AiHost row.
// The counterpart rule holds too: a persona never carries format text.
//
// Client-safe: no Node imports, no database.
//
// SOURCE OF TRUTH: docs/SHOW_FORMATS.md. The segment tables there and the
// entries here must agree; the validator below catches the arithmetic, not the
// prose.

/** Mirrors the Prisma FormatTopicMode enum. */
export type FormatTopicMode = "SINGLE" | "MULTI" | "CARRYOVER";

/** Mirrors the Prisma FormatStatus enum. */
export type FormatStatus = "DRAFT" | "ACTIVE" | "RETIRED";

/** Mirrors the Prisma FormatSegmentDevice enum. */
export type FormatSegmentDevice =
  | "NONE"
  | "VERDICT"
  | "PICK"
  | "SCORE"
  | "CALLER"
  | "RETRACTION"
  | "STEELMAN_TRANSFER";

/** Share of a segment's floor time per seat. Must sum to 1. */
export interface FloorSplit {
  seatA: number;
  seatB: number;
}

/** How the talk moves inside a segment. */
export interface TurnProfile {
  /** 0-1. How often a turn is cut into rather than yielded. */
  interruptionRate: number;
  /** 0-1. How often a listening seat makes a non-turn noise. */
  backchannelRate: number;
  /** Words the writer should aim for per spoken turn. */
  targetTurnWords: number;
  /** May the same seat take two turns in a row? */
  allowConsecutiveTurns: boolean;
}

export interface FormatSegmentSeed {
  /** Rundown position, 0-based, contiguous. */
  order: number;
  /** Stable key; also the intensityCurve key. */
  key: string;
  displayName: string;
  seconds: number;
  floorSplit: FloorSplit;
  turnProfile: TurnProfile;
  /** Verifiable claims per MINUTE this segment should carry. */
  evidenceDensity: number;
  device: FormatSegmentDevice;
  /** Null whenever device is NONE. */
  deviceConfig: Record<string, unknown> | null;
  exitCondition: string;
  producerNote: string;
}

export interface ShowFormatSeed {
  slug: string;
  name: string;
  tagline: string;
  topicMode: FormatTopicMode;
  totalSeconds: number;
  coldOpenStyle: string;
  signOffStyle: string;
  /** Target intensity 1-10 per segment key. One entry per segment, no extras. */
  intensityCurve: Record<string, number>;
  status: FormatStatus;
  version: number;
  segments: FormatSegmentSeed[];
}

/**
 * The seven authored formats.
 *
 * NOT YET POPULATED — these are transcribed from the segment tables in
 * docs/SHOW_FORMATS.md, which is authored from the production spec. The seeder
 * refuses to run against an empty catalog rather than reporting a successful
 * seed of nothing.
 *
 * Expected slugs: the-ledger, six-minutes-to-air, the-draft, the-autopsy,
 * the-flip, open-line (DRAFT — it needs a caller voice pool that does not
 * exist yet), hot-seat.
 */
export const SHOW_FORMAT_SEEDS: ShowFormatSeed[] = [];

/**
 * Slug of the two-host generic format the MIGRATION backfills onto every
 * pre-existing show. It is deliberately NOT in SHOW_FORMAT_SEEDS: it is
 * migration output, not authored catalog, and the seeder must never touch it.
 */
export const BACKFILL_FORMAT_SLUG = "classic-debate";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Everything a format must satisfy before it is allowed into the database.
 *
 * These are WRITE-TIME checks on purpose. A format whose segments do not add
 * up to its clock, or whose floor split does not sum to 1, does not fail
 * loudly at generation time — it quietly produces an episode of the wrong
 * length with a lopsided floor, which reads as a pipeline bug for weeks.
 *
 * Returns every problem found, so one run tells you everything to fix.
 */
export function validateShowFormatSeed(f: ShowFormatSeed): string[] {
  const errs: string[] = [];
  const at = (m: string) => errs.push(`${f.slug}: ${m}`);

  if (!SLUG_RE.test(f.slug)) at(`slug is not kebab-case`);
  if (!f.name.trim()) at("name is empty");
  if (!f.tagline.trim()) at("tagline is empty");
  if (!Number.isInteger(f.version) || f.version < 1) at(`version must be a positive integer, got ${f.version}`);
  if (!Number.isInteger(f.totalSeconds) || f.totalSeconds <= 0) at(`totalSeconds must be a positive integer, got ${f.totalSeconds}`);
  if (!f.coldOpenStyle.trim()) at("coldOpenStyle is empty");
  if (!f.signOffStyle.trim()) at("signOffStyle is empty");
  if (!f.segments.length) at("has no segments");

  // Rundown positions must be 0..n-1 with nothing missing or repeated: the
  // database's unique constraint stops duplicates but not a gap, and a gap
  // means a segment was dropped in transcription.
  const orders = f.segments.map((s) => s.order).sort((a, b) => a - b);
  orders.forEach((o, i) => {
    if (o !== i) at(`segment order is not contiguous from 0 (saw ${orders.join(",")})`);
  });

  const keys = new Set<string>();
  for (const s of f.segments) {
    const sat = (m: string) => at(`segment "${s.key}" ${m}`);
    if (!SLUG_RE.test(s.key.replace(/_/g, "-"))) sat("key is not a lowercase identifier");
    if (keys.has(s.key)) sat("key is used twice");
    keys.add(s.key);
    if (!s.displayName.trim()) sat("has no displayName");
    if (!Number.isInteger(s.seconds) || s.seconds <= 0) sat(`seconds must be a positive integer, got ${s.seconds}`);

    const split = s.floorSplit.seatA + s.floorSplit.seatB;
    if (Math.abs(split - 1) > 1e-9) sat(`floorSplit sums to ${split}, not 1`);
    if (s.floorSplit.seatA < 0 || s.floorSplit.seatB < 0) sat("floorSplit has a negative share");

    const t = s.turnProfile;
    if (t.interruptionRate < 0 || t.interruptionRate > 1) sat(`interruptionRate ${t.interruptionRate} is outside 0-1`);
    if (t.backchannelRate < 0 || t.backchannelRate > 1) sat(`backchannelRate ${t.backchannelRate} is outside 0-1`);
    if (!Number.isInteger(t.targetTurnWords) || t.targetTurnWords <= 0) sat(`targetTurnWords must be a positive integer, got ${t.targetTurnWords}`);

    if (s.evidenceDensity < 0) sat(`evidenceDensity ${s.evidenceDensity} is negative`);

    // A device with no config is usually a transcription slip; a NONE segment
    // carrying config is a device that was removed and left its settings.
    if (s.device === "NONE" && s.deviceConfig !== null) sat("is device NONE but carries deviceConfig");
    if (s.device !== "NONE" && s.deviceConfig === null) sat(`is device ${s.device} but carries no deviceConfig`);

    if (!s.exitCondition.trim()) sat("has no exitCondition");
    if (!s.producerNote.trim()) sat("has no producerNote");
  }

  const sum = f.segments.reduce((n, s) => n + s.seconds, 0);
  if (sum !== f.totalSeconds) at(`segments sum to ${sum}s but totalSeconds is ${f.totalSeconds}s`);

  // The curve is keyed by segment key, so a renamed segment must rename its
  // curve entry too or the intensity silently disappears.
  const curveKeys = Object.keys(f.intensityCurve);
  for (const s of f.segments) {
    const v = f.intensityCurve[s.key];
    if (typeof v !== "number") at(`intensityCurve has no entry for segment "${s.key}"`);
    else if (!Number.isInteger(v) || v < 1 || v > 10) at(`intensityCurve["${s.key}"] is ${v}, outside 1-10`);
  }
  for (const k of curveKeys) {
    if (!keys.has(k)) at(`intensityCurve has an entry for "${k}", which is not a segment`);
  }

  return errs;
}

/** Validates the whole catalog, including cross-format uniqueness. */
export function validateShowFormatCatalog(formats: ShowFormatSeed[]): string[] {
  const errs = formats.flatMap(validateShowFormatSeed);
  const seen = new Set<string>();
  for (const f of formats) {
    if (seen.has(f.slug)) errs.push(`${f.slug}: slug appears twice in the catalog`);
    seen.add(f.slug);
    if (f.slug === BACKFILL_FORMAT_SLUG) {
      errs.push(`${f.slug}: is the migration's backfill format and must not be in the authored catalog`);
    }
  }
  return errs;
}
