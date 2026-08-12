// How old is the evidence the routing assignments rest on?
//
// Every model assignment in profiles.ts is justified by a measurement: a live
// contract probe, or a role experiment. Those measurements are cited carefully
// and dated exactly once, in a comment, and then they age silently. Nothing in
// the system distinguishes "Nemotron is primary because it measured fastest" from
// "Nemotron is primary because it measured fastest eleven months ago against a
// model that has since been retrained".
//
// This module makes the age readable. It is pure and filesystem-free at its core
// so it can be unit-tested; the CLI (`npm run routing:staleness`) supplies the
// clock and the directory listing.
//
// ON MISSING ARTIFACTS. `/artifacts/*` is gitignored, so a fresh checkout and
// every CI runner has none. A missing artifact therefore CANNOT mean "stale" —
// it is the normal state — which is exactly why each source also carries a
// declared date that lives in tracked source. The artifact, when present, is the
// more precise signal; the declared date is the one that always exists.

import { LLM_CONTRACT_PROBE_DATE } from "./capabilities";
import { ROLE_EXPERIMENT_DATE } from "./profiles";

export interface EvidenceSource {
  id: string;
  /** What routing decisions this evidence is load-bearing for. */
  covers: string;
  /** ISO date declared in tracked source, next to the finding it dates. */
  declaredOn: string;
  /** Artifact basename, or a suffix match for a family of them. */
  artifact: string;
  /** The command that produces fresh evidence. */
  refreshWith: string;
}

export const ROUTING_EVIDENCE: EvidenceSource[] = [
  {
    id: "llm-contract-probe",
    covers:
      "which models are reachable at all, and which request fields each accepts — the basis for every " +
      "`liveContractVerified` flag and for the verified_development chain membership",
    declaredOn: LLM_CONTRACT_PROBE_DATE,
    artifact: "-contract-report.json",
    refreshWith: "npm run probe:llm-contract",
  },
  {
    id: "role-experiment-dialogue",
    covers: "script_movement, script_rewrite, script_dialogue_director and both host writers",
    declaredOn: ROLE_EXPERIMENT_DATE,
    artifact: "role-experiment-dialogue.json",
    refreshWith: "npm run test:role-experiments dialogue",
  },
  {
    id: "role-experiment-outline",
    covers: "script_outline, script_story_editor and script_debate_architect",
    declaredOn: ROLE_EXPERIMENT_DATE,
    artifact: "role-experiment-outline.json",
    refreshWith: "npm run test:role-experiments outline",
  },
  {
    id: "role-experiment-verification",
    covers: "script_verification and fact_check",
    declaredOn: ROLE_EXPERIMENT_DATE,
    artifact: "role-experiment-verification.json",
    refreshWith: "npm run test:role-experiments verification",
  },
];

/** Evidence older than this is reported as stale. */
export const STALENESS_LIMIT_DAYS = 90;

export interface EvidenceAge {
  source: EvidenceSource;
  /** Age in whole days of the freshest signal available for this source. */
  ageDays: number;
  /** Which signal the age came from. */
  basis: "artifact" | "declared";
  /** Present when an artifact was found on disk. */
  artifactPath?: string;
  stale: boolean;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(then: Date, now: Date): number {
  return Math.floor((now.getTime() - then.getTime()) / MS_PER_DAY);
}

/**
 * Age every evidence source.
 *
 * `artifactMtimes` maps a found artifact path to its modification time. The
 * caller does the directory listing so this stays testable with a fixed clock
 * and a fixed set of files.
 *
 * When an artifact exists, its mtime wins ONLY IF it is newer than the declared
 * date — an artifact that predates the declared date means someone re-ran the
 * measurement, updated the comment, and left an old file behind, and the
 * comment is the deliberate record.
 */
export function evaluateRoutingStaleness(
  now: Date,
  artifactMtimes: Record<string, Date> = {},
  limitDays: number = STALENESS_LIMIT_DAYS
): EvidenceAge[] {
  return ROUTING_EVIDENCE.map((source) => {
    const declaredAt = new Date(`${source.declaredOn}T00:00:00Z`);
    const declaredAge = daysBetween(declaredAt, now);

    const match = Object.entries(artifactMtimes).find(([p]) => p.endsWith(source.artifact));
    if (match && match[1] > declaredAt) {
      const ageDays = daysBetween(match[1], now);
      return { source, ageDays, basis: "artifact" as const, artifactPath: match[0], stale: ageDays > limitDays };
    }
    return {
      source,
      ageDays: declaredAge,
      basis: "declared" as const,
      artifactPath: match?.[0],
      stale: declaredAge > limitDays,
    };
  });
}

/** One plain-English line per source. */
export function describeEvidenceAge(age: EvidenceAge, limitDays: number = STALENESS_LIMIT_DAYS): string {
  const from =
    age.basis === "artifact"
      ? `last written ${age.ageDays} days ago`
      : `declared ${age.source.declaredOn}, ${age.ageDays} days ago${age.artifactPath ? "" : " (no artifact on disk)"}`;
  const verdict = age.stale ? `STALE (over ${limitDays} days)` : "ok";
  return `${age.source.id.padEnd(30)} ${verdict.padEnd(24)} ${from}`;
}
