"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { validateScriptContent, sanitizeScriptContent, ValidationSummary } from "@/lib/services/scriptValidation";

// Helper to compile episode context
async function getEpisodeContextForScript(script: any) {
  const ep = await db.episode.findUnique({
    where: { id: script.episodeId },
    include: {
      topics: {
        include: {
          topic: {
            include: {
              researchBrief: true,
            },
          },
        },
      },
    },
  });

  if (!ep) {
    throw new Error(`Episode not found for script ID ${script.id}.`);
  }

  const hostA = await db.aiHost.findFirst({ where: { name: "Max Voltage", isActive: true } });
  const hostB = await db.aiHost.findFirst({ where: { name: "Dr. Linebreak", isActive: true } });

  if (!hostA || !hostB) {
    throw new Error("Active host profiles for Max Voltage and Dr. Linebreak must be active.");
  }

  const allowedSourceRefs = new Set<string>();
  const unsafeClaims: string[] = [];

  for (const et of ep.topics) {
    const brief = et.topic.researchBrief;
    if (brief) {
      const sourceIds = Array.isArray(brief.sourceIds) ? (brief.sourceIds as any[]) : [];
      for (const src of sourceIds) {
        if (src && src.type && src.id) {
          allowedSourceRefs.add(`${src.type}:${src.id}`);
        }
      }
      const unsafe = Array.isArray(brief.unsafeClaims) ? (brief.unsafeClaims as any[]) : [];
      for (const uc of unsafe) {
        if (uc && uc.claim) {
          unsafeClaims.push(uc.claim);
        }
      }
    }
  }

  return { allowedSourceRefs, hostA, hostB, unsafeClaims, episode: ep };
}

// Helper to determine Episode status (checks for another approved script version)
async function getEpisodeStatusForRevision(episodeId: string, excludeScriptId?: string): Promise<string> {
  const approvedCount = await db.script.count({
    where: {
      episodeId,
      status: "approved",
      NOT: excludeScriptId ? { id: excludeScriptId } : undefined,
    },
  });
  return approvedCount > 0 ? "script_approved" : "script_draft";
}

// Helper to generate plainText from segments structure
function generatePlainTextFromSegments(segments: any[]): string {
  return segments
    .map((seg) => {
      const label = `[${seg.type.toUpperCase()}${seg.title ? ` — ${seg.title}` : ""}]`;
      const dialogue = (seg.lines || [])
        .map((line: any) => `${line.speakerName}:\n${line.text}`)
        .join("\n\n");
      return `${label}\n\n${dialogue}`;
    })
    .join("\n\n");
}

export async function fetchScripts(filters: {
  status?: string;
  episodeStatus?: string;
  version?: string | number;
  search?: string;
}) {
  try {
    const where: any = {};
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.version !== undefined && filters.version !== "") {
      where.version = Number(filters.version);
    }
    if (filters.episodeStatus || filters.search) {
      where.episode = {};
      if (filters.episodeStatus) {
        where.episode.status = filters.episodeStatus;
      }
      if (filters.search) {
        where.episode.title = { contains: filters.search, mode: "insensitive" };
      }
    }

    const list = await db.script.findMany({
      where,
      include: { episode: true },
      orderBy: { createdAt: "desc" },
    });

    const serialized = list.map((s) => {
      const contentObj = typeof s.content === "object" && s.content !== null ? (s.content as any) : {};
      const safety = contentObj.safety || {};

      return {
        id: s.id,
        episodeTitle: s.episode.title,
        version: s.version,
        status: s.status,
        episodeStatus: s.episode.status,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.createdAt.toISOString(),
        totalLineCount: safety.totalLineCount || 0,
        factualLineCount: safety.factualLineCount || 0,
        evidenceCoveragePercent: safety.evidenceCoveragePercent || 0,
        reasons: safety.reasons || [],
      };
    });

    return { success: true, scripts: serialized };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch scripts." };
  }
}

