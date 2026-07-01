import Redis, { RedisOptions } from "ioredis";
import { getRedisUrl } from "./env";

export const getRedisConnectionOptions = (): RedisOptions => {
  const redisUrl = getRedisUrl();
  try {
    const urlObj = new URL(redisUrl);
    return {
      host: urlObj.hostname || "localhost",
      port: urlObj.port ? parseInt(urlObj.port) : 6379,
      username: urlObj.username || undefined,
      password: urlObj.password || undefined,
      maxRetriesPerRequest: null, // Required by BullMQ
      enableReadyCheck: false,
    };
  } catch {
    // Fallback if URL parsing fails
    return {
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
};

const globalForRedis = globalThis as unknown as {
  redisConnection: Redis | undefined;
};

export const getRedisClient = (): Redis => {
  const redisUrl = getRedisUrl();
  if (process.env.NODE_ENV === "production") {
    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    client.on("error", (err: any) => {
      if (err.message && err.message.includes("NOAUTH")) {
        console.error("[Redis] Authentication failed! The Redis password or URL configured in REDIS_URL is invalid or missing credentials.");
      }
    });
    return client;
  }

  if (!globalForRedis.redisConnection) {
    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    client.on("error", (err: any) => {
      if (err.message && err.message.includes("NOAUTH")) {
        console.error("[Redis] Authentication failed! The Redis password or URL configured in REDIS_URL is invalid or missing credentials.");
      }
    });
    globalForRedis.redisConnection = client;
  }

  return globalForRedis.redisConnection;
};

export default getRedisClient;
