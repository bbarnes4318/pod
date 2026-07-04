import React from "react";
import Link from "next/link";
import { getDiscoverData } from "./discoverData";
import { accentFor, accentForSport } from "./accent";
import { EpisodeCard, HeroPlay, CardEpisode } from "./EpisodeCard";

export const dynamic = "force-dynamic";

const SPORT_EMOJI: Record<string, string> = {
  basketball: "🏀", football: "🏈", baseball: "⚾", soccer: "⚽", hockey: "🏒", "combat sports": "🥊",
};

function emojiFor(title: string, sport?: string): string {
  const s = (sport || "").toLowerCase();
  if (SPORT_EMOJI[s]) return SPORT_EMOJI[s];
  const t = title.toLowerCase();
  if (/nba|basket|seed|dunk|court|lakers|luka|lebron/.test(t)) return "🏀";
  if (/nfl|draft|quarterback|football|trade/.test(t)) return "🏈";
  if (/messi|soccer|argentina|world cup|goal|marsch/.test(t)) return "⚽";
  if (/mlb|baseball|inning/.test(t)) return "⚾";
  if (/fight|ufc|knockout|octagon/.test(t)) return "🥊";
  // Editorial fallback: a big typographic quote mark (always renders crisply)
  return "“";
}

function fmtDur(s: number | null): string {
  if (!s) return "—";
  return `${Math.round(s / 60)} min`;
}

export default async function DiscoverPage() {
  const data = await getDiscoverData();

  const cards: CardEpisode[] = data.episodes.map((e) => {
    const a = accentFor(e.title);
    return {
      id: e.id,
      title: e.title,
      audioUrl: e.audioUrl,
      meta: fmtDur(e.durationSeconds),
      emoji: emojiFor(e.title),
      accentSolid: a.solid,
      accentSoft: a.soft,
      accentTint: a.tint,
      accentDeep: a.deep,
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
            <div className="uHeroCover" style={{ background: `linear-gradient(140deg, ${featured.accentSoft}, ${featured.accentTint} 65%, #fff)` }}>
              <span
                className={featured.emoji === "“" ? "quoteMark" : undefined}
                style={{ fontSize: featured.emoji === "“" ? "10rem" : "5.5rem", color: featured.emoji === "“" ? featured.accentSolid : undefined }}
                aria-hidden="true"
              >
                {featured.emoji}
              </span>
              <span
                aria-hidden="true"
                style={{ position: "absolute", bottom: 14, left: 14, right: 14, display: "flex", alignItems: "flex-end", gap: 3, height: 26, opacity: 0.5 }}
              >
                {[12, 22, 9, 26, 16, 24, 11, 19, 25, 8, 21, 14, 24, 10, 18, 23, 12, 20].map((h, i) => (
                  <span key={i} style={{ flex: 1, height: h, borderRadius: 2, background: featured.accentSolid }} />
                ))}
              </span>
            </div>
            <div>
              <div className="uHeroKicker" style={{ color: featured.accentDeep }}>
                {data.episodes[0].status === "published" ? "Latest episode" : "Fresh off the mix"}
              </div>
              <h2 className="uHeroTitle">{featured.title}</h2>
              <div className="uHeroMeta">
                <span style={{ fontWeight: 650, color: "var(--u-ink-2)" }}>Max Voltage & Dr. Linebreak</span>
                <span className="uDot" />
                <span>{featured.meta}</span>
                <span className="uDot" />
                <span>AI sports debate</span>
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
                  <div className="uTakeScore" style={{ background: a.tint, color: a.deep }}>
                    {Math.round(t.debateScore)}
                    <small>DEBATE</small>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="uTakeTitle">{t.title}</div>
                    <div className="uTakeMeta">
                      <span>{emojiFor(t.title, t.sport)} {t.sport}</span>
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
