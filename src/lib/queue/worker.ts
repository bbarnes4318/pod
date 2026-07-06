// Standalone Queue Worker for Take Machine
import "dotenv/config";
import { assertProductionEnv, getOddsApiKeyStatus, getRssFeedStatus } from "../env";
import { runResearchRouting } from "../research/source-router";
import { fetchArticleExcerpts } from "../research/articleText";

// Fail loudly on startup if production configuration is invalid
assertProductionEnv();

import { Worker, Job } from "bullmq";
import { getRedisClient } from "../redis";
import { db } from "../db";
import { getSportsDataProvider } from "../providers/sports/factory";
import { getLLMProvider } from "../providers/llm/factory";
import { JobData, IngestJobData, TopicGenJobData, ResearchBriefJobData, EpisodeBuildJobData, ScriptGenJobData, FactCheckJobData, TtsSegmentJobData, FinalAudioStitchJobData, ContentAssetJobData } from "./podcastQueue";
import { buildEpisodeFromTopics } from "../services/episodeService";
import { generateScriptForEpisode } from "../services/scriptService";
import { factCheckScript } from "../services/factCheckService";
import { generateTtsSegments } from "../services/ttsSegmentService";
import { stitchFinalEpisodeAudio } from "../services/audioStitchingService";
import { generateEpisodeContentAssets } from "../services/contentAssetService";
import { ensureStarterSoundPack } from "../services/soundDesignSeedService";
import { resolveEpisodeHosts } from "../services/hostCasting";
import type { AiHost } from "@prisma/client";
import { podcastQueue } from "./podcastQueue";

/** Persona block for LLM prompts, built from a host's own profile record —
 *  so topic/brief seeding reflects whoever the show's active hosts are, not
 *  hardcoded names. */
function hostPersonaBlock(host: AiHost): string {
  const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x) => typeof x === "string") as string[] : []);
  const dislikes = arr(host.dislikes).slice(0, 4).join(", ");
  const likes = arr(host.likes).slice(0, 4).join(", ");
  return [
    `${host.name}:`,
    `- Role: ${host.role}`,
    `- Worldview: ${host.worldview}`,
    `- Speaking style: ${host.speakingStyle} (intensity ${host.intensityLevel}/10).`,
    likes ? `- Leans into: ${likes}.` : "",
    dislikes ? `- Hates: ${dislikes}.` : "",
  ].filter(Boolean).join("\n");
}
import {
  runRecurringPodcastGeneration,
  recurringCronPattern,
  RECURRING_GENERATION_TIME,
  RECURRING_GENERATION_TZ,
} from "../services/recurringPodcastService";

const QUEUE_NAME = "podcast-generation";

console.log("--------------------------------------------------");
console.log("TAKE MACHINE WORKER - INITIALIZING");
console.log(`Redis Connection: ${process.env.REDIS_URL || "redis://localhost:6379"}`);
console.log(`Queue Name: ${QUEUE_NAME}`);
console.log("--------------------------------------------------");

// Sound-design starter pack ships with the app (like migrations): if the
// asset library has no seed rows, synthesize + upload them on boot so the
// produced-audio layer works out of the box. Non-fatal on failure.
ensureStarterSoundPack().catch((err) =>
  console.warn(`[Worker] Sound pack auto-seed skipped: ${err.message}`)
);

// Daily recurring-podcast tick. upsertJobScheduler is idempotent: re-running
// it on every boot just refreshes the schedule (and picks up env changes to
// RECURRING_GENERATION_TIME / RECURRING_GENERATION_TZ).
podcastQueue
  .upsertJobScheduler(
    "recurring-podcast-generation",
    { pattern: recurringCronPattern(), tz: RECURRING_GENERATION_TZ },
    { name: "scheduler:recurring-podcasts", data: {} }
  )
  .then(() =>
    console.log(
      `[Worker] Recurring-podcast scheduler registered: daily at ${RECURRING_GENERATION_TIME} ${RECURRING_GENERATION_TZ}`
    )
  )
  .catch((err) => console.error(`[Worker] Failed to register recurring-podcast scheduler: ${err.message}`));

// Initialize BullMQ Worker
const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    if (job.name === "ingest:sports-data") {
      return handleSportsIngestion(job as Job<IngestJobData>);
    } else if (job.name === "generate:topics") {
      return handleTopicGeneration(job as Job<TopicGenJobData>);
    } else if (job.name === "generate:research-brief") {
      return handleResearchBriefGeneration(job as Job<ResearchBriefJobData>);
    } else if (job.name === "build:episode") {
      return handleEpisodeBuilding(job as Job<EpisodeBuildJobData>);
    } else if (job.name === "generate:script") {
      return handleScriptGeneration(job as Job<ScriptGenJobData>);
    } else if (job.name === "fact-check:script") {
      return handleFactChecking(job as Job<FactCheckJobData>);
    } else if (job.name === "tts:generate-segments") {
      return handleTtsSegmentGeneration(job as Job<TtsSegmentJobData>);
    } else if (job.name === "audio:stitch-final") {
      return handleFinalAudioStitching(job as Job<FinalAudioStitchJobData>);
    } else if (job.name === "content:generate-assets") {
      return handleContentAssetGeneration(job as Job<ContentAssetJobData>);
    } else if (job.name === "scheduler:recurring-podcasts") {
      return handleRecurringPodcastScheduler(job);
    } else if (job.name === "generate-podcast") {
      return handlePodcastGeneration(job as Job<JobData>);
    } else {
      console.warn(`[Worker] Unknown job type received: ${job.name}`);
      return { success: false, error: "Unknown job type" };
    }
  },
  {
    connection: getRedisClient() as any,
    concurrency: 2, // Allow processing up to 2 jobs concurrently
  }
);

// Worker Event Listeners
worker.on("active", (job) => {
  console.log(`[Worker] Job ${job.id} [${job.name}] became active`);
});

worker.on("completed", (job, result) => {
  console.log(`[Worker] Job ${job.id} [${job.name}] completed. Result:`, result);
});

worker.on("failed", (job, err) => {
  console.error(`[Worker] Job ${job?.id} [${job?.name}] failed with error:`, err.message);
});

worker.on("error", (err) => {
  console.error("[Worker] Global worker error occurred:", err);
});

// Helper function to simulate background processing delay
function simulateProgress(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 1. Podcast Generation handler (Simulated pipeline stages)
async function handlePodcastGeneration(job: Job<JobData>) {
  const { episodeId, stage } = job.data;
  console.log(`[Worker] Podcast generation job ${job.id} started for Episode ID: ${episodeId}, Stage: ${stage}`);

  switch (stage) {
    case "fetch-sports":
      console.log("[Worker] Stage: Fetching sports Talking Points & scoring them...");
      if (process.env.SPORTS_PROVIDER === "stub" || !process.env.SPORTS_PROVIDER) {
        console.warn("[Worker] GUARD: SPORTS_PROVIDER is set to 'stub'. The stub provider is for architecture validation only. It must never be used to generate real topics, research briefs, scripts, or published episodes. Skipping real content generation.");
      }
      await simulateProgress(1000);
      break;
    case "generate-script":
      console.log("[Worker] Stage: Generating debate script for the episode's cast hosts...");
      await simulateProgress(1500);
      break;
    case "generate-audio":
      console.log("[Worker] Stage: Converting script lines to TTS audio segments...");
      await simulateProgress(2000);
      break;
    case "stitch-audio":
      console.log("[Worker] Stage: Stitching audio segments with FFmpeg into final MP3...");
      await simulateProgress(1000);
      break;
    case "publish":
      console.log("[Worker] Stage: Finalizing metadata and updating RSS feed...");
      await simulateProgress(800);
      break;
    default:
      console.log(`[Worker] Unknown stage: ${stage}. Running generic processing...`);
      await simulateProgress(1000);
  }

  console.log(`[Worker] Podcast generation job completed successfully!`);
  return { success: true, processedStage: stage, episodeId };
}

// Recurring-podcast scheduler tick: enqueue an episode build for every
// recurring podcast due today (idempotent — see recurringPodcastService).
async function handleRecurringPodcastScheduler(job: Job) {
  console.log(`[Worker] Recurring-podcast scheduler tick started (job ${job.id})`);

  const jobLog = await db.jobLog.create({
    data: {
      jobType: "scheduler:recurring-podcasts",
      status: "running",
      input: { scheduledAt: new Date().toISOString() },
      output: {},
    },
  });

  try {
    const result = await runRecurringPodcastGeneration();
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: { status: "completed", output: result as any },
    });
    const enqueued = result.outcomes.filter((o) => o.status === "enqueued").length;
    const skipped = result.outcomes.filter((o) => o.status === "skipped_already_generated").length;
    console.log(
      `[Worker] Recurring scheduler done for ${result.dateKey} (${result.weekday}): due=${result.dueCount}, enqueued=${enqueued}, skipped=${skipped}`
    );
    return { success: true, ...result };
  } catch (err: any) {
    console.error(`[Worker] Recurring scheduler failed:`, err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: { status: "failed", error: err.message || "Unknown scheduler error" },
    });
    throw err;
  }
}