export async function fetchScriptForReview(scriptId: string) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
    });

    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    const { allowedSourceRefs, hostA, hostB, unsafeClaims, episode } = await getEpisodeContextForScript(script);

    // Group allowed source refs for the evidence panel
    const evidencePanelItems: any[] = [];
    for (const et of episode.topics) {
      const brief = et.topic.researchBrief;
      if (brief) {
        const facts = Array.isArray(brief.facts) ? (brief.facts as any[]) : [];
        const stats = Array.isArray(brief.stats) ? (brief.stats as any[]) : [];
        const sourceIds = Array.isArray(brief.sourceIds) ? (brief.sourceIds as any[]) : [];

        for (const src of sourceIds) {
          if (src && src.id && src.type) {
            let detailText = "";
            const matchedFact = facts.find((f) => f.evidenceRefs?.some((ref: any) => ref.id === src.id));
            if (matchedFact) {
              detailText = matchedFact.text;
            } else {
              const matchedStat = stats.find((s) => s.evidenceRefs?.some((ref: any) => ref.id === src.id));
              if (matchedStat) {
                detailText = matchedStat.text;
              }
            }

            evidencePanelItems.push({
              type: src.type,
              id: src.id,
              topicTitle: et.topic.title,
              detailText,
            });
          }
        }
      }
    }

    const contentObj = typeof script.content === "object" && script.content !== null ? (script.content as any) : {};

    return {
      success: true,
      script: {
        id: script.id,
        episodeId: script.episodeId,
        version: script.version,
        content: contentObj,
        plainText: script.plainText,
        status: script.status,
        createdAt: script.createdAt.toISOString(),
      },
      episode: {
        id: episode.id,
        title: episode.title,
        status: episode.status,
      },
      evidencePanelItems,
      hostA: { id: hostA.id, name: hostA.name },
      hostB: { id: hostB.id, name: hostB.name },
      unsafeClaims,
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to load script for review." };
  }
}

export async function saveScriptEdits(scriptId: string, updatedContent: any) {
  try {
    const script = await db.script.findUnique({ where: { id: scriptId } });
    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    if (script.status === "approved" || script.status === "rejected") {
      throw new Error("Edits cannot be saved directly to approved or rejected scripts. Use Save as New Version instead.");
    }

    const { allowedSourceRefs, hostA, hostB, unsafeClaims, episode } = await getEpisodeContextForScript(script);

    // Sanitize script content (remove invalid refs, normalize indices, speakerHostId alignment)
    const { sanitizedContent, cleanedEvidenceRefCount } = sanitizeScriptContent(updatedContent, {
      allowedSourceRefs,
      hostA,
      hostB,
    });

    // Validate sanitized content
    const summary = validateScriptContent(sanitizedContent, { allowedSourceRefs, hostA, hostB, unsafeClaims });

    // Store cleaned counts
    summary.cleanedEvidenceRefCount = cleanedEvidenceRefCount;
    sanitizedContent.safety = summary;

    const plainText = generatePlainTextFromSegments(sanitizedContent.segments);
    const updatedStatus = summary.validationPassed ? script.status : "needs_revision";

    // Determine target episode status based on other approved scripts
    const nextEpisodeStatus = summary.validationPassed
      ? episode.status
      : await getEpisodeStatusForRevision(episode.id, scriptId);

    await db.$transaction(async (tx) => {
      // Save Script edits
      await tx.script.update({
        where: { id: scriptId },
        data: {
          content: sanitizedContent as any,
          plainText,
          status: updatedStatus,
        },
      });

      // Update Episode status
      await tx.episode.update({
        where: { id: episode.id },
        data: { status: nextEpisodeStatus },
      });

      // Write JobLog
      await tx.jobLog.create({
        data: {
          jobType: "script:review",
          status: summary.validationPassed ? "completed" : "failed",
          input: { scriptId, action: "save", cleanedEvidenceRefCount } as any,
          output: {
            validationSummary: summary,
            resultingScriptStatus: updatedStatus,
            resultingEpisodeStatus: nextEpisodeStatus,
            cleanedEvidenceRefCount,
            reasons: summary.reasons,
          } as any,
        },
      });
    });

    revalidatePath("/admin/scripts");
    revalidatePath(`/admin/scripts/${scriptId}`);
    return { success: true, validationSummary: summary };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to save script edits." };
  }
}

