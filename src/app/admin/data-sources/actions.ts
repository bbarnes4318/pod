"use server";

import { db } from "@/lib/db";
import { queueIngestionJob } from "@/lib/queue/podcastQueue";
import { revalidatePath } from "next/cache";
import { getOddsApiKey, getRssNewsFeeds } from "@/lib/env";

export async function fetchIngestionStats() {
  try {
    const leagues = await db.league.count();
    const teams = await db.team.count();
    const players = await db.player.count();
    const games = await db.game.count();
    const odds = await db.oddsSnapshot.count();
    const injuries = await db.injury.count();
    const news = await db.newsItem.count();
    
    const teamStats = await db.teamStat.count();
    const playerStats = await db.playerStat.count();
    const stats = teamStats + playerStats;

    return { success: true, stats: { leagues, teams, players, games, odds, injuries, news, stats } };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch statistics" };
  }
}

export async function fetchRecentJobLogs() {
  try {
    const logs = await db.jobLog.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
    });
    // Serialize Dates
    const serialized = logs.map((log) => ({
      id: log.id,
      jobType: log.jobType,
      status: log.status,
      input: log.input,
      output: log.output,
      error: log.error,
      createdAt: log.createdAt.toISOString(),
      updatedAt: log.updatedAt.toISOString(),
    }));
    return { success: true, logs: serialized };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to fetch job logs" };
  }
}

interface IngestParams {
  providerType: string;
  leagueId: string;
  sport: string;
  dateOrRange: string;
}

export async function triggerDataIngestion(params: IngestParams) {
  try {
    const provider = params.providerType.toLowerCase();
    
    // 1. Validation of provider credentials before queueing
    if (provider === "sportsdataio") {
      const key = process.env.SPORTSDATAIO_API_KEY;
      if (!key || key === "your-sportsdataio-api-key") {
        throw new Error("Credentials missing: SPORTSDATAIO_API_KEY is not configured in .env");
      }
    } else if (provider === "oddsapi") {
      const key = getOddsApiKey();
      if (!key) {
        throw new Error("Credentials missing: ODDS_API_KEY is not configured in .env");
      }
    } else if (provider === "rss-news") {
      const feeds = getRssNewsFeeds();
      if (feeds.length === 0) {
        throw new Error("Configuration missing: NEWS_RSS_FEEDS is not configured in .env");
      }
    } else if (provider !== "stub") {
      throw new Error(`Unsupported provider type: ${params.providerType}`);
    }

    if (!params.leagueId && provider !== "rss-news") {
      throw new Error("League ID is required for sports data providers.");
    }

    // 2. Queue the BullMQ job
    const job = await queueIngestionJob({
      providerType: params.providerType,
      leagueId: params.leagueId,
      sport: params.sport,
      dateOrRange: params.dateOrRange,
    });

    revalidatePath("/admin/data-sources");
    return { success: true, jobId: job.id };
  } catch (err: any) {
    return { success: false, error: err.message || "Failed to trigger ingestion job." };
  }
}
