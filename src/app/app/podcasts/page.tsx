import React from "react";
import Link from "next/link";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/currentUser";
import { ownerScope } from "@/lib/ownerScope";
import { WEEKDAY_LABELS } from "./config";
import GenerateNowButton from "./GenerateNowButton";

export const dynamic = "force-dynamic";

export default async function PodcastsPage() {
  const user = await currentUser();
  const podcasts = await db.podcast
    .findMany({
      where: ownerScope(user),
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { episodes: true } } },
    })
    .catch(() => [] as any[]);

  return (
    <>
      <div className="uTopbar">
        <div>
          <h1 className="uPageTitle">Shows</h1>
          <div style={{ color: "var(--u-ink-2)", fontSize: "0.82rem", marginTop: 4 }}>
            Build a themed podcast with its own cast, rituals, recurring segments, and season storylines.
          </div>
        </div>
        <Link
          href="/app/podcasts/new"
          className="uPlayLg"
          data-testid="shows-open-show-forge"
          style={{ background: "var(--u-brand)", textDecoration: "none", padding: "0.6rem 1.3rem", fontSize: "0.86rem" }}
        >
          ✦ Open Show Forge
        </Link>
      </div>
      <div className="uContent" style={{ maxWidth: 900 }}>
        <div
          data-testid="show-forge-product-banner"
          style={{
            marginBottom: "1.4rem",
            padding: "1.2rem 1.3rem",
            borderRadius: 18,
            border: "1px solid var(--u-hairline-2)",
            background: "linear-gradient(135deg, var(--u-brand-soft), var(--u-surface))",
            display: "grid",
            gap: 8,
          }}
        >
          <div style={{ fontSize: "0.74rem", fontWeight: 900, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--u-brand)" }}>
            Show Forge is live
          </div>
          <div style={{ fontSize: "1.12rem", fontWeight: 900, color: "var(--u-ink)" }}>
            Create a real show—not just another isolated episode.
          </div>
          <div style={{ color: "var(--u-ink-2)", fontSize: "0.86rem", lineHeight: 1.55 }}>
            Choose the show’s promise, assign Host Studio characters, create recurring segments, and map storylines that move across future episodes.
          </div>
        </div>

        {podcasts.length === 0 ? (
          <div style={{ textAlign: "center", padding: "3.5rem 1rem", color: "var(--u-ink-2)" }}>
            <div style={{ fontSize: "2.2rem", marginBottom: "0.7rem" }}>🎙️</div>
            <p style={{ fontWeight: 800, marginBottom: "0.4rem", color: "var(--u-ink)" }}>No shows yet</p>
            <p style={{ fontSize: "0.88rem", marginBottom: "1.4rem" }}>Build the creative world once, then let every episode belong to it.</p>
            <Link href="/app/podcasts/new" className="uPlayLg" style={{ background: "var(--u-brand)", textDecoration: "none" }}>
              ✦ Build your first show
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
                    Open headquarters →
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
