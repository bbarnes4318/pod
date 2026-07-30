import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { fmtDate, fmtDuration } from "../lib";
import { AppPage, PageHeader, ButtonLink, Toolbar, ToolbarGroup, SegmentedControl, DataTable, RowTitle, TableRowActions, MobileList, Card, StatusBadge, Pagination, EmptyState } from "@/components/studio";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 25;
const FILTERS: Record<string, string[]> = {
  ready: ["publish_ready"],
  assets: ["audio_ready", "content_ready"],
  live: ["published"],
  failed: ["failed"],
};

export default async function PublishPage({ searchParams }: { searchParams: Promise<{ view?: string; page?: string }> }) {
  const user = await currentUser();
  const sp = await searchParams;
  const view = FILTERS[sp.view || "ready"] ? sp.view || "ready" : "ready";
  const page = Math.max(1, Number.parseInt(sp.page || "1", 10) || 1);
  const where = { AND: [ownerScope(user), { status: { in: FILTERS[view] } }] };
  const [episodes, total] = await Promise.all([
    db.episode.findMany({ where, orderBy: view === "live" ? { publishedAt: "desc" } : { updatedAt: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: { podcast: { select: { name: true } } } }),
    db.episode.count({ where }),
  ]);
  const feedUrl = process.env.PODCAST_RSS_URL || "/rss";
  const options = [
    { value: "ready", label: "Ready to publish", href: "/studio/publish?view=ready" },
    { value: "assets", label: "Needs assets", href: "/studio/publish?view=assets" },
    { value: "live", label: "Live", href: "/studio/publish?view=live" },
    { value: "failed", label: "Failed", href: "/studio/publish?view=failed" },
  ];

  return <AppPage>
    <PageHeader title="Publishing" description="Package, release, and verify episodes without leaving the customer Studio." actions={<a href="/rss" target="_blank" rel="noreferrer" className="btnGhost">Open public feed</a>} />
    <Toolbar><ToolbarGroup><SegmentedControl options={options} value={view} /></ToolbarGroup><ToolbarGroup><span className="epMeta">Feed: {feedUrl}</span>{user?.role === "ADMIN" && <ButtonLink href="/admin/rss" variant="ghost" size="compact">Admin feed tools</ButtonLink>}</ToolbarGroup></Toolbar>
    {episodes.length === 0 ? <EmptyState title={view === "live" ? "No episodes are live yet" : view === "failed" ? "No failed publishing jobs" : "Nothing is waiting in this queue"} description={view === "ready" ? "Episodes appear here after their publishing assets are complete." : view === "assets" ? "Audio-ready episodes appear here while show notes and packaging are prepared." : view === "live" ? "Publish the first completed episode and it will appear here." : "Publishing failures will appear here with a clear route back to the episode."} action={view === "live" ? <ButtonLink href="/studio/episodes?status=ready" variant="primary">Review ready episodes</ButtonLink> : undefined} /> : <>
      <DataTable label="Publishing queue"><thead><tr><th>Episode</th><th>Show</th><th>Duration</th><th>Packaging</th><th>Publish status</th><th>Updated</th><th><span className="srOnly">Actions</span></th></tr></thead><tbody>{episodes.map(ep => { const live = ep.status === "published"; const needsAssets = ["audio_ready", "content_ready"].includes(ep.status); const failed = ep.status === "failed"; return <tr key={ep.id}><td><RowTitle title={ep.title} subtitle={ep.description} /></td><td>{ep.podcast?.name || "Standalone"}</td><td>{fmtDuration(ep.durationSeconds)}</td><td><StatusBadge tone={failed ? "danger" : needsAssets ? "warning" : "success"}>{failed ? "Needs attention" : needsAssets ? "In progress" : "Complete"}</StatusBadge></td><td><StatusBadge tone={live ? "success" : failed ? "danger" : "live"}>{live ? "Live" : failed ? "Failed" : "Ready"}</StatusBadge></td><td>{fmtDate(ep.publishedAt || ep.updatedAt)}</td><td><TableRowActions><ButtonLink href={`/studio/episodes/${ep.id}#publish`} size="compact" variant={live ? "ghost" : "primary"}>{live ? "View" : failed ? "Fix" : needsAssets ? "Prepare" : "Publish"}</ButtonLink></TableRowActions></td></tr>; })}</tbody></DataTable>
      <MobileList>{episodes.map(ep => <Card key={ep.id}><div className="studioMobileRow"><div className="studioMobileRowTop"><StatusBadge tone={ep.status === "published" ? "success" : ep.status === "failed" ? "danger" : "live"}>{ep.status === "published" ? "Live" : ep.status === "failed" ? "Failed" : ep.status === "publish_ready" ? "Ready" : "Needs assets"}</StatusBadge><span className="epMeta">{fmtDuration(ep.durationSeconds)}</span></div><RowTitle title={ep.title} subtitle={ep.podcast?.name || "Standalone"} /><ButtonLink href={`/studio/episodes/${ep.id}#publish`} size="compact">Open publishing</ButtonLink></div></Card>)}</MobileList>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/studio/publish" query={{ view }} />
    </>}
  </AppPage>;
}
