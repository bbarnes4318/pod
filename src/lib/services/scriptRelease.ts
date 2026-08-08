// Recording a human release from editorial hold.
//
// The gate has always said, in the text of its own error message, that "a human
// must review it in Studio and record an explicit release" — and
// `evaluateDownstreamBlock` has always read `content.humanRelease` to honour
// one. But nothing in the product ever WROTE that field. Outside of two test
// files, `humanRelease` appeared exactly once in application code: a read-only
// line in EditorialGatePanel that rendered a release nobody could create.
//
// So a held script was permanently held. The Studio "Approve" button flips
// `Script.status` to "approved", which the gate does not consult, so approving
// changed nothing the guard could see and TTS refused the script again with the
// identical message. This module closes that loop.
//
// The release is deliberately narrow:
//   · It acknowledges a SPECIFIC verdict. If the script is re-evaluated and
//     comes back worse, the recorded release no longer outranks it and the
//     script re-blocks — which is the existing DECISION_RANK behaviour, not a
//     new rule.
//   · It records who, when, and the exact reason strings they were shown, so
//     the decision is attributable after the fact.
//   · It refuses to release a verdict the approver did not actually read: the
//     caller passes the decision its UI rendered, and a mismatch is an error
//     rather than a silent release of something else.

import { db } from "@/lib/db";
import {
  buildReleaseRecord,
  evaluateDownstreamBlock,
  type HumanReleaseRecord,
  type ScriptEditorialDecision,
} from "./scriptEditorialGate";

export interface RecordReleaseInput {
  scriptId: string;
  /** Attributable identity — an email or user id, never "operator". */
  approvedBy: string;
  /** The decision the approver's screen was showing. Guards against releasing a
   *  verdict that changed between render and click. */
  expectedDecision?: ScriptEditorialDecision | "unknown";
  note?: string;
}

export type RecordReleaseResult =
  | { success: true; record: HumanReleaseRecord; wasBlocked: boolean }
  | { success: false; error: string; currentDecision?: ScriptEditorialDecision | "unknown" };

/**
 * Write an attributable human release onto the script, clearing the editorial
 * hold for every downstream queue boundary.
 *
 * Returns `wasBlocked: false` when the script was not actually blocked — the
 * release is still recorded (it is harmless and keeps the audit honest), but the
 * caller can tell the operator that nothing was standing in the way.
 */
export async function recordHumanRelease(input: RecordReleaseInput): Promise<RecordReleaseResult> {
  const approvedBy = input.approvedBy?.trim();
  if (!approvedBy) {
    return { success: false, error: "A release must name the person recording it." };
  }

  const script = await db.script.findUnique({
    where: { id: input.scriptId },
    select: { id: true, content: true },
  });
  if (!script || script.content === null || script.content === undefined) {
    return { success: false, error: `Script ${input.scriptId} not found.` };
  }

  // Evaluate against the SAME function the queue guard uses, so what the
  // operator releases is exactly what production was refusing. Passing an empty
  // env would resolve the gate mode differently, so the process env is used.
  const verdict = evaluateDownstreamBlock(script.content);

  if (input.expectedDecision && input.expectedDecision !== verdict.decision) {
    return {
      success: false,
      error:
        `This script's verdict changed to "${verdict.decision}" since the page was loaded. ` +
        `Reload and read the current reasons before releasing it.`,
      currentDecision: verdict.decision,
    };
  }

  const record = buildReleaseRecord(verdict, approvedBy, input.note);

  const content = script.content as Record<string, unknown>;
  await db.script.update({
    where: { id: script.id },
    data: { content: { ...content, humanRelease: record } as never },
  });

  await db.jobLog.create({
    data: {
      jobType: "script:release",
      status: "completed",
      input: { scriptId: script.id, approvedBy, decision: verdict.decision } as never,
      output: {
        acknowledgedReasons: verdict.reasons,
        failedCriticalAxes: verdict.failedCriticalAxes,
        note: record.note ?? null,
      } as never,
    },
  });

  return { success: true, record, wasBlocked: verdict.blocked };
}

/** Remove a previously recorded release, putting the script back under the gate. */
export async function revokeHumanRelease(scriptId: string): Promise<{ success: boolean; error?: string }> {
  const script = await db.script.findUnique({ where: { id: scriptId }, select: { id: true, content: true } });
  if (!script || !script.content) return { success: false, error: `Script ${scriptId} not found.` };
  const { humanRelease: _dropped, ...rest } = script.content as Record<string, unknown>;
  await db.script.update({ where: { id: script.id }, data: { content: rest as never } });
  return { success: true };
}
