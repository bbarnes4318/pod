"use server";

// Search and live activity for the Studio shell.
//
// Both are reads scoped to the signed-in viewer by the same rules the list
// pages use (ownerScope), so the palette can never surface a show, episode or
// research topic the Shows and Episodes pages would hide.

import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { activeTopicCutoff } from "@/lib/services/topicFreshness";
import { getStudioProductions, type StudioProductions } from "./productions";

export interface SearchHit {
  kind: "show" | "episode" | "host" | "topic";
  id: string;
  label: string;
  sub?: string;
  href: string;
}

const PER_KIND = 5;

export async function searchStudio(rawQuery: string): Promise<SearchHit[]> {
  const user = await currentUser();
  const q = String(rawQuery ?? "").trim().slice(0, 80);
  if (!user || q.length < 2) return [];
  const contains = { contains: q, mode: "insensitive" as const };
  const scope = ownerScope(user);

  const [shows, episodes, hosts, sportsTopics, businessTopics] = await Promise.all([
    db.podcast.findMany({
      where: { ...scope, name: contains },
      orderBy: { updatedAt: "desc" },
      take: PER_KIND,
      select: { id: true, name: true, intelligenceType: true },
    }),
    db.episode.findMany({
      where: { ...scope, title: contains },
      orderBy: { updatedAt: "desc" },
      take: PER_KIND,
      select: { id: true, title: true, podcast: { select: { name: true } } },
    }),
    // Same visibility as the Talent page: your hosts plus the shared house cast.
    db.aiHost.findMany({
      where: { OR: [{ ownerId: user.id }, { ownerId: null }], isArchived: false, name: contains },
      orderBy: { name: "asc" },
      take: PER_KIND,
      select: { id: true, name: true, role: true },
    }),
    // The sports take pool is shared by design; only usable, fresh takes.
    db.topicCandidate.findMany({
      where: { status: "approved", createdAt: { gte: activeTopicCutoff() }, title: contains },
      orderBy: { debateScore: "desc" },
      take: PER_KIND,
      select: { id: true, title: true, sport: true },
    }),
    // Business research belongs to a show, so it is scoped through the show.
    db.businessTopicOpportunity.findMany({
      where: { podcast: scope, editorialStatus: { in: ["CANDIDATE", "APPROVED"] }, title: contains },
      orderBy: { opportunityScore: "desc" },
      take: PER_KIND,
      select: { id: true, title: true, podcastId: true, podcast: { select: { name: true } } },
    }),
  ]);

  return [
    ...shows.map((s): SearchHit => ({ kind: "show", id: s.id, label: s.name, sub: s.intelligenceType === "BUSINESS" ? "Business show" : "Sports show", href: `/studio/shows/${s.id}` })),
    ...episodes.map((e): SearchHit => ({ kind: "episode", id: e.id, label: e.title, sub: e.podcast?.name ?? "Standalone episode", href: `/studio/episodes/${e.id}` })),
    ...hosts.map((h): SearchHit => ({ kind: "host", id: h.id, label: h.name, sub: h.role, href: "/studio/hosts" })),
    ...sportsTopics.map((t): SearchHit => ({ kind: "topic", id: t.id, label: t.title, sub: `Sports take · ${t.sport}`, href: `/studio/create?topic=${t.id}` })),
    ...businessTopics.map((t): SearchHit => ({ kind: "topic", id: t.id, label: t.title, sub: `Research topic · ${t.podcast.name}`, href: `/studio/shows/${t.podcastId}?tab=topics` })),
  ];
}

/** What is in production and what is waiting on you. Polled by the shell. */
export async function getStudioActivity(offset = 0): Promise<StudioProductions> {
  return getStudioProductions(await currentUser(), { offset: Number(offset) || 0 });
}
