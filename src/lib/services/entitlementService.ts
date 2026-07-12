// Entitlements + usage metering (Step 9c). One place that answers "what can this
// account do, and how much has it used this period?" — enforced server-side at
// the real generation/feature entrypoints, never UI-only.
//
// Metering is REAL: episode usage is counted from actual Episode rows the owner
// created this calendar month (no fabricated numbers, no separate counter to
// drift). The plan comes from User.plan (the billing-webhook target). NO payment
// processor is touched anywhere in this file.

import { db } from "@/lib/db";
import { planFor, isPlanId, isPremiumTtsProvider, OWNER_PLAN, type PlanConfig, type PlanId, DEFAULT_PLAN } from "@/lib/plans";

/** First instant of the current calendar month (UTC) — the metering period. */
function periodStart(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function periodLabel(d = new Date()): string {
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Emails granted owner entitlements without a role change: OWNER_EMAILS is a
 *  comma-separated, case-insensitive env list, set on BOTH the web and worker
 *  environments (the recurring scheduler meters owners on the worker). */
function ownerEmails(): string[] {
  return (process.env.OWNER_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** The account that owns/operates the app: ADMIN role, or listed in
 *  OWNER_EMAILS. Owner accounts get OWNER_PLAN (no caps, all features) from
 *  getUserPlan, so every gate below passes for them — while the tier ladder
 *  and its server-side enforcement stay fully intact for everyone else. */
export function isOwnerAccount(user: { role?: string | null; email?: string | null }): boolean {
  if (user.role === "ADMIN") return true;
  const email = user.email?.trim().toLowerCase();
  return !!email && ownerEmails().includes(email);
}

export async function getUserPlan(userId: string): Promise<PlanConfig> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { plan: true, role: true, email: true },
  });
  // Owner/admin bypass — the operator's own account is never plan-limited.
  if (user && isOwnerAccount(user)) return OWNER_PLAN;
  return planFor(user?.plan);
}

export interface EpisodeUsage {
  used: number;
  limit: number | null; // null = unlimited
  remaining: number | null;
  periodStart: string;
  periodLabel: string;
}

/** Episodes the owner has GENERATED this month, counted from real Episode rows. */
export async function getEpisodeUsage(userId: string, plan?: PlanConfig): Promise<EpisodeUsage> {
  const p = plan ?? (await getUserPlan(userId));
  const start = periodStart();
  const used = await db.episode.count({ where: { ownerId: userId, createdAt: { gte: start } } });
  const limit = p.maxEpisodesPerMonth;
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    periodStart: start.toISOString(),
    periodLabel: periodLabel(),
  };
}

export type Allow = { ok: true } | { ok: false; error: string; upgrade: true };

/**
 * The metered gate for the expensive action (episode generation). Blocks a
 * Free/Creator account that has hit its monthly cap with a clear upgrade
 * message. Called at the generation entrypoints — server-enforced.
 */
export async function assertCanCreateEpisode(userId: string): Promise<Allow> {
  const plan = await getUserPlan(userId);
  const usage = await getEpisodeUsage(userId, plan);
  if (usage.limit !== null && usage.used >= usage.limit) {
    return {
      ok: false,
      upgrade: true,
      error: `You've used all ${usage.limit} episodes on the ${plan.name} plan this month (resets ${nextResetLabel()}). Upgrade to keep creating.`,
    };
  }
  return { ok: true };
}

/** Premium TTS engines require a premium-voices plan. Enforced where a provider
 *  override reaches generation. */
export async function assertPremiumVoiceAllowed(userId: string, provider?: string | null): Promise<Allow> {
  if (!isPremiumTtsProvider(provider)) return { ok: true }; // stub/openai are free
  const plan = await getUserPlan(userId);
  if (plan.premiumVoices) return { ok: true };
  return {
    ok: false,
    upgrade: true,
    error: `Premium voices (${provider}) are a Creator feature. Upgrade to use them, or pick a standard voice.`,
  };
}

/** Podcast (show) count cap. Enforced when creating a new podcast. */
export async function assertCanCreatePodcast(userId: string): Promise<Allow> {
  const plan = await getUserPlan(userId);
  if (plan.maxPodcasts === null) return { ok: true };
  const owned = await db.podcast.count({ where: { ownerId: userId } });
  if (owned >= plan.maxPodcasts) {
    return {
      ok: false,
      upgrade: true,
      error: `The ${plan.name} plan includes ${plan.maxPodcasts} podcast${plan.maxPodcasts === 1 ? "" : "s"}. Upgrade for more.`,
    };
  }
  return { ok: true };
}

function nextResetLabel(): string {
  const d = new Date();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Full entitlement + usage snapshot for the pricing/plan UI. All real. */
export async function getEntitlementSummary(userId: string) {
  const plan = await getUserPlan(userId);
  const [usage, podcastCount] = await Promise.all([
    getEpisodeUsage(userId, plan),
    db.podcast.count({ where: { ownerId: userId } }),
  ]);
  return { plan, usage, podcastCount };
}

/**
 * Set an account's plan — the manual/admin tier control (and the exact write a
 * future billing webhook would perform). No charge, no processor.
 */
export async function setUserPlanId(userId: string, plan: string): Promise<{ ok: boolean; error?: string }> {
  if (!isPlanId(plan)) return { ok: false, error: "Unknown plan." };
  await db.user.update({ where: { id: userId }, data: { plan } });
  return { ok: true };
}

export { DEFAULT_PLAN };
