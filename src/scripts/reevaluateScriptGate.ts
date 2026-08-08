// Give a legacy script a REAL editorial verdict.
//
// The rollout policy (src/lib/queue/rolloutPolicy.ts) lets a script written
// before the gate had authority finish its run without a verdict, attributably.
// That allowance is a bridge, not a destination — this command is the way off
// it. It re-scores an existing script with the current invariants and, when a
// judge is available, the current independent judge, then writes a real verdict
// onto the script so the grandfather clause no longer applies to it.
//
//   npm run gate:reevaluate -- --script <scriptId>
//   npm run gate:reevaluate -- --episode <episodeId>
//   npm run gate:reevaluate -- --all-legacy [--limit 50]
//   ...add --dry-run to score without writing.
//
// It never RELAXES a verdict: if the re-evaluation says hold, the script is
// held. The point is to replace "never measured" with "measured".

import "dotenv/config";
import { evaluateProductionInvariants } from "../lib/services/productionInvariants";
import { evaluateScriptEditorialGate, type ScriptPipelineProvenance } from "../lib/services/scriptEditorialGate";
import { assessScriptQuality } from "../lib/services/scriptQualityJudge";
import { scoreScriptQuality } from "../lib/services/episodeQualityService";
import { getRoleLLMProvider, roleHasRealProvider } from "../lib/providers/llm/routing";
import { retiredHostNameFragments } from "../lib/hosts/roster";
import { resolveGateEnforcementCutover } from "../lib/queue/rolloutPolicy";

interface Args { scriptId?: string; episodeId?: string; allLegacy?: boolean; limit: number; dryRun: boolean }

function parseArgs(argv: string[]): Args {
  const out: Args = { limit: 50, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--script") out.scriptId = argv[++i];
    else if (argv[i] === "--episode") out.episodeId = argv[++i];
    else if (argv[i] === "--all-legacy") out.allLegacy = true;
    else if (argv[i] === "--limit") out.limit = Number(argv[++i]) || 50;
    else if (argv[i] === "--dry-run") out.dryRun = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scriptId && !args.episodeId && !args.allLegacy) {
    console.error("Specify --script <id>, --episode <id>, or --all-legacy. Add --dry-run to score without writing.");
    process.exit(2);
  }

  const { db } = await import("../lib/db");
  const where = args.scriptId
    ? { id: args.scriptId }
    : args.episodeId
      ? { episodeId: args.episodeId }
      : {};
  const scripts = await db.script.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: args.allLegacy ? args.limit : undefined,
    select: { id: true, episodeId: true, createdAt: true, content: true, status: true },
  });

  const cutover = resolveGateEnforcementCutover();
  const targets = args.allLegacy
    ? scripts.filter((s) => {
        const blob = s.content as { editorialGate?: { decision?: string } } | null;
        return !blob?.editorialGate?.decision;
      })
    : scripts;

  if (!targets.length) {
    console.log("No matching scripts. Nothing to re-evaluate.");
    return;
  }
  console.log(`Re-evaluating ${targets.length} script(s).${args.dryRun ? " (dry run)" : ""}`);
  if (cutover) console.log(`Current enforcement cutover: ${cutover.toISOString()}`);

  const judge = roleHasRealProvider("quality_judge") ? getRoleLLMProvider("quality_judge") : null;
  if (!judge) {
    console.warn(
      "WARNING: no quality_judge provider is configured. In production a missing judge is a HOLD, " +
        "so every script re-evaluated now will be held. Configure the judge first unless that is what you want."
    );
  }

  let held = 0;
  let passed = 0;
  for (const script of targets) {
    const blob = (script.content || {}) as Record<string, unknown>;
    const segments = Array.isArray(blob.segments) ? (blob.segments as unknown[]) : [];
    if (!segments.length) {
      console.log(`  ${script.id}: SKIP (no segments)`);
      continue;
    }
    const hostNames = [
      ...new Set(
        segments.flatMap((s) =>
          ((s as { lines?: Array<{ speakerName?: string }> }).lines || []).map((l) => String(l.speakerName || "").trim())
        ).filter(Boolean)
      ),
    ];

    const invariants = evaluateProductionInvariants(segments as never, {
      activeHostNames: hostNames,
      retiredHostNames: retiredHostNameFragments(),
    });
    const quality = await assessScriptQuality(judge, segments as never, {
      episodeTitle: String(blob.episodeTitle || "Re-evaluated script"),
      hostNames,
    });
    quality.deterministic = scoreScriptQuality(blob as never);

    // Provenance is recorded as OBSERVED-UNKNOWN, not invented. A legacy script
    // genuinely has no record of how it was written, and claiming otherwise here
    // would repeat the exact defect this branch exists to remove.
    const provenance: ScriptPipelineProvenance = {
      path: "legacy_reevaluated",
      fallbackReason: "Script predates pipeline provenance; how it was written is not recorded.",
      stages: [],
      judgeRan: Boolean(quality.judge),
    };
    const gate = evaluateScriptEditorialGate(quality, process.env, { invariants, provenance });

    console.log(
      `  ${script.id} (${script.createdAt.toISOString()}): ${gate.decision}` +
        `${gate.failedCriticalAxes.length ? ` [${gate.failedCriticalAxes.join(", ")}]` : ""}`
    );
    if (gate.decision === "pass") passed += 1;
    else held += 1;

    if (!args.dryRun) {
      await db.script.update({
        where: { id: script.id },
        data: {
          content: {
            ...blob,
            productionInvariants: invariants,
            quality: quality.deterministic,
            qualityReview: quality,
            editorialGate: gate,
            pipelineProvenance: provenance,
          } as never,
          status: gate.decision === "pass" ? "draft" : "needs_revision",
        },
      });
    }
  }

  console.log(`\nDone. pass=${passed} needs-human=${held}${args.dryRun ? " (nothing written)" : ""}`);
  console.log(
    "A script that came back review/hold is NOT stuck: a human can inspect it in Studio and record an " +
      "attributable release, or edit and regenerate it."
  );
}

main().catch((err) => {
  console.error("Re-evaluation failed:", err?.message || err);
  process.exit(1);
});
