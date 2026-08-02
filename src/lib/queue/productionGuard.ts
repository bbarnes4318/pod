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
export type ScriptContentLoader = (scriptId: string) => Promise<unknown | null>;

// Imported lazily so the gate's decision logic can be executed in tests and in
// CI without a generated Prisma client standing between the assertion and the
// behaviour being asserted.
const dbLoader: ScriptContentLoader = async (scriptId) => {
  const { db } = await import("../db");
  const script = await db.script.findUnique({
    where: { id: scriptId },
    select: { id: true, content: true },
  });
  return script ? script.content : null;
};

let activeLoader: ScriptContentLoader = dbLoader;

/**
 * Test seam. Lets the queue-chain regression prove — by execution, not by
 * reading source — that a held script never reaches `productionQueue.add`.
 */
export function __setScriptContentLoaderForTests(loader: ScriptContentLoader | null): void {
  activeLoader = loader ?? dbLoader;
}

export async function assertScriptReleasableForProduction(
  scriptId: string,
  stage: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<DownstreamBlockVerdict> {
  const content = await activeLoader(scriptId);
  if (content === null || content === undefined) {
    throw new Error(`Script ${scriptId} not found; refusing to queue ${stage}.`);
  }
  const verdict = evaluateDownstreamBlock(content, env);
  if (verdict.blocked) {
    throw new ProductionHoldError(scriptId, stage, verdict);
  }
  return verdict;
}
