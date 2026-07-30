import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { canViewOwned } from "@/lib/ownerScope";

export default async function LegacyPodcastPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await currentUser();
  const podcast = await db.podcast.findUnique({ where: { id }, select: { ownerId: true } }).catch(() => null);

  // Legacy bookmarks may redirect only after the same ownership check used by
  // the canonical Studio route. Returning a redirect first turns a private or
  // legacy-unowned show into a misleading HTTP 200 and weakens URL isolation.
  if (!podcast || !canViewOwned(user, podcast)) notFound();

  redirect(`/studio/shows/${id}`);
}
