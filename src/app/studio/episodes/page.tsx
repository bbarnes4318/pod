import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { fmtDate, fmtDuration, qualityOf, statusChip } from "../lib";
import { AppPage, PageHeader, ButtonLink, Toolbar, ToolbarGroup, SearchInput, Select, DataTable, RowTitle, TableRowActions, MobileList, Card, StatusBadge, ScoreDisplay, Pagination, EmptyState } from "@/components/studio";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 25;
const GROUPS: Record<string, string[] | undefined> = {
  all: undefined,
  progress: ["draft", "script_draft", "fact_checked", "script_approved", "audio_segments_ready", "audio_stitching", "content_generating"],
  ready: ["audio_ready", "content_ready", "publish_ready"],
  published: ["published"],
  failed: ["failed"],
};

function toneFor(status: string): "neutral" | "success" | "warning" | "danger" | "info" | "live" {
  if (status === "published") return "success";
  if (status === "failed") return "danger";
  if (["audio_ready", "content_ready", "publish_ready"].includes(status)) return "live";
  if (["audio_stitching", "content_generating"].includes(status)) return "warning";
  return "info";
}

export default async function EpisodesLibrary({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; show?: string; sort?: string; page?: string }> }) {
  const user = await currentUser();
  const sp = await searchParams;
  const status = GROUPS[sp.status || "all"] ? sp.status || "all" : "all";
  const page = Math.max(1, Number.parseInt(sp.page || "1", 10) || 1);
  const q = (sp.q || "").trim();
  const show = (sp.show || "").trim();
  const sort = ["updated", "oldest", "title"].includes(sp.sort || "") ? sp.sort! : "updated";
  const filters = {
    ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
    ...(show ? { podcastId: show } : {}),
    ...(GROUPS[status] ? { status: { in: GROUPS[status] } } : {}),
  };
  const where = { AND: [ownerScope(user), filters] };
  const orderBy = sort === "title" ? { title: "asc" as const } : sort === "oldest" ? { updatedAt: "asc" as const } : { updatedAt: "desc" as const };
  const [episodes, total, shows] = await Promise.all([
    db.episode.findMany({ where, orderBy, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE, include: { podcast: { select: { id: true, name: true } }, scripts: { orderBy: { version: "desc" }, take: 1, select: { content: true } } } }),
    db.episode.count({ where }),
    db.podcast.findMany({ where: ownerScope(user), orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);

  return <AppPage>
    <PageHeader title="Episodes" description="Search, review, and move every production through the pipeline from one compact library." actions={<ButtonLink href="/studio/create" variant="primary" size="prominent">Create episode</ButtonLink>} />
    <form method="get">
      <Toolbar>
        <ToolbarGroup><SearchInput name="q" defaultValue={q} placeholder="Search episodes" aria-label="Search episodes" /><Select name="status" defaultValue={status} aria-label="Status"><option value="all">All statuses</option><option value="progress">In progress</option><option value="ready">Ready</option><option value="published">Published</option><option value="failed">Failed</option></Select><Select name="show" defaultValue={show} aria-label="Show"><option value="">All shows</option>{shows.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select><Select name="sort" defaultValue={sort} aria-label="Sort"><option value="updated">Recently updated</option><option value="oldest">Oldest updated</option><option value="title">Episode title</option></Select></ToolbarGroup>
        <ToolbarGroup><button className="btnGhost" type="submit">Apply filters</button>{(q || status !== "all" || show || sort !== "updated") && <ButtonLink href="/studio/episodes" variant="ghost">Clear</ButtonLink>}</ToolbarGroup>
      </Toolbar>
    </form>
    {episodes.length === 0 ? <EmptyState title="No episodes match this view" description={total === 0 && !q && status === "all" && !show ? "Create the first episode and its production status will appear here." : "Change or clear the filters to see more of your production library."} action={<ButtonLink href={q || status !== "all" || show ? "/studio/episodes" : "/studio/create"} variant="primary">{q || status !== "all" || show ? "Clear filters" : "Create an episode"}</ButtonLink>} /> : <>
      <DataTable label="Episode production library"><colgroup><col style={{ width: "34%" }} /><col style={{ width: "18%" }} /><col style={{ width: "15%" }} /><col style={{ width: "9%" }} /><col style={{ width: "9%" }} /><col style={{ width: "9%" }} /><col style={{ width: "6%" }} /></colgroup><thead><tr><th>Episode</th><th>Show</th><th>Status</th><th>Duration</th><th>Quality</th><th>Updated</th><th><span className="srOnly">Actions</span></th></tr></thead><tbody>{episodes.map(ep => { const quality = qualityOf(ep.scripts[0]); const chip = statusChip(ep.status); return <tr key={ep.id}><td><RowTitle title={ep.title} subtitle={ep.description} /></td><td>{ep.podcast?.name || "Standalone"}</td><td><StatusBadge tone={toneFor(ep.status)}>{chip.label}</StatusBadge></td><td>{fmtDuration(ep.durationSeconds)}</td><td>{quality ? <ScoreDisplay value={quality.total} /> : "—"}</td><td>{fmtDate(ep.updatedAt)}</td><td><TableRowActions><ButtonLink href={`/studio/episodes/${ep.id}`} size="compact" variant="ghost" aria-label={`Open ${ep.title}`}>Open</ButtonLink></TableRowActions></td></tr>; })}</tbody></DataTable>
      <MobileList>{episodes.map(ep => { const quality = qualityOf(ep.scripts[0]); const chip = statusChip(ep.status); return <Card key={ep.id}><div style={{ display: "grid", gap: 10 }}><div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><StatusBadge tone={toneFor(ep.status)}>{chip.label}</StatusBadge>{quality && <ScoreDisplay value={quality.total} />}</div><RowTitle title={ep.title} subtitle={ep.podcast?.name || "Standalone"} /><div className="epMeta">{fmtDuration(ep.durationSeconds)} · Updated {fmtDate(ep.updatedAt)}</div><ButtonLink href={`/studio/episodes/${ep.id}`} size="compact">Open episode</ButtonLink></div></Card>; })}</MobileList>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/studio/episodes" query={{ q: q || undefined, status: status !== "all" ? status : undefined, show: show || undefined, sort: sort !== "updated" ? sort : undefined }} />
    </>}
  </AppPage>;
}