// 2. Real Sports Data Ingestion Handler
async function handleSportsIngestion(job: Job<IngestJobData>) {
  const { providerType, leagueId, sport, dateOrRange } = job.data;
  console.log(`[Worker] Starting sports ingestion: provider=${providerType}, league=${leagueId}, sport=${sport || "N/A"}, dateOrRange=${dateOrRange || "N/A"}`);

  // Create database JobLog record to monitor job status
  const jobLog = await db.jobLog.create({
    data: {
      jobType: `ingest:${providerType.toLowerCase()}`,
      status: "running",
      input: job.data as any,
      output: {},
    },
  });

  try {
    // Check if the stub provider is active
    if (providerType.toLowerCase() === "stub") {
      console.log("[Worker] Stub provider active — real sports ingestion disabled.");
      
      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "completed",
          output: { 
            message: "Stub provider active — real sports ingestion disabled.", 
            counts: { games: 0, news: 0, odds: 0, injuries: 0, stats: 0 } 
          },
        },
      });
      return { success: true, message: "Stub provider active — real sports ingestion disabled.", counts: { games: 0, news: 0, odds: 0 } };
    }

    // Initialize the real provider instance (fails if API credentials are missing)
    const provider = getSportsDataProvider(providerType);
    
    // Ingestion Counts
    let gamesCount = 0;
    let newsCount = 0;
    let oddsCount = 0;
    let injuriesCount = 0;
    let statsCount = 0;

    // Skipped Records & Logs
    let skippedGamesMissingTeams = 0;
    let skippedOddsMissingGame = 0;
    let skippedNewsMissingUrl = 0;
    const skippedRecordsReasonSummary: string[] = [];

    if (providerType.toLowerCase() === "rss-news") {
      // Ingest News items from RSS feeds
      const newsItems = await provider.getNews(leagueId);
      for (const item of newsItems) {
        if (!item.url) {
          skippedNewsMissingUrl++;
          skippedRecordsReasonSummary.push("News item from RSS feed missing URL.");
          continue;
        }

        // Unique deterministic ID based on RSS feed link to avoid duplicates
        const idKey = `rss:${item.url}`;

        // Ensure we strip HTML and store a safe summary snippet <= 250 characters
        let summary = null;
        if (item.summary) {
          const cleanSummary = item.summary.replace(/<[^>]*>/g, "").trim();
          summary = cleanSummary.length > 250 ? cleanSummary.substring(0, 247) + "..." : cleanSummary;
        }

        await db.newsItem.upsert({
          where: { id: idKey },
          update: {
            title: item.title,
            publishedAt: item.publishedAt,
            summary,
            entities: item.entities,
            raw: item.raw,
          },
          create: {
            id: idKey,
            title: item.title,
            source: item.source,
            url: item.url,
            publishedAt: item.publishedAt,
            summary,
            entities: item.entities,
            raw: item.raw,
          },
        });
        newsCount++;
      }
    } else if (providerType.toLowerCase() === "sportsdataio") {
      // SportsDataIO Real API Ingestion
      
      // 1. Teams/Standings Ingestion (Upsert Teams first for proper relationships)
      try {
        const standings = await provider.getStandings(leagueId, dateOrRange || "2026");
        for (const item of standings) {
          if (!item.TeamID || !item.Name || !item.Key) {
            skippedRecordsReasonSummary.push(`Standings team skipped: missing stable TeamID, Key or Name.`);
            continue;
          }

          const teamIdStr = `sio:${leagueId.toLowerCase()}:${item.TeamID}`;
          await db.team.upsert({
            where: { id: teamIdStr },
            update: {
              name: item.Name,
              city: item.City || "",
              abbreviation: item.Key,
            },
            create: {
              id: teamIdStr,
              leagueId: leagueId.toUpperCase(),
              name: item.Name,
              city: item.City || "",
              abbreviation: item.Key,
              slug: `${leagueId.toLowerCase()}-${item.Key.toLowerCase()}`,
            },
          });
        }
      } catch (err: any) {
        console.warn(`[Worker] Standings ingestion skipped or failed: ${err.message}`);
      }

      // 2. Schedules/Games Ingestion
      try {
        const schedules = await provider.getSchedules(leagueId, dateOrRange || "2026");
        for (const game of schedules) {
          // Strict Validation: No fake placeholder teams or empty values
          if (
            !game.HomeTeamID ||
            !game.AwayTeamID ||
            !game.HomeTeam ||
            !game.AwayTeam ||
            game.HomeTeam === "HOME" ||
            game.AwayTeam === "AWAY" ||
            game.HomeTeam === "Home Team" ||
            game.AwayTeam === "Away Team"
          ) {
            skippedGamesMissingTeams++;
            skippedRecordsReasonSummary.push(`Game ${game.GameID || "unknown"} skipped: missing or placeholder home/away team identifiers.`);
            continue;
          }

          const gameIdStr = `sio:${leagueId.toLowerCase()}:${game.GameID}`;
          const homeTeamIdStr = `sio:${leagueId.toLowerCase()}:${game.HomeTeamID}`;
          const awayTeamIdStr = `sio:${leagueId.toLowerCase()}:${game.AwayTeamID}`;

          // Ensure teams exist in DB using real names only (no fake cities or placeholding names)
          await db.team.upsert({
            where: { id: homeTeamIdStr },
            update: {},
            create: {
              id: homeTeamIdStr,
              leagueId: leagueId.toUpperCase(),
              name: game.HomeTeam,
              city: "",
              abbreviation: game.HomeTeam,
              slug: `${leagueId.toLowerCase()}-${game.HomeTeam.toLowerCase()}-${game.HomeTeamID}`,
            },
          });
          await db.team.upsert({
            where: { id: awayTeamIdStr },
            update: {},
            create: {
              id: awayTeamIdStr,
              leagueId: leagueId.toUpperCase(),
              name: game.AwayTeam,
              city: "",
              abbreviation: game.AwayTeam,
              slug: `${leagueId.toLowerCase()}-${game.AwayTeam.toLowerCase()}-${game.AwayTeamID}`,
            },
          });

          // Upsert Game
          await db.game.upsert({
            where: { id: gameIdStr },
            update: {
              status: game.Status || "scheduled",
              homeScore: game.HomeScore !== null && game.HomeScore !== undefined ? Math.round(game.HomeScore) : null,
              awayScore: game.AwayScore !== null && game.AwayScore !== undefined ? Math.round(game.AwayScore) : null,
              raw: game,
            },
            create: {
              id: gameIdStr,
              leagueId: leagueId.toUpperCase(),
              homeTeamId: homeTeamIdStr,
              awayTeamId: awayTeamIdStr,
              scheduledAt: game.DateTime ? new Date(game.DateTime) : new Date(),
              status: game.Status || "scheduled",
              homeScore: game.HomeScore !== null && game.HomeScore !== undefined ? Math.round(game.HomeScore) : null,
              awayScore: game.AwayScore !== null && game.AwayScore !== undefined ? Math.round(game.AwayScore) : null,
              sourceId: String(game.GameID),
              raw: game,
            },
          });
          gamesCount++;
        }
      } catch (err: any) {
        console.warn(`[Worker] Game schedules ingestion skipped or failed: ${err.message}`);
      }

      // 3. News Ingestion
      try {
        const news = await provider.getNews(leagueId);
        for (const item of news) {
          if (!item.Url) {
            skippedNewsMissingUrl++;
            skippedRecordsReasonSummary.push(`News item ${item.NewsID || "unknown"} skipped: missing URL.`);
            continue;
          }

          const newsIdStr = `sio:${leagueId.toLowerCase()}:${item.NewsID}`;

          // Keep summary strictly as a safe excerpt <= 250 characters (stripping HTML)
          let summary = null;
          if (item.Content) {
            const cleanSummary = item.Content.replace(/<[^>]*>/g, "").trim();
            summary = cleanSummary.length > 250 ? cleanSummary.substring(0, 247) + "..." : cleanSummary;
          }

          await db.newsItem.upsert({
            where: { id: newsIdStr },
            update: {
              title: item.Title,
              publishedAt: item.Updated ? new Date(item.Updated) : new Date(),
              summary,
              raw: item,
            },
            create: {
              id: newsIdStr,
              title: item.Title,
              source: item.Source || "SportsDataIO",
              url: item.Url,
              publishedAt: item.Updated ? new Date(item.Updated) : new Date(),
              summary,
              entities: [],
              raw: item,
            },
          });
          newsCount++;
        }
      } catch (err: any) {
        console.warn(`[Worker] News Ingestion skipped or failed: ${err.message}`);
      }

      // 4. Injuries Ingestion
      try {
        const injuries = await provider.getInjuries(leagueId);
        for (const injury of injuries) {
          if (!injury.PlayerID || !injury.Name || !injury.TeamID) {
            skippedRecordsReasonSummary.push("Injury entry skipped: missing stable player or team IDs.");
            continue;
          }

          const playerIdStr = `sio:${leagueId.toLowerCase()}:${injury.PlayerID}`;
          const teamIdStr = `sio:${leagueId.toLowerCase()}:${injury.TeamID}`;

          // Ensure Player exists
          await db.player.upsert({
            where: { id: playerIdStr },
            update: {
              name: injury.Name,
              position: injury.Position,
              status: injury.Status,
            },
            create: {
              id: playerIdStr,
              leagueId: leagueId.toUpperCase(),
              teamId: teamIdStr,
              name: injury.Name,
              position: injury.Position,
              status: injury.Status,
            },
          });

          // Insert Injury Event
          await db.injury.create({
            data: {
              playerId: playerIdStr,
              teamId: teamIdStr,
              status: injury.Status,
              description: injury.Injury || "Injured",
              reportedAt: new Date(),
              sourceId: String(injury.PlayerID),
            },
          });
          injuriesCount++;
        }
      } catch (err: any) {
        console.warn(`[Worker] Injuries Ingestion skipped or failed: ${err.message}`);
      }
    } else if (providerType.toLowerCase() === "oddsapi") {
      // 1. Fetch live odds
      const odds = await provider.getOdds(leagueId, sport);
      for (const gameOdds of odds) {
        const commenceTime = new Date(gameOdds.commence_time);
        const margin = 12 * 60 * 60 * 1000; // 12 hours search buffer

        // Search for matching game in local database (must tie back to real games)
        const matchingGame = await db.game.findFirst({
          where: {
            leagueId: leagueId.toUpperCase(),
            scheduledAt: {
              gte: new Date(commenceTime.getTime() - margin),
              lte: new Date(commenceTime.getTime() + margin),
            },
            homeTeam: {
              name: { contains: gameOdds.home_team.split(" ").pop(), mode: "insensitive" } // Match city/mascot suffix
            }
          },
        });

        if (!matchingGame) {
          skippedOddsMissingGame++;
          skippedRecordsReasonSummary.push(`Odds snapshot for Odds API game ${gameOdds.id} skipped: matching Game not found in database.`);
          console.warn(`[Worker] Skipped OddsSnapshot: no matching Game found in database for teams ${gameOdds.home_team} vs ${gameOdds.away_team} at ${gameOdds.commence_time}`);
          continue;
        }

        // Insert odds records from bookmakers
        const bookmakers = gameOdds.bookmakers || [];
        for (const bookmaker of bookmakers) {
          const markets = bookmaker.markets || [];
          for (const market of markets) {
            const outcomes = market.outcomes || [];
            for (const outcome of outcomes) {
              await db.oddsSnapshot.create({
                data: {
                  gameId: matchingGame.id,
                  sportsbook: bookmaker.title,
                  market: market.key,
                  line: outcome.point !== undefined ? parseFloat(outcome.point) : null,
                  price: outcome.price !== undefined ? parseFloat(outcome.price) : null,
                  capturedAt: new Date(),
                  sourceId: gameOdds.id,
                  raw: outcome,
                },
              });
              oddsCount++;
            }
          }
        }
      }
    }

    const outputObj = {
      message: "Ingestion completed successfully.",
      counts: {
        games: gamesCount,
        news: newsCount,
        odds: oddsCount,
        injuries: injuriesCount,
        stats: statsCount,
      },
      skippedGamesMissingTeams,
      skippedOddsMissingGame,
      skippedNewsMissingUrl,
      skippedRecordsReasonSummary: skippedRecordsReasonSummary.slice(0, 20), // Cap reasons to prevent payload bloat
    };

    // Update JobLog on completion
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: outputObj,
      },
    });

    console.log(`[Worker] Ingestion completed. Stats: games=${gamesCount}, news=${newsCount}, odds=${oddsCount}, skippedGames=${skippedGamesMissingTeams}, skippedOdds=${skippedOddsMissingGame}`);
    return { success: true, counts: { games: gamesCount, news: newsCount, odds: oddsCount } };
  } catch (err: any) {
    console.error(`[Worker] Ingestion job ${job.id} failed:`, err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown ingestion error",
      },
    });
    throw err;
  }
}

