// Audit + repair ResearchBrief evidence integrity.
//   npm run repair:research-evidence            # DRY RUN — reports, changes nothing
//   npm run repair:research-evidence -- --apply # writes the safe repairs
//
// WHY THIS EXISTS
// Briefs written before the evidence gates were integrity checks can carry
// references that were never real: the topic citing ITSELF (the old
// `[{type:"topic", id:topicId}]` fallback), refs to rows since deleted,
// unsupported types, and transient `research-N` ids that resolve to nothing.
// The old gate measured array length, so every one of those looked "sourced".
//
// WHAT IT WILL NOT DO, deliberately:
//   • invent a source, evidence or fact to make a brief pass;
//   • regenerate research (that costs money and is a human's call);
//   • touch an episode or its immutable snapshot — a published episode's
//     evidence is frozen ON PURPOSE, and "fixing" it would rewrite history;
//   • mark an invalid brief valid. If nothing real survives, the brief simply
//     has no sources and its topic stays ineligible. That is the true state,
//     and the point of this task was to stop hiding it.

import { db } from "../lib/db";
import {
  parseEvidenceRefList, resolveEvidenceRefs, dedupeRefs, sortRefs, refKey,
  RESEARCH_IS_TRANSIENT, type EvidenceReference,
} from "../lib/services/evidenceRefs";

const APPLY = process.argv.includes("--apply");

interface Finding {
  topicId: string;
  title: string;
  selfCited: boolean;
  missing: string[];
  unsupported: string[];
  transient: string[];
  duplicates: number;
  validBefore: number;
  validAfter: number;
  /** Refs that would be persisted after repair. */
  repaired: EvidenceReference[];
  wouldBecomeIneligible: boolean;
}

/** Refs cited by accepted brief content — the only honest basis for sourceIds. */
function citedRefs(brief: { facts?: unknown; stats?: unknown; counterArguments?: unknown }): EvidenceReference[] {
  const out: EvidenceReference[] = [];
  for (const field of [brief.facts, brief.stats, brief.counterArguments]) {
    if (!Array.isArray(field)) continue;
    for (const item of field as Array<{ evidenceRefs?: unknown }>) {
      out.push(...parseEvidenceRefList(item?.evidenceRefs).refs);
    }
  }
  return dedupeRefs(out);
}

