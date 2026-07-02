"use server";

import { db } from "@/lib/db";
import { queueFactCheckJob } from "@/lib/queue/podcastQueue";
import { revalidatePath } from "next/cache";

export async function triggerFactCheck(scriptId: string, forceRecheck = false) {
  try {
    const script = await db.script.findUnique({
      where: { id: scriptId },
    });

    if (!script) {
      throw new Error(`Script with ID ${scriptId} not found.`);
    }

    if (script.status !== "approved" && script.status !== "draft" && script.status !== "needs_revision") {
      throw new Error(`Only draft, needs_revision, or approved scripts can be fact checked. Current status: ${script.status}`);
    }

    await queueFactCheckJob({ scriptId, forceRecheck });

    revalidatePath(`/admin/scripts/${scriptId}`);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to queue fact check job." };
  }
}

export async function fetchFactChecks(filters: {
  status?: string;
  episodeStatus?: string;
  version?: string | number;
  provider?: string;
  search?: string;
}) {
  try {
    const where: any = {};
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.provider) {
      where.provider = filters.provider;
    }
    if (filters.version !== undefined && filters.version !== "") {
      where.script = {
        version: Number(filters.version),
      };
    }
    if (filters.episodeStatus || filters.search) {
      if (!where.script) where.script = {};
      where.script.episode = {};
      if (filters.episodeStatus) {
        where.script.episode.status = filters.episodeStatus;
      }
      if (filters.search) {
        where.script.episode.title = { contains: filters.search, mode: "insensitive" };
      }
    }

    const list = await db.factCheckResult.findMany({
      where,
      include: {
        script: {
          include: {
            episode: true,
          },
        },
      },
      orderBy: { checkedAt: "desc" },
    });

    const serialized = list.map((f) => {
      const summary = typeof f.summary === "object" && f.summary !== null ? (f.summary as any) : {};
      const coverage = typeof f.evidenceCoverage === "object" && f.evidenceCoverage !== null ? (f.evidenceCoverage as any) : {};

      return {
        id: f.id,
        scriptId: f.scriptId,
        version: f.script.version,
        episodeId: f.script.episodeId,
        episodeTitle: f.script.episode.title,
        episodeStatus: f.script.episode.status,
        scriptStatus: f.script.status,
        status: f.status, // "passed" | "failed" | "needs_review"
        provider: f.provider,
        checkedAt: f.checkedAt.toISOString(),
        issueCount: (summary.totalErrors || 0) + (summary.totalWarnings || 0),
        unsupportedClaimCount: coverage.unsupportedClaimCount || 0,
        unsafeClaimCount: coverage.unsafeClaimCount || 0,
      };
    });

    return { success: true, factChecks: serialized };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch fact check history." };
  }
}

export async function fetchLatestFactCheckForScript(scriptId: string) {
  try {
    const f = await db.factCheckResult.findFirst({
      where: { scriptId },
      orderBy: { checkedAt: "desc" },
    });

    if (!f) return { success: true, factCheck: null };

    return {
      success: true,
      factCheck: {
        id: f.id,
        scriptId: f.scriptId,
        status: f.status,
        checkedAt: f.checkedAt.toISOString(),
        summary: typeof f.summary === "object" && f.summary !== null ? (f.summary as any) : {},
        evidenceCoverage: typeof f.evidenceCoverage === "object" && f.evidenceCoverage !== null ? (f.evidenceCoverage as any) : {},
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch latest fact check." };
  }
}

export async function fetchFactCheckDetail(factCheckId: string) {
  try {
    const f = await db.factCheckResult.findUnique({
      where: { id: factCheckId },
      include: {
        script: {
          include: {
            episode: true,
          },
        },
      },
    });

    if (!f) {
      throw new Error(`FactCheckResult with ID ${factCheckId} not found.`);
    }

    return {
      success: true,
      factCheck: {
        id: f.id,
        scriptId: f.scriptId,
        episodeId: f.script.episodeId,
        episodeTitle: f.script.episode.title,
        version: f.script.version,
        status: f.status,
        provider: f.provider,
        checkedAt: f.checkedAt.toISOString(),
        summary: typeof f.summary === "object" && f.summary !== null ? (f.summary as any) : {},
        issues: typeof f.issues === "object" && f.issues !== null ? (f.issues as any) : {},
        evidenceCoverage: typeof f.evidenceCoverage === "object" && f.evidenceCoverage !== null ? (f.evidenceCoverage as any) : {},
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch fact check details." };
  }
}