// 3. Real Sports Topic Generation Handler
async function handleTopicGeneration(job: Job<TopicGenJobData>) {
  const { leagueId, sport, minScore } = job.data;
  console.log(`[Worker] Starting sports topic generation job: league=${leagueId || "all"}, sport=${sport || "all"}`);

  // Helper to normalize title for duplicate protection
  const normalizeTitle = (t: string): string => {
    return t
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ") // Collapse whitespace
      .replace(/[^\w\s]/g, ""); // Remove punctuation
  };

  // Create JobLog record to monitor topic generation
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "generate:topics",
      status: "running",
      input: job.data as any,
      output: {},
    },
  });

  try {
    // 1. Stub LLM Guard: Must throw error and abort
    if (process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER) {
      const errorMsg = "LLM provider is stub. Real topic generation disabled.";
      console.warn(`[Worker] ${errorMsg}`);
      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "failed",
          error: errorMsg,
        },
      });
      throw new Error(errorMsg);
    }

    // 2. Fetch recent real sports evidence from Postgres
    const whereLeague = leagueId ? { leagueId: leagueId.toUpperCase() } : {};

    const games = await db.game.findMany({
      where: whereLeague,
      take: 30,
      orderBy: { scheduledAt: "desc" },
      include: { homeTeam: true, awayTeam: true },
    });

    const newsItems = await db.newsItem.findMany({
      take: 30,
      orderBy: { publishedAt: "desc" },
    });

    // Filter news items by league keyword if provided
    const filteredNews = leagueId
      ? newsItems.filter(
          (n) =>
            n.title.toLowerCase().includes(leagueId.toLowerCase()) ||
            (n.summary && n.summary.toLowerCase().includes(leagueId.toLowerCase()))
        )
      : newsItems;

    const injuries = await db.injury.findMany({
      where: {
        team: whereLeague,
      },
      take: 20,
      orderBy: { reportedAt: "desc" },
      include: { player: true, team: true },
    });

    // Skip injury records missing a linked player or team required for a useful topic
    const validInjuries = injuries.filter((i) => i.player?.name && i.team?.name);

    const oddsSnapshots = await db.oddsSnapshot.findMany({
      where: {
        game: whereLeague,
      },
      take: 30,
      orderBy: { capturedAt: "desc" },
    });

    const teamStats = await db.teamStat.findMany({
      where: whereLeague,
      take: 20,
      orderBy: { recordedAt: "desc" },
    });

    const playerStats = await db.playerStat.findMany({
      where: whereLeague,
      take: 20,
      orderBy: { recordedAt: "desc" },
    });

    const totalEvidenceCount =
      games.length + filteredNews.length + validInjuries.length + oddsSnapshots.length + teamStats.length + playerStats.length;

    // Static leagues alone do not count as evidence
    if (totalEvidenceCount === 0) {
      const emptyMsg = "No real sports evidence available. Ingest real sports data before generating topics.";
      console.warn(`[Worker] ${emptyMsg}`);
      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "completed",
          output: {
            message: emptyMsg,
            noEvidenceCount: 1,
            insertedCount: 0,
            skippedCount: 0,
            rejectedCount: 0,
            duplicateCount: 0,
            missingSportCount: 0,
            missingLeagueCount: 0,
            invalidLeagueCount: 0,
            leagueMismatchCount: 0,
            skippedWeakEvidenceCount: 0,
          },
        },
      });
      return { success: true, message: emptyMsg };
    }

    // 3. Serialize evidence concisely for LLM prompt context (no placeholder unknown text)
    const serializedEvidence = {
      games: games.map((g) => ({
        id: g.id,
        leagueId: g.leagueId,
        homeTeam: g.homeTeam.name,
        awayTeam: g.awayTeam.name,
        score: g.homeScore !== null ? `${g.homeScore}-${g.awayScore}` : "N/A",
        status: g.status,
        date: g.scheduledAt.toISOString(),
      })),
      news: filteredNews.map((n) => ({
        id: n.id,
        title: n.title,
        source: n.source,
        summary: n.summary,
        date: n.publishedAt.toISOString(),
      })),
      injuries: validInjuries.map((i) => ({
        id: i.id,
        player: i.player!.name,
        team: i.team!.name,
        status: i.status,
        description: i.description,
        date: i.reportedAt.toISOString(),
      })),
      odds: oddsSnapshots.map((o) => ({
        id: o.id,
        gameId: o.gameId,
        sportsbook: o.sportsbook,
        market: o.market,
        line: o.line,
        price: o.price,
      })),
      stats: [
        ...teamStats.map((ts) => ({ id: ts.id, teamId: ts.teamId, type: ts.statType, value: ts.value })),
        ...playerStats.map((ps) => ({ id: ps.id, playerId: ps.playerId, type: ps.statType, value: ps.value })),
      ],
    };

    // 4. Formulate LLM prompts matching the show's ACTIVE debate duo (resolved
    // from the roster; no hardcoded host names).
    const { hostA: topicHostA, hostB: topicHostB } = await resolveEpisodeHosts({ hostIds: [] });
    const systemPrompt = `You are the Topic Engine for Take Machine, an AI sports debate podcast.
Your job is to find sports topics that will create strong disagreement between the show's two AI hosts:

${hostPersonaBlock(topicHostA)}

${hostPersonaBlock(topicHostB)}

Rules:
- Do not invent facts, injuries, odds, stats, quotes, or rumors.
- Every topic must directly link to the supplied evidence records.
- Do not copy full copyrighted article summaries or texts.
- If evidence is weak, lower scores. Prefer argument potential over boring facts.

You must return a JSON object containing a 'topics' array of 10-20 candidates.
Schema for each topic candidate in the array:
{
  "title": "A short punchy sports-radio style question",
  "sport": "Football | Basketball | Baseball | Combat Sports | Betting | Fantasy Sports | Poker | etc.",
  "leagueId": "NFL | NBA | MLB | NHL | NCAAF | NCAAB | MMA | GAMBLING | FANTASY | POKER",
  "summary": "One-paragraph summary explaining the debate angle",
  "whyFansCare": "A brief sentence why fans will click",
  "whyMaxVoltageWillAgree": "Why ${topicHostA.name} (the higher-intensity host) will take a strong stance",
  "whyDrLinebreakWillDisagree": "Why ${topicHostB.name} (the lower-intensity host) will contradict them from their own worldview",
  "controversyScore": 1-100,
  "starPowerScore": 1-100,
  "bettingRelevanceScore": 1-100,
  "recencyScore": 1-100,
  "evidenceIds": [
    { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat", "id": "matching-evidence-uuid-or-id" }
  ]
}`;

    const prompt = `Here is the current real-world sports evidence in the database. Analyze it and generate 10-20 debate topics:
${JSON.stringify(serializedEvidence, null, 2)}`;

    // Resolve LLM Provider
    const llm = getLLMProvider();
    
    let llmResult: any;
    let parseErrorCount = 0;
    let providerError = null;

    try {
      llmResult = await llm.generateStructuredOutput<{ topics: any[] }>({
        prompt,
        systemPrompt,
        temperature: 0.25,
      });
    } catch (err: any) {
      providerError = err.message;
      parseErrorCount = 1;
      console.error(`[Worker] LLM execution or JSON parsing failed: ${err.message}`);
      
      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "failed",
          error: `LLM Ingestion Parse/Provider Error: ${err.message}`,
          output: { parseErrorCount: 1, providerError: err.message },
        },
      });
      throw err;
    }

    // 5. Validation loop
    let insertedCount = 0;
    let skippedCount = 0;
    let rejectedCount = 0;
    let duplicateCount = 0;
    let invalidEvidenceCount = 0;

    let missingSportCount = 0;
    let missingLeagueCount = 0;
    let invalidLeagueCount = 0;
    let leagueMismatchCount = 0;
    let skippedWeakEvidenceCount = 0;

    const skippedRecordsReasonSummary: string[] = [];

    const topicsList = llmResult?.topics || [];

    // Fetch existing candidates for advanced duplicate checking
    const existingCandidates = await db.topicCandidate.findMany({
      select: { title: true, evidenceIds: true },
    });

    for (const topic of topicsList) {
      // Basic fields validation
      if (!topic.title || !topic.summary || !Array.isArray(topic.evidenceIds) || topic.evidenceIds.length === 0) {
        skippedCount++;
        skippedRecordsReasonSummary.push(`Topic candidate '${topic.title || "untitled"}' skipped: missing title, summary, or evidenceIds.`);
        continue;
      }

      // Metadata validation: No defaulting to NBA/Basketball. Reject if sport is missing or invalid.
      if (!topic.sport || typeof topic.sport !== "string" || !topic.sport.trim()) {
        missingSportCount++;
        rejectedCount++;
        skippedRecordsReasonSummary.push(`Topic '${topic.title}' rejected: missing sport metadata.`);
        continue;
      }

      const topicSport = topic.sport.trim();
      if (sport && topicSport.toLowerCase() !== sport.toLowerCase()) {
        leagueMismatchCount++; // Count under mismatches
        rejectedCount++;
        skippedRecordsReasonSummary.push(`Topic '${topic.title}' rejected: sport mismatch (expected '${sport}', got '${topicSport}').`);
        continue;
      }

      // Metadata validation: Reject if leagueId is missing, invalid, or mismatched
      if (!topic.leagueId || typeof topic.leagueId !== "string" || !topic.leagueId.trim()) {
        missingLeagueCount++;
        rejectedCount++;
        skippedRecordsReasonSummary.push(`Topic '${topic.title}' rejected: missing leagueId metadata.`);
        continue;
      }

      const topicLeague = topic.leagueId.trim().toUpperCase();
      if (leagueId && topicLeague !== leagueId.toUpperCase()) {
        leagueMismatchCount++;
        rejectedCount++;
        skippedRecordsReasonSummary.push(`Topic '${topic.title}' rejected: leagueId mismatch (expected '${leagueId}', got '${topicLeague}').`);
        continue;
      }

      // Verify leagueId exists in our League reference database table
      const dbLeague = await db.league.findUnique({
        where: { id: topicLeague },
      });
      if (!dbLeague) {
        invalidLeagueCount++;
        rejectedCount++;
        skippedRecordsReasonSummary.push(`Topic '${topic.title}' rejected: invalid/unsupported leagueId '${topicLeague}' (not in League table).`);
        continue;
      }

      // Verify every evidenceId actually exists in its corresponding database table
      const validEvidence: any[] = [];
      let hasInvalidEvidence = false;

      for (const ref of topic.evidenceIds) {
        if (!ref.type || !ref.id) {
          hasInvalidEvidence = true;
          break;
        }

        let exists = false;
        try {
          if (ref.type === "game") {
            const r = await db.game.findUnique({ where: { id: ref.id } });
            exists = !!r;
          } else if (ref.type === "newsItem") {
            const r = await db.newsItem.findUnique({ where: { id: ref.id } });
            exists = !!r;
          } else if (ref.type === "injury") {
            const r = await db.injury.findUnique({ where: { id: ref.id } });
            exists = !!r;
          } else if (ref.type === "oddsSnapshot") {
            const r = await db.oddsSnapshot.findUnique({ where: { id: ref.id } });
            exists = !!r;
          } else if (ref.type === "teamStat") {
            const r = await db.teamStat.findUnique({ where: { id: ref.id } });
            exists = !!r;
          } else if (ref.type === "playerStat") {
            const r = await db.playerStat.findUnique({ where: { id: ref.id } });
            exists = !!r;
          }
        } catch {
          exists = false;
        }

        if (!exists) {
          hasInvalidEvidence = true;
          skippedRecordsReasonSummary.push(`Topic '${topic.title}' rejected: evidence reference [${ref.type}] ${ref.id} not found in DB.`);
          break;
        }
        validEvidence.push(ref);
      }

      if (hasInvalidEvidence) {
        invalidEvidenceCount++;
        rejectedCount++;
        continue;
      }

      // Calculate evidenceStrengthScore: base is quantity, fresh, odds/injuries
      let evidenceStrengthScore = Math.min(validEvidence.length * 15, 50);
      const hasOddsOrInjury = validEvidence.some(
        (ev) => ev.type === "oddsSnapshot" || ev.type === "injury"
      );
      if (hasOddsOrInjury) {
        evidenceStrengthScore += 25;
      }
      const hasNewsOrFresh = validEvidence.some(
        (ev) => ev.type === "newsItem" || ev.type === "game"
      );
      if (hasNewsOrFresh) {
        evidenceStrengthScore += 25;
      }
      evidenceStrengthScore = Math.max(1, Math.min(100, evidenceStrengthScore));

      // Reject if evidence is weak (e.g. less than 2 valid evidence items)
      if (validEvidence.length < 2 || evidenceStrengthScore < 20) {
        skippedWeakEvidenceCount++;
        rejectedCount++;
        skippedRecordsReasonSummary.push(`Topic '${topic.title}' rejected: evidence strength (${evidenceStrengthScore}) is too weak.`);
        continue;
      }

      // Clamp subscores server-side to 1-100 range
      const controversy = Math.max(1, Math.min(100, Number(topic.controversyScore) || 50));
      const starPower = Math.max(1, Math.min(100, Number(topic.starPowerScore) || 50));
      const bettingRelevance = Math.max(1, Math.min(100, Number(topic.bettingRelevanceScore) || 50));
      const recency = Math.max(1, Math.min(100, Number(topic.recencyScore) || 50));

      // Server-side debateScore formula:
      const debateScore =
        controversy * 0.30 +
        starPower * 0.20 +
        bettingRelevance * 0.20 +
        recency * 0.20 +
        evidenceStrengthScore * 0.10;

      // Advanced Duplicate protection check
      const normalizedCandidateTitle = normalizeTitle(topic.title);
      const candidateEvidenceIds = validEvidence.map((ev) => ev.id).sort().join(",");
      let isDuplicate = false;

      for (const ec of existingCandidates) {
        // 1. Normalized title match
        if (normalizeTitle(ec.title) === normalizedCandidateTitle) {
          isDuplicate = true;
          break;
        }
        // 2. Evidence ID overlap match
        const ecEvidenceIds = Array.isArray(ec.evidenceIds)
          ? ec.evidenceIds.map((ev: any) => ev.id).sort().join(",")
          : "";
        if (ecEvidenceIds && ecEvidenceIds === candidateEvidenceIds) {
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) {
        duplicateCount++;
        continue;
      }

      // Save valid TopicCandidate
      await db.topicCandidate.create({
        data: {
          title: topic.title.trim(),
          sport: topicSport,
          leagueId: topicLeague,
          summary: topic.summary,
          controversyScore: controversy,
          starPowerScore: starPower,
          bettingRelevanceScore: bettingRelevance,
          recencyScore: recency,
          debateScore,
          evidenceIds: validEvidence as any,
          status: "pending",
        },
      });
      insertedCount++;
    }

    // 6. Complete JobLog
    const outputObj = {
      message: "Topic generation completed successfully.",
      insertedCount,
      skippedCount,
      rejectedCount,
      duplicateCount,
      noEvidenceCount: 0,
      invalidEvidenceCount,
      parseErrorCount,
      providerError,
      missingSportCount,
      missingLeagueCount,
      invalidLeagueCount,
      leagueMismatchCount,
      skippedWeakEvidenceCount,
      skippedRecordsReasonSummary: skippedRecordsReasonSummary.slice(0, 20),
    };

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: outputObj,
      },
    });

    console.log(`[Worker] Topic generation complete. Inserted: ${insertedCount}, Skipped: ${skippedCount}, Rejected: ${rejectedCount}, Duplicates: ${duplicateCount}`);
    return { success: true, insertedCount };
  } catch (err: any) {
    console.error(`[Worker] Topic generation failed:`, err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown topic generation error",
      },
    });
    throw err;
  }
}

