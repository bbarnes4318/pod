// Is the evidence behind the routing assignments still recent?
//
//   npm run routing:staleness
//
// NETWORK-FREE. Exits NONZERO when any evidence source is older than 90 days.
//
// WHY IT EXISTS. Every model assignment in profiles.ts is justified by a
// measurement, and each is cited carefully — "Nemotron 5/5 in-scope, 0 false
// positives, 13 s" reads like a fact about Nemotron. It is a fact about one
// afternoon. Nothing in the pipeline ages that citation, so a routing map can
// drift from "measured" to "remembered" without a single test going red.
//
// This does not fail deploys. `test:production-readiness` reports it as a
// warning, because stale evidence is a reason to re-measure, not a reason to
// stop shipping — and a staleness check that blocks releases gets suppressed
// within a week, which is worse than not having one.

import fs from "fs";
import path from "path";
import {
  STALENESS_LIMIT_DAYS,
  describeEvidenceAge,
  evaluateRoutingStaleness,
  type EvidenceAge,
} from "../lib/providers/llm/routingEvidence";

const ARTIFACT_DIR = path.join(process.cwd(), "artifacts");

/** mtimes of everything in artifacts/, or {} when the directory does not exist. */
export function readArtifactMtimes(dir: string = ARTIFACT_DIR): Record<string, Date> {
  const out: Record<string, Date> = {};
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out; // gitignored and absent on a fresh checkout — not an error
  }
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) out[full] = st.mtime;
    } catch {
      /* unreadable entry — ignore rather than fail the whole check */
    }
  }
  return out;
}

export function currentRoutingStaleness(now: Date = new Date()): EvidenceAge[] {
  return evaluateRoutingStaleness(now, readArtifactMtimes());
}

function main() {
  const ages = currentRoutingStaleness();
  console.log(`\nRouting evidence freshness (limit ${STALENESS_LIMIT_DAYS} days)\n`);
  for (const age of ages) console.log(`  ${describeEvidenceAge(age)}`);

  const stale = ages.filter((a) => a.stale);
  if (stale.length === 0) {
    console.log(`\nAll ${ages.length} evidence sources are within ${STALENESS_LIMIT_DAYS} days.\n`);
    process.exit(0);
  }

  console.log(
    `\n${stale.length} of ${ages.length} evidence sources are older than ${STALENESS_LIMIT_DAYS} days.\n` +
      `\nThis does not mean the routing is wrong. It means nothing has checked it recently, and the\n` +
      `assignments below are currently justified by a measurement rather than by a recent one:\n`
  );
  for (const s of stale) {
    console.log(`  ${s.source.id} (${s.ageDays} days old)`);
    console.log(`      decides: ${s.source.covers}`);
    console.log(`      refresh: ${s.source.refreshWith}`);
    console.log(
      `      then update the declared date in source (${s.source.id.startsWith("llm-contract") ? "LLM_CONTRACT_PROBE_DATE in capabilities.ts" : "ROLE_EXPERIMENT_DATE in profiles.ts"}) in the same commit.\n`
    );
  }
  process.exit(1);
}

// Only run the CLI when invoked directly — testProductionReadiness imports
// currentRoutingStaleness from this module and must not trigger a process.exit.
const invokedDirectly = process.argv[1] && /routingStaleness\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) main();
