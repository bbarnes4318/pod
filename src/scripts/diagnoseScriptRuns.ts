// WHERE DID THE HOUR GO? Answered from your own database, not from a container.
//
//   npm run diagnose:script-runs                  # the last 10 script runs
//   npm run diagnose:script-runs -- --limit 30
//   npm run diagnose:script-runs -- --episode <episodeId>
//
// Needs DATABASE_URL pointed at the database the worker writes to — the same
// value the web and worker services already run with. READ-ONLY: one SELECT,
// no writes, ever.
//
// This file is deliberately thin. The arithmetic that can be WRONG in a way
// that misdirects an operator — waiting versus calling, and the verdict drawn
// from it — lives in lib/services/scriptRunDiagnosis.ts, where a network-free
// test pins it (npm run test:script-run-diagnosis). Here we only ask the
// database for rows and print what that module concludes.

import { db } from "../lib/db";
import { analyzeScriptRun, formatScriptRunReport } from "../lib/services/scriptRunDiagnosis";

function parseArgs(argv: string[]) {
  let limit = 10;
  let episodeId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") {
      const parsed = Number.parseInt(argv[i + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) limit = Math.min(parsed, 200);
      i++;
    } else if (argv[i] === "--episode") {
      episodeId = argv[i + 1];
      i++;
    }
  }
  return { limit, episodeId };
}

async function main() {
  const { limit, episodeId } = parseArgs(process.argv.slice(2));

  const rows = await db.jobLog.findMany({
    where: {
      jobType: "generate:script",
      ...(episodeId ? { input: { path: ["episodeId"], equals: episodeId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      status: true,
      error: true,
      input: true,
      output: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (rows.length === 0) {
    console.log(`\nNo generate:script job logs found${episodeId ? ` for episode ${episodeId}` : ""}.\n`);
    return;
  }

  console.log(`\nScript runs — where the time went   (${rows.length} most recent)\n`);

  let anyWaiting = false;
  for (const row of rows) {
    const analysis = analyzeScriptRun(row);
    if (analysis.verdict === "mostly_waiting") anyWaiting = true;
    for (const line of formatScriptRunReport(analysis, row.createdAt)) console.log(line);
    console.log("");
  }

  console.log("Read-only: this command ran one SELECT and wrote nothing.");
  if (anyWaiting) {
    console.log(
      "At least one run above was mostly WAITING. That is provider headroom, not prompt tuning:\n" +
        "check which account the slowest stage names, and whether anything else is spending its quota."
    );
  }
  console.log("");
}

main()
  .catch((err) => {
    console.error(`\nDiagnosis failed: ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      "If that is a connection error, DATABASE_URL is not pointed at the database that ran the job.\n"
    );
    process.exit(1);
  })
  .finally(() => {
    void db.$disconnect();
  });
