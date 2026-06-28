// Standalone Queue Worker for Take Machine
import "dotenv/config";
import { Worker, Job } from "bullmq";
import { getRedisClient } from "../redis";
import { db } from "../db";
import { getSportsDataProvider } from "../providers/sports/factory";
import { JobData, IngestJobData } from "./podcastQueue";

const QUEUE_NAME = "podcast-generation";

console.log("--------------------------------------------------");
console.log("TAKE MACHINE WORKER - INITIALIZING");
console.log(`Redis Connection: ${process.env.REDIS_URL || "redis://localhost:6379"}`);
console.log(`Queue Name: ${QUEUE_NAME}`);
console.log("--------------------------------------------------");

// Initialize BullMQ Worker
const worker = new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    if (job.name === "ingest:sports-data") {
      return handleSportsIngestion(job as Job<IngestJobData>);
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
      console.log("[Worker] Stage: Generating debate script for Max Voltage and Dr. Linebreak...");
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
    let gamesCount = 0;
    let newsCount = 0;
    let oddsCount = 0;
    let injuriesCount = 0;
    let statsCount = 0;

    if (providerType.toLowerCase() === "rss-news") {
      // Ingest News items from RSS feeds
      const newsItems = await provider.getNews(leagueId);
      for (const item of newsItems) {
        // Unique deterministic ID based on RSS feed link to avoid duplicates
        const idKey = `rss:${item.url}`;
        await db.newsItem.upsert({
          where: { id: idKey },
          update: {
            title: item.title,
            publishedAt: item.publishedAt,
            summary: item.summary,
            entities: item.entities,
            raw: item.raw,
          },
          create: {
            id: idKey,
            title: item.title,
            source: item.source,
            url: item.url,
            publishedAt: item.publishedAt,
            summary: item.summary,
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
          const teamIdStr = `sio:${leagueId.toLowerCase()}:${item.TeamID}`;
          await db.team.upsert({
            where: { id: teamIdStr },
            update: {
              name: item.Name,
              city: item.City,
              abbreviation: item.Key,
            },
            create: {
              id: teamIdStr,
              leagueId: leagueId.toUpperCase(),
              name: item.Name,
              city: item.City,
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
          const gameIdStr = `sio:${leagueId.toLowerCase()}:${game.GameID}`;
          const homeTeamIdStr = `sio:${leagueId.toLowerCase()}:${game.HomeTeamID}`;
          const awayTeamIdStr = `sio:${leagueId.toLowerCase()}:${game.AwayTeamID}`;

          // Ensure teams exist in DB
          await db.team.upsert({
            where: { id: homeTeamIdStr },
            update: {},
            create: {
              id: homeTeamIdStr,
              leagueId: leagueId.toUpperCase(),
              name: game.HomeTeam || "Home Team",
              city: "",
              abbreviation: game.HomeTeam || "HOME",
              slug: `${leagueId.toLowerCase()}-${(game.HomeTeam || "HOME").toLowerCase()}-${game.HomeTeamID}`,
            },
          });
          await db.team.upsert({
            where: { id: awayTeamIdStr },
            update: {},
            create: {
              id: awayTeamIdStr,
              leagueId: leagueId.toUpperCase(),
              name: game.AwayTeam || "Away Team",
              city: "",
              abbreviation: game.AwayTeam || "AWAY",
              slug: `${leagueId.toLowerCase()}-${(game.AwayTeam || "AWAY").toLowerCase()}-${game.AwayTeamID}`,
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
          const newsIdStr = `sio:${leagueId.toLowerCase()}:${item.NewsID}`;
          await db.newsItem.upsert({
            where: { id: newsIdStr },
            update: {
              title: item.Title,
              publishedAt: item.Updated ? new Date(item.Updated) : new Date(),
              summary: item.Content,
              raw: item,
            },
            create: {
              id: newsIdStr,
              title: item.Title,
              source: item.Source || "SportsDataIO",
              url: item.Url || "",
              publishedAt: item.Updated ? new Date(item.Updated) : new Date(),
              summary: item.Content,
              entities: [],
              raw: item,
            },
          });
          newsCount++;
        }
      } catch (err: any) {
        console.warn(`[Worker] News ingestion skipped or failed: ${err.message}`);
      }

      // 4. Injuries Ingestion
      try {
        const injuries = await provider.getInjuries(leagueId);
        for (const injury of injuries) {
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
        console.warn(`[Worker] Injuries ingestion skipped or failed: ${err.message}`);
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
    };

    // Update JobLog on completion
    await db.jobLog.update({
      where: { id: jobLog.id },
      data: {
        status: "completed",
        output: outputObj,
      },
    });

    console.log(`[Worker] Ingestion completed. Stats: games=${gamesCount}, news=${newsCount}, odds=${oddsCount}`);
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

// Graceful Shutdown
const shutdown = async (signal: string) => {
  console.log(`[Worker] Received ${signal}. Closing queue worker...`);
  await worker.close();
  console.log("[Worker] Queue worker closed. Exiting process.");
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
