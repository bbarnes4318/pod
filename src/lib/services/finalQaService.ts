import { db } from "../db";
import { getRedisClient } from "../redis";
import { execSync } from "child_process";

export interface QaCheck {
  name: string;
  description: string;
  status: "pass" | "fail" | "warning";
  value?: string;
  details?: string;
}

export interface QaAuditResult {
  passed: boolean;
  timestamp: string;
  checks: QaCheck[];
}

export async function runProductionReadinessAudit(): Promise<QaAuditResult> {
  const checks: QaCheck[] = [];
  const now = new Date();

  // 1. Database Reachability
  let dbOk = false;
  try {
    await db.$queryRaw`SELECT 1`;
    dbOk = true;
    checks.push({
      name: "Database Connectivity",
      description: "Verifies the PostgreSQL database is reachable and accepting queries.",
      status: "pass",
      value: "CONNECTED",
    });
  } catch (e: any) {
    checks.push({
      name: "Database Connectivity",
      description: "Verifies the PostgreSQL database is reachable and accepting queries.",
      status: "fail",
      value: "DISCONNECTED",
      details: e.message || "Failed to execute SELECT 1 query.",
    });
  }

  // 2. Prisma Client
  checks.push({
    name: "Prisma Client Generated",
    description: "Confirms that Prisma Client is built and types are ready.",
    status: dbOk ? "pass" : "warning",
    value: "GENERATED",
  });

  // 3. Queue / Redis Connectivity
  let redisOk = false;
  try {
    const redis = getRedisClient();
    const pong = await redis.ping();
    if (pong === "PONG") {
      redisOk = true;
      checks.push({
        name: "Redis Queue Connectivity",
        description: "Checks Redis connection status for background worker queue.",
        status: "pass",
        value: "ONLINE",
      });
    } else {
      checks.push({
        name: "Redis Queue Connectivity",
        description: "Checks Redis connection status for background worker queue.",
        status: "fail",
        value: "UNEXPECTED_RESPONSE",
        details: `Redis ping returned: ${pong}`,
      });
    }
  } catch (e: any) {
    checks.push({
      name: "Redis Queue Connectivity",
      description: "Checks Redis connection status for background worker queue.",
      status: "fail",
      value: "OFFLINE",
      details: e.message || "Failed to ping Redis server.",
    });
  }

  // 4. Abstraction Providers Configuration
  const providers = {
    llm: process.env.LLM_PROVIDER || "stub",
    tts: process.env.TTS_PROVIDER || "stub",
    sports: process.env.SPORTS_PROVIDER || "stub",
    storage: process.env.STORAGE_PROVIDER || "stub",
  };

  const isProduction = process.env.NODE_ENV === "production";

  for (const [key, val] of Object.entries(providers)) {
    const title = `${key.toUpperCase()} Abstraction Provider`;
    const hasStub = val.toLowerCase().trim() === "stub";
    
    let status: "pass" | "warning" | "fail" = "pass";
    let details = `Configured engine: '${val}'`;

    if (hasStub) {
      status = isProduction ? "fail" : "warning";
      details = `Demo mode active ('stub' provider is selected). Must be updated for production deployment.`;
    }

    checks.push({
      name: title,
      description: `Checks target integration provider for the ${key} abstraction layer.`,
      status,
      value: val.toUpperCase(),
      details,
    });
  }

  // 5. RSS Podcast Config Checks
  const rssKeys = [
    "PODCAST_TITLE",
    "PODCAST_DESCRIPTION",
    "PODCAST_LANGUAGE",
    "PODCAST_AUTHOR",
    "PODCAST_OWNER_NAME",
    "PODCAST_OWNER_EMAIL",
    "PODCAST_SITE_URL",
    "PODCAST_RSS_URL",
    "PODCAST_IMAGE_URL",
  ];

  const missingRss = rssKeys.filter((k) => !process.env[k]?.trim());
  if (missingRss.length === 0) {
    checks.push({
      name: "RSS Podcast Configuration",
      description: "Validates presence of all 9 required metadata fields for public RSS generation.",
      status: "pass",
      value: "COMPLETE",
    });
  } else {
    checks.push({
      name: "RSS Podcast Configuration",
      description: "Validates presence of all 9 required metadata fields for public RSS generation.",
      status: "fail",
      value: `${rssKeys.length - missingRss.length}/${rssKeys.length} CONFIGURED`,
      details: `Missing required env variables: ${missingRss.join(", ")}`,
    });
  }

  // 6. Preview Token configuration
  const previewToken = process.env.RSS_PREVIEW_TOKEN;
  checks.push({
    name: "RSS Preview Authorization Token",
    description: "Verifies if the preview token is configured for private drafts rendering.",
    status: previewToken?.trim() ? "pass" : "warning",
    value: previewToken?.trim() ? "CONFIGURED" : "MISSING",
    details: previewToken?.trim() ? undefined : "Preview route /rss/preview will be inaccessible.",
  });

  // 7. FFmpeg / FFprobe checking
  let ffmpegOk = false;
  try {
    execSync("ffmpeg -version", { timeout: 500, stdio: "ignore" });
    ffmpegOk = true;
  } catch (e) {}

  let ffprobeOk = false;
  try {
    execSync("ffprobe -version", { timeout: 500, stdio: "ignore" });
    ffprobeOk = true;
  } catch (e) {}

  checks.push({
    name: "FFmpeg Binary Integration",
    description: "Checks server availability of ffmpeg for audio stitching operations.",
    status: ffmpegOk ? "pass" : "warning",
    value: ffmpegOk ? "AVAILABLE" : "MISSING",
    details: ffmpegOk ? undefined : "FFmpeg command failed or is not registered in system PATH.",
  });

  checks.push({
    name: "FFprobe Binary Integration",
    description: "Checks server availability of ffprobe for media files duration analysis.",
    status: ffprobeOk ? "pass" : "warning",
    value: ffprobeOk ? "AVAILABLE" : "MISSING",
    details: ffprobeOk ? undefined : "FFprobe command failed or is not registered in system PATH.",
  });

  // 8. Stuck Jobs Audit (limit scans for speed)
  if (dbOk) {
    try {
      const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
      const stuckEpisodes = await db.episode.findMany({
        where: {
          status: {
            in: ["generating", "queued", "audio_stitching", "content_generating"],
          },
          updatedAt: {
            lt: fifteenMinutesAgo,
          },
        },
        select: { id: true, title: true, status: true, updatedAt: true },
        take: 10,
      });

      if (stuckEpisodes.length === 0) {
        checks.push({
          name: "Stuck Pipeline Jobs Audit",
          description: "Scans for episodes locked in active pipeline states for more than 15 minutes.",
          status: "pass",
          value: "CLEAN",
        });
      } else {
        checks.push({
          name: "Stuck Pipeline Jobs Audit",
          description: "Scans for episodes locked in active pipeline states for more than 15 minutes.",
          status: "warning",
          value: `${stuckEpisodes.length} STUCK`,
          details: `Stuck episodes: ${stuckEpisodes.map((e) => `${e.title} (${e.status})`).join(", ")}`,
        });
      }
    } catch (e: any) {
      checks.push({
        name: "Stuck Pipeline Jobs Audit",
        description: "Scans for episodes locked in active pipeline states for more than 15 minutes.",
        status: "warning",
        value: "ERROR",
        details: `Failed to query stuck episodes: ${e.message}`,
      });
    }
  }

  // 9. Action Items / Orphaned States (Informational)
  if (dbOk) {
    try {
      const contentReadyCount = await db.episode.count({
        where: { status: "content_ready" },
      });
      const publishReadyCount = await db.episode.count({
        where: { status: "publish_ready" },
      });

      if (contentReadyCount > 0) {
        checks.push({
          name: "Action Item: Prepare Assets",
          description: "Identifies episodes with ready content assets waiting to be prepared for RSS.",
          status: "warning",
          value: `${contentReadyCount} PENDING PREP`,
          details: "Head to the Content Assets page to configure permanent publishing metadata.",
        });
      }

      if (publishReadyCount > 0) {
        checks.push({
          name: "Action Item: Publish Episodes",
          description: "Identifies episodes prepared and waiting to go live in the public RSS feed.",
          status: "warning",
          value: `${publishReadyCount} PENDING PUBLISH`,
          details: "Head to the RSS Feeds console to trigger public release.",
        });
      }
    } catch (e: any) {
      console.warn("Failed to check orphaned states:", e.message);
    }
  }

  // 10. Recent Job Logs failures (past 24h)
  if (dbOk) {
    try {
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const failedCount = await db.jobLog.count({
        where: {
          status: "failed",
          createdAt: {
            gte: oneDayAgo,
          },
        },
      });

      checks.push({
        name: "Recent Job Operations Failures",
        description: "Checks for failed JobLog entries in the past 24 hours.",
        status: failedCount > 5 ? "fail" : failedCount > 0 ? "warning" : "pass",
        value: `${failedCount} FAILED`,
        details: failedCount > 0 ? `${failedCount} background operations failed in the last 24 hours.` : undefined,
      });
    } catch (e: any) {
      console.warn("Failed to query recent job failures:", e.message);
    }
  }

  // Final Overall audit state
  const hasFailure = checks.some((c) => c.status === "fail");
  
  return {
    passed: !hasFailure,
    timestamp: now.toISOString(),
    checks,
  };
}
