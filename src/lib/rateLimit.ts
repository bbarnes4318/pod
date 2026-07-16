// Server-side rate limiting for expensive/abusable admin operations.
//
// Redis-backed because the app already runs Redis (BullMQ/ioredis) and web runs
// as more than one process in production — a process-local counter would give
// each instance its own quota and silently multiply the real limit.
//
// FAIL-SAFE, NEVER HANG. The shared ioredis client is configured with
// `maxRetriesPerRequest: null` (BullMQ requires it), which means a command
// issued while Redis is unreachable is queued and retried FOREVER — it never
// resolves and never rejects. An unbounded INCR here would therefore hang the
// admin request instead of limiting it. (That exact failure mode already cost
// this project: the /admin layout's Redis status probe hung every render.) So
// every call is raced against a short timeout, and a limiter that cannot answer
// in time ALLOWS the request and says so.
//
// Allowing on failure is the deliberate choice for THIS surface: these limits
// exist to stop an authenticated operator from hammering outbound fetches by
// accident, not to hold a security boundary. Authorization is enforced
// separately by requireAdmin() and never depends on Redis being up.

import { getRedisClient } from "./redis";

/** A limiter that can't answer this fast is treated as unavailable. */
const REDIS_OP_TIMEOUT_MS = 1_000;

export interface RateLimitRule {
  /** Requests permitted per window. */
  limit: number;
  windowSeconds: number;
}

/** Centralized limits — one place to audit what an operator may do how often. */
export const ADMIN_RATE_LIMITS = {
  /** Creating editorial topics by hand. */
  customTopicCreate: { limit: 20, windowSeconds: 60 },
  /** Ingestion requests (each may carry up to MAX_URLS_PER_REQUEST urls). */
  sourceImport: { limit: 10, windowSeconds: 60 },
  /** Outbound article fetches, counted per URL — the real cost driver. */
  sourceFetch: { limit: 40, windowSeconds: 60 },
  /** Research enqueues. */
  researchEnqueue: { limit: 20, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitKind = keyof typeof ADMIN_RATE_LIMITS;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. Only meaningful when !allowed. */
  retryAfterSeconds: number;
  /** True when the limiter couldn't be consulted and the request was let through. */
  degraded: boolean;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const bail = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([p, bail]).finally(() => clearTimeout(timer)) as Promise<T | null>;
}

/**
 * Consume one unit against `kind` for `identity`.
 *
 * Fixed-window counter: INCR + EXPIRE. Coarser than a sliding window, but it is
 * two commands and cannot drift — appropriate for "stop an operator melting the
 * fetcher", which is what these limits are for.
 */
export async function consumeRateLimit(
  kind: RateLimitKind,
  identity: string,
  opts: { cost?: number; redis?: { incrby: (k: string, n: number) => Promise<number>; expire: (k: string, s: number) => Promise<unknown>; ttl: (k: string) => Promise<number> } } = {}
): Promise<RateLimitResult> {
  const rule = ADMIN_RATE_LIMITS[kind];
  const cost = Math.max(1, opts.cost ?? 1);
  const window = rule.windowSeconds;
  // Bucket the key by window so an abandoned counter expires on its own even if
  // EXPIRE never landed.
  const bucket = Math.floor(Date.now() / 1000 / window);
  const key = `ratelimit:${kind}:${identity}:${bucket}`;

  try {
    const redis = opts.redis ?? (getRedisClient() as unknown as NonNullable<typeof opts.redis>);
    const count = await withTimeout(redis.incrby(key, cost), REDIS_OP_TIMEOUT_MS);
    if (count === null) {
      // Redis is unreachable or too slow. Do NOT wait on it.
      return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0, degraded: true };
    }
    // Best-effort TTL; if it doesn't land, the bucketed key still rolls over.
    void withTimeout(Promise.resolve(redis.expire(key, window + 1)), REDIS_OP_TIMEOUT_MS).catch(() => {});

    if (count > rule.limit) {
      const elapsed = Math.floor(Date.now() / 1000) % window;
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, window - elapsed), degraded: false };
    }
    return { allowed: true, remaining: Math.max(0, rule.limit - count), retryAfterSeconds: 0, degraded: false };
  } catch {
    // A limiter that throws must not take the operator's request down with it.
    return { allowed: true, remaining: rule.limit, retryAfterSeconds: 0, degraded: true };
  }
}

/** Operator-facing copy for a refusal. Mentions no infrastructure. */
export function rateLimitMessage(kind: RateLimitKind, retryAfterSeconds: number): string {
  const what =
    kind === "customTopicCreate" ? "created too many topics" :
    kind === "sourceImport" ? "imported sources too many times" :
    kind === "sourceFetch" ? "fetched too many source URLs" :
    "queued research too many times";
  return `You've ${what} in a short period. Try again in ${retryAfterSeconds}s.`;
}
