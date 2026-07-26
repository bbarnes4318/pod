/* eslint-disable @typescript-eslint/no-explicit-any -- reads untyped Json brief/topic payloads */
// Classify every existing topic, then retire the betting-framed ones down to
// quota. Two steps, both idempotent.
//
//   BACKFILL — every row gets a real `frame`, so the quota query and the
//              standing pool check both operate on truth rather than on the
//              'human' column default.
//   PURGE    — the live pool inherited months of betting-framed topics that
//              predate the quota. Keeping them would mean the fix "works" while
//              the board a customer actually sees stays the same. At most the
//              single best one survives (highest debateScore); the rest are
//              retired editorially — status 'rejected', never deleted, so the
//              history of what was generated stays auditable.
//
// Usage:  tsx src/scripts/backfillTopicFrame.ts [--apply]
// Without --apply it is a dry run and writes nothing.

import { db } from "@/lib/db";
import { classifyTopicRow } from "@/lib/services/bettingFrame";
import { BETTING_QUOTA } from "@/lib/services/bettingQuota";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "MODE: APPLY (writing)" : "MODE: DRY RUN (no writes) — pass --apply to commit\n");

  const topics = await db.topicCandidate.findMany({
    include: { researchBrief: true },
    orderBy: { createdAt: "desc" },
  });
  console.log(`classifying ${topics.length} topic(s)…`);

  let changed = 0;
  const betting: { id: string; title: string; debateScore: number; status: string }[] = [];

  for (const t of topics) {
    const cls = classifyTopicRow(t as any);
    if (cls.frame !== t.frame || cls.score !== t.frameScore) {
      changed++;
      if (apply) {
        await db.topicCandidate.update({
          where: { id: t.id },
          data: { frame: cls.frame, frameScore: cls.score, frameSignals: cls.signals as any },
        });
      }
    }
    if (cls.frame === "betting") {
      betting.push({ id: t.id, title: t.title, debateScore: t.debateScore, status: t.status });
    }
  }
  console.log(`  reclassified: ${changed}`);
  console.log(`  betting-framed: ${betting.length} of ${topics.length} (${((betting.length / (topics.length || 1)) * 100).toFixed(1)}%)`);

  // Purge: only rows still SELECTABLE matter to a customer.
  const live = betting.filter((b) => b.status === "approved" || b.status === "pending");
  live.sort((a, b) => b.debateScore - a.debateScore);
  const keep = live.slice(0, BETTING_QUOTA);
  const retire = live.slice(BETTING_QUOTA);

  console.log(`\nlive betting-framed topics: ${live.length}`);
  if (keep.length) console.log(`  KEEPING (best ${BETTING_QUOTA}): [${keep[0].debateScore.toFixed(0)}] ${keep[0].title}`);
  console.log(`  RETIRING: ${retire.length}`);
  for (const r of retire.slice(0, 25)) console.log(`    - [${r.debateScore.toFixed(0)}] ${r.title.slice(0, 68)}`);
  if (retire.length > 25) console.log(`    … and ${retire.length - 25} more`);

  if (apply && retire.length) {
    // Editorial retirement, not deletion: the row stays for auditing what the
    // generator produced, but leaves every selectable surface.
    const res = await db.topicCandidate.updateMany({
      where: { id: { in: retire.map((r) => r.id) } },
      data: { status: "rejected" },
    });
    console.log(`\n  retired ${res.count} topic(s) → status 'rejected'`);
  }

  const [total, stillBetting] = await Promise.all([
    db.topicCandidate.count({ where: { status: { in: ["approved", "pending"] } } }),
    db.topicCandidate.count({ where: { status: { in: ["approved", "pending"] }, frame: "betting" } }),
  ]);
  console.log(`\nRESULT — live pool: ${total} topic(s), betting-framed ${stillBetting} (${total ? ((stillBetting / total) * 100).toFixed(1) : "0.0"}%)`);
  if (!apply) console.log("(dry run — nothing was written)");

  await db.$disconnect();
}

void main().catch(async (e) => {
  console.error(e);
  await db.$disconnect();
  process.exit(1);
});
