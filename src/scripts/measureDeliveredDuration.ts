// Are episodes actually as long as they were written to be?
//
//   npm run measure:delivered-duration          # last 20 episodes
//   npm run measure:delivered-duration -- 50    # last 50
//
// REQUIRES DATABASE ACCESS. Run it where the database is reachable — the worker
// container. It is READ-ONLY: it issues findMany and nothing else.
//
// WHY IT EXISTS. The script pipeline sizes an episode with a bare literal:
//
//   scriptSevenRolePipeline.ts:265
//   const totalWordTarget = Math.max(550, Math.round(args.targetDuration * 145));
//
// 145 words per minute has no comment, no citation and no test. The same repo
// holds two other values for the same quantity, one of which is documented:
//
//   episodeEstimate.ts:11   WORDS_PER_MINUTE = 183   (derived: 2,200 words / 12 min)
//   voiceAuditionScenes.ts  AUDITION_WORDS_PER_MINUTE = 155
//
// 145 and 183 sit at opposite ends of the same product — 145 decides how much
// script to WRITE, 183 is what the Studio TELLS THE USER the episode will run —
// and they disagree by 26%. If 183 is closer to the truth, a 12-minute episode
// is being written to ~9.5 minutes of speech and the turn floor derived from
// 145 is wrong in the opposite direction from "too many turns".
//
// HOW THIS ANSWERS IT, AND WHAT IT CANNOT ANSWER.
//
// `Episode.durationSeconds` is measured by ffprobe on the rendered file, so it
// is real audio, not an estimate. Two readings come out of it:
//
//   (a) THE DIRECT ANSWER — rendered duration against the target the script was
//       written to. If a 12-minute-target episode renders 9.5 minutes, it is
//       short, and no words-per-minute argument is needed to say so.
//
//   (b) THE IMPLIED RATE — shipped words / rendered minutes, comparable to 145
//       and 183.
//
// (b) carries a bias, and it runs in a knowable direction. Rendered duration
// includes music beds, stingers, bookends and pauses, so it OVERSTATES the time
// spent speaking, which UNDERSTATES the implied rate. The implied rate is
// therefore a LOWER BOUND on true speech rate. That makes one inference safe and
// one unsafe:
//
//   SAFE:   implied rate already above 145  =>  145 is too low, episodes are
//           being written short. The bias can only have pushed this number down.
//   UNSAFE: implied rate below 183  =>  proves nothing on its own, because
//           non-speech audio could account for the whole gap.
//
// So a result above 145 is decisive and a result below 183 is not. The script
// says which one it got rather than leaving that to the reader.

import { db } from "../lib/db";
import { wordsIn } from "../lib/services/scriptWordFlow";

const DECLARED = { pipeline: 145, studioEstimate: 183, audition: 155 };

interface Row {
  episodeId: string;
  title: string;
  targetMinutes: number | null;
  renderedMinutes: number;
  shippedWords: number;
  impliedWpm: number;
  unsupportedClaims: number | null;
  factualLines: number | null;
}

/**
 * Spoken words in a persisted script.
 *
 * Counting is delegated to `wordsIn` — the same definition the pipeline's own
 * word-flow instrumentation uses — so a duration measured here and a word count
 * logged during generation cannot drift apart. Bracketed production tags are
 * not voiced and are not counted; including them would inflate the implied rate
 * and bias the verdict toward "the pipeline is fine".
 */
