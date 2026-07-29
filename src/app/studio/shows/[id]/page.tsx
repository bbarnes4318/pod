import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { SEED_TEAMS } from "@/lib/data/teamSeed";
import { requireUserPage } from "@/lib/currentUser";
import { canViewOwned } from "@/lib/ownerScope";
import { friendlyStage } from "@/app/app/lib";
import { WEEKDAY_LABELS } from "@/app/app/podcasts/config";
import ShowForgeWizard, { type WizardHost, type WizardTeam } from "@/components/studio/ShowForgeWizard";
import { decodeShowForgeState, defaultShowForgeState, storylineSequence } from "@/lib/shows/showForge";
import GenerateShowEpisodeButton from "../GenerateShowEpisodeButton";
import { AppPage, PageHeader, ButtonLink, Card, StatusBadge, Section, SectionHeader, DataTable, RowTitle, TableRowActions, EmptyState } from "@/components/studio";

export const dynamic = "force-dynamic";
const PRODUCED = new Set(["audio_ready", "content_generating", "content_ready", "publish_ready", "published"]);

export default async function StudioShowHeadquartersPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ edit?: string }> }) {
  const { id } = await params;
  const { edit } = await searchParams;
  const user = await requireUserPage(`/studio/shows/${id}`);
  const podcast = await db.podcast.findUnique({
    where: { id },
    include: {
      editorialConfig: true,
      productionConfig: true,
      episodes: { orderBy: { createdAt: "desc" }, take: 30, select: { id: true, title: true, description: true, status: true, createdAt: true, updatedAt: true, audioUrl: true, durationSeconds: true } },
    },
  }).catch(() => null);
  if (!podcast || !canViewOwned(user, podcast)) notFound();

  const [hostsRaw, teamsRaw] = await Promise.all([
    db.aiHost.findMany({ where: { isActive: true, isArchived: false, OR: [{ ownerId: user.id }, { ownerId: null }] }, orderBy: { name: "asc" }, select: { id: true, name: true, role: true } }).catch(() => [] as any[]),
    db.team.findMany({ where: { id: { startsWith: "seed:" } }, orderBy: [{ leagueId: "asc" }, { name: "asc" }], select: { id: true, leagueId: true, name: true } }).catch(() => [] as any[]),
  ]);
  const teams: WizardTeam[] = (teamsRaw.length > 0 ? teamsRaw : SEED_TEAMS).map((team: any) => ({ id: team.id, leagueId: team.leagueId, name: team.name }));
  const hosts: WizardHost[] = hostsRaw.map((host: any) => ({ id: host.id, name: host.name, role: host.role }));
  const showForge = decodeShowForgeState(podcast.editorialConfig?.scriptStyle).state || defaultShowForgeState();
  const hostIds = podcast.productionConfig?.hostIds?.length ? podcast.productionConfig.hostIds : podcast.hostIds;
  const producedCount = podcast.episodes.filter(episode => PRODUCED.has(episode.status)).length;
  const nextBeat = storylineSequence(showForge.storylines)[producedCount] || null;
  const cadence = podcast.cadence === "recurring" ? podcast.scheduleDays.map(day => (WEEKDAY_LABELS[day] || day).slice(0, 3)).join(" · ") : "Manual releases";
  const assignedNames = hosts.filter(host => hostIds.includes(host.id)).map(host => host.name).join(" + ") || "No hosts assigned";

  if (edit === "1") {
    return <AppPage><PageHeader title={`Edit ${podcast.name}`} description="Update the show bible in a focused workspace. Existing episodes keep the configuration they were created with." breadcrumbs={[{ label: "Shows", href: "/studio/shows" }, { label: podcast.name, href: `/studio/shows/${podcast.id}` }, { label: "Edit" }]} actions={<ButtonLink href={`/studio/shows/${podcast.id}`} variant="ghost">Cancel</ButtonLink>} /><ShowForgeWizard hosts={hosts} teams={teams} podcastId={podcast.id} initial={{ name: podcast.name, cadence: podcast.cadence as "one_time" | "recurring", scheduleDays: podcast.scheduleDays, verticals: podcast.editorialConfig?.verticals || podcast.verticals, teams: podcast.editorialConfig?.teams || podcast.teams, segmentCount: podcast.editorialConfig?.segmentCount || podcast.segmentCount, hostIds, showForge }} /></AppPage>;
  }

  return <AppPage>
    <PageHeader detail title={podcast.name} description={showForge.bible.audiencePromise} breadcrumbs={[{ label: "Shows", href: "/studio/shows" }, { label: podcast.name }]} actions={<><ButtonLink href={`/studio/shows/${podcast.id}/sound`} variant="secondary">Sound and branding</ButtonLink><ButtonLink href={`/studio/shows/${podcast.id}?edit=1`} variant="secondary">Edit show</ButtonLink><GenerateShowEpisodeButton podcastId={podcast.id} primary /></>} />
    <div className="showHeadquartersSummary"><Card className="showPromiseCard"><div className="showHeadquartersMeta"><StatusBadge tone={podcast.visibility === "public" ? "success" : "neutral"}>{podcast.visibility === "public" ? "Active" : "Private"}</StatusBadge><span>{cadence}</span><span>{assignedNames}</span></div><h2>{showForge.bible.premise}</h2><p><strong>Host chemistry:</strong> {showForge.bible.hostChemistry}</p></Card><Card><SectionHeader title="Next storyline movement" />{nextBeat ? <div className="nextBeat"><StatusBadge tone="info">{nextBeat.storylineTitle}</StatusBadge><strong>{nextBeat.beatTitle}</strong><p>{nextBeat.beatDirection}</p></div> : <p className="settingsStatus">No season beat is due. The next episode stands alone inside the show bible.</p>}</Card></div>
    {showForge.storylines.length > 0 && <Section><SectionHeader title="Storyline board" description="Active arcs are reserved across episodes without changing factual evidence." /><div className="storylineGrid">{showForge.storylines.map(storyline => <Card key={storyline.id}><div className="showHeadquartersMeta"><StatusBadge tone={storyline.status === "active" ? "info" : storyline.status === "resolved" ? "success" : "warning"}>{storyline.status}</StatusBadge><span>{storyline.beats.length} beats</span></div><h3>{storyline.title}</h3><p>{storyline.premise}</p></Card>)}</div></Section>}
    <Section><SectionHeader title="Episodes in this show" description="Recent episodes and their current production stage." actions={<ButtonLink href={`/studio/create?show=${podcast.id}`} variant="link">Build a rundown</ButtonLink>} />{podcast.episodes.length === 0 ? <EmptyState title="No episodes yet" description="Generate the premiere when the cast and show bible are ready." /> : <DataTable label={`Episodes in ${podcast.name}`}><thead><tr><th>Episode</th><th>Status</th><th>Duration</th><th>Updated</th><th><span className="srOnly">Action</span></th></tr></thead><tbody>{podcast.episodes.slice(0, 15).map(episode => { const stage = friendlyStage(episode.status); return <tr key={episode.id}><td><RowTitle title={episode.title} subtitle={episode.description} /></td><td><StatusBadge tone={episode.status === "published" ? "success" : episode.status === "failed" ? "danger" : episode.audioUrl ? "live" : "info"}>{stage.label}</StatusBadge></td><td>{episode.durationSeconds ? `${Math.floor(episode.durationSeconds / 60)}:${String(episode.durationSeconds % 60).padStart(2, "0")}` : "—"}</td><td>{new Date(episode.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</td><td><TableRowActions><ButtonLink href={`/studio/episodes/${episode.id}`} variant="ghost" size="compact">Open</ButtonLink></TableRowActions></td></tr>; })}</tbody></DataTable>}</Section>
  </AppPage>;
}
