"use client";

// Episode card + hero play controls — client components so they can drive
// the persistent player. Accents arrive as plain props from the server.

import React from "react";
import Link from "next/link";
import { usePlayer } from "./PlayerBar";

export interface CardEpisode {
  id: string;
  title: string;
  audioUrl: string | null;
  meta: string;
  emoji: string;
  accentSolid: string;
  accentSoft: string;
  accentTint: string;
  accentDeep: string;
}

export function EpisodeCard({ ep }: { ep: CardEpisode }) {
  const { play, track, playing } = usePlayer();
  const isCurrent = track?.id === ep.id;

  return (
    <div className="uEpCard">
      <Link href={`/app/episodes/${ep.id}`} aria-label={ep.title}>
        <div className="uEpCover" style={{ background: `linear-gradient(135deg, ${ep.accentSoft}, ${ep.accentTint} 70%)` }}>
          <span
            className={ep.emoji === "“" ? "quoteMark" : undefined}
            style={{ fontSize: ep.emoji === "“" ? "4.6rem" : "2.2rem", color: ep.emoji === "“" ? ep.accentSolid : undefined }}
            aria-hidden="true"
          >
            {ep.emoji}
          </span>
          {ep.audioUrl && (
            <button
              className="uEpPlay"
              style={{ background: ep.accentSolid, opacity: isCurrent ? 1 : undefined, transform: isCurrent ? "none" : undefined }}
              aria-label={isCurrent && playing ? `Pause ${ep.title}` : `Play ${ep.title}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                play({ id: ep.id, title: ep.title, audioUrl: ep.audioUrl!, accentSolid: ep.accentSolid, accentSoft: ep.accentSoft, coverEmoji: ep.emoji });
              }}
            >
              {isCurrent && playing ? "❚❚" : "▶"}
            </button>
          )}
        </div>
      </Link>
      <Link href={`/app/episodes/${ep.id}`} className="uEpTitle">{ep.title}</Link>
      <div className="uEpMeta">
        <span style={{ color: ep.accentDeep, fontWeight: 700 }}>Max & Doc</span>
        <span>·</span>
        <span>{ep.meta}</span>
      </div>
    </div>
  );
}

export function HeroPlay({ ep, label }: { ep: CardEpisode; label?: string }) {
  const { play, track, playing } = usePlayer();
  const isCurrent = track?.id === ep.id;
  if (!ep.audioUrl) {
    return (
      <Link href={`/app/episodes/${ep.id}`} className="uPlayLg" style={{ background: ep.accentSolid, textDecoration: "none" }}>
        View episode
      </Link>
    );
  }
  return (
    <button
      className="uPlayLg"
      style={{ background: ep.accentSolid }}
      onClick={() => play({ id: ep.id, title: ep.title, audioUrl: ep.audioUrl!, accentSolid: ep.accentSolid, accentSoft: ep.accentSoft, coverEmoji: ep.emoji })}
    >
      {isCurrent && playing ? "❚❚ Pause" : `▶ ${label || "Play episode"}`}
    </button>
  );
}
