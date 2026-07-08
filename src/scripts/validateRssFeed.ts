// Validates the generated RSS against the podcast RSS 2.0 + Apple Podcasts
// requirements. Two independent checks:
//   1. the built-in structural validator (validateRssXml)
//   2. fast-xml-parser proves the document is WELL-FORMED XML and then we
//      assert the required RSS/iTunes elements + enclosure attributes exist.
// Run: npm run validate:rss
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { generateRssXml, validateRssXml, type PodcastConfig } from "@/lib/services/rssFeedService";

const config: PodcastConfig = {
  title: "Take Machine — NFL",
  description: "Sports takes, argued.",
  language: "en-us",
  author: "Take Machine",
  ownerName: "Take Machine",
  ownerEmail: "owner@example.com",
  siteUrl: "https://podcast.example.com",
  rssUrl: "https://podcast.example.com/rss/pod-123",
  imageUrl: "https://podcast.example.com/cover.png",
  category: "Sports",
  explicit: false,
  ttl: 60,
};

const episode = {
  id: "ep-1",
  title: "Is the MVP race already over?",
  rssGuid: "take-machine:ep-1:script-1",
  publishedAt: new Date("2026-07-07T12:00:00Z"),
  description: "A heated debate on the MVP frontrunner.",
  rssSummary: "A heated debate on the MVP frontrunner.",
  longShowNotes: "# Show notes\n\nThe hosts argue the MVP race.\n\n* Topic one\n* Topic two",
  transcriptUrl: "https://podcast.example.com/t.md",
  audioUrl: "https://cdn.example.com/ep-1.mp3",
  audioFileSizeBytes: 18234567,
  audioMimeType: "audio/mpeg",
  durationSeconds: 733,
  episodeNumber: 1,
  seasonNumber: 1,
  explicit: false,
  rssImageUrl: "https://podcast.example.com/ep-1.png",
};

function main() {
  const xml = generateRssXml([episode], config, false);
  const problems: string[] = [];

  // 1. Structural validator shipped with the feed service.
  if (!validateRssXml(xml)) problems.push("validateRssXml() failed structural checks.");

  // 2. Well-formedness (fast-xml-parser).
  const wf = XMLValidator.validate(xml);
  if (wf !== true) problems.push(`Not well-formed XML: ${JSON.stringify(wf)}`);

  // 3. Required elements + enclosure attributes.
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" }).parse(xml);
  const channel = parsed?.rss?.channel;
  if (parsed?.rss?.["@_version"] !== "2.0") problems.push("rss@version must be 2.0.");
  if (!channel?.title) problems.push("channel.title missing.");
  if (!channel?.["itunes:image"]) problems.push("channel itunes:image missing.");
  if (!channel?.["itunes:category"]) problems.push("channel itunes:category missing.");
  const item = Array.isArray(channel?.item) ? channel.item[0] : channel?.item;
  if (!item?.guid) problems.push("item.guid missing.");
  if (!item?.enclosure?.["@_url"]) problems.push("item.enclosure@url missing.");
  if (!item?.enclosure?.["@_length"]) problems.push("item.enclosure@length missing.");
  if (!item?.enclosure?.["@_type"]) problems.push("item.enclosure@type missing.");
  if (!item?.["itunes:duration"]) problems.push("item itunes:duration missing.");

  if (problems.length > 0) {
    console.error("RSS INVALID:\n - " + problems.join("\n - "));
    process.exit(1);
  }
  console.log("RSS VALID ✓ (validateRssXml + fast-xml-parser well-formed + required RSS 2.0 / iTunes elements present)");
}

main();
