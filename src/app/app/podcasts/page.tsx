import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { WEEKDAY_LABELS } from "./config";
import GenerateNowButton from "./GenerateNowButton";

export const dynamic = "force-dynamic";

export default async function PodcastsPage() {
  const user = await currentUser();
  // Scope to the signed-in user's shows plus legacy (pre-auth, ownerId=null)
  // podcasts so existing content stays visible. Logged-out visitors see only
  // the legacy/public shows.
  const ownerFilter = user
    ? { OR: [{ ownerId: user.id }, { ownerId: null }] }
    : { ownerId: null };
  const podcasts = await db.podcast
    .findMany({
      where: ownerFilter,
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { episodes: true } } },
    })
    .catch(() => [] as any[]);

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">My podcasts</h1>
        <Link href="/app/podcasts/new" className="uPlayLg" style={{ background: "var(--u-brand)", textDecoration: "none", padding: "0.6rem 1.3rem", fontSize: "0.86rem" }}>
          ＋ New podcast
        </Link>
      </div>
      <div className="uContent" style={{ maxWidth: 860 }}>
        {podcasts.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3.5rem 1rem", color: "var(--u-ink-2)" }}>
            <div style={{ fontSize: "2.2rem", marginBottom: "0.7rem" }}>🎙️</div>
            <p style={{ fontWeight: 700, marginBottom: "0.4rem", color: "var(--u-ink)" }}>No podcasts yet</p>
            <p style={{ fontSize: "0.88rem", marginBottom: "1.4rem" }}>Set one up once and Take Machine keeps the episodes coming.</p>
            <Link href="/app/podcasts/new" className="uPlayLg" style={{ background: "var(--u-brand)", textDecoration: "none" }}>
              Create your first podcast
            </Link>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem" }}>
            {podcasts.map((p: any) => (
              <div key={p.id} className="uTakeCard" style={{ justifyContent: "space-between" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="uTakeTitle" style={{ fontSize: "0.98rem" }}>{p.name}</div>
                  <div className="uTakeMeta" style={{ marginTop: "0.4rem", flexWrap: "wrap" }}>
                    <span className="uHeat" style={{ background: "var(--u-brand-soft)", color: "var(--u-brand)" }}>
                      {p.cadence === "recurring"
                        ? `🔁 ${p.scheduleDays.map((d: string) => (WEEKDAY_LABELS[d] || d).slice(0, 3)).join(" · ")}`
                        : "🎯 One-time"}
                    </span>
                    <span>{p.verticals.join(", ")}</span>
                    <span>{p.segmentCount} segment{p.segmentCount === 1 ? "" : "s"}</span>
                    <span>{p._count.episodes} episode{p._count.episodes === 1 ? "" : "s"}</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexShrink: 0 }}>
                  <GenerateNowButton podcastId={p.id} />
                  <Link href={`/app/podcasts/${p.id}`} className="uRecordBtn" style={{ textDecoration: "none" }}>
                    Manage →
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
