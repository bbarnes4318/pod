export interface PodcastConfig {
  title: string;
  description: string;
  language: string;
  author: string;
  ownerName: string;
  ownerEmail: string;
  siteUrl: string;
  rssUrl: string;
  imageUrl: string;
  category: string;
  subcategory?: string;
  explicit: boolean;
  copyright?: string;
  ttl: number;
}

export function getPodcastConfig(): PodcastConfig {
  return {
    title: process.env.PODCAST_TITLE || "",
    description: process.env.PODCAST_DESCRIPTION || "",
    language: process.env.PODCAST_LANGUAGE || "en-us",
    author: process.env.PODCAST_AUTHOR || "",
    ownerName: process.env.PODCAST_OWNER_NAME || "",
    ownerEmail: process.env.PODCAST_OWNER_EMAIL || "",
    siteUrl: process.env.PODCAST_SITE_URL || "",
    rssUrl: process.env.PODCAST_RSS_URL || "",
    imageUrl: process.env.PODCAST_IMAGE_URL || "",
    category: process.env.PODCAST_CATEGORY || "Sports",
    subcategory: process.env.PODCAST_SUBCATEGORY || "",
    explicit: process.env.PODCAST_EXPLICIT === "true",
    copyright: process.env.PODCAST_COPYRIGHT || "",
    ttl: Number(process.env.PODCAST_TTL) || 60,
  };
}

export function validatePodcastConfig(config: PodcastConfig): string[] {
  const required = [
    { key: "title", label: "PODCAST_TITLE" },
    { key: "description", label: "PODCAST_DESCRIPTION" },
    { key: "language", label: "PODCAST_LANGUAGE" },
    { key: "author", label: "PODCAST_AUTHOR" },
    { key: "ownerName", label: "PODCAST_OWNER_NAME" },
    { key: "ownerEmail", label: "PODCAST_OWNER_EMAIL" },
    { key: "siteUrl", label: "PODCAST_SITE_URL" },
    { key: "rssUrl", label: "PODCAST_RSS_URL" },
    { key: "imageUrl", label: "PODCAST_IMAGE_URL" },
  ];
  return required
    .filter((field) => !config[field.key as keyof PodcastConfig])
    .map((field) => field.label);
}

