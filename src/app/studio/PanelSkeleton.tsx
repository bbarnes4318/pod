// Shared panel-level loading placeholder.
//
// The studio's per-episode panels each fetch their own view-model on mount, and
// each used to collapse to a single line of muted text ("Loading mix…") while
// they did. That reads as an empty page and shifts the layout when the real
// panel lands. This holds a panel-shaped footprint instead.
//
// No "use client" directive: it renders no interactivity, so it works as a
// child of both server and client components.

import React from "react";

export default function PanelSkeleton({
  label,
  rows = 3,
  toolbar = true,
}: {
  /** Accessible name — what the user is waiting for, e.g. "Loading the mix". */
  label: string;
  /** Body lines to reserve, tuned per panel to match its real height. */
  rows?: number;
  /** Reserve the panel's control strip too. */
  toolbar?: boolean;
}) {
  return (
    <div className="skelBlock" role="status" aria-busy="true" aria-label={label}>
      <span className="srOnly">{label}</span>
      {toolbar && (
        <div className="skelRow mb-4">
          <div className="skelChip" />
          <div className="skelChip skelChip--sm" />
          <div className="skelChip skelChip--xs" />
        </div>
      )}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={`skelLine${i === rows - 1 ? " skelLine--short" : ""}`} />
      ))}
    </div>
  );
}
