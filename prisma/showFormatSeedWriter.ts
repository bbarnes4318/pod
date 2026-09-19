// The WRITER for the authored show-format catalog.
//
// The catalog itself lives in src/lib/formats/showFormatSeeds.ts so the format
// contracts can be asserted without standing up a database — the same split
// the host roster uses (src/lib/hosts/roster.ts is the data, prisma/seed.ts is
// the writer). This module is a pure module with NO top-level side effects, so
// both prisma/seed.ts and prisma/seedFormats.ts can import it without one
// triggering the other's seed.

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  BACKFILL_FORMAT_SLUG,
  SHOW_FORMAT_SEEDS,
  validateShowFormatCatalog,
  type ShowFormatSeed,
} from "../src/lib/formats/showFormatSeeds";

/** The seed types are named interfaces (floorSplit/turnProfile have fixed,
 *  documented shapes); Prisma's Json input wants an index signature. The cast
 *  is at the write boundary only — the shapes stay checked everywhere else,
 *  and validateShowFormatCatalog has already checked the values. */
const asJson = (v: object): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export interface SeedShowFormatsResult {
  formatsWritten: number;
  segmentsWritten: number;
  segmentsRemoved: number;
  byFormat: Array<{ slug: string; status: string; version: number; segments: number }>;
}

/**
 * Upserts the authored catalog by slug.
 *
 * WRITE-TIME VALIDATION FIRST. An invalid format must be impossible to store,
 * because none of its failure modes are loud at generation time: a rundown
 * that does not add up produces an episode of the wrong length, and a floor
 * split that does not sum to 1 produces a lopsided floor. Both read as
 * pipeline bugs for weeks. The seed aborts before writing anything.
 *
 * Segments are replaced wholesale per format rather than diffed: a rundown is
 * an ordered whole, and a partial update can leave a segment from a previous
 * version sitting in the middle of a new one. Replacement is safe because
 * Episodes never read a ShowFormat row — they read the formatSnapshot frozen
 * at generation time.
 */
export async function seedShowFormats(
  prisma: PrismaClient,
  formats: ShowFormatSeed[] = SHOW_FORMAT_SEEDS
): Promise<SeedShowFormatsResult> {
  if (formats.length === 0) {
    throw new Error(
      "Seed aborted: the show-format catalog is empty. SHOW_FORMAT_SEEDS in " +
        "src/lib/formats/showFormatSeeds.ts has not been populated from the " +
        "segment tables in docs/SHOW_FORMATS.md. Refusing to report a " +
        "successful seed of nothing."
    );
  }

  const errors = validateShowFormatCatalog(formats);
  if (errors.length > 0) {
    throw new Error(
      `Seed aborted: ${errors.length} invalid show-format definition(s). Nothing was written.\n` +
        errors.map((e) => `  - ${e}`).join("\n")
    );
  }

  const result: SeedShowFormatsResult = {
    formatsWritten: 0,
    segmentsWritten: 0,
    segmentsRemoved: 0,
    byFormat: [],
  };

  for (const f of formats) {
    const scalars = {
      name: f.name,
      tagline: f.tagline,
      topicMode: f.topicMode,
      totalSeconds: f.totalSeconds,
      coldOpenStyle: f.coldOpenStyle,
      signOffStyle: f.signOffStyle,
      intensityCurve: asJson(f.intensityCurve),
      status: f.status,
      version: f.version,
    };

    // One transaction per format: a format and its rundown are never half
    // written, so an interrupted seed leaves whole formats rather than a
    // format whose segments are gone.
    await prisma.$transaction(async (tx) => {
      const format = await tx.showFormat.upsert({
        where: { slug: f.slug },
        update: scalars,
        create: { slug: f.slug, ...scalars },
      });

      const removed = await tx.formatSegment.deleteMany({ where: { formatId: format.id } });
      result.segmentsRemoved += removed.count;

      await tx.formatSegment.createMany({
        data: f.segments.map((s) => ({
          formatId: format.id,
          order: s.order,
          key: s.key,
          displayName: s.displayName,
          seconds: s.seconds,
          floorSplit: asJson(s.floorSplit),
          turnProfile: asJson(s.turnProfile),
          evidenceDensity: s.evidenceDensity,
          device: s.device,
          deviceConfig: s.deviceConfig ? asJson(s.deviceConfig) : undefined,
          exitCondition: s.exitCondition,
          producerNote: s.producerNote,
        })),
      });
    });

    result.formatsWritten += 1;
    result.segmentsWritten += f.segments.length;
    result.byFormat.push({ slug: f.slug, status: f.status, version: f.version, segments: f.segments.length });

    const draft = f.status === "DRAFT" ? "  [DRAFT — not selectable for generation]" : "";
    console.log(`Upserted show format: ${f.name} (${f.slug}) — ${f.segments.length} segment(s)${draft}`);
  }

  // The migration's backfill format is deliberately not in the catalog. Say so
  // rather than leaving an operator to wonder why the row count is n+1.
  const backfill = await prisma.showFormat.count({ where: { slug: BACKFILL_FORMAT_SLUG } });
  if (backfill > 0) {
    console.log(
      `Left "${BACKFILL_FORMAT_SLUG}" untouched — it is migration backfill for pre-existing shows, not authored catalog.`
    );
  }

  return result;
}
