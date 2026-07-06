"use server";

import { requireAdmin } from "@/lib/adminAuth";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import {
  validateEpisodeForRss,
  prepareEpisodeForPublishing,
  publishEpisode,
  unpublishEpisode,
} from "@/lib/services/rssPublishingService";
import { getPodcastConfig, validatePodcastConfig } from "@/lib/services/rssFeedService";

export async function fetchRssDashboard(filters?: { status?: string; search?: string }) {
  await requireAdmin();
  const whereClause: any = {};

  if (filters?.status) {
    whereClause.episode = {
      status: filters.status,
    };
  }

  if (filters?.search) {
    whereClause.episode = {
      ...whereClause.episode,
      title: {
        contains: filters.search,
        mode: "insensitive",
      },
    };
  }

  const scripts = await db.script.findMany({
    where: whereClause,
    orderBy: { createdAt: "desc" },
    include: {
      episode: true,
      factCheckResults: {
        orderBy: { checkedAt: "desc" },
        take: 1,
      },
    },
  });

  return scripts;
}

export async function fetchRssDetail(scriptId: string) {
  await requireAdmin();
  const script = await db.script.findUnique({
    where: { id: scriptId },
    include: {
      episode: true,
      audioSegments: true,
      factCheckResults: {
        orderBy: { checkedAt: "desc" },
        take: 1,
      },
    },
  });
  return script;
}

export async function fetchRssEligibility(scriptId: string) {
  await requireAdmin();
  return await validateEpisodeForRss(scriptId);
}

export async function prepareEpisodeForRssAction(scriptId: string) {
  await requireAdmin();
  const result = await prepareEpisodeForPublishing(scriptId);
  revalidatePath("/admin/rss");
  revalidatePath(`/admin/rss/${scriptId}`);
  return result;
}

export async function publishEpisodeAction(scriptId: string, forceRepublish = false) {
  await requireAdmin();
  const result = await publishEpisode(scriptId, { forceRepublish });
  revalidatePath("/admin/rss");
  revalidatePath(`/admin/rss/${scriptId}`);
  return result;
}

export async function unpublishEpisodeAction(scriptId: string) {
  await requireAdmin();
  const result = await unpublishEpisode(scriptId);
  revalidatePath("/admin/rss");
  revalidatePath(`/admin/rss/${scriptId}`);
  return result;
}

export async function fetchPodcastConfigChecklist() {
  await requireAdmin();
  const config = getPodcastConfig();
  const missingKeys = validatePodcastConfig(config);
  return {
    config,
    missingKeys,
    isValid: missingKeys.length === 0,
  };
}

export async function fetchLatestRssJob(scriptId: string) {
  await requireAdmin();
  const jobs = await db.jobLog.findMany({
    where: {
      jobType: {
        in: ["rss:prepare-episode", "rss:publish-episode", "rss:unpublish-episode"],
      },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return (
    jobs.find((j) => {
      const input = j.input as any;
      const output = j.output as any;
      return input?.scriptId === scriptId || output?.scriptId === scriptId;
    }) || null
  );
}
