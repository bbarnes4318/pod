// Shared cover art for episode cards + hero. No client hooks — usable from
// both server pages and client components.

import React from "react";

export interface CoverEpisode {
  id: string;
  title: string;
  emoji: string;
  accentSolid: string;
  accentSoft: string;
  accentDeep: string;
  score?: number | null;
}

/** Deterministic waveform silhouette per episode (stable SSR/client). */
export function waveBars(seedStr: string, n = 26, min = 5, range = 20): number[] {
  let a = 7;
  for (const c of seedStr) a = ((a * 31 + c.charCodeAt(0)) & 0xffffffff) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    a = (a * 1664525 + 1013904223) >>> 0;
    const r = a / 4294967296;
    const envelope = 0.55 + 0.45 * Math.sin((i / n) * Math.PI * 1.15 + 0.4);
    out.push(min + Math.round(r * range * envelope));
  }
  return out;
}

/** Saturated content-derived cover: the solid hue owns the card; soft base where the waveform sits. */
export function coverStyle(ep: Pick<CoverEpisode, "accentSolid" | "accentSoft">): React.CSSProperties {
  return { background: `linear-gradient(160deg, ${ep.accentSolid} 0%, ${ep.accentSolid} 58%, ${ep.accentSoft} 100%)` };
}

export function CoverArt({ ep, waveHeight = 22, emojiSize = "2.6rem" }: { ep: CoverEpisode; waveHeight?: number; emojiSize?: string }) {
  const bars = waveBars(ep.id + ep.title, 26, 5, waveHeight - 4);
  const quoteSize = `calc(${emojiSize} * 1.8)`;
  return (
    <>
      <span
        className={ep.emoji === "“" ? "quoteMark" : undefined}
        style={{
          fontSize: ep.emoji === "“" ? quoteSize : emojiSize,
          color: ep.emoji === "“" ? "rgba(255,255,255,0.95)" : undefined,
          filter: ep.emoji === "“" ? undefined : "drop-shadow(0 2px 6px rgba(22,24,29,0.25))",
          marginBottom: waveHeight + 6,
        }}
        aria-hidden="true"
      >
        {ep.emoji}
      </span>
      {typeof ep.score === "number" && (
        <span className="uScoreBadge onCover" style={{ color: ep.accentDeep }}>
          {ep.score}
          <small>SCORE</small>
        </span>
      )}
      <span className="uWaveMotif" style={{ height: waveHeight }} aria-hidden="true">
        {bars.map((h, i) => (
          <span key={i} style={{ height: h, background: ep.accentSolid, opacity: 0.9 }} />
        ))}
      </span>
    </>
  );
}