export async function saveScriptAsNewVersion(scriptId: string, updatedContent: any) {
  try {
    const script = await db.script.findUnique({ where: { id: scriptId } });
    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    const { allowedSourceRefs, hostA, hostB, unsafeClaims, episode } = await getEpisodeContextForScript(script);

    // Find the latest version number
    const maxScript = await db.script.findFirst({
      where: { episodeId: script.episodeId },
      orderBy: { version: "desc" },
    });
    const nextVersion = maxScript ? maxScript.version + 1 : 1;

    // Sanitize script content
    const { sanitizedContent, cleanedEvidenceRefCount } = sanitizeScriptContent(updatedContent, {
      allowedSourceRefs,
      hostA,
      hostB,
    });

    // Validate sanitized content
    const summary = validateScriptContent(sanitizedContent, { allowedSourceRefs, hostA, hostB, unsafeClaims });

    summary.cleanedEvidenceRefCount = cleanedEvidenceRefCount;
    sanitizedContent.safety = summary;

    const plainText = generatePlainTextFromSegments(sanitizedContent.segments);
    const nextStatus = summary.validationPassed ? "draft" : "needs_revision";

    // Determine target episode status
    const nextEpisodeStatus = summary.validationPassed
      ? episode.status
      : await getEpisodeStatusForRevision(episode.id);

    const newScript = await db.$transaction(async (tx) => {
      // Save new Script record
      const s = await tx.script.create({
        data: {
          episodeId: script.episodeId,
          version: nextVersion,
          content: sanitizedContent as any,
          plainText,
          status: nextStatus,
        },
      });

      // Update Episode status
      await tx.episode.update({
        where: { id: episode.id },
        data: { status: nextEpisodeStatus },
      });

      // Write JobLog
      await tx.jobLog.create({
        data: {
          jobType: "script:review",
          status: summary.validationPassed ? "completed" : "failed",
          input: { scriptId, action: "save_as_new_version", version: nextVersion, cleanedEvidenceRefCount } as any,
          output: {
            validationSummary: summary,
            resultingScriptStatus: nextStatus,
            resultingEpisodeStatus: nextEpisodeStatus,
            cleanedEvidenceRefCount,
            reasons: summary.reasons,
          } as any,
        },
      });

      return s;
    });

    revalidatePath("/admin/scripts");
    revalidatePath(`/admin/scripts/${scriptId}`);
    return { success: true, newScriptId: newScript.id, validationSummary: summary };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to save script as new version." };
  }
}

export async function validateScript(scriptId: string, optionalContent?: any) {
  try {
    const script = await db.script.findUnique({ where: { id: scriptId } });
    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    const { allowedSourceRefs, hostA, hostB, unsafeClaims } = await getEpisodeContextForScript(script);
    const rawContent = optionalContent || script.content;

    // Sanitize first
    const { sanitizedContent, cleanedEvidenceRefCount } = sanitizeScriptContent(rawContent, {
      allowedSourceRefs,
      hostA,
      hostB,
    });

    const summary = validateScriptContent(sanitizedContent, { allowedSourceRefs, hostA, hostB, unsafeClaims });
    summary.cleanedEvidenceRefCount = cleanedEvidenceRefCount;

    // Write JobLog
    await db.jobLog.create({
      data: {
        jobType: "script:review",
        status: summary.validationPassed ? "completed" : "failed",
        input: { scriptId, action: "validate", cleanedEvidenceRefCount } as any,
        output: {
          validationSummary: summary,
          cleanedEvidenceRefCount,
          reasons: summary.reasons,
        } as any,
      },
    });

    return { success: true, validationSummary: summary };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to validate script." };
  }
}

