import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { qualityOf, fmtDuration, statusChip, nextActionFor, FINISHED_STATUSES, bustAudioUrl, showHue, showInitials } from "../lib";
import { PlayButton } from "../StudioAudio";
import { Icon } from "../StudioIcons";
import Pager from "../Pager";
import "../library.css";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 24;

const VIEWS = [
  { key: "all", label: "All" },
  { key: "progress", label: "In production" },
  { key: "ready", label: "Ready" },
  { key: "live", label: "Live" },
  { key: "attention", label: "Needs attention" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];
type Bucket = Exclude<ViewKey, "all">;

/**
 * The four buckets as database filters. They are the same rule the page used
 * to apply in memory to its first 200 rows (failed -> attention, published ->
 * live, finished-or-has-audio -> ready, everything else -> in production), so
 * the counts are now right for a library of any size. Each episode lands in
 * exactly one bucket; "has audio" means a non-empty audioUrl.
 */
const HAS_AUDIO = { AND: [{ audioUrl: { not: null } }, { audioUrl: { not: "" } }] };
const NO_AUDIO = { OR: [{ audioUrl: null }, { audioUrl: "" }] };
const BUCKET_WHERE: Record<Bucket, Record<string, unknown>> = {
  attention: { status: "failed" },
  live: { status: "published" },
  ready: { status: { notIn: ["failed", "published"] }, OR: [{ status: { in: FINISHED_STATUSES } }, HAS_AUDIO] },
  progress: { status: { notIn: ["failed", ...FINISHED_STATUSES] }, ...NO_AUDIO },
};

function pillClass(status: string, kind: "accent" | "success" | "plain"): string {
  if (status === "failed") return "statusPill statusPill--err";
  if (status === "published") return "statusPill statusPill--ok";
  if (status === "script_draft") return "statusPill statusPill--warn";
  if (kind === "accent" || kind === "success") return "statusPill statusPill--live";
  return "statusPill";
}

const fmtUpdated = (d: Date) =>
  new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(d).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

export default async function EpisodesLibrary({ searchParams }: { searchParams: Promise<{ view?: string; q?: string; layout?: string; page?: string }> }) {
  // Scoped to the viewer: every query below goes through ownerScope(user).
  const user = await currentUser();
  const sp = await searchParams;
  const view: ViewKey = VIEWS.some((v) => v.key === sp.view) ? (sp.view as ViewKey) : "all";
  const q = (sp.q ?? "").trim().slice(0, 120);
  const layout: "table" | "grid" = sp.layout === "grid" ? "grid" : "table";
  const requestedPage = Math.max(1, Math.floor(Number(sp.page)) || 1);

  const scope = ownerScope(user);
  const search = q
    ? { OR: [{ title: { contains: q, mode: "insensitive" as const } }, { podcast: { name: { contains: q, mode: "insensitive" as const } } }] }
    : {};
  const whereFor = (v: ViewKey) => ({ AND: [scope, search, v === "all" ? {} : BUCKET_WHERE[v]] });

  // Counts come from the database, with the search applied, so a tab's number
  // is the number of rows that tab will show, across every page.
  const [libraryTotal, progress, ready, live, attention] = await Promise.all([
    db.episode.count({ where: scope }),
    db.episode.count({ where: whereFor("progress") }),
    db.episode.count({ where: whereFor("ready") }),
    db.episode.count({ where: whereFor("live") }),
    db.episode.count({ where: whereFor("attention") }),
  ]);
  const counts: Record<ViewKey, number> = { all: progress + ready + live + attention, progress, ready, live, attention };

  const total = counts[view];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);

  const episodes = await db.episode.findMany({
    where: whereFor(view),
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true, title: true, status: true, audioUrl: true, durationSeconds: true, updatedAt: true, rssImageUrl: true,
      podcast: { select: { id: true, name: true, coverImageUrl: true } },
      // ponytail: the quality score lives inside Script.content (JSON), so the
      // table still reads the latest script's content, but only for the 24
      // rows on screen and never for the grid. Upgrade path: a stored
      // Script.qualityTotal column (needs a migration).
      scripts: layout === "table" ? { orderBy: { version: "desc" }, take: 1, select: { content: true } } : false,
    },
  });

  const hrefFor = (next: { view?: ViewKey; layout?: "table" | "grid"; page?: number }) => {
    const v = next.view ?? view;
    const l = next.layout ?? layout;
    const p = new URLSearchParams();
    if (v !== "all") p.set("view", v);
    if (q) p.set("q", q);
    if (l === "grid") p.set("layout", "grid");
    if (next.page && next.page > 1) p.set("page", String(next.page));
    const s = p.toString();
    return s ? `/studio/episodes?${s}` : "/studio/episodes";
  };

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Episodes"
        subtitle="Every episode across your shows, newest activity first."
        status={<span className="sectionCount">{libraryTotal.toLocaleString()} total</span>}
      />

      {libraryTotal === 0 ? (
        <div className="emptyState">
          <span className="emptyStateIcon">{Icon.episodes}</span>
          <div className="emptyStateTitle">No episodes yet</div>
          <p className="emptyStateBody">Create an episode from a show or from a topic. It appears here as soon as production starts.</p>
          <Link href="/studio/create" className="btnPrimary">Create your first episode</Link>
        </div>
      ) : (
        <>
          <div className="listToolbar">
            <nav className="segmented" aria-label="Filter episodes by status">
              {VIEWS.map((v) => (
                <Link key={v.key} href={hrefFor({ view: v.key })} aria-current={view === v.key ? "page" : undefined}>
                  {v.label}
                  <span className="segCount">{counts[v.key]}</span>
                </Link>
              ))}
            </nav>
            <div className="libToolbarEnd">
              <form className="listSearch" action="/studio/episodes" role="search">
                {view !== "all" && <input type="hidden" name="view" value={view} />}
                {layout === "grid" && <input type="hidden" name="layout" value="grid" />}
                <span className="listSearchIcon">{Icon.search}</span>
                <input className="input" type="search" name="q" defaultValue={q} placeholder="Search by title or show" aria-label="Search episodes" />
              </form>
              <nav className="segmented" aria-label="Layout">
                <Link href={hrefFor({ layout: "table", page })} aria-current={layout === "table" ? "true" : undefined}>Table</Link>
                <Link href={hrefFor({ layout: "grid", page })} aria-current={layout === "grid" ? "true" : undefined}>Grid</Link>
              </nav>
            </div>
          </div>

          {episodes.length === 0 ? (
            <div className="emptyState">
              <div className="emptyStateTitle">No episodes match</div>
              <p className="emptyStateBody">Nothing in this view{q ? ` matches “${q}”` : ""}.</p>
              <Link href={layout === "grid" ? "/studio/episodes?layout=grid" : "/studio/episodes"} className="btnGhost">Clear filters</Link>
            </div>
          ) : layout === "grid" ? (
            <ul className="epGrid" aria-label="Episodes">
              {episodes.map((ep) => {
                const chip = statusChip(ep.status);
                const next = nextActionFor(ep);
                // The episode's own cover first, then its show's; a show with
                // neither gets its initials on its hue, as everywhere else.
                const cover = ep.rssImageUrl || ep.podcast?.coverImageUrl || null;
                const href = `/studio/episodes/${ep.id}`;
                return (
                  <li key={ep.id} className="epGridCard">
                    <div className="epGridArt" data-hue={ep.podcast ? showHue(ep.podcast.id) : undefined}>
                      {cover ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={cover} alt="" loading="lazy" />
                      ) : (
                        <span className="epGridInitials" aria-hidden="true">{ep.podcast ? showInitials(ep.podcast.name) : "·"}</span>
                      )}
                      {ep.audioUrl && (
                        <PlayButton
                          className="playBtn epGridPlay"
                          track={{ id: ep.id, src: bustAudioUrl(ep.audioUrl, ep.updatedAt), title: ep.title, subtitle: ep.podcast?.name ?? undefined, href }}
                        />
                      )}
                    </div>
                    <div className="epGridBody">
                      <span className={pillClass(ep.status, chip.kind)}>{ep.status === "failed" ? "Failed" : chip.label}</span>
                      <Link href={href} className="epGridTitle">{ep.title}</Link>
                      <span className="epGridShow">{ep.podcast?.name ?? "Standalone episode"}</span>
                      <span className="epGridMeta">
                        {ep.durationSeconds ? `${fmtDuration(ep.durationSeconds)} · ` : ""}Updated {fmtUpdated(ep.updatedAt)}
                      </span>
                      <Link href={next.href} className="epGridNext">
                        <span className="epGridNextStage">{next.stage}</span>
                        {next.label}
                      </Link>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="dataTableWrap">
              <table className="dataTable">
                <thead>
                  <tr>
                    <th scope="col">Episode</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="num">Quality</th>
                    <th scope="col" className="num">Length</th>
                    <th scope="col">Updated</th>
                    <th scope="col" className="actions"><span className="srOnly">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {episodes.map((ep) => {
                    const chip = statusChip(ep.status);
                    const quality = qualityOf((ep as { scripts?: { content: unknown }[] }).scripts?.[0]);
                    return (
                      <tr key={ep.id}>
                        <td className="primaryCell">
                          <span className="epLibCell">
                            {ep.audioUrl ? (
                              <PlayButton
                                className="playBtn playBtn--sm"
                                track={{ id: ep.id, src: bustAudioUrl(ep.audioUrl, ep.updatedAt), title: ep.title, subtitle: ep.podcast?.name ?? undefined, href: `/studio/episodes/${ep.id}` }}
                              />
                            ) : (
                              <span className="showArt showArt--xs epLibArt" data-hue={ep.podcast ? showHue(ep.podcast.id) : undefined} aria-hidden="true">
                                {ep.podcast ? showInitials(ep.podcast.name) : "·"}
                              </span>
                            )}
                            <span className="epLibText">
                              <Link href={`/studio/episodes/${ep.id}`}>{ep.title}</Link>
                              <span className="subText">{ep.podcast?.name ?? "Standalone episode"}</span>
                            </span>
                          </span>
                        </td>
                        <td><span className={pillClass(ep.status, chip.kind)}>{ep.status === "failed" ? "Failed" : chip.label}</span></td>
                        <td className="num">{quality ? <span className="qualityNum" data-band={quality.total >= 80 ? "high" : quality.total >= 60 ? "mid" : "low"}>{quality.total}</span> : <span className="dimText">—</span>}</td>
                        <td className="num">{fmtDuration(ep.durationSeconds)}</td>
                        <td>{fmtUpdated(ep.updatedAt)}</td>
                        <td className="actions">
                          <Link href={`/studio/episodes/${ep.id}`} className="btnSubtle btnSm" aria-label={`Open ${ep.title}`}>
                            Open
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <Pager page={page} pageCount={pageCount} total={total} noun="episodes" hrefFor={(p) => hrefFor({ page: p })} />
        </>
      )}
    </div>
  );
}