async function main() {
  console.log(`\nResearch evidence audit — ${APPLY ? "APPLY (writes)" : "DRY RUN (no changes)"}\n`);

  const briefs = await db.researchBrief.findMany({
    include: { topic: { select: { id: true, title: true, status: true, evidenceIds: true } } },
    orderBy: { createdAt: "asc" },
  });

  const findings: Finding[] = [];
  let valid = 0;

  for (const brief of briefs) {
    const topic = brief.topic;
    const parsed = parseEvidenceRefList(brief.sourceIds);

    const selfCited =
      parsed.errors.some((e) => e.code === "topic_self") || parsed.refs.some((r) => r.id === topic.id);
    const unsupported = parsed.errors.filter((e) => e.code === "unsupported_type" || e.code === "malformed" || e.code === "missing_id").map((e) => e.ref ?? e.message);
    const transient = parsed.refs.filter((r) => r.type === "research" && RESEARCH_IS_TRANSIENT).map(refKey);

    // Candidates: real types only, never the topic itself.
    const candidates = parsed.refs.filter((r) => r.id !== topic.id && !(r.type === "research" && RESEARCH_IS_TRANSIENT));
    const resolved = candidates.length ? await resolveEvidenceRefs(candidates, { db, topicId: topic.id }) : { valid: [], invalid: [] };
    const missing = resolved.invalid.map((i) => `${refKey(i.ref)} (${i.error.code})`);

    // Rebuild from what accepted content actually cites, intersected with what
    // still resolves. A ref no claim uses was never doing any work.
    const cited = citedRefs(brief as { facts?: unknown; stats?: unknown; counterArguments?: unknown })
      .filter((r) => r.id !== topic.id && !(r.type === "research" && RESEARCH_IS_TRANSIENT));
    const citedResolved = cited.length ? await resolveEvidenceRefs(cited, { db, topicId: topic.id }) : { valid: [], invalid: [] };

    const repaired = sortRefs(dedupeRefs([...citedResolved.valid, ...resolved.valid]));

    // Count duplicates from the RAW stored array. parseEvidenceRefList already
    // dedupes, so measuring its output against itself is always zero — which
    // would quietly mark a brief with repeated refs "clean" and skip repairing
    // it. The stored row is what we are auditing, not our parse of it.
    const rawList = Array.isArray(brief.sourceIds) ? (brief.sourceIds as unknown[]) : [];
    const duplicates = Math.max(0, rawList.length - parsed.refs.length - parsed.errors.length);

    const clean =
      !selfCited && unsupported.length === 0 && transient.length === 0 &&
      missing.length === 0 && duplicates === 0 && repaired.length > 0;

    if (clean) { valid++; continue; }

    findings.push({
      topicId: topic.id, title: topic.title, selfCited, missing, unsupported, transient, duplicates,
      validBefore: parsed.refs.length, validAfter: repaired.length, repaired,
      wouldBecomeIneligible: repaired.length === 0 && topic.status === "approved",
    });
  }

  // ---- Report ----
  const selfCount = findings.filter((f) => f.selfCited).length;
  const missingCount = findings.filter((f) => f.missing.length > 0).length;
  const unsupportedCount = findings.filter((f) => f.unsupported.length > 0).length;
  const transientCount = findings.filter((f) => f.transient.length > 0).length;
  const noValid = findings.filter((f) => f.validAfter === 0).length;
  const ineligible = findings.filter((f) => f.wouldBecomeIneligible);

  console.log(`  briefs inspected .................. ${briefs.length}`);
  console.log(`  already valid .................... ${valid}`);
  console.log(`  cite the topic itself ............ ${selfCount}`);
  console.log(`  reference missing records ........ ${missingCount}`);
  console.log(`  unsupported / malformed refs ..... ${unsupportedCount}`);
  console.log(`  transient research refs .......... ${transientCount}`);
  console.log(`  duplicate refs ................... ${findings.filter((f) => f.duplicates > 0).length}`);
  console.log(`  NO valid source after repair ..... ${noValid}`);
  console.log(`  approved topics that would become INELIGIBLE: ${ineligible.length}`);

  if (findings.length > 0) {
    console.log(`\n  Proposed repairs:`);
    for (const f of findings.slice(0, 40)) {
      const parts: string[] = [];
      if (f.selfCited) parts.push("drop topic-self");
      if (f.missing.length) parts.push(`drop ${f.missing.length} missing`);
      if (f.unsupported.length) parts.push(`drop ${f.unsupported.length} unsupported`);
      if (f.transient.length) parts.push(`drop ${f.transient.length} transient`);
      if (f.duplicates > 0) parts.push(`dedupe ${f.duplicates}`);
      console.log(`   - ${f.title.slice(0, 60)}`);
      console.log(`       ${f.validBefore} ref(s) -> ${f.validAfter} valid | ${parts.join(", ") || "rebuild"}${f.wouldBecomeIneligible ? "  ** becomes INELIGIBLE **" : ""}`);
    }
    if (findings.length > 40) console.log(`   … and ${findings.length - 40} more`);
  }

  if (ineligible.length > 0) {
    console.log(
      `\n  NOTE: ${ineligible.length} approved topic(s) have no verifiable source and will stop being\n` +
      `  episode-eligible. This is not a regression — they were never grounded; the old\n` +
      `  length-only gate just couldn't tell. Re-run research to ground them honestly.`
    );
  }

  if (!APPLY) {
    console.log(`\n  DRY RUN — nothing was written. Re-run with --apply to persist these repairs.\n`);
    await db.$disconnect();
    return;
  }

  // ---- Apply ----
  let repairedCount = 0;
  for (const f of findings) {
    // Only sourceIds is rewritten. Facts, stats and arguments are the editorial
    // record and are never edited here; an ungrounded claim is a reason to
    // re-run research, not to quietly delete the evidence of the problem.
    await db.researchBrief.update({
      where: { topicId: f.topicId },
      data: { sourceIds: f.repaired as unknown as object[] },
    });
    repairedCount++;
  }
  console.log(`\n  Applied: rebuilt sourceIds on ${repairedCount} brief(s). No source, evidence or fact was invented.`);
  console.log(`  Episodes and their frozen snapshots were not touched.\n`);
  await db.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await db.$disconnect();
  process.exit(1);
});