// Helper to classify sports topics using LLM (with heuristic fallback)
async function classifyTopic(title: string, summary: string): Promise<string> {
  if (process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER) {
    return runHeuristicClassification(title, summary);
  }

  const llm = getLLMProvider();
  const systemPrompt = `You are an expert sports media classifier. Classify the given sports topic into exactly one of these types:
- game_preview
- betting_market
- news_reaction
- team_topic
- player_topic
- coach_topic
- conference_topic
- generic_sports_take

Return valid JSON matching this schema:
{
  "classification": "one_of_the_above_types"
}`;

  const prompt = `Topic Title: ${title}\nTopic Summary: ${summary}`;

  try {
    const res = await llm.generateStructuredOutput<{ classification: string }>({
      prompt,
      systemPrompt,
      temperature: 0.1,
    });
    const type = res.classification?.trim().toLowerCase();
    const validTypes = [
      "game_preview",
      "betting_market",
      "news_reaction",
      "team_topic",
      "player_topic",
      "coach_topic",
      "conference_topic",
      "generic_sports_take"
    ];
    if (validTypes.includes(type)) {
      return type;
    }
  } catch (err: any) {
    console.warn(`[Worker] LLM classification failed, falling back to heuristics: ${err.message}`);
  }

  return runHeuristicClassification(title, summary);
}

