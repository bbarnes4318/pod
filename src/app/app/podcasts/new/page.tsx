import { redirect } from "next/navigation";

export default async function LegacyNewPodcastPage({ searchParams }: { searchParams: Promise<{ topic?: string }> }) {
  const { topic } = await searchParams;
  redirect(topic ? `/studio/shows/new?topic=${encodeURIComponent(topic)}` : "/studio/shows/new");
}
