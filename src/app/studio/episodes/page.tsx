import React from "react";
import StudioPageHeader from "../StudioPageHeader";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { qualityOf, fmtDuration, statusChip, FINISHED_STATUSES } from "../lib";
import { Icon } from "../StudioIcons";

export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "all", label: "All" },
  { key: "progress", label: "In production" },
  { key: "ready", label: "Ready" },
  { key: "live", label: "Live" },
  { key: "attention", label: "Needs attention" },
] as const;
type ViewKey = (typeof VIEWS)[number]["key"];

function viewOf(status: string, hasAudio: boolean): Exclude<ViewKey, "all"> {
  if (status === "failed") return "attention";
  if (status === "published") return "live";
  if (FINISHED_STATUSES.includes(status) || hasAudio) return "ready";
  return "progress";
}

function pillClass(status: string, kind: "accent" | "success" | "plain"): string {
  if (status === "failed") return "statusPill statusPill--err";
  if (status === "published") return "statusPill statusPill--ok";
  if (status === "script_draft") return "statusPill statusPill--warn";
  if (kind === "accent" || kind === "success") return "statusPill statusPill--live";
  return "statusPill";
}

const fmtUpdated = (d: Date) =>
  new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(d).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

export default async function EpisodesLibrary({ searchParams }: { searchParams: Promise<{ view?: string; q?: string }> }) {
  // Scoped to the viewer: this page previously ran an unscoped findMany and
  // listed every episode on the deployment to every account.
  const user = await currentUser();
  const { view: rawView, q: rawQ } = await searchParams;
  const view: ViewKey = VIEWS.some((v) => v.key === rawView) ? (rawView as ViewKey) : "all";
  const q = (rawQ ?? "").trim();

  const episodes = await db.episode.findMany({
    where: ownerScope(user),
    orderBy: { updatedAt: "desc" },
    take: 200,
    include: {
      scripts: { orderBy: { version: "desc" }, take: 1, select: { id: true, content: true } },
      podcast: { select: { id: true, name: true } },
    },
  });

  const counts: Record<ViewKey, number> = { all: episodes.length, progress: 0, ready: 0, live: 0, attention: 0 };
  for (const ep of episodes) counts[viewOf(ep.status, !!ep.audioUrl)] += 1;

  const needle = q.toLowerCase();
  const rows = episodes.filter(
    (ep) =>
      (view === "all" || viewOf(ep.status, !!ep.audioUrl) === view) &&
      (!needle || ep.title.toLowerCase().includes(needle) || (ep.podcast?.name ?? "").toLowerCase().includes(needle))
  );
  const hrefFor = (v: ViewKey) => {
    const p = new URLSearchParams();
    if (v !== "all") p.set("view", v);
    if (q) p.set("q", q);
    const s = p.toString();
    return s ? `/studio/episodes?${s}` : "/studio/episodes";
  };

  return (
    <div className="fadeUp">
      <StudioPageHeader
        title="Episodes"
        subtitle="Every episode across your shows, newest activity first."
        status={<span className="sectionCount">{episodes.length} total</span>}
      />

      {episodes.length === 0 ? (
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
                <Link key={v.key} href={hrefFor(v.key)} aria-current={view === v.key ? "page" : undefined}>
                  {v.label}
                  <span className="segCount">{counts[v.key]}</span>
                </Link>
              ))}
            </nav>
            <form className="listSearch" action="/studio/episodes" role="search">
              {view !== "all" && <input type="hidden" name="view" value={view} />}
              <span className="listSearchIcon">{Icon.search}</span>
              <input className="input" type="search" name="q" defaultValue={q} placeholder="Search by title or show" aria-label="Search episodes" />
            </form>
          </div>

          {rows.length === 0 ? (
            <div className="emptyState">
              <div className="emptyStateTitle">No episodes match</div>
              <p className="emptyStateBody">Nothing in this view{q ? ` matches “${q}”` : ""}.</p>
              <Link href="/studio/episodes" className="btnGhost">Clear filters</Link>
            </div>
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
                  {rows.map((ep) => {
                    const chip = statusChip(ep.status);
                    const quality = qualityOf(ep.scripts[0]);
                    return (
                      <tr key={ep.id}>
                        <td className="primaryCell">
                          <Link href={`/studio/episodes/${ep.id}`}>{ep.title}</Link>
                          <span className="subText">{ep.podcast?.name ?? "Standalone episode"}</span>
                        </td>
                        <td><span className={pillClass(ep.status, chip.kind)}>{ep.status === "failed" ? "Failed" : chip.label}</span></td>
                        <td className="num">{quality ? <span className="qualityNum" data-band={quality.total >= 80 ? "high" : quality.total >= 60 ? "mid" : "low"}>{quality.total}</span> : <span className="dimText">—</span>}</td>
                        <td className="num">{fmtDuration(ep.durationSeconds)}</td>
                        <td>{fmtUpdated(ep.updatedAt)}</td>
                        <td className="actions">
                          <Link href={`/studio/episodes/${ep.id}`} className="btnSubtle btnSm" aria-label={`Open ${ep.title}`}>
                            {ep.audioUrl ? "Listen" : "Open"}
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
