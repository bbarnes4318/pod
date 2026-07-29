import { redirect } from "next/navigation";

export default async function LegacyPodcastSoundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/studio/shows/${id}/sound`);
}
