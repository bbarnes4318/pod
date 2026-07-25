"use client";

// Episode-detail workspace — the organizing layer over the (many, powerful)
// per-episode panels. The header + quality score + player live ABOVE this as a
// fixed anchor; everything else is grouped into a small set of tabs so the user
// sees one focused workspace at a time instead of an endless vertical stack.
//
// Panels are rendered once and shown/hidden with `hidden` (not unmounted), so
// stateful children (MixView scrub position, TranscriptWorkspace edits,
// PublishPanel polling) keep their state across tab switches — and every panel
// still mounts on load exactly as it did in the old single-scroll layout.

import React, { useEffect, useState } from "react";

export interface WorkspaceTab {
  key: string;
  label: string;
  hint: string;
  node: React.ReactNode;
}

export default function EpisodeWorkspace({ tabs }: { tabs: WorkspaceTab[] }) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");

  // Tabs are addressable by hash (#transcript, #produce, …) so anything on the
  // page — notably the production console's "Read the draft" checkpoint CTA —
  // can send the user straight to the right panel instead of telling them to go
  // find a tab. Read on mount and follow subsequent hash changes.
  useEffect(() => {
    const applyHash = () => {
      const key = window.location.hash.replace(/^#/, "");
      if (key && tabs.some((t) => t.key === key)) setActive(key);
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
    // `tabs` is rebuilt each server render; key identity is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.map((t) => t.key).join(",")]);

  if (tabs.length === 0) return null;

  return (
    <div className="epWorkspace">
      <div className="epTabs" role="tablist" aria-label="Episode tools">
        {tabs.map((t) => {
          const isActive = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`eptab-${t.key}`}
              aria-selected={isActive}
              aria-controls={`eppanel-${t.key}`}
              className={`epTab${isActive ? " active" : ""}`}
              onClick={() => setActive(t.key)}
            >
              <span className="epTabLabel">{t.label}</span>
              <span className="epTabHint">{t.hint}</span>
            </button>
          );
        })}
      </div>

      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <div
            key={t.key}
            role="tabpanel"
            id={`eppanel-${t.key}`}
            aria-labelledby={`eptab-${t.key}`}
            hidden={!isActive}
            className="epTabPanel"
          >
            {t.node}
          </div>
        );
      })}
    </div>
  );
}
