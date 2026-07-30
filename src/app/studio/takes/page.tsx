import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { scoreTopicTalkability } from "@/lib/services/talkabilityService";
import { getTopicUsage } from "@/lib/services/topicUsageService";
import { fmtDate } from "../lib";
import type { Prisma, TopicEditorialStatus } from "@prisma/client";
import { AppPage, PageHeader, ButtonLink, Toolbar, ToolbarGroup, SearchInput, Select, DataTable, RowTitle, TableRowActions, MobileList, Card, StatusBadge, ScoreDisplay, Pagination, EmptyState } from "@/components/studio";

export const dynamic = "force-dynamic";
const PAGE_SIZE = 25;
const BOARD_STATUSES: TopicEditorialStatus[] = ["pending", "approved"];

export default async function TakesBoard({ searchParams }: { searchParams: Promise<{ q?: string; sport?: string; league?: string; status?: string; sort?: string; page?: string }> }) {
  const sp = await searchParams;
  const q = (sp.q || "").trim();
  const sport = (sp.sport || "").trim();
  const league = (sp.league || "").trim();
  const status: TopicEditorialStatus | "all" = sp.status === "pending" || sp.status === "approved" ? sp.status : "all";
  const sort = sp.sort === "fresh" ? "fresh" : "score";
  const page = Math.max(1, Number.parseInt(sp.page || "1", 10) || 1);
  const where: Prisma.TopicCandidateWhereInput = {
    status: status === "all" ? { in: BOARD_STATUSES } : status,
    ...(q ? { OR: [{ title: { contains: q, mode: "insensitive" as const } }, { summary: { contains: q, mode: "insensitive" as const } }] } : {}),
    ...(sport ? { sport: { equals: sport, mode: "insensitive" as const } } : {}),
    ...(league ? { leagueId: league } : {}),
  };
  const [topics, total, sportRows, leagueRows] = await Promise.all([
    db.topicCandidate.findMany({ where, include: { researchBrief: true }, orderBy: sort === "fresh" ? { createdAt: "desc" } : { debateScore: "desc" }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    db.topicCandidate.count({ where }),
    db.topicCandidate.findMany({ where: { status: { in: BOARD_STATUSES } }, distinct: ["sport"], select: { sport: true }, orderBy: { sport: "asc" } }),
    db.topicCandidate.findMany({ where: { status: { in: BOARD_STATUSES }, leagueId: { not: null } }, distinct: ["leagueId"], select: { leagueId: true, league: { select: { name: true } } }, orderBy: { leagueId: "asc" } }),
  ]);
  const user = await currentUser();
  const usage = user ? await getTopicUsage(topics.map(topic => topic.id), { ownerId: user.id }) : new Map();
  const ranked = topics.map(topic => ({ topic, score: scoreTopicTalkability({ title: topic.title, summary: topic.summary, createdAt: topic.createdAt, brief: topic.researchBrief as any }) })).sort((a, b) => sort === "score" ? b.score.total - a.score.total : b.topic.createdAt.getTime() - a.topic.createdAt.getTime());
  const query = { q: q || undefined, sport: sport || undefined, league: league || undefined, status: status !== "all" ? status : undefined, sort: sort !== "score" ? sort : undefined };

  return <AppPage>
    <PageHeader title="Takes" description="A compact editorial queue ranked by how much useful debate each story can produce right now." actions={<ButtonLink href="/studio/create" variant="primary" size="prominent">Build a rundown</ButtonLink>} />
    <form method="get"><Toolbar><ToolbarGroup><SearchInput name="q" defaultValue={q} placeholder="Search takes" aria-label="Search takes" /><Select name="sport" defaultValue={sport} aria-label="Sport"><option value="">All sports</option>{sportRows.map(row => <option key={row.sport} value={row.sport}>{row.sport}</option>)}</Select><Select name="league" defaultValue={league} aria-label="League"><option value="">All leagues</option>{leagueRows.map(row => <option key={row.leagueId!} value={row.leagueId!}>{row.league?.name || row.leagueId}</option>)}</Select><Select name="status" defaultValue={status} aria-label="Status"><option value="all">All readiness</option><option value="approved">Ready</option><option value="pending">New</option></Select><Select name="sort" defaultValue={sort} aria-label="Sort"><option value="score">Highest score</option><option value="fresh">Newest first</option></Select></ToolbarGroup><ToolbarGroup><button className="btnGhost" type="submit">Apply filters</button>{Object.values(query).some(Boolean) && <ButtonLink href="/studio/takes" variant="ghost">Clear</ButtonLink>}</ToolbarGroup></Toolbar></form>
    {ranked.length === 0 ? <EmptyState title="No takes match this view" description="Clear the filters or return later after the topic pipeline has added fresh sports stories." action={<ButtonLink href="/studio/takes" variant="primary">Clear filters</ButtonLink>} /> : <>
      <DataTable label="Takes editorial queue"><thead><tr><th>Heat</th><th>Take</th><th>Sport</th><th>Status</th><th>Freshness</th><th>Score breakdown</th><th><span className="srOnly">Action</span></th></tr></thead><tbody>{ranked.map(({ topic, score }) => { const used = usage.get(topic.id)?.currentOwnerUseCount ?? 0; const breakdown = `C ${Math.round(topic.controversyScore)} · S ${Math.round(topic.starPowerScore)} · B ${Math.round(topic.bettingRelevanceScore)} · F ${Math.round(topic.recencyScore)}`; return <tr key={topic.id}><td><ScoreDisplay value={score.total} /></td><td><RowTitle title={topic.title} subtitle={topic.summary} /></td><td>{topic.sport}</td><td><StatusBadge tone={topic.status === "approved" && topic.researchBrief ? "success" : "info"}>{topic.status === "approved" && topic.researchBrief ? "Ready" : "New"}</StatusBadge>{used > 0 && <span className="epMeta"> Used {used}×</span>}</td><td>{fmtDate(topic.createdAt)}</td><td title="Controversy · Star power · Betting · Freshness">{breakdown}</td><td><TableRowActions><ButtonLink href={`/studio/create?topic=${topic.id}`} size="compact" variant="primary">Use</ButtonLink></TableRowActions></td></tr>; })}</tbody></DataTable>
      <MobileList>{ranked.map(({ topic, score }) => <Card key={topic.id}><div className="studioMobileRow"><div className="studioMobileRowTop"><ScoreDisplay value={score.total} /><StatusBadge tone={topic.status === "approved" && topic.researchBrief ? "success" : "info"}>{topic.status === "approved" && topic.researchBrief ? "Ready" : "New"}</StatusBadge></div><RowTitle title={topic.title} subtitle={topic.summary} /><div className="epMeta">{topic.sport} · {fmtDate(topic.createdAt)}</div><ButtonLink href={`/studio/create?topic=${topic.id}`} size="compact" variant="primary">Use this take</ButtonLink></div></Card>)}</MobileList>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} basePath="/studio/takes" query={query} />
    </>}
  </AppPage>;
}
