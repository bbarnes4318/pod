import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPodcastConfig, generateRssXml, type PodcastConfig } from "@/lib/services/rssFeedService";

export const dynamic = "force-dynamic";

// Per-podcast RSS feed. Stable, shareable URL: /rss/<podcastId> (the podcast's
// uuid never changes), and per-owner because every Podcast row has an ownerId.
// The channel metadata is the show's own name; anything the Podcast model
// doesn't carry (image, owner email, site) falls back to the env-level show
// config so the feed stays spec-valid. Reuses the same generateRssXml the
// global feed uses.
export async function GET(_req: Request, ctx: { params: Promise<{ podcastId: string }> }) {
  const { podcastId } = await ctx.params;

  const podcast = await db.podcast.findUnique({
    where: { id: podcastId },
    select: { id: true, name: true, verticals: true, ownerUser: { select: { name: true, email: true } } },
  });
  if (!podcast) {
    return new NextResponse("Not Found: unknown podcast", { status: 404, headers: { "Content-Type": "text/plain" } });
  }

  const env = getPodcastConfig();
  const siteUrl = env.siteUrl || process.env.AUTH_URL || "";
  const config: PodcastConfig = {
    ...env,
    title: podcast.name || env.title || "Take Machine",
    description: env.description || `${podcast.name} — sports takes from Take Machine.`,
    author: podcast.ownerUser?.name || env.author || "Take Machine",
    ownerName: podcast.ownerUser?.name || env.ownerName || "",
    ownerEmail: podcast.ownerUser?.email || env.ownerEmail || "",
    siteUrl,
    rssUrl: `${siteUrl}/rss/${podcast.id}`,
    imageUrl: env.imageUrl || "",
    category: env.category || "Sports",
  };

  try {
    const episodes = await db.episode.findMany({
      where: { podcastId: podcast.id, status: "published", publishedAt: { not: null } },
      orderBy: { publishedAt: "desc" },
    });

    // Only items with everything a spec-valid enclosure/item needs.
    const valid = episodes.filter(
      (ep) =>
        ep.title?.trim() &&
        ep.audioUrl?.trim() &&
        ep.durationSeconds &&
        ep.durationSeconds > 0 &&
        ep.rssGuid?.trim() &&
        ep.audioFileSizeBytes &&
        ep.audioFileSizeBytes > 0 &&
        ep.audioMimeType?.trim() &&
        ((ep.rssSummary && ep.rssSummary.trim()) || (ep.description && ep.description.trim()) || (ep.longShowNotes && ep.longShowNotes.trim()))
    );

    const xml = generateRssXml(valid, config, false);
    return new NextResponse(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, no-cache, no-transform",
      },
    });
  } catch (err: any) {
    return new NextResponse(`Internal Server Error: ${err.message}`, { status: 500, headers: { "Content-Type": "text/plain" } });
  }
}