function runHeuristicClassification(title: string, summary: string): string {
  const combined = `${title} ${summary || ""}`.toLowerCase();
  if (combined.match(/\b(odds|spread|total|moneyline|betting|wager|sportsbook)\b/i)) {
    return "betting_market";
  }
  if (combined.match(/\b(preview|matchup|versus|vs\b|play against|upcoming game)\b/i)) {
    return "game_preview";
  }
  if (combined.match(/\b(injury|injuries|trades|signing|signed|breaking|fired|hired|announced)\b/i)) {
    return "news_reaction";
  }
  if (combined.match(/\b(coach|coaching|manager|head coach)\b/i)) {
    return "coach_topic";
  }
  if (combined.match(/\b(player|quarterback|qb|mvp|rookie|athlete)\b/i)) {
    return "player_topic";
  }
  if (combined.match(/\b(team|franchise|club|squad)\b/i)) {
    return "team_topic";
  }
  if (combined.match(/\b(conference|division|sec|big ten|acc|pac-12|playoff bracket)\b/i)) {
    return "conference_topic";
  }
  return "generic_sports_take";
}

// 4. Research Brief Generation Handler
async function handleResearchBriefGeneration(job: Job<ResearchBriefJobData>) {
  const { topicId, forceRegenerate = false } = job.data;
  console.log(`[Worker] Starting Research Brief generation job: topicId=${topicId}, forceRegenerate=${forceRegenerate}`);

  // Create JobLog record to monitor Research Brief generation
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "generate:research-brief",
      status: "running",
      input: job.data as any,
      output: {},
    },
  });

  try {
    // 1. Fetch and Guard TopicCandidate
    const topic = await db.topicCandidate.findUnique({
      where: { id: topicId },
    });

    if (!topic) {
      throw new Error(`TopicCandidate with ID ${topicId} not found.`);
    }

    // Allow both freshly-approved topics and already-"used" ones. A "used"
    // topic already passed approval (an episode was built from it), so
    // regenerating its research brief is safe and lets operators rebuild
    // content without re-approving from scratch. The forceRegenerate check
    // below still governs overwriting an existing brief.
    if (topic.status !== "approved" && topic.status !== "used") {
      throw new Error(`TopicCandidate with ID ${topicId} must be 'approved' or 'used' to generate a research brief (current status: ${topic.status}).`);
    }

    // 2. Overwrite check
    const existingBrief = await db.researchBrief.findUnique({
      where: { topicId },
    });

    if (existingBrief && !forceRegenerate) {
      const skipMsg = `ResearchBrief for topic ${topicId} already exists. Skipping run.`;
      console.log(`[Worker] ${skipMsg}`);
      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "completed",
          output: {
            message: skipMsg,
            topicId,
            forceRegenerate,
            skippedCount: 1,
            insertedCount: 0,
            updatedCount: 0,
          },
        },
      });
      return { success: true, message: skipMsg, skipped: true };
    }

    // 3. Topic Classification
    const classification = await classifyTopic(topic.title, topic.summary || "");
    console.log(`[Worker] Classified topic ${topicId} as: ${classification}`);

    // 4. Resolve evidence references if present
    const topicEvidenceIds = Array.isArray(topic.evidenceIds)
      ? (topic.evidenceIds as any[])
      : [];

    const topicEvidenceMap = new Map<string, string>();
    for (const ref of topicEvidenceIds) {
      if (ref.id && ref.type) {
        topicEvidenceMap.set(ref.id, ref.type);
      }
    }

    const resolvedGames: any[] = [];
    const resolvedNews: any[] = [];
    const resolvedInjuries: any[] = [];
    const resolvedOdds: any[] = [];
    const resolvedTeamStats: any[] = [];
    const resolvedPlayerStats: any[] = [];

    let invalidEvidenceCount = 0;

    for (const ref of topicEvidenceIds) {
      let exists = false;
      let record: any = null;

      if (ref.type === "game") {
        record = await db.game.findUnique({ where: { id: ref.id }, include: { homeTeam: true, awayTeam: true } });
        if (record) {
          resolvedGames.push(record);
          exists = true;
        }
      } else if (ref.type === "newsItem") {
        record = await db.newsItem.findUnique({ where: { id: ref.id } });
        if (record) {
          resolvedNews.push(record);
          exists = true;
        }
      } else if (ref.type === "injury") {
        record = await db.injury.findUnique({ where: { id: ref.id }, include: { player: true, team: true } });
        if (record) {
          resolvedInjuries.push(record);
          exists = true;
        }
      } else if (ref.type === "oddsSnapshot") {
        record = await db.oddsSnapshot.findUnique({ where: { id: ref.id } });
        if (record) {
          resolvedOdds.push(record);
          exists = true;
        }
      } else if (ref.type === "teamStat") {
        record = await db.teamStat.findUnique({ where: { id: ref.id } });
        if (record) {
          resolvedTeamStats.push(record);
          exists = true;
        }
      } else if (ref.type === "playerStat") {
        record = await db.playerStat.findUnique({ where: { id: ref.id } });
        if (record) {
          resolvedPlayerStats.push(record);
          exists = true;
        }
      }

      if (!exists) {
        invalidEvidenceCount++;
        const msg = `Approved evidence reference [${ref.type}] ${ref.id} not found in database. Generation aborted.`;
        throw new Error(msg);
      }
    }

    // Guard against stub LLM provider
    if (process.env.LLM_PROVIDER?.toLowerCase() === "stub" || !process.env.LLM_PROVIDER) {
      const errorMsg = "LLM provider is stub. Real research brief generation disabled.";
      console.warn(`[Worker] ${errorMsg}`);
      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "failed",
          error: errorMsg,
        },
      });
      throw new Error(errorMsg);
    }

    // Filter out injuries lacking linked player or team
    const validInjuries = resolvedInjuries.filter((i) => i.player?.name && i.team?.name);

    // 5. Source Priority Guidelines & Invoke Research Source Router (Exa AI)
    let sourcePriorityGuideline = "";
    if (classification === "betting_market") {
      sourcePriorityGuideline = `Source Priority order:
1. User topic / title / prompt
2. Tied-back game data
3. Odds / markets (focus heavily on spread, total, moneyline, implied score, and market movement)
4. Exa Web Research (context, injury reporting, news, matchup narratives, background)
5. RSS news headlines
6. Team context`;
    } else if (classification === "game_preview") {
      sourcePriorityGuideline = `Source Priority order:
1. User topic / title / prompt
2. Exa Web Research (matchup context, recent forms, general sentiment)
3. RSS news headlines (freshness signals)
4. Schedule / game data (matchup, date, time)
5. Related team context
6. Odds API (optional supporting market context)`;
    } else if (classification === "news_reaction") {
      sourcePriorityGuideline = `Source Priority order:
1. User topic / title / prompt
2. Exa Web Research (deep context on the news event)
3. RSS news headlines
4. Related team/player context
(Do not use or require Odds API data unless explicitly relevant)`;
    } else {
      sourcePriorityGuideline = `Source Priority order:
1. User topic / title / prompt
2. Exa Web Research (general context, stats, sentiment, historical records)
3. RSS news headlines
4. Related team/player/coach/conference context
5. Schedule / game data
(Do not use or require Odds API data unless an upcoming game or betting angle is explicitly detected)`;
    }

    // Zero-cost enrichment: pull the full text behind the topic's matched
    // news items so the brief works from real reporting, not 250-char blurbs.
    const newsExcerptByUrl = new Map<string, string>();
    try {
      const excerpts = await fetchArticleExcerpts(
        resolvedNews.map((n: any) => n.url).filter(Boolean),
        { maxArticles: 4, maxCharsPerArticle: 2200 }
      );
      for (const ex of excerpts) {
        if (ex.ok) newsExcerptByUrl.set(ex.url, ex.excerpt);
      }
      console.log(`[Worker] Article enrichment: ${newsExcerptByUrl.size}/${Math.min(4, resolvedNews.length)} full-text excerpt(s) fetched.`);
    } catch (err: any) {
      console.warn(`[Worker] Article enrichment skipped: ${err.message}`);
    }

    const { researchResults, sourceNotes } = await runResearchRouting({
      title: topic.title,
      summary: topic.summary || "",
      classification,
      hasOddsApi: getOddsApiKeyStatus() === "CONFIGURED",
      hasRssFeeds: getRssFeedStatus() === "CONFIGURED",
      resolvedOddsCount: resolvedOdds.length,
      resolvedNewsCount: resolvedNews.length,
      resolvedGamesCount: resolvedGames.length,
    });

    // Dynamically insert Exa research results into topicEvidenceMap as valid "research" refs
    for (let idx = 0; idx < researchResults.length; idx++) {
      topicEvidenceMap.set(`research-${idx + 1}`, "research");
    }

    const isBettingTopic = classification === "betting_market" || 
      `${topic.title} ${topic.summary}`.toLowerCase().match(/\b(odds|spread|total|moneyline|betting|wager)\b/i);

    const sourceNotesUsed = sourceNotes;

    // Decouple Odds: betting brief should show "Odds unavailable" if Odds API key/data is missing
    let oddsContextFallback: string | null = null;
    if (isBettingTopic && resolvedOdds.length === 0) {
      oddsContextFallback = "Odds unavailable";
    }

    // 6. Serialize compact evidence packet
    const serializedEvidence = {
      topic: {
        title: topic.title,
        summary: topic.summary,
        sport: topic.sport,
        leagueId: topic.leagueId,
        classification,
      },
      evidence: {
        research: researchResults.map((r, idx) => ({
          id: `research-${idx + 1}`,
          title: r.title,
          url: r.url,
          highlights: r.highlights,
          snippet: r.snippet,
        })),
        games: resolvedGames.map((g) => ({
          id: g.id,
          homeTeam: g.homeTeam.name,
          awayTeam: g.awayTeam.name,
          score: g.homeScore !== null ? `${g.homeScore}-${g.awayScore}` : "N/A",
          status: g.status,
          date: g.scheduledAt.toISOString(),
        })),
        news: resolvedNews.map((n) => ({
          id: n.id,
          title: n.title,
          source: n.source,
          summary: n.summary,
          // Full-article depth (fetched below) — RSS summaries are capped at
          // 250 chars, which is headline-level; the excerpt carries the real
          // numbers, quotes, and specifics the brief needs.
          articleExcerpt: newsExcerptByUrl.get(n.url) || undefined,
          date: n.publishedAt.toISOString(),
        })),
        injuries: validInjuries.map((i) => ({
          id: i.id,
          player: i.player!.name,
          team: i.team!.name,
          status: i.status,
          description: i.description,
        })),
        odds: resolvedOdds.map((o) => ({
          id: o.id,
          gameId: o.gameId,
          sportsbook: o.sportsbook,
          market: o.market,
          line: o.line,
          price: o.price,
        })),
        stats: [
          ...resolvedTeamStats.map((ts) => ({ id: ts.id, teamId: ts.teamId, type: ts.statType, value: ts.value })),
          ...resolvedPlayerStats.map((ps) => ({ id: ps.id, playerId: ps.playerId, type: ps.statType, value: ps.value })),
        ],
      },
    };

    // 7. Formulate structured LLM prompts from the show's ACTIVE debate duo
    // (resolved from the roster; no hardcoded host names).
    const { hostA: briefHostA, hostB: briefHostB } = await resolveEpisodeHosts({ hostIds: [] });
    const systemPrompt = `You are the Research Brief Generator for Take Machine, an AI sports debate podcast.
Your job is to prepare a fact-grounded debate prep sheet for two hosts based ONLY on the supplied evidence.

${sourcePriorityGuideline}

${hostPersonaBlock(briefHostA)}

${hostPersonaBlock(briefHostB)}

Rules:
- Do not invent facts, stats, injuries, odds, quotes, or rumors.
- Do not cite anything outside the supplied evidence.
- Every factual bullet must include evidenceRefs (pointing to the exact records from input).
- Every argument must be grounded in evidenceRefs.
- If a claim is tempting but unsupported, place it in unsafeClaims instead of using it.
- Return valid JSON only with the schema below.

SPECIFICITY REQUIREMENTS (this brief is ammunition for a debate show — generic summaries are useless):
- Mine the articleExcerpt and research highlights for EXACT numbers, dates, records, scores, contract figures, and named people. Every keyFactsContext item should carry at least one concrete number or named person.
- Capture who-said-what: if the evidence contains a striking statement, include it as a SHORT paraphrase or a quote of at most 20 words with attribution ("per <source>"). NEVER copy longer passages verbatim.
- Surface the CONFLICT: what changed, who is angry, what is at stake, what happens next. "Team is playing well" is not a fact worth writing down; "Team has won 7 of 9 since benching X, per <source>" is.
- Aim for 8-12 keyFactsContext items and 4-6 onAirTalkingPoints when the evidence supports it.

Schema:
{
  "classification": "${classification}",
  "mainAngle": "The overarching theme or angle of the debate.",
  "whyMattersNow": "Why this topic is timely and relevant to sports fans today.",
  "keyFactsContext": [
    {
      "text": "Fact/context statement (e.g. team has won 4 games in a row)",
      "evidenceRefs": [ { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat" | "research", "id": "matching-uuid-or-id" } ],
      "confidence": "high" | "medium" | "low"
    }
  ],
  "onAirTalkingPoints": [
    {
      "text": "Talking point / stat comparison for the hosts to highlight on air",
      "evidenceRefs": [ { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat" | "research", "id": "matching-uuid-or-id" } ]
    }
  ],
  "contrarianAngle": "A contrarian view or hot take that goes against the consensus.",
  "strongestDebateQuestion": "The ultimate debate question that drives the show segment.",
  "suggestedHostTake": "A recommended landing point or take for the main host.",
  "argumentForHostA": "The argument ${briefHostA.name} will make from their worldview, grounded in evidence.",
  "argumentForHostAEvidenceRefs": [ { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat" | "research", "id": "matching-uuid-or-id" } ],
  "argumentForHostB": "The argument ${briefHostB.name} will make from their worldview, grounded in evidence.",
  "argumentForHostBEvidenceRefs": [ { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat" | "research", "id": "matching-uuid-or-id" } ],
  "counterArguments": [
    {
      "host": "${briefHostA.name}" | "${briefHostB.name}",
      "claim": "Counterpoint or argument",
      "evidenceRefs": [ { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat" | "research", "id": "matching-uuid-or-id" } ]
    }
  ],
  "unsafeClaims": [
    {
      "claim": "A claim that you wanted to make but could not verify with absolute certainty in the evidence.",
      "reason": "Explanation of why it is unsafe"
    }
  ],
  "sourceIds": [
    { "type": "game" | "newsItem" | "injury" | "oddsSnapshot" | "teamStat" | "playerStat" | "research", "id": "matching-uuid-or-id" }
  ]
}`;

    const prompt = `Here is the current real-world sports topic and the supporting evidence records. Prepare the structured research brief:
${JSON.stringify(serializedEvidence, null, 2)}`;

    // Resolve LLM Provider
    const llm = getLLMProvider();
    
    let llmResult: any;
    let parseErrorCount = 0;
    let providerError = null;

    try {
      llmResult = await llm.generateStructuredOutput<any>({
        prompt,
        systemPrompt,
        temperature: 0.2,
      });
    } catch (err: any) {
      providerError = err.message;
      parseErrorCount = 1;
      console.error(`[Worker] LLM execution or JSON parsing failed for brief: ${err.message}`);
      
      await db.jobLog.update({
        where: { id: jobLog.id },
        data: {
          status: "failed",
          error: `LLM Brief Parse/Provider Error: ${err.message}`,
          output: { parseErrorCount: 1, providerError: err.message },
        },
      });
      throw err;
    }

    // 8. Validation loop
    let insertedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let rejectedClaimCount = 0;
    let unsafeClaimCount = 0;

    let missingArgumentCount = 0;
    let invalidArgumentEvidenceCount = 0;
    let emptySourceIdsCount = 0;

    const validFacts: any[] = [];
    const validStats: any[] = [];
    const validCounterArguments: any[] = [];
    const finalUnsafeClaims: any[] = [];

    const rawFacts = Array.isArray(llmResult?.keyFactsContext) 
      ? llmResult.keyFactsContext 
      : Array.isArray(llmResult?.facts) ? llmResult.facts : [];
    const rawStats = Array.isArray(llmResult?.onAirTalkingPoints) 
      ? llmResult.onAirTalkingPoints 
      : Array.isArray(llmResult?.stats) ? llmResult.stats : [];
    const rawCounterArguments = Array.isArray(llmResult?.counterArguments) ? llmResult.counterArguments : [];
    const rawUnsafeClaims = Array.isArray(llmResult?.unsafeClaims) ? llmResult.unsafeClaims : [];

    // Parse existing unsafe claims returned by LLM
    for (const uc of rawUnsafeClaims) {
      if (uc && typeof uc === "object") {
        finalUnsafeClaims.push({
          claim: uc.claim || uc.text || "Unverified claim",
          reason: uc.reason || "Hallucination risk",
        });
        unsafeClaimCount++;
      }
    }

    const rumorKeywords = /\b(reported|rumored|sources say|likely|expected|could be|might be|insider|unnamed source)\b/i;
    const hasEvidence = topicEvidenceMap.size > 0;

    const filterClaims = (list: any[], target: any[]) => {
      for (const item of list) {
        if (!item || !item.text) {
          rejectedClaimCount++;
          continue;
        }

        const itemRefs = Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [];

        if (hasEvidence) {
          // 1. Validate all evidence refs point to the topic's approved evidence packet
          const cleanRefs = itemRefs.filter((ref: any) => ref && ref.id && topicEvidenceMap.get(ref.id) === ref.type);

          if (cleanRefs.length === 0) {
            rejectedClaimCount++;
            finalUnsafeClaims.push({
              claim: item.text,
              reason: "Rejected: No valid evidence references found matching approved topic evidence IDs.",
            });
            unsafeClaimCount++;
            continue;
          }

          // Check if LLM outputted refs outside the approved packet
          const hasOutsideRefs = itemRefs.some((ref: any) => !ref || !ref.id || topicEvidenceMap.get(ref.id) !== ref.type);
          if (hasOutsideRefs) {
            rejectedClaimCount++;
            finalUnsafeClaims.push({
              claim: item.text,
              reason: "Rejected: Attempted to reference evidence IDs outside the approved TopicCandidate evidence packet.",
            });
            unsafeClaimCount++;
            continue;
          }

          if (rumorKeywords.test(item.text)) {
            rejectedClaimCount++;
            finalUnsafeClaims.push({
              claim: item.text,
              reason: "Rejected: Contains rumor or unverified keyword.",
            });
            unsafeClaimCount++;
            continue;
          }

          target.push({
            text: item.text,
            confidence: item.confidence || "high",
            evidenceRefs: cleanRefs,
          });
        } else {
          // If no evidence is stored in database, allow facts normally without ref checks
          if (rumorKeywords.test(item.text)) {
            rejectedClaimCount++;
            finalUnsafeClaims.push({
              claim: item.text,
              reason: "Rejected: Contains rumor or unverified keyword.",
            });
            unsafeClaimCount++;
            continue;
          }

          target.push({
            text: item.text,
            confidence: item.confidence || "high",
            evidenceRefs: [],
          });
        }
      }
    };

    filterClaims(rawFacts, validFacts);
    filterClaims(rawStats, validStats);

    // Validate counterArguments
    for (const ca of rawCounterArguments) {
      if (!ca || !ca.claim) {
        rejectedClaimCount++;
        continue;
      }
      const caRefs = Array.isArray(ca.evidenceRefs) ? ca.evidenceRefs : [];

      if (hasEvidence) {
        const cleanRefs = caRefs.filter((ref: any) => ref && ref.id && topicEvidenceMap.get(ref.id) === ref.type);

        if (cleanRefs.length === 0) {
          rejectedClaimCount++;
          finalUnsafeClaims.push({
            claim: ca.claim,
            reason: "Rejected CounterArgument: No valid evidence references matching approved topic evidence IDs.",
          });
          unsafeClaimCount++;
          continue;
        }

        const hasOutsideRefs = caRefs.some((ref: any) => !ref || !ref.id || topicEvidenceMap.get(ref.id) !== ref.type);
        if (hasOutsideRefs) {
          rejectedClaimCount++;
          finalUnsafeClaims.push({
            claim: ca.claim,
            reason: "Rejected CounterArgument: References evidence outside approved TopicCandidate packet.",
          });
          unsafeClaimCount++;
          continue;
        }

        if (rumorKeywords.test(ca.claim)) {
          rejectedClaimCount++;
          finalUnsafeClaims.push({
            claim: ca.claim,
            reason: "Rejected CounterArgument: Contains rumor or unverified keyword.",
          });
          unsafeClaimCount++;
          continue;
        }

        validCounterArguments.push({
          host: ca.host || briefHostA.name,
          claim: ca.claim,
          evidenceRefs: cleanRefs,
        });
      } else {
        if (rumorKeywords.test(ca.claim)) {
          rejectedClaimCount++;
          finalUnsafeClaims.push({
            claim: ca.claim,
            reason: "Rejected CounterArgument: Contains rumor or unverified keyword.",
          });
          unsafeClaimCount++;
          continue;
        }

        validCounterArguments.push({
          host: ca.host || briefHostA.name,
          claim: ca.claim,
          evidenceRefs: [],
        });
      }
    }

    // Validate Host Arguments
    const argA = llmResult?.argumentForHostA;
    const argB = llmResult?.argumentForHostB;
    const refsA = llmResult?.argumentForHostAEvidenceRefs;
    const refsB = llmResult?.argumentForHostBEvidenceRefs;

    if (!argA || typeof argA !== "string" || !argA.trim() || !argB || typeof argB !== "string" || !argB.trim()) {
      missingArgumentCount++;
      throw new Error("Brief generation failed: argumentForHostA or argumentForHostB is missing or empty.");
    }

    if (rumorKeywords.test(argA) || rumorKeywords.test(argB)) {
      invalidArgumentEvidenceCount++;
      throw new Error("Brief generation failed: Host arguments contain unverified rumor or expected keywords.");
    }

    let cleanRefsA: any[] = [];
    let cleanRefsB: any[] = [];

    if (hasEvidence) {
      if (!Array.isArray(refsA) || refsA.length === 0 || !Array.isArray(refsB) || refsB.length === 0) {
        invalidArgumentEvidenceCount++;
        throw new Error("Brief generation failed: Host arguments lack supporting evidence reference arrays.");
      }

      cleanRefsA = refsA.filter((ref: any) => ref && ref.id && topicEvidenceMap.get(ref.id) === ref.type);
      cleanRefsB = refsB.filter((ref: any) => ref && ref.id && topicEvidenceMap.get(ref.id) === ref.type);

      if (cleanRefsA.length === 0 || cleanRefsB.length === 0) {
        invalidArgumentEvidenceCount++;
        throw new Error("Brief generation failed: Host arguments lack valid evidence refs matching approved topic evidence IDs.");
      }

      // If any ref points outside the approved packet, reject
      const hasOutsideRefsA = refsA.some((ref: any) => !ref || !ref.id || topicEvidenceMap.get(ref.id) !== ref.type);
      const hasOutsideRefsB = refsB.some((ref: any) => !ref || !ref.id || topicEvidenceMap.get(ref.id) !== ref.type);
      if (hasOutsideRefsA || hasOutsideRefsB) {
        invalidArgumentEvidenceCount++;
        throw new Error("Brief generation failed: Host arguments contain evidence refs outside approved TopicCandidate packet.");
      }
    }

    // Build list of valid source IDs server-side by collecting all validated evidence refs used
    const allRefsMap = new Map<string, any>();
    for (const f of validFacts) {
      for (const ref of f.evidenceRefs) {
        allRefsMap.set(`${ref.type}:${ref.id}`, ref);
      }
    }
    for (const s of validStats) {
      for (const ref of s.evidenceRefs) {
        allRefsMap.set(`${ref.type}:${ref.id}`, ref);
      }
    }
    for (const ca of validCounterArguments) {
      for (const ref of ca.evidenceRefs) {
        allRefsMap.set(`${ref.type}:${ref.id}`, ref);
      }
    }
    for (const ref of cleanRefsA) {
      allRefsMap.set(`${ref.type}:${ref.id}`, ref);
    }
    for (const ref of cleanRefsB) {
      allRefsMap.set(`${ref.type}:${ref.id}`, ref);
    }

    let finalSourceIds = Array.from(allRefsMap.values());
    if (finalSourceIds.length === 0) {
      // Fallback for unmatched topics
      finalSourceIds = [{ type: "topic", id: topicId }];
    }

    // 8. Reject Weak Briefs
    if (validFacts.length === 0) {
      throw new Error("Brief generation failed: No valid facts remained after validation check.");
    }

    // Nullify injury and odds context if no injury/odds snapshots exist
    let injuryContext = llmResult.injuryContext || null;
    if (resolvedInjuries.length === 0) {
      injuryContext = null;
    }
    let oddsContext = llmResult.oddsContext || oddsContextFallback;
    if (resolvedOdds.length === 0 && !isBettingTopic) {
      oddsContext = null;
    }

    const briefData = {
      facts: validFacts as any,
      stats: validStats as any,
      injuryContext,
      oddsContext,
      argumentForHostA: argA.trim(),
      argumentForHostB: argB.trim(),
      counterArguments: validCounterArguments as any,
      unsafeClaims: finalUnsafeClaims as any,
      sourceIds: finalSourceIds as any,
      classification,
      mainAngle: (llmResult.mainAngle || "").trim(),
      whyMattersNow: (llmResult.whyMattersNow || "").trim(),
      keyFactsContext: validFacts as any,
      onAirTalkingPoints: validStats as any,
      contrarianAngle: (llmResult.contrarianAngle || "").trim(),
      strongestDebateQuestion: (llmResult.strongestDebateQuestion || "").trim(),
      suggestedHostTake: (llmResult.suggestedHostTake || "").trim(),
      sourceNotesUsed,
    };

    // Save ResearchBrief linked to the TopicCandidate
    if (existingBrief) {
      await db.researchBrief.update({
        where: { topicId },
        data: briefData,
      });
      updatedCount = 1;
    } else {
      await db.researchBrief.create({
        data: {
          topicId,
          ...briefData,
        },
      });
      insertedCount = 1;
    }

    // 8. Complete JobLog
    const outputObj = {
      message: "Research brief generation completed successfully.",
      topicId,
      forceRegenerate,
      insertedCount,
      updatedCount,
      skippedCount,
      rejectedClaimCount,
      unsafeClaimCount,
      invalidEvidenceCount,
      missingArgumentCount,
      invalidArgumentEvidenceCount,
      emptySourceIdsCount,
      providerError,
    };

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: outputObj,
      },
    });

    console.log(`[Worker] Research Brief complete. Inserted: ${insertedCount}, Updated: ${updatedCount}, Skipped: ${skippedCount}, Rejected Claims: ${rejectedClaimCount}, Unsafe Claims: ${unsafeClaimCount}`);
    return { success: true, insertedCount, updatedCount };
  } catch (err: any) {
    console.error(`[Worker] Research Brief generation failed:`, err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown brief generation error",
      },
    });
    throw err;
  }
}

