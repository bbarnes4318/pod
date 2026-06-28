// Standalone Queue Worker for Take Machine
import "dotenv/config";
import { Worker, Job } from "bullmq";
import { getRedisClient } from "../redis";
import { db } from "../db";
import { getSportsDataProvider } from "../providers/sports/factory";
import { getLLMProvider } from "../providers/llm/factory";
import { JobData, IngestJobData, TopicGenJobData } from "./podcastQueue";

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
    } else if (job.name === "generate:topics") {
      return handleTopicGeneration(job as Job<TopicGenJobData>);
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

    // 4. Formulate LLM prompts matching debate profiles
    const systemPrompt = `You are the Topic Engine for Take Machine, an AI sports debate podcast.
Your job is to find sports topics that will create strong disagreement between two AI hosts:

Max Voltage:
- Loud, emotional, sarcastic, fan-first.
- Legacy/pressure/results-driven, hates excuses, hot seat enthusiast.
- Loves clutch moments, playoff drama, collapses, and fraud-watch teams.

Dr. Linebreak:
- Calm, arrogant, analytics-first.
- Uses stats, odds, efficiency indices, injury context, market movement, and roster construction.
- Hates lazy narratives, small-sample overreactions, box-score scouting, and fan emotions.

Rules:
- Do not invent facts, injuries, odds, stats, quotes, or rumors.
- Every topic must directly link to the supplied evidence records.
- Do not copy full copyrighted article summaries or texts.
- If evidence is weak, lower scores. Prefer argument potential over boring facts.

You must return a JSON object containing a 'topics' array of 10-20 candidates.
Schema for each topic candidate in the array:
{
  "title": "A short punchy sports-radio style question",
  "sport": "Football | Basketball | Baseball | Combat Sports | etc.",
  "leagueId": "NFL | NBA | MLB | NCAAF | NCAAB | MMA",
  "summary": "One-paragraph summary explaining the debate angle",
  "whyFansCare": "A brief sentence why fans will click",
  "whyMaxVoltageWillAgree": "Why Max Voltage will have a strong legacy/emotional stance",
  "whyDrLinebreakWillDisagree": "Why Dr. Linebreak will contradict him using data/context",
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

// Graceful Shutdown
const shutdown = async (signal: string) => {
  console.log(`[Worker] Received ${signal}. Closing queue worker...`);
  await worker.close();
  console.log("[Worker] Queue worker closed. Exiting process.");
  process.exit(0);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
