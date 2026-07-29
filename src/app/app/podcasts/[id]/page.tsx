import { redirect } from "next/navigation";

export default async function LegacyPodcastPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/studio/shows/${id}`);
}
