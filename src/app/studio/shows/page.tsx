import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { WEEKDAY_LABELS } from "@/app/app/podcasts/config";
import GenerateShowEpisodeButton from "./GenerateShowEpisodeButton";
import { AppPage, PageHeader, ButtonLink, Card, StatusBadge, EmptyState } from "@/components/studio";

export const dynamic = "force-dynamic";

export default async function StudioShowsPage() {
  const user = await currentUser();
  const podcasts = await db.podcast.findMany({
    where: ownerScope(user),
    orderBy: { updatedAt: "desc" },
    include: {
      productionConfig: { select: { hostIds: true } },
      episodes: { orderBy: { updatedAt: "desc" }, take: 1, select: { title: true, updatedAt: true, status: true } },
      _count: { select: { episodes: true } },
    },
  });
  const hostIds = [...new Set(podcasts.flatMap(show => show.productionConfig?.hostIds?.length ? show.productionConfig.hostIds : show.hostIds))];
  const hosts = await db.aiHost.findMany({ where: { id: { in: hostIds } }, select: { id: true, name: true } });
  const hostNames = new Map(hosts.map(host => [host.id, host.name]));

  return <AppPage>
    <PageHeader title="Shows" description="Manage each show’s cast, creative rules, storylines, sound, schedule, and episode history." actions={<ButtonLink href="/studio/shows/new" variant="primary" size="prominent" data-testid="studio-open-show-forge">Build a show</ButtonLink>} />
    {podcasts.length === 0 ? <EmptyState title="No shows yet" description="Build the show bible, assign hosts, and generate the premiere without leaving Studio." action={<ButtonLink href="/studio/shows/new" variant="primary">Build your first show</ButtonLink>} /> : <div className="showsProductionGrid">{podcasts.map(show => {
      const cadence = show.cadence === "recurring" ? show.scheduleDays.map(day => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(" · ") : "Manual releases";
      const assignedIds = show.productionConfig?.hostIds?.length ? show.productionConfig.hostIds : show.hostIds;
      const assigned = assignedIds.map(id => hostNames.get(id)).filter(Boolean).join(" + ") || "No hosts assigned";
      const latest = show.episodes[0];
      return <Card key={show.id} className="showProductionCard"><div className="showProductionHead"><div><StatusBadge tone={show.visibility === "public" ? "success" : "neutral"}>{show.visibility === "public" ? "Active" : "Draft"}</StatusBadge><h2>{show.name}</h2></div><span className="epMeta">{show._count.episodes} episode{show._count.episodes === 1 ? "" : "s"}</span></div><dl className="showProductionFacts"><div><dt>Sports</dt><dd>{show.verticals.join(", ") || "Sports"}</dd></div><div><dt>Cadence</dt><dd>{cadence}</dd></div><div><dt>Hosts</dt><dd>{assigned}</dd></div><div><dt>Latest</dt><dd>{latest?.title || "No episodes yet"}</dd></div></dl><div className="showProductionActions"><GenerateShowEpisodeButton podcastId={show.id} /><ButtonLink href={`/studio/shows/${show.id}`} variant="secondary">Open show</ButtonLink></div></Card>;
    })}</div>}
  </AppPage>;
}
