/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped Json brief/topic payloads */
// Pool composition + the axis-by-axis talkability breakdown, betting vs human.
//
// Two jobs:
//   1. ROOT CAUSE. Is the scorer selecting FOR odds? Score real topics of both
//      kinds and compare each axis. A hypothesis about a scorer is worth
//      exactly as much as the numbers it produces on real rows.
//   2. STANDING CHECK. Report the betting share of the live pool, so a
//      regression is visible on every scheduled generation run instead of being
//      rediscovered by reading the board months later.
//
// Read-only. Safe to run against production.

import { db } from "@/lib/db";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { classifyTopicRow } from "@/lib/services/bettingFrame";

const AXES = ["specificity", "tension", "evidence", "hook", "freshness"] as const;
const MAXES: Record<string, number> = { specificity: 30, tension: 20, evidence: 20, hook: 15, freshness: 15 };

function mean(ns: number[]): number {
  return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0;
}
const f1 = (n: number) => n.toFixed(1).padStart(5);

async function main() {
  const limitArg = Number(process.argv[2] || 20);

  const topics = await db.topicCandidate.findMany({
    where: { status: { in: ["approved", "pending"] } },
    include: { researchBrief: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const rows = topics.map((t) => {
    const cls = classifyTopicRow(t as any);
    const report = scoreTopicTalkability({
      title: t.title,
      summary: t.summary,
      createdAt: t.createdAt,
      brief: (t.researchBrief as any) || null,
    });
    return { id: t.id, title: t.title, status: t.status, frame: cls.frame, signals: cls.signals, report };
  });

  const briefed = rows.filter((r) => r.report.total > 20); // unbriefed rows floor out and would swamp the means
  const betting = briefed.filter((r) => r.frame === "betting");
  const human = briefed.filter((r) => r.frame === "human");

  console.log("=".repeat(78));
  console.log("POOL COMPOSITION");
  console.log("=".repeat(78));
  const allBetting = rows.filter((r) => r.frame === "betting").length;
  console.log(`total candidate topics (approved+pending): ${rows.length}`);
  console.log(`betting-framed:                            ${allBetting} (${((allBetting / (rows.length || 1)) * 100).toFixed(1)}%)`);
  console.log(`human-stakes:                              ${rows.length - allBetting} (${(((rows.length - allBetting) / (rows.length || 1)) * 100).toFixed(1)}%)`);
  console.log(`with a usable brief (talkability > 20):    ${briefed.length}  [betting ${betting.length} / human ${human.length}]`);

  // Rank position is what actually decides what a customer is offered.
  const ranked = [...briefed].sort((a, b) => b.report.total - a.report.total);
  for (const n of [10, 20]) {
    const top = ranked.slice(0, n);
    const b = top.filter((r) => r.frame === "betting").length;
    console.log(`betting share of TOP ${String(n).padEnd(2)} by talkability:      ${b}/${top.length} (${((b / (top.length || 1)) * 100).toFixed(0)}%)`);
  }

  const sampleB = betting.slice(0, limitArg);
  const sampleH = human.slice(0, limitArg);

  console.log("\n" + "=".repeat(78));
  console.log(`AXIS-BY-AXIS — ${sampleB.length} betting-framed vs ${sampleH.length} human-stakes`);
  console.log("=".repeat(78));
  console.log("axis          max   betting   human    gap   betting%  human%");
  console.log("-".repeat(78));
  const totB: number[] = sampleB.map((r) => r.report.total);
  const totH: number[] = sampleH.map((r) => r.report.total);
  for (const axis of AXES) {
    const b = mean(sampleB.map((r) => (r.report.axes as any)[axis].score));
    const h = mean(sampleH.map((r) => (r.report.axes as any)[axis].score));
    const max = MAXES[axis];
    console.log(
      `${axis.padEnd(13)} ${String(max).padStart(3)}  ${f1(b)}   ${f1(h)}  ${f1(b - h)}   ` +
        `${((b / max) * 100).toFixed(0).padStart(5)}%  ${((h / max) * 100).toFixed(0).padStart(5)}%`
    );
  }
  console.log("-".repeat(78));
  console.log(`${"TOTAL".padEnd(13)} 100  ${f1(mean(totB))}   ${f1(mean(totH))}  ${f1(mean(totB) - mean(totH))}`);

  // The specificity mechanism, made concrete: what is actually in the facts.
  console.log("\nSPECIFICITY DETAIL (the axis under suspicion)");
  console.log("-".repeat(78));
  for (const [label, sample] of [["betting", sampleB], ["human", sampleH]] as const) {
    const nums = sample.map((r) => Number((r.report.axes.specificity.detail.match(/^(\d+) numbers/) || [])[1] || 0));
    const names = sample.map((r) => Number((r.report.axes.specificity.detail.match(/(\d+) names/) || [])[1] || 0));
    console.log(`${label.padEnd(8)} avg numbers/facts: ${mean(nums).toFixed(1).padStart(6)}   avg names: ${mean(names).toFixed(1).padStart(6)}`);
  }

  // The explicit bonus: evidence adds points merely for HAVING an oddsContext.
  const withOdds = briefed.filter((r) => {
    const t = topics.find((x) => x.id === r.id);
    return !!(t?.researchBrief as any)?.oddsContext;
  });
  console.log(`\nbriefs carrying an oddsContext field: ${withOdds.length}/${briefed.length}` +
    `  (each is worth +2 evidence regardless of the topic's frame)`);

  console.log("\nTOP 12 BY TALKABILITY (what the customer is offered first)");
  console.log("-".repeat(78));
  ranked.slice(0, 12).forEach((r, i) => {
    console.log(`${String(i + 1).padStart(2)}. [${r.report.total.toString().padStart(3)}] ${r.frame === "betting" ? "BET " : "human"} ${r.title.slice(0, 62)}`);
  });

  await db.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
