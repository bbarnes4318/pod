import React from "react";

/**
 * A league, conference, or team crest.
 *
 * Two things it exists to handle, both of which come out of the real asset
 * set rather than a preference:
 *
 *   · SOME MARKS ARE DARK IN EVERY VARIANT. The manifest measures each logo
 *     and flags those (`plate`); on a #0E1116 surface they are invisible, so
 *     they get a light plate behind them instead of shipping a blank square.
 *
 *   · SOME ENTRIES HAVE NO ART AT ALL. `cfb-logos/fbs-independents` is an
 *     empty folder, and neither college league ships a league mark. Rather
 *     than a hole in the grid, those fall back to a monogram. It replaces the
 *     image rather than sitting under it: logos are transparent PNGs and SVGs,
 *     so an underlay reads as the abbreviation ghosting through the crest.
 *
 * Plain <img> and not next/image on purpose: these are ~600 small static files
 * already in /public, served straight from the CDN edge, and the optimiser
 * would add a per-variant transform for no gain at 28-64px.
 */
export default function BoardLogo({
  src,
  alt,
  plate,
  monogram,
  size = "md",
}: {
  src?: string | null;
  /** Empty string when a visible label already names the thing. */
  alt: string;
  plate?: boolean;
  /** Shown when there is no art — usually the team abbreviation. */
  monogram?: string;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const classes = ["boardLogo", `boardLogo--${size}`];
  if (plate) classes.push("boardLogo--plate");

  return (
    <span className={classes.join(" ")}>
      {src ? (
        <img className="boardLogoImg" src={src} alt={alt} loading="lazy" decoding="async" />
      ) : (
        monogram && <span className="boardLogoMonogram">{monogram}</span>
      )}
    </span>
  );
}
