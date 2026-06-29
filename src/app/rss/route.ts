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

    const getUsableParagraph = (notes: string | null) => {
      if (!notes) return null;
      const paragraphs = notes
        .split(/\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("*"));
      return paragraphs.length > 0 ? paragraphs[0] : null;
    };

    const validEpisodes = episodes.filter((ep) => {
      const hasDescriptionSource = 
        (ep.rssSummary && ep.rssSummary.trim()) ||
        (ep.description && ep.description.trim()) ||
        getUsableParagraph(ep.longShowNotes);

      return (
        ep.status === "published" &&
        ep.publishedAt &&
        ep.title && ep.title.trim() &&
        ep.audioUrl && ep.audioUrl.trim() &&
        ep.durationSeconds && ep.durationSeconds > 0 &&
        ep.rssGuid && ep.rssGuid.trim() &&
        ep.audioFileSizeBytes && ep.audioFileSizeBytes > 0 &&
        ep.audioMimeType && ep.audioMimeType.trim() &&
        ep.transcriptUrl && ep.transcriptUrl.trim() &&
        ep.longShowNotes && ep.longShowNotes.trim() &&
        hasDescriptionSource
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
