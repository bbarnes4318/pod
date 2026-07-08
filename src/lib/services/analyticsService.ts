// Episode analytics (Step 9b) — IAB-style download/listen tracking.
//
// PRIVACY-FIRST: we never store a raw IP or any PII. From the request we derive
//   • clientHash = sha256(ip + user-agent + daily salt), truncated — used ONLY
//     to dedup; the IP itself is dropped and never persisted.
//   • appBucket  = a coarse client label parsed from the user-agent.
//   • country    = a 2-letter ISO code, ONLY when the edge/proxy supplies a geo
//     header (Cloudflare cf-ipcountry / Vercel x-vercel-ip-country / x-geo-*).
//     No GeoIP database, no IP → location lookup on our side. Null when unknown.
//
// IAB DEDUP: a @@unique on (episodeId, clientHash, dayBucket, kind) makes the DB
// collapse repeat requests from the same client for the same episode within a
// UTC-day window (podcast apps re-requesting via HTTP Range, browser re-fetches)
// into a single counted event. The first request of the day wins; duplicates
// hit the unique constraint and are silently ignored.

import crypto from "node:crypto";
import { db } from "@/lib/db";

export type EventKind = "download" | "play";
export type EventSource = "rss" | "direct" | "player";

/** Rotating daily salt so a client hash can't be correlated across days. */
function dayBucketUtc(d = new Date()): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}
function clientHash(ip: string, ua: string, dayBucket: string): string {
  const salt = process.env.ANALYTICS_HASH_SALT || "take-machine-analytics";
  return crypto.createHash("sha256").update(`${ip}|${ua}|${dayBucket}|${salt}`).digest("hex").slice(0, 32);
}

/** Coarse client/app bucket from the user-agent — no fingerprinting. */
export function appBucketForUa(ua: string): string {
  const s = ua || "";
  if (/AppleCoreMedia|itunespodcast|Podcasts\/|iTunes/i.test(s)) return "Apple Podcasts";
  if (/Spotify/i.test(s)) return "Spotify";
  if (/Overcast/i.test(s)) return "Overcast";
  if (/Pocket ?Casts/i.test(s)) return "Pocket Casts";
  if (/Castbox/i.test(s)) return "Castbox";
  if (/Podcast ?Addict/i.test(s)) return "Podcast Addict";
  if (/Amazon ?Music|AmazonMusic/i.test(s)) return "Amazon Music";
  if (/Google|gPodder/i.test(s)) return "Google";
  if (/Android/i.test(s)) return "Android app";
  if (/iPhone|iPad|iOS/i.test(s)) return "iOS app";
  if (/Mozilla|Chrome|Safari|Firefox|Edge|Web/i.test(s)) return "Web";
  if (!s) return "Unknown";
  return "Other";
}

/** Extract privacy-safe request metadata. The raw IP is used only to compute
 *  the hash locally and is never returned or stored. */
function extractMeta(headers: Headers, dayBucket: string): { clientHash: string; country: string | null; appBucket: string } {
  const ua = headers.get("user-agent") || "";
  const fwd = headers.get("x-forwarded-for") || "";
  const ip = (fwd.split(",")[0] || "").trim() || headers.get("x-real-ip") || headers.get("x-client-ip") || "0.0.0.0";
  const rawCountry =
    headers.get("cf-ipcountry") ||
    headers.get("x-vercel-ip-country") ||
    headers.get("x-geo-country") ||
    headers.get("x-country-code") ||
    null;
  const country = rawCountry && /^[A-Za-z]{2}$/.test(rawCountry) && rawCountry.toUpperCase() !== "XX"
    ? rawCountry.toUpperCase()
    : null;
  return { clientHash: clientHash(ip, ua, dayBucket), country, appBucket: appBucketForUa(ua) };
}

/**
 * Record one download/listen event, IAB-deduped. Safe to await inline in a
 * route — never throws (a duplicate or any error is swallowed so tracking can
 * never break the audio path).
 */