export async function approveScript(scriptId: string) {
  try {
    const script = await db.script.findUnique({ where: { id: scriptId } });
    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    if (script.status !== "draft" && script.status !== "needs_revision") {
      await db.jobLog.create({
        data: {
          jobType: "script:review",
          status: "failed",
          input: { scriptId, action: "approve" } as any,
          output: {
            reason: `Only draft or needs_revision scripts can be approved. Current status: ${script.status}`,
            currentScriptStatus: script.status,
          } as any,
        },
      });
      throw new Error(`Only draft or needs_revision scripts can be approved. Current status: ${script.status}`);
    }

    const { allowedSourceRefs, hostA, hostB, unsafeClaims, episode } = await getEpisodeContextForScript(script);

    // Sanitize script content prior to approval validations
    const { sanitizedContent, cleanedEvidenceRefCount } = sanitizeScriptContent(script.content, {
      allowedSourceRefs,
      hostA,
      hostB,
    });

    // Approving a script IS the human review. Clear any per-line
    // needsHumanReview flags so the accepted lines flow through TTS and
    // stitching. The hard safety gates below (unsafe claims, unsupported
    // claims, evidence coverage, host balance) still apply.
    let clearedReviewFlagCount = 0;
    if (Array.isArray(sanitizedContent.segments)) {
      for (const seg of sanitizedContent.segments) {
        if (!seg || !Array.isArray(seg.lines)) continue;
        for (const line of seg.lines) {
          if (line && line.needsHumanReview === true) {
            line.needsHumanReview = false;
            clearedReviewFlagCount++;
          }
        }
      }
    }

    // Validate sanitized content
    const summary = validateScriptContent(sanitizedContent, { allowedSourceRefs, hostA, hostB, unsafeClaims });
    summary.cleanedEvidenceRefCount = cleanedEvidenceRefCount;
    sanitizedContent.safety = summary;

    // Regenerate plainText from sanitized content
    const plainText = generatePlainTextFromSegments(sanitizedContent.segments);

    // Run strict approval validations
    if (!summary.validationPassed) {
      throw new Error(`Cannot approve script: basic validation failed. Reasons: ${summary.reasons.join("; ")}`);
    }

    if (summary.evidenceCoveragePercent < 90) {
      throw new Error(`Cannot approve script: evidence coverage is ${summary.evidenceCoveragePercent}%, which is under the required 90%.`);
    }

    if (summary.invalidEvidenceRefCount > 0) {
      throw new Error(`Cannot approve script: contains ${summary.invalidEvidenceRefCount} invalid evidence references.`);
    }

    if (summary.unsupportedClaimCount > 0) {
      throw new Error(`Cannot approve script: contains ${summary.unsupportedClaimCount} unsupported claims.`);
    }

    if (summary.unsafeClaimCount > 0) {
      throw new Error(`Cannot approve script: uses ${summary.unsafeClaimCount} unsafe claims as facts.`);
    }

    // needsHumanReview flags were cleared above (approval = the human review),
    // so summary.needsHumanReviewCount is 0 here by construction. clearedReviewFlagCount
    // records how many were resolved for the audit log.

    if (summary.totalLineCount < 40) {
      throw new Error(`Cannot approve script: total lines count is ${summary.totalLineCount}, which is under the minimum of 40.`);
    }

    if (summary.hostLineShare["Max Voltage"] < 25 || summary.hostLineShare["Dr. Linebreak"] < 25) {
      throw new Error("Cannot approve script: dialogue host split is unbalanced. Each must have >= 25% line share.");
    }

    if (!plainText || !plainText.trim()) {
      throw new Error("Cannot approve script: plainText transcript is empty.");
    }

    // Atomic transaction for Script approval
    await db.$transaction(async (tx) => {
      // Set Script.status = approved and save sanitized content + safety + plainText
      await tx.script.update({
        where: { id: scriptId },
        data: {
          status: "approved",
          content: sanitizedContent as any,
          plainText,
        },
      });

      // Set Episode.status = script_approved
      await tx.episode.update({
        where: { id: episode.id },
        data: { status: "script_approved" },
      });

      // Write JobLog
      await tx.jobLog.create({
        data: {
          jobType: "script:review",
          status: "completed",
          input: { scriptId, action: "approve", cleanedEvidenceRefCount, clearedReviewFlagCount } as any,
          output: {
            validationSummary: summary,
            resultingScriptStatus: "approved",
            resultingEpisodeStatus: "script_approved",
            cleanedEvidenceRefCount,
            clearedReviewFlagCount,
            reasons: [],
          } as any,
        },
      });
    });

    revalidatePath("/admin/scripts");
    revalidatePath(`/admin/scripts/${scriptId}`);
    revalidatePath(`/admin/episodes/${episode.id}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to approve script." };
  }
}

export async function rejectScript(scriptId: string, reason: string) {
  try {
    const script = await db.script.findUnique({ where: { id: scriptId } });
    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    const { episode } = await getEpisodeContextForScript(script);

    // Find if another script version is already approved for this episode
    const nextEpisodeStatus = await getEpisodeStatusForRevision(episode.id, scriptId);

    await db.$transaction(async (tx) => {
      await tx.script.update({
        where: { id: scriptId },
        data: { status: "rejected" },
      });

      await tx.episode.update({
        where: { id: episode.id },
        data: { status: nextEpisodeStatus },
      });

      // Write JobLog
      await tx.jobLog.create({
        data: {
          jobType: "script:review",
          status: "completed",
          input: { scriptId, action: "reject", reason } as any,
          output: {
            validationSummary: (script.content as any)?.safety || null,
            resultingScriptStatus: "rejected",
            resultingEpisodeStatus: nextEpisodeStatus,
            reasons: [reason],
          } as any,
        },
      });
    });

    revalidatePath("/admin/scripts");
    revalidatePath(`/admin/scripts/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to reject script." };
  }
}

export async function markScriptNeedsRevision(scriptId: string, reason?: string) {
  try {
    const script = await db.script.findUnique({ where: { id: scriptId } });
    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    const { episode } = await getEpisodeContextForScript(script);

    // Determine target episode status
    const nextEpisodeStatus = await getEpisodeStatusForRevision(episode.id, scriptId);

    await db.$transaction(async (tx) => {
      await tx.script.update({
        where: { id: scriptId },
        data: { status: "needs_revision" },
      });

      await tx.episode.update({
        where: { id: episode.id },
        data: { status: nextEpisodeStatus },
      });

      // Write JobLog
      await tx.jobLog.create({
        data: {
          jobType: "script:review",
          status: "completed",
          input: { scriptId, action: "needs_revision", reason } as any,
          output: {
            validationSummary: (script.content as any)?.safety || null,
            resultingScriptStatus: "needs_revision",
            resultingEpisodeStatus: nextEpisodeStatus,
            reasons: reason ? [reason] : [],
          } as any,
        },
      });
    });

    revalidatePath("/admin/scripts");
    revalidatePath(`/admin/scripts/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to mark script needs revision." };
  }
}
