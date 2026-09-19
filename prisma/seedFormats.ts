// Dedicated entry point for seeding the show-format catalog.
//   Run: npm run seed:formats
//
// SEPARATE FROM `prisma db seed` ON PURPOSE. The worker does not run
// `prisma db seed` on deploy, so anything that only lives there never reaches
// production. This script exists so seeding formats is a DELIBERATE act with
// its own command and its own output, run by a human who has read
// docs/SHOW_FORMATS.md — not a side effect of a deploy.
//
// Idempotent: upserts by slug, replaces each format's rundown wholesale, and
// never touches the migration's "classic-debate" backfill format.

import { PrismaClient } from "@prisma/client";
import { seedShowFormats } from "./showFormatSeedWriter";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding show formats...");
  const result = await seedShowFormats(prisma);

  const formats = await prisma.showFormat.count();
  const segments = await prisma.formatSegment.count();
  const shows = await prisma.podcast.count();
  const showsWithFormat = await prisma.podcast.count({ where: { formatId: { not: null } } });

  console.log("\nRow counts after seeding:");
  console.log(`  ShowFormat        ${formats}  (${result.formatsWritten} authored + migration backfill)`);
  console.log(`  FormatSegment     ${segments}  (${result.segmentsWritten} written, ${result.segmentsRemoved} replaced)`);
  console.log(`  Podcast           ${shows}  (${showsWithFormat} with a format)`);
  for (const f of result.byFormat) {
    console.log(`    - ${f.slug} v${f.version} ${f.status} — ${f.segments} segment(s)`);
  }

  if (showsWithFormat !== shows) {
    console.warn(
      `\nWARNING: ${shows - showsWithFormat} show(s) have no format. The migration backfill did not reach them — investigate before generating.`
    );
  }
}

main()
  .catch((e) => {
    console.error("Error during format seed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