export function escapeXml(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatRssDate(date: Date | string | number): string {
  const d = new Date(date);
  return d.toUTCString();
}

export function formatItunesDuration(seconds: number): string {
  if (isNaN(seconds) || seconds <= 0) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");

  if (h > 0) {
    return `${h}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export function markdownToSafeHtml(markdown: string): string {
  if (!markdown) return "";

  // First escape ampersands, tags, etc.
  let html = escapeXml(markdown);

  // Convert headings
  html = html.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^##\s+(.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^#\s+(.+)$/gm, "<h1>$1</h1>");

  // Convert bold
  html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

  // Convert italics
  html = html.replace(/\*(.*?)\*/g, "<em>$1</em>");

  // Convert bullet points
  html = html.replace(/^\*\s+(.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>[\s\S]*?<\/li>)+/g, "<ul>$&</ul>");

  // Convert paragraphs
  const paragraphs = html.split(/\n{2,}/);
  html = paragraphs
    .map((p) => {
      const trimmed = p.trim();
      if (!trimmed) return "";
      if (
        trimmed.startsWith("<h") ||
        trimmed.startsWith("<ul") ||
        trimmed.startsWith("<li") ||
        trimmed.startsWith("<p")
      ) {
        return trimmed;
      }
      return `<p>${trimmed.replace(/\n/g, "<br />")}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  return html;
}

export function generateRssXml(episodes: any[], config: PodcastConfig, isPreview = false): string {
  const lastBuildDate = formatRssDate(new Date());

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
  xmlns:content="http://purl.org/rss/1.0/modules/content/"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(config.title)}</title>
    <link>${escapeXml(config.siteUrl)}</link>
    <description>${escapeXml(config.description)}</description>
    <language>${escapeXml(config.language)}</language>
    <copyright>${escapeXml(config.copyright || `Copyright ${new Date().getFullYear()} ${config.author}`)}</copyright>
    <managingEditor>${escapeXml(config.ownerEmail ? `${config.ownerEmail} (${config.ownerName})` : "")}</managingEditor>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <pubDate>${lastBuildDate}</pubDate>
    <ttl>${config.ttl}</ttl>
    <image>
      <url>${escapeXml(config.imageUrl)}</url>
      <title>${escapeXml(config.title)}</title>
      <link>${escapeXml(config.siteUrl)}</link>
    </image>
    <itunes:author>${escapeXml(config.author)}</itunes:author>
    <itunes:summary>${escapeXml(config.description)}</itunes:summary>
    <itunes:owner>
      <itunes:name>${escapeXml(config.ownerName)}</itunes:name>
      <itunes:email>${escapeXml(config.ownerEmail)}</itunes:email>
    </itunes:owner>
    <itunes:image href="${escapeXml(config.imageUrl)}" />
    <itunes:category text="${escapeXml(config.category)}">
      ${config.subcategory ? `<itunes:category text="${escapeXml(config.subcategory)}" />` : ""}
    </itunes:category>
    <itunes:explicit>${config.explicit ? "yes" : "no"}</itunes:explicit>
    <atom:link href="${escapeXml(isPreview ? config.rssUrl + "/preview" : config.rssUrl)}" rel="self" type="application/rss+xml" />
`;

  for (const ep of episodes) {
    const pubDate = isPreview ? (ep.publishedAt || ep.updatedAt || ep.createdAt) : ep.publishedAt;
    if (!pubDate) continue;

    if (!ep.title || !ep.title.trim()) continue;
    if (!ep.rssGuid || !ep.rssGuid.trim()) continue;
    if (!ep.audioUrl || !ep.audioUrl.trim()) continue;
    if (!ep.audioFileSizeBytes || ep.audioFileSizeBytes <= 0) continue;
    if (!ep.audioMimeType || !ep.audioMimeType.trim()) continue;
    if (!ep.durationSeconds || ep.durationSeconds <= 0) continue;

    // Grounded description resolution
    let descriptionText = "";
    if (ep.rssSummary && ep.rssSummary.trim()) {
      descriptionText = ep.rssSummary.trim();
    } else if (ep.description && ep.description.trim()) {
      descriptionText = ep.description.trim();
    } else if (ep.longShowNotes && ep.longShowNotes.trim()) {
      const paragraphs = ep.longShowNotes
        .split(/\n+/)
        .map((p: string) => p.trim())
        .filter((p: string) => p.length > 0 && !p.startsWith("#") && !p.startsWith("*"));
      if (paragraphs.length > 0) {
        descriptionText = paragraphs[0];
      }
    }

    if (!descriptionText || !descriptionText.trim()) {
      continue;
    }

    // Build show notes / content HTML
    let showNotesHtml = markdownToSafeHtml(ep.longShowNotes || "");
    if (process.env.RSS_INCLUDE_TRANSCRIPT_LINK === "true" && ep.transcriptUrl) {
      showNotesHtml += `\n<p><a href="${escapeXml(ep.transcriptUrl)}">Read the full episode transcript here</a></p>`;
    }
    showNotesHtml += `\n<p><em>Production Note: Generated by Take Machine from approved, fact-checked script assets.</em></p>`;

    const durationStr = formatItunesDuration(ep.durationSeconds || 0);
    const sizeBytes = ep.audioFileSizeBytes || 0;
    const mimeType = ep.audioMimeType || "audio/mpeg";
    // IAB tracking prefix (Step 9b): point the enclosure at our download route
    // (?src=rss) so podcast-client fetches are counted (deduped) before it
    // 302s to the real audio file. Falls back to the raw audio URL when no site
    // URL is configured, so the feed stays spec-valid either way.
    const base = (config.siteUrl || "").replace(/\/+$/, "");
    const audioUrl = base ? `${base}/api/episodes/${ep.id}/download?src=rss` : (ep.audioUrl || "");

    xml += `    <item>
      <title>${escapeXml(ep.title)}</title>
      <guid isPermaLink="false">${escapeXml(ep.rssGuid)}</guid>
      <pubDate>${formatRssDate(pubDate)}</pubDate>
      <description>${escapeXml(descriptionText)}</description>
      <content:encoded><![CDATA[${showNotesHtml}]]></content:encoded>
      <enclosure url="${escapeXml(audioUrl)}" length="${sizeBytes}" type="${escapeXml(mimeType)}" />
      <itunes:duration>${escapeXml(durationStr)}</itunes:duration>
      <itunes:summary>${escapeXml(descriptionText)}</itunes:summary>
      ${ep.episodeNumber !== null && ep.episodeNumber !== undefined ? `<itunes:episode>${ep.episodeNumber}</itunes:episode>` : ""}
      ${ep.seasonNumber !== null && ep.seasonNumber !== undefined ? `<itunes:season>${ep.seasonNumber}</itunes:season>` : ""}
      <itunes:explicit>${ep.explicit ? "yes" : "no"}</itunes:explicit>
      <link>${escapeXml(config.siteUrl)}/episodes/${ep.id}</link>
      ${ep.rssImageUrl ? `<itunes:image href="${escapeXml(ep.rssImageUrl)}" />` : ""}
    </item>
`;
  }

  xml += `  </channel>
</rss>`;

  return xml;
}

export function validateRssXml(xml: string): boolean {
  if (!xml || xml.trim().length === 0) return false;
  if (!xml.includes("<rss") || !xml.includes("</rss>")) return false;
  if (!xml.includes("<channel>") || !xml.includes("</channel>")) return false;

  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of itemMatches) {
    if (!item.includes("<guid")) return false;
    if (!item.includes("<enclosure")) return false;
    if (!item.includes("url=") || !item.includes("length=") || !item.includes("type=")) return false;
  }
  return true;
}