export function countSpokenWords(content: unknown): number {
  const segments = (content as { segments?: unknown })?.segments;
  if (!Array.isArray(segments)) return 0;
  let total = 0;
  for (const seg of segments) {
    const lines = (seg as { lines?: unknown })?.lines;
    if (Array.isArray(lines)) total += wordsIn(lines as Array<{ text?: unknown }>);
  }
  return total;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function main() {
  const limit = Number(process.argv[2]) || 20;
  console.log(`\nDelivered duration vs written length — last ${limit} rendered episode(s)\n`);

  // Only episodes that actually rendered. A null durationSeconds means no audio
  // exists, and including those would silently average in zeros.
  const episodes = await db.episode.findMany({
    where: { durationSeconds: { not: null, gt: 0 } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, title: true, durationSeconds: true },
  });

  if (!episodes.length) {
    console.log("No episodes with a measured duration. Nothing to report — and no conclusion either way.\n");
    await db.$disconnect();
    return;
  }

  const rows: Row[] = [];
  for (const ep of episodes) {
    const script = await db.script.findFirst({
      where: { episodeId: ep.id },
      orderBy: { version: "desc" },
      select: { id: true, content: true },
    });
    if (!script) continue;

    const shippedWords = countSpokenWords(script.content);
    if (shippedWords === 0) continue; // no readable script; counting it as 0 wpm would be a lie

    const targetRaw = (script.content as { estimatedDurationMinutes?: unknown })?.estimatedDurationMinutes;
    const targetMinutes = typeof targetRaw === "number" && targetRaw > 0 ? targetRaw : null;
    const renderedMinutes = (ep.durationSeconds as number) / 60;

    const fc = await db.factCheckResult.findFirst({
      where: { scriptId: script.id },
      orderBy: { checkedAt: "desc" },
      select: { evidenceCoverage: true },
    });
    const cov = (fc?.evidenceCoverage as Record<string, unknown> | null) || null;

    rows.push({
      episodeId: ep.id,
      title: (ep.title || "").slice(0, 34),
      targetMinutes,
      renderedMinutes,
      shippedWords,
      impliedWpm: shippedWords / renderedMinutes,
      unsupportedClaims: typeof cov?.unsupportedClaimCount === "number" ? cov.unsupportedClaimCount : null,
      factualLines: typeof cov?.factualLineCount === "number" ? cov.factualLineCount : null,
    });
  }

  if (!rows.length) {
    console.log("Episodes rendered, but none had a readable script. No conclusion.\n");
    await db.$disconnect();
    return;
  }

  console.log(
    "  episode                              target   rendered   words   impl.wpm   unsupported/factual"
  );
  for (const r of rows) {
    const target = r.targetMinutes ? `${r.targetMinutes.toFixed(0)}m` : "  ?";
    const claims =
      r.factualLines === null ? "     n/a" : `${r.unsupportedClaims}/${r.factualLines}`;
    console.log(
      `  ${r.title.padEnd(36)} ${target.padStart(5)}   ${r.renderedMinutes.toFixed(1).padStart(6)}m  ` +
        `${String(r.shippedWords).padStart(6)}   ${r.impliedWpm.toFixed(0).padStart(6)}   ${claims.padStart(12)}`
    );
  }

  // ---------------------------------------------------------------- verdict
  const withTarget = rows.filter((r) => r.targetMinutes !== null);
  const medWpm = median(rows.map((r) => r.impliedWpm));

  console.log(`\n  Episodes measured: ${rows.length} (${withTarget.length} with a recorded target)`);
  console.log(
    `  Median implied rate: ${medWpm.toFixed(0)} wpm  ` +
      `(pipeline writes to ${DECLARED.pipeline}, Studio quotes ${DECLARED.studioEstimate})`
  );

  if (withTarget.length) {
    const ratios = withTarget.map((r) => r.renderedMinutes / (r.targetMinutes as number));
    const medRatio = median(ratios);
    const short = withTarget.filter((r) => r.renderedMinutes < (r.targetMinutes as number) * 0.9).length;
    console.log(
      `  Median rendered/target: ${(medRatio * 100).toFixed(0)}%  ` +
        `— ${short}/${withTarget.length} episode(s) came in more than 10% short.`
    );
  } else {
    console.log("  No episode recorded its target duration, so the direct length check cannot run.");
  }

  console.log("\n  VERDICT");
  if (medWpm > DECLARED.pipeline) {
    console.log(
      `  DECISIVE. The implied rate (${medWpm.toFixed(0)}) is above the ${DECLARED.pipeline} the pipeline\n` +
        `  writes to, and rendered duration includes music and pauses, which can only have pushed this\n` +
        `  number DOWN. True speech rate is higher still, so ${DECLARED.pipeline} is too low and episodes\n` +
        `  are being written short. The turn floor derived from it is wrong in the direction of TOO FEW\n` +
        `  words, not too many.`
    );
  } else {
    console.log(
      `  NOT DECISIVE. The implied rate (${medWpm.toFixed(0)}) is at or below ${DECLARED.pipeline}, but\n` +
        `  rendered duration includes non-speech audio, so this is a lower bound and cannot by itself\n` +
        `  clear the ${DECLARED.pipeline} figure. Settling it needs speech-only duration — sum\n` +
        `  AudioSegment.durationMs (or DialogueSceneAudio) for these episodes and divide by that instead.`
    );
  }

  const claimRows = rows.filter((r) => r.factualLines !== null);
  if (claimRows.length) {
    const totalFactual = claimRows.reduce((n, r) => n + (r.factualLines || 0), 0);
    const totalUnsupported = claimRows.reduce((n, r) => n + (r.unsupportedClaims || 0), 0);
    console.log(
      `\n  Evidence coverage across ${claimRows.length} episode(s): ` +
        `${totalUnsupported}/${totalFactual} factual lines unsupported` +
        (totalFactual > 0 ? ` (${((totalUnsupported / totalFactual) * 100).toFixed(0)}%).` : ".")
    );
    console.log(
      `  Episodes generated BEFORE the evidence-ref fix will read ~100% unsupported; only runs after\n` +
        `  the deploy test the fix. Compare the newest rows against the older ones rather than the total.`
    );
  }

  console.log("");
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(`\nFAILED: ${(err as Error).message}\n`);
  await db.$disconnect().catch(() => {});
  process.exit(1);
});
