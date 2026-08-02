// The choke point between an evaluated script and money being spent on it.
//
// Before episode e7867729 the editorial gate was consulted in exactly ONE file
// (factCheckService), behind `script.status !== "approved"` — and the normal
// Studio path sets status to "approved" immediately before fact-checking, so
// the check could never fire. Meanwhile seven separate call sites could reach
// `queueTtsSegmentGenerationJob` directly, none of which consulted the gate at
// all.
//
// Enforcing here means every caller — Studio, admin, retry, and the worker's
// own production chain — passes through the same verdict. A new enqueue site
// cannot forget to check, because the check is not at the call site.

import { evaluateDownstreamBlock, type DownstreamBlockVerdict } from "../services/scriptEditorialGate";
import { evaluateRolloutDisposition, type RolloutDecision } from "./rolloutPolicy";

export class ProductionHoldError extends Error {
  readonly code = "PRODUCTION_HOLD";
  readonly verdict: DownstreamBlockVerdict;
  readonly scriptId: string;
  readonly stage: string;

  constructor(scriptId: string, stage: string, verdict: DownstreamBlockVerdict) {
    const axes = verdict.failedCriticalAxes.length
      ? ` Failed critical axes: ${verdict.failedCriticalAxes.join(", ")}.`
      : "";
    super(
      `Script ${scriptId} is on editorial ${verdict.decision} and cannot enter ${stage} automatically.${axes} ` +
        `Reasons: ${verdict.reasons.length ? verdict.reasons.join(" | ") : "no reasons recorded"}. ` +
        `A human must review it in Studio and record an explicit release.`
    );
    this.name = "ProductionHoldError";
    this.scriptId = scriptId;
    this.stage = stage;
    this.verdict = verdict;
  }
}

/**
 * Throws unless the script's recorded editorial verdict permits automatic
 * downstream production. `pass` continues; `review` and `hold` require a
 * recorded human release stored on the script content.
 */
export interface LoadedScript {
  content: unknown;
  /** Needed by the rollout policy; a script cannot be shown to predate the
   *  enforcement cutover without it. */
  createdAt: Date | string | null;
}

export type ScriptContentLoader = (scriptId: string) => Promise<LoadedScript | null>;

// Imported lazily so the gate's decision logic can be executed in tests and in
// CI without a generated Prisma client standing between the assertion and the
// behaviour being asserted.
const dbLoader: ScriptContentLoader = async (scriptId) => {
  const { db } = await import("../db");
  const script = await db.script.findUnique({
    where: { id: scriptId },
    select: { id: true, content: true, createdAt: true },
  });
  return script ? { content: script.content, createdAt: script.createdAt } : null;
};

let activeLoader: ScriptContentLoader = dbLoader;

/**
 * Test seam. Lets the queue-chain regression prove — by execution, not by
 * reading source — that a held script never reaches `productionQueue.add`.
 */
export function __setScriptContentLoaderForTests(loader: ScriptContentLoader | null): void {
  activeLoader = loader ?? dbLoader;
}

/** Emitted whenever the rollout policy lets an unmeasured legacy script pass. */
export interface GrandfatherNotice {
  scriptId: string;
  stage: string;
  decision: RolloutDecision;
}

let onGrandfather: ((notice: GrandfatherNotice) => void) | null = null;

/** Lets the worker record grandfathered passes onto the JobLog. */
export function setGrandfatherObserver(fn: ((notice: GrandfatherNotice) => void) | null): void {
  onGrandfather = fn;
}

export async function assertScriptReleasableForProduction(
  scriptId: string,
  stage: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<DownstreamBlockVerdict> {
  const loaded = await activeLoader(scriptId);
  if (!loaded || loaded.content === null || loaded.content === undefined) {
    throw new Error(`Script ${scriptId} not found; refusing to queue ${stage}.`);
  }
  const verdict = evaluateDownstreamBlock(loaded.content, env);
  if (!verdict.blocked) return verdict;

  // ROLLOUT POLICY. Only an UNMEASURED script can be grandfathered, and only
  // when it demonstrably predates the configured enforcement cutover. A script
  // that was measured and came back `review`/`hold` is never grandfathered —
  // its remedy is an attributable human release, which is a documented path,
  // not a dead end.
  if (verdict.decision === "unknown") {
    const rollout = evaluateRolloutDisposition({
      hasVerdict: false,
      scriptCreatedAt: loaded.createdAt,
      env,
    });
    if (rollout.grandfathered) {
      onGrandfather?.({ scriptId, stage, decision: rollout });
      console.warn(
        `[ProductionGuard] GRANDFATHERED script ${scriptId} into ${stage} with no editorial ` +
          `verdict. ${rollout.reason}`
      );
      return {
        ...verdict,
        blocked: false,
        reasons: [...verdict.reasons, rollout.reason],
        rollout,
      };
    }
    throw new ProductionHoldError(scriptId, stage, {
      ...verdict,
      reasons: [...verdict.reasons, rollout.reason],
      rollout,
    });
  }

  throw new ProductionHoldError(scriptId, stage, verdict);
}