// 5. Episode Builder Handler
async function handleEpisodeBuilding(job: Job<EpisodeBuildJobData>) {
  console.log(`[Worker] Starting Episode Build job: ID=${job.id}`);

  // Create JobLog record to monitor Episode building
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "build:episode",
      status: "running",
      input: job.data as any,
      output: {},
    },
  });

  try {
    const res = await buildEpisodeFromTopics(job.data);

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: res as any,
      },
    });

    console.log(`[Worker] Episode Build completed. Episode ID: ${res.episodeId}`);
    return res;
  } catch (err: any) {
    console.error(`[Worker] Episode Build failed:`, err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown episode build error",
      },
    });
    throw err;
  }
}

// 6. Script Generator Handler
async function handleScriptGeneration(job: Job<ScriptGenJobData>) {
  console.log(`[Worker] Starting Script Generation job: EpisodeID=${job.data.episodeId}`);

  // Create JobLog record to monitor Script generation
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "generate:script",
      status: "running",
      input: job.data as any,
      output: {},
    },
  });

  try {
    const res = await generateScriptForEpisode(job.data);

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: res as any,
      },
    });

    console.log(`[Worker] Script Generation completed. Version: ${res.version}`);
    return res;
  } catch (err: any) {
    console.error(`[Worker] Script Generation failed:`, err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown script generation error",
      },
    });
    throw err;
  }
}

