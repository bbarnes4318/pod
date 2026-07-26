// Production data migration for the derived format gate (PR #59 / C1).
//
// Run (in the deployed container):
//   npm run migrate:legacy-formats            -- dry run: REPORT ONLY
//   npm run migrate:legacy-formats -- --apply -- move affected shows
//   npm run migrate:legacy-formats -- --reverse -- restore recorded priors
//
// What it does: any PodcastEditorialConfig whose stored format is registered
// but no longer selectable (speakerMin > MAX_HOSTS — i.e. three_person_panel
// and its `roundtable` alias) is moved to the default two-host format. The
// prior value is recorded, BEFORE any write, in a JobLog row
// (jobType "migrate:legacy-panel-formats"), which is what makes --reverse
// possible and lets the owner be told exactly what changed.
//
// The resolver ALSO degrades these formats at episode time (podcastConfiguration
// resolveEpisodeConfiguration), so nothing breaks between deploy and migration;
// this migration exists so shows stop carrying a value they can't re-select and
// stop emitting the degrade warning on every episode.

import { PrismaClient } from "@prisma/client";
import { getShowFormat, isRegisteredFormat, isGenerationReadyFormat, DEFAULT_FORMAT_ID, canonicalFormatId } from "../lib/formats/showFormatRegistry";

const JOB_TYPE = "migrate:legacy-panel-formats";

async function main() {
  const apply = process.argv.includes("--apply");
  const reverse = process.argv.includes("--reverse");
  const prisma = new PrismaClient();
  try {
    if (reverse) {
      // Restore the most recent completed forward run's recorded priors.
      const log = await prisma.jobLog.findFirst({
        where: { jobType: JOB_TYPE, status: "completed" },
        orderBy: { createdAt: "desc" },
      });
      const moved = ((log?.output as { moved?: { podcastId: string; priorFormat: string }[] })?.moved) ?? [];
      if (!log || moved.length === 0) {
        console.log("Nothing to reverse: no completed forward migration with recorded priors found.");
        return;
      }
      for (const m of moved) {
        await prisma.podcastEditorialConfig.updateMany({ where: { podcastId: m.podcastId }, data: { format: m.priorFormat } });
        console.log(`restored ${m.podcastId} -> ${m.priorFormat}`);
      }
      await prisma.jobLog.create({
        data: { jobType: JOB_TYPE, status: "completed", input: { reverseOf: log.id }, output: { restored: moved } },
      });
      console.log(`Reversed ${moved.length} podcast(s) from migration ${log.id}.`);
      return;
    }

    // Affected = registered but not selectable under the derived gate.
    // Derived from the registry — never a hardcoded format list.
    const rows = await prisma.podcastEditorialConfig.findMany({
      select: { podcastId: true, format: true, podcast: { select: { name: true, ownerId: true } } },
    });
    const affected = rows.filter((r) => {
      const canonical = canonicalFormatId(r.format);
      return isRegisteredFormat(canonical) && !isGenerationReadyFormat(canonical);
    });

    console.log(`Podcasts on a no-longer-selectable format: ${affected.length}`);
    for (const r of affected) {
      const f = getShowFormat(r.format)!;
      console.log(`  ${r.podcastId}  "${r.podcast?.name}"  format=${r.format} (needs ${f.speakerMin} voices)  owner=${r.podcast?.ownerId ?? "legacy"}`);
    }
    if (affected.length === 0) return;

    if (!apply) {
      console.log("\nDry run — nothing written. Re-run with --apply to migrate.");
      return;
    }

    // Record priors BEFORE any write, so a crash mid-apply is still reversible.
    const moved = affected.map((r) => ({ podcastId: r.podcastId, priorFormat: r.format, name: r.podcast?.name ?? null }));
    const log = await prisma.jobLog.create({
      data: { jobType: JOB_TYPE, status: "running", input: { defaultFormat: DEFAULT_FORMAT_ID }, output: { moved } },
    });
    for (const r of affected) {
      await prisma.podcastEditorialConfig.updateMany({ where: { podcastId: r.podcastId }, data: { format: DEFAULT_FORMAT_ID } });
      console.log(`moved ${r.podcastId} -> ${DEFAULT_FORMAT_ID}`);
    }
    await prisma.jobLog.update({ where: { id: log.id }, data: { status: "completed" } });
    console.log(`\nMigrated ${affected.length} podcast(s). Priors recorded in JobLog ${log.id}; reverse with --reverse.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
