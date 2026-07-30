import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { fmtDuration, fmtDate, FINISHED_STATUSES, statusChip } from "./lib";
import { AppPage, PageHeader, MetricGrid, Metric, Section, SectionHeader, ButtonLink, Card, StatusBadge, ScoreDisplay, DataTable, RowTitle, TableRowActions, EmptyState } from "@/components/studio";

export const dynamic = "force-dynamic";
const AVAILABLE = ["approved", "pending"] as const;
const IN_PROGRESS = ["draft", "script_draft", "fact_checked", "script_approved", "audio_segments_ready", "audio_stitching", "content_generating"];
const READY = ["audio_ready", "content_ready", "publish_ready"];

function toneFor(status: string): "neutral" | "success" | "warning" | "danger" | "info" | "live" { if (status === "published") return "success"; if (status === "failed") return "danger"; if (READY.includes(status)) return "live"; if (IN_PROGRESS.includes(status)) return "info"; return "neutral"; }

export default async function StudioBoard() {
  const viewer = await currentUser();
  const owned = ownerScope(viewer);
  // This is a force-dynamic server page. The rolling dashboard window must be
  // resolved at request time rather than frozen at module load.
  // eslint-disable-next-line react-hooks/purity
  const publishedSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [takes, poolCount, inProgressCount, readyCount, publishedCount, recentEpisodes] = await Promise.all([
    db.topicCandidate.findMany({ where: { status: { in: [...AVAILABLE] } }, include: { researchBrief: true }, orderBy: { debateScore: "desc" }, take: 8 }),
    db.topicCandidate.count({ where: { status: { in: [...AVAILABLE] } } }),
    db.episode.count({ where: { AND: [owned, { status: { in: IN_PROGRESS } }] } }),
    db.episode.count({ where: { AND: [owned, { status: { in: READY } }] } }),
    db.episode.count({ where: { AND: [owned, { status: "published", publishedAt: { gte: publishedSince } }] } }),
    db.episode.findMany({ where: owned, orderBy: { updatedAt: "desc" }, take: 8, include: { podcast: { select: { name: true } } } }),
  ]);
  const cards = takes.map(topic => {
    const talk = scoreTopicTalkability({ title: topic.title, summary: topic.summary, createdAt: topic.createdAt, brief: topic.researchBrief as any });
    return { id: topic.id, title: topic.title, sport: topic.sport, heat: talk.total, whyNow: topic.researchBrief?.whyMattersNow?.trim() || topic.summary?.trim() || "This story is scoring as a strong discussion candidate." };
  });

  return <AppPage>
    <PageHeader title="The Board" description="Choose what deserves production next, then track the episodes already moving through the Studio." />
    <MetricGrid><Metric label="Takes ready" value={poolCount} hint="Available to use" /><Metric label="In production" value={inProgressCount} hint="Active pipeline work" /><Metric label="Ready to publish" value={readyCount} hint="Audio or packaging complete" /><Metric label="Published recently" value={publishedCount} hint="Last 30 days" /></MetricGrid>
    <Section><SectionHeader title="Trending takes" description="Ranked from the existing talkability and evidence signals." actions={<ButtonLink href="/studio/takes" variant="link">View all takes</ButtonLink>} />
      {cards.length === 0 ? <EmptyState title="The board is clear" description="No candidate stories are waiting. The next topic-ingestion run will refill this queue." /> : <div className="boardProductionGrid">{cards.map(card => <Card key={card.id} className="boardProductionCard"><div className="boardProductionMeta"><StatusBadge tone="info">{card.sport}</StatusBadge><span title={`Debate heat ${card.heat} of 100`}><ScoreDisplay value={card.heat} /></span></div><h3>{card.title}</h3><p><strong>Why now:</strong> {card.whyNow}</p><ButtonLink href={`/studio/create?topic=${card.id}`} variant="secondary" size="compact">Use this take</ButtonLink></Card>)}</div>}
    </Section>
    <Section><SectionHeader title="Recent episodes" description="The latest production activity across your shows." actions={<ButtonLink href="/studio/episodes" variant="link">Open production library</ButtonLink>} />
      {recentEpisodes.length === 0 ? <EmptyState title="No episodes yet" description="Your first generated episode will appear here with its live production status." action={<ButtonLink href="/studio/create" variant="primary">Create an episode</ButtonLink>} /> : <DataTable label="Recent episodes"><thead><tr><th>Episode</th><th>Show</th><th>Status</th><th>Duration</th><th>Updated</th><th><span className="srOnly">Action</span></th></tr></thead><tbody>{recentEpisodes.map(ep => { const chip = statusChip(ep.status); const ready = FINISHED_STATUSES.includes(ep.status) && !!ep.audioUrl; return <tr key={ep.id}><td><RowTitle title={ep.title} subtitle={ep.description} /></td><td>{ep.podcast?.name || "Standalone"}</td><td><StatusBadge tone={toneFor(ep.status)}>{chip.label}</StatusBadge></td><td>{ready ? fmtDuration(ep.durationSeconds) : "—"}</td><td>{fmtDate(ep.updatedAt)}</td><td><TableRowActions><ButtonLink href={`/studio/episodes/${ep.id}`} variant="ghost" size="compact">Open</ButtonLink></TableRowActions></td></tr>; })}</tbody></DataTable>}
    </Section>
  </AppPage>;
}
