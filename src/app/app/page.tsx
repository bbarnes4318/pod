import React from "react";
import Link from "next/link";
import { getDiscoverData } from "./discoverData";
import { accentForSport } from "./accent";
import { EpisodeCard, HeroPlay, CardEpisode } from "./EpisodeCard";
import { CoverArt, coverStyle } from "./cover";
import { emojiForTitle, sportFromTitle } from "./lib";

export const dynamic = "force-dynamic";

function fmtDur(s: number | null): string {
  if (!s) return "—";
  return `${Math.round(s / 60)} min`;
}

export default async function DiscoverPage() {
  const data = await getDiscoverData();

  const cards: CardEpisode[] = data.episodes.map((e) => {
    const a = accentForSport(sportFromTitle(e.title), e.title);
    return {
      id: e.id,
      title: e.title,
      audioUrl: e.audioUrl,
      meta: fmtDur(e.durationSeconds),
      emoji: emojiForTitle(e.title),
      accentSolid: a.solid,
      accentSoft: a.soft,
      accentTint: a.tint,
      accentDeep: a.deep,
      score: e.score,
      description: e.description,
    };
  });

  const featured = cards[0] ?? null;
  const fresh = cards.slice(1);

  return (
    <>
      <div className="uTopbar">
        <h1 className="uPageTitle">Discover</h1>
        <div className="uTopRight">
          <label className="uSearch">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input placeholder="Search episodes, takes…" aria-label="Search" />
          </label>
          <div className="uAvatar" aria-label="Account">TM</div>
        </div>
      </div>

      <div className="uContent">
        {data.isPreviewData && (
          <div style={{ fontSize: "0.72rem", color: "var(--u-ink-3)", marginBottom: "0.75rem" }}>
            Preview data (local dev — no database connected)
          </div>
        )}

        {/* ---- HERO / FEATURED ---- */}
        {featured ? (
          <section className="uHero" aria-label="Featured episode">
            <div className="uHeroCover" style={coverStyle(featured)}>
              <CoverArt ep={{ ...featured, score: null }} waveHeight={42} emojiSize="5.2rem" />
            </div>
            <div>
              <div className="uHeroKicker" style={{ color: featured.accentDeep }}>
                {data.episodes[0].status === "published" ? "Latest episode" : "Fresh off the mix"}
              </div>
              <h2 className="uHeroTitle">{featured.title}</h2>
              {featured.description && <p className="uHeroDesc">{featured.description}</p>}
              <div className="uHeroMeta">
                <span className="uHostAvas" aria-hidden="true">
                  <span className="uHostAva" style={{ background: "#E86A5E" }}>MV</span>
                  <span className="uHostAva" style={{ background: "#3E7BD6" }}>DL</span>
                </span>
                <span style={{ fontWeight: 650, color: "var(--u-ink-2)" }}>Max Voltage & Dr. Linebreak</span>
                <span className="uDot" />
                <span>{featured.meta}</span>
                {typeof featured.score === "number" && (
                  <span
                    className="uScoreBadge inHero"
                    style={{ background: featured.accentTint, color: featured.accentDeep }}
                  >
                    {featured.score}
                    <small>/100 SHOW SCORE</small>
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: "0.7rem", flexWrap: "wrap" }}>
                <HeroPlay ep={featured} />
                <Link href={`/app/episodes/${featured.id}`} className="uGhostBtn" style={{ textDecoration: "none" }}>
                  Details
                </Link>
                <button className="uGhostBtn" aria-label="Share episode">Share</button>
              </div>
            </div>
          </section>
        ) : (
          <section className="uHero" style={{ gridTemplateColumns: "1fr", textAlign: "center", padding: "3rem" }}>
            <div>
              <h2 className="uHeroTitle">Your first episode starts with a take</h2>
              <p style={{ color: "var(--u-ink-2)", marginBottom: "1.4rem" }}>Pick a hot topic below and Take Machine turns it into a full debate episode.</p>
              <Link href="/app/create" className="uPlayLg" style={{ background: "var(--u-brand)", textDecoration: "none" }}>＋ Create an episode</Link>
            </div>
          </section>
        )}

        {/* ---- FRESH EPISODES ---- */}
        {fresh.length > 0 && (
          <>
            <div className="uSectionHead">
              <h2 className="uSectionTitle">Fresh episodes</h2>
              <Link href="/app/episodes" className="uSectionLink">See all</Link>
            </div>
            <div className="uRow">
              {fresh.map((ep) => (
                <EpisodeCard key={ep.id} ep={ep} />
              ))}
            </div>
          </>
        )}

        {/* ---- TRENDING TAKES ---- */}
        <div className="uSectionHead">
          <h2 className="uSectionTitle">Trending takes to record</h2>
          <Link href="/app/topics" className="uSectionLink">Browse all takes</Link>
        </div>
        {data.takes.length === 0 ? (
          <p style={{ color: "var(--u-ink-3)", fontSize: "0.88rem" }}>No takes on the board right now — check back soon.</p>
        ) : (
          <div className="uTakes">
            {data.takes.map((t) => {
              const a = accentForSport(t.sport, t.title);
              const hot = t.debateScore >= 75;
              return (
                <div key={t.id} className="uTakeCard">
                  <div className="uTakeScore" style={{ background: a.solid, color: "#fff" }}>
                    {Math.round(t.debateScore)}
                    <small>DEBATE</small>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="uTakeTitle">{t.title}</div>
                    <div className="uTakeMeta">
                      <span style={{ color: a.deep, fontWeight: 700 }}>{emojiForTitle(t.title, t.sport)} {t.sport}</span>
                      {hot && (
                        <span className="uHeat" style={{ background: a.soft, color: a.deep }}>
                          🔥 Hot
                        </span>
                      )}
                    </div>
                  </div>
                  <Link href={`/app/create?topic=${t.id}`} className="uRecordBtn" style={{ textDecoration: "none" }}>
                    Record this
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