async function handleFactChecking(job: Job<FactCheckJobData>) {
  const { scriptId, forceRecheck } = job.data;
  console.log(`[Worker] Starting fact-check:script job for Script ${scriptId}`);

  // Create JobLog record to monitor Fact checking
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "fact-check:script",
      status: "running",
      input: { scriptId, forceRecheck } as any,
      output: {},
    },
  });

  try {
    const res = await factCheckScript({ scriptId, forceRecheck });

    const summary = (res.summary as any) || {};
    const coverage = (res.evidenceCoverage as any) || {};
    const issues = (res.issues as any) || {};
    const errors = Array.isArray(issues.errors) ? issues.errors : [];
    const warnings = Array.isArray(issues.warnings) ? issues.warnings : [];
    const reasons = [...errors, ...warnings].map((i: any) => i.reason || JSON.stringify(i));

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: {
          finalStatus: res.status,
          deterministicPassed: summary.deterministicPassed,
          semanticStatus: summary.semanticStatus,
          factualLineCount: coverage.factualLineCount || 0,
          factualLineWithValidEvidenceCount: coverage.factualLineWithValidEvidenceCount || 0,
          evidenceCoveragePercent: coverage.evidenceCoveragePercent || 0,
          unsupportedClaimCount: coverage.unsupportedClaimCount || 0,
          unsafeClaimCount: coverage.unsafeClaimCount || 0,
          invalidEvidenceRefCount: coverage.invalidEvidenceRefCount || 0,
          rumorLanguageCount: coverage.rumorLanguageCount || 0,
          needsHumanReviewCount: coverage.needsHumanReviewCount || 0,
          invalidSpeakerCount: coverage.invalidSpeakerCount || 0,
          semanticUnsupportedCount: coverage.semanticUnsupportedCount || 0,
          semanticNeedsReviewCount: coverage.semanticNeedsReviewCount || 0,
          semanticInvalidEvidenceRefCount: coverage.semanticInvalidEvidenceRefCount || 0,
          semanticMisleadingCount: coverage.semanticMisleadingCount || 0,
          semanticUnsafeClaimCount: coverage.semanticUnsafeClaimCount || 0,
          issueCount: (summary.totalErrors || 0) + (summary.totalWarnings || 0),
          factCheckResultId: res.id,
          reasons,
        } as any,
      },
    });

    console.log(`[Worker] Fact Check completed. Status: ${res.status}`);
    return { success: true, factCheckResultId: res.id, status: res.status };
  } catch (err: any) {
    console.error(`[Worker] Fact Check failed:`, err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown fact check error",
        output: {
          finalStatus: "failed",
          reasons: [err.message || "Execution error"],
        } as any,
      },
    });
    throw err;
  }
}