export async function recordPlayEvent(params: {
  episodeId: string;
  kind: EventKind;
  source: EventSource;
  headers: Headers;
}): Promise<void> {
  try {
    const ep = await db.episode.findUnique({ where: { id: params.episodeId }, select: { ownerId: true } });
    if (!ep) return; // unknown episode — nothing to attribute
    const dayBucket = dayBucketUtc();
    const meta = extractMeta(params.headers, dayBucket);
    await db.playEvent.create({
      data: {
        episodeId: params.episodeId,
        ownerId: ep.ownerId,
        kind: params.kind,
        source: params.source,
        clientHash: meta.clientHash,
        country: meta.country,
        appBucket: meta.appBucket,
        dayBucket,
      },
    });
  } catch {
    // Unique-constraint hit = an IAB duplicate within the window → ignore.
    // Any other error must not affect the audio response either.
  }
}

/* ------------------------------------------------------------------ */
/* Owner-scoped aggregation for the analytics view.                    */
/* ------------------------------------------------------------------ */

export interface AnalyticsSummary {
  totalDownloads: number;
  totalPlays: number;
  episodeCount: number;
  daily: { date: string; downloads: number; plays: number }[];
  byEpisode: { episodeId: string; title: string; downloads: number; plays: number; publishedAt: string | null }[];
  byCountry: { country: string; count: number }[];
  byApp: { app: string; count: number }[];
  rangeDays: number;
}

/**
 * All analytics for ONE owner, scoped server-side to episodes they own. Returns
 * real counts only — an owner with no events gets zeros, never fabricated data.
 */
export async function getOwnerAnalytics(ownerId: string, opts?: { days?: number }): Promise<AnalyticsSummary> {
  const days = Math.min(365, Math.max(7, opts?.days ?? 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Owner's episodes are the only rows we ever read events for.
  const episodes = await db.episode.findMany({
    where: { ownerId },
    select: { id: true, title: true, publishedAt: true },
  });
  const epIds = episodes.map((e) => e.id);
  const titleById = new Map(episodes.map((e) => [e.id, e.title]));
  const publishedById = new Map(episodes.map((e) => [e.id, e.publishedAt ? e.publishedAt.toISOString() : null]));

  const empty: AnalyticsSummary = {
    totalDownloads: 0, totalPlays: 0, episodeCount: episodes.length,
    daily: [], byEpisode: [], byCountry: [], byApp: [], rangeDays: days,
  };
  if (epIds.length === 0) return empty;

  const events = await db.playEvent.findMany({
    where: { episodeId: { in: epIds }, at: { gte: since } },
    select: { episodeId: true, kind: true, country: true, appBucket: true, dayBucket: true },
  });

  // Daily series (fill every day in range so the chart has no gaps).
  const dailyMap = new Map<string, { downloads: number; plays: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    dailyMap.set(d, { downloads: 0, plays: 0 });
  }
  const epAgg = new Map<string, { downloads: number; plays: number }>();
  const countryAgg = new Map<string, number>();
  const appAgg = new Map<string, number>();
  let totalDownloads = 0;
  let totalPlays = 0;

  for (const ev of events) {
    const isDl = ev.kind === "download";
    if (isDl) totalDownloads++; else totalPlays++;
    const day = dailyMap.get(ev.dayBucket);
    if (day) { if (isDl) day.downloads++; else day.plays++; }
    const ep = epAgg.get(ev.episodeId) ?? { downloads: 0, plays: 0 };
    if (isDl) ep.downloads++; else ep.plays++;
    epAgg.set(ev.episodeId, ep);
    const c = ev.country || "Unknown";
    countryAgg.set(c, (countryAgg.get(c) ?? 0) + 1);
    const a = ev.appBucket || "Unknown";
    appAgg.set(a, (appAgg.get(a) ?? 0) + 1);
  }

  return {
    totalDownloads,
    totalPlays,
    episodeCount: episodes.length,
    rangeDays: days,
    daily: [...dailyMap.entries()].map(([date, v]) => ({ date, ...v })),
    byEpisode: [...epAgg.entries()]
      .map(([episodeId, v]) => ({ episodeId, title: titleById.get(episodeId) || "Untitled", publishedAt: publishedById.get(episodeId) ?? null, ...v }))
      .sort((a, b) => b.downloads + b.plays - (a.downloads + a.plays)),
    byCountry: [...countryAgg.entries()].map(([country, count]) => ({ country, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    byApp: [...appAgg.entries()].map(([app, count]) => ({ app, count })).sort((a, b) => b.count - a.count),
  };
}
