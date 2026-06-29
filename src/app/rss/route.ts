import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPodcastConfig, validatePodcastConfig, generateRssXml } from "@/lib/services/rssFeedService";

export const dynamic = "force-dynamic";

export async function GET() {
  const config = getPodcastConfig();
  const missingKeys = validatePodcastConfig(config);

  if (missingKeys.length > 0) {
    return new NextResponse(
      `Internal Server Error: Missing required podcast configuration keys: ${missingKeys.join(", ")}`,
      {
        status: 500,
        headers: { "Content-Type": "text/plain" },
      }
    );
  }

  try {
    const episodes = await db.episode.findMany({
      where: {
        status: "published",
        publishedAt: { not: null },
      },
      orderBy: { publishedAt: "desc" },
    });

    const validEpisodes = episodes.filter((ep) => {
      return (
        ep.title &&
        ep.audioUrl &&
        ep.durationSeconds &&
        ep.durationSeconds > 0 &&
        ep.rssGuid &&
        ep.publishedAt &&
        ep.audioFileSizeBytes &&
        ep.audioFileSizeBytes > 0 &&
        (ep.rssSummary || ep.description || ep.longShowNotes)
      );
    });

    const xml = generateRssXml(validEpisodes, config, false);

    return new NextResponse(xml, {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, no-cache, no-transform",
      },
    });
  } catch (err: any) {
    return new NextResponse(`Internal Server Error: ${err.message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
