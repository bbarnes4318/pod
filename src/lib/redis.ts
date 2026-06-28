import Redis, { RedisOptions } from "ioredis";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

export const getRedisConnectionOptions = (): RedisOptions => {
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
  if (process.env.NODE_ENV === "production") {
    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    client.on("error", () => {}); // Silence connection errors
    return client;
  }

  if (!globalForRedis.redisConnection) {
    const client = new Redis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    client.on("error", () => {}); // Silence connection errors
    globalForRedis.redisConnection = client;
  }

  return globalForRedis.redisConnection;
};

export default getRedisClient;