async function handleTtsSegmentGeneration(job: Job<TtsSegmentJobData>) {
  const { scriptId, forceRegenerate, segmentRange, hostId, providerOverride } = job.data;
  console.log(`[Worker] Starting tts:generate-segments job for Script ${scriptId}`);

  // Create JobLog record to monitor TTS generation
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "tts:generate-segments",
      status: "running",
      input: { scriptId, forceRegenerate, segmentRange, hostId, providerOverride } as any,
      output: {},
    },
  });

  try {
    const res = await generateTtsSegments(job.data);

    const hasErrors = Array.isArray(res.failedLines) && res.failedLines.length > 0;
    const finalJobStatus = hasErrors ? "completed_with_errors" : "completed";

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: finalJobStatus,
        output: res as any,
      },
    });

    console.log(`[Worker] TTS segment generation completed. Status: ${finalJobStatus}`);
    return { success: true, ...res };
  } catch (err: any) {
    console.error(`[Worker] TTS segment generation failed:`, err.message);
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown TTS generation error",
        output: {
          scriptId,
          failedLines: [],
          reasons: [err.message || "Execution error"],
        } as any,
      },
    });
    throw err;
  }
}

async function handleFinalAudioStitching(job: Job<FinalAudioStitchJobData>) {
  const { scriptId } = job.data;
  console.log(`[Worker] Starting audio:stitch-final job for Script ${scriptId}`);
  try {
    const res = await stitchFinalEpisodeAudio(job.data);
    console.log(`[Worker] Final audio stitching job completed. Status: ${res.finalStatus}`);
    return { success: true, ...res };
  } catch (err: any) {
    console.error(`[Worker] Final audio stitching job failed:`, err.message);
    throw err;
  }
}

async function handleContentAssetGeneration(job: Job<ContentAssetJobData>) {
  const { scriptId, forceRegenerate, includeChapters, includeMarkdown, includeJson, providerOverride } = job.data;
  console.log(`[Worker] Starting content:generate-assets job for Script ${scriptId}`);

  // Create JobLog in running state
  const jobLog = await db.jobLog.create({
    data: {
      jobType: "content:generate-assets",
      status: "running",
      input: { scriptId, forceRegenerate, includeChapters, includeMarkdown, includeJson, providerOverride } as any,
      output: {},
    },
  });

  try {
    const res = await generateEpisodeContentAssets(job.data);
    const isSkipped = res.finalStatus === "skipped";

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: isSkipped ? "skipped" : "completed",
        output: res as any,
      },
    });

    console.log(`[Worker] Content asset generation completed. Status: ${isSkipped ? "skipped" : "completed"}`);
    return { success: true, ...res };
  } catch (err: any) {
    console.error(`[Worker] Content asset generation failed:`, err.message);

    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "failed",
        error: err.message || "Unknown content asset generation error",
        output: {
          scriptId,
          finalStatus: "failed",
          reasons: [err.message || "Execution error"],
        } as any,
      },
    });
    throw err;
  }
}

// Graceful Shutdown
const shutdown = async (signal: string) => {
  console.log(`[Worker] Received ${signal}. Closing queue worker...`);
  await worker.close();
  console.log("[Worker] Queue worker closed. Exiting process.");
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
