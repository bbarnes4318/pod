// Script approval as a reusable service — the budget-protection checkpoint.
//
// The /admin console has its own approveScript server action (admin-gated,
// with the same safety gates). The login-gated /studio Create flow needs to
// let the EPISODE OWNER approve their own script before any expensive TTS
// runs, without going through Basic Auth. Rather than duplicate the strict
// validation, this service reuses the shared scriptValidation + hostCasting
// services and applies the same safety gates. It is intentionally
// self-contained so it never touches (or regresses) the admin surface.
//
// Approving a script is the human review: it clears per-line needsHumanReview
// flags, sanitizes evidence refs, runs the hard safety gates, then flips
// Script.status → "approved" and Episode.status → "script_approved". Only from
// script_approved can fact-check advance the episode to fact_checked, which is
// the sole gate the TTS stage will run behind.

import { db } from "@/lib/db";
import { validateScriptContent, sanitizeScriptContent } from "@/lib/services/scriptValidation";
import { resolveEpisodeHosts } from "@/lib/services/hostCasting";

export interface ScriptApprovalResult {
  success: boolean;
  scriptId?: string;
  error?: string;
  reasons?: string[];
  /** Non-blocking grounding notes (surfaced in the transcript step; the hard
   *  publish gate still enforces them before going live). */
  warnings?: string[];
}

/** Build the validation context (allowed evidence refs, unsafe claims, the two
 *  cast hosts) for an episode's script. Mirrors the admin helper. */
async function contextForEpisode(episodeId: string) {
  const ep = await db.episode.findUnique({
    where: { id: episodeId },
    include: { topics: { include: { topic: { include: { researchBrief: true } } } } },
  });
  if (!ep) throw new Error("Episode not found.");

  const { hostA, hostB } = await resolveEpisodeHosts({ hostIds: ep.hostIds });

  const allowedSourceRefs = new Set<string>();
  const unsafeClaims: string[] = [];
  for (const et of ep.topics) {
    const brief = et.topic.researchBrief;
    if (!brief) continue;
    const sourceIds = Array.isArray(brief.sourceIds) ? (brief.sourceIds as any[]) : [];
    for (const src of sourceIds) {
      if (src && src.type && src.id) allowedSourceRefs.add(`${src.type}:${src.id}`);
    }
    const unsafe = Array.isArray(brief.unsafeClaims) ? (brief.unsafeClaims as any[]) : [];
    for (const uc of unsafe) if (uc && uc.claim) unsafeClaims.push(uc.claim);
  }
  return { episode: ep, hostA, hostB, allowedSourceRefs, unsafeClaims };
}

function plainTextFromSegments(segments: any[]): string {
  return (segments || [])
    .map((seg) => {
      const label = `[${String(seg.type || "").toUpperCase()}${seg.title ? ` — ${seg.title}` : ""}]`;
      const dialogue = (seg.lines || [])
        .map((line: any) => `${line.speakerName}:\n${line.text}`)
        .join("\n\n");
      return `${label}\n\n${dialogue}`;
    })
    .join("\n\n");
}

/**
 * Approve the latest script for an episode. Returns { success:false, reasons }
 * with the exact gate failures when the script isn't safe to voice yet, so the
 * Create flow can show the creator what to fix (or regenerate).
 */
export async function approveEpisodeLatestScript(episodeId: string): Promise<ScriptApprovalResult> {
  const script = await db.script.findFirst({
    where: { episodeId },
    orderBy: { version: "desc" },
  });
  if (!script) return { success: false, error: "No script to approve yet." };
  if (script.status === "approved") return { success: true, scriptId: script.id };
  if (script.status !== "draft" && script.status !== "needs_revision") {
    return { success: false, error: `This script can't be approved from status "${script.status}".` };
  }

  const { episode, hostA, hostB, allowedSourceRefs, unsafeClaims } = await contextForEpisode(episodeId);

  // Sanitize evidence refs, then clear needsHumanReview flags (approval IS the
  // human review) so accepted lines flow through TTS.
  const { sanitizedContent, cleanedEvidenceRefCount } = sanitizeScriptContent(script.content, {
    allowedSourceRefs,
    hostA,
    hostB,
  });
  if (Array.isArray(sanitizedContent.segments)) {
    for (const seg of sanitizedContent.segments) {
      if (!seg || !Array.isArray(seg.lines)) continue;
      for (const line of seg.lines) if (line && line.needsHumanReview === true) line.needsHumanReview = false;
    }
  }

  const summary = validateScriptContent(sanitizedContent, { allowedSourceRefs, hostA, hostB, unsafeClaims });
  summary.cleanedEvidenceRefCount = cleanedEvidenceRefCount;
  sanitizedContent.safety = summary;
  const plainText = plainTextFromSegments(sanitizedContent.segments);

  // Gate policy: "warnings, hard-gate at publish". The owner approving IS the
  // human review, so grounding gaps (a factual line with no citation, low
  // evidence coverage, an invalid ref) are recorded as WARNINGS and surfaced in
  // the transcript step — they no longer hard-block voicing. Genuine SAFETY
  // (unsafe claims used as fact) and STRUCTURAL/quality problems (invalid host
  // casting, too-short or unbalanced script, empty transcript) still block. The
  // hard publish gate blocks going live on unresolved claims.
  const reasons: string[] = [];
  if (summary.unsafeClaimCount > 0) reasons.push(`${summary.unsafeClaimCount} unsafe claim(s) used as fact.`);
  if (summary.invalidSpeakerCount > 0) reasons.push(`${summary.invalidSpeakerCount} line(s) have invalid host casting.`);
  if (summary.totalLineCount < 40) reasons.push(`Only ${summary.totalLineCount} lines (needs ≥ 40).`);
  const shareA = summary.hostLineShare[hostA.name] ?? 0;
  const shareB = summary.hostLineShare[hostB.name] ?? 0;
  if (shareA < 25 || shareB < 25) reasons.push("Host dialogue split is unbalanced (each needs ≥ 25%).");
  if (!plainText.trim()) reasons.push("Transcript is empty.");

  const warnings: string[] = [];
  if (summary.evidenceCoveragePercent < 90) warnings.push(`Evidence coverage is ${summary.evidenceCoveragePercent}% — verify claims before publishing.`);
  if (summary.invalidEvidenceRefCount > 0) warnings.push(`${summary.invalidEvidenceRefCount} invalid evidence reference(s).`);
  if (summary.unsupportedClaimCount > 0) warnings.push(`${summary.unsupportedClaimCount} unsupported claim(s) — resolve before publishing.`);

  if (reasons.length > 0) {
    return { success: false, error: "Script isn't ready to voice yet.", reasons };
  }

  await db.$transaction(async (tx) => {
    await tx.script.update({
      where: { id: script.id },
      data: { status: "approved", content: sanitizedContent as any, plainText },
    });
    await tx.episode.update({
      where: { id: episode.id },
      data: { status: "script_approved" },
    });
    await tx.jobLog.create({
      data: {
        jobType: "script:review",
        status: "completed",
        input: { scriptId: script.id, episodeId, action: "approve", surface: "studio" } as any,
        output: {
          resultingScriptStatus: "approved",
          resultingEpisodeStatus: "script_approved",
          validationSummary: summary,
          warnings,
        } as any,
      },
    });
  });

  return { success: true, scriptId: script.id, warnings };
}
