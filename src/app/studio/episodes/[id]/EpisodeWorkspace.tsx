"use client";

// Episode-detail workspace — the organizing layer over the (many, powerful)
// per-episode panels. The header + quality score + player live ABOVE this as a
// fixed anchor; everything else is grouped into a small set of tabs so the user
// sees one focused workspace at a time instead of an endless vertical stack.
//
// Panels mount on FIRST VISIT and are never unmounted after that. Once mounted
// they are shown/hidden with `hidden`, so stateful children (MixView scrub
// position, TranscriptWorkspace edits, PublishPanel polling) keep their state
// across tab switches.
//
// They used to all mount on page load. Every panel that fetches or polls on
// mount — publishing assets, the social clip, the diversity report — did so on
// every episode page view, including for the majority of views that only ever
// look at the overview. Deferring costs nothing on the tab you are looking at
// and skips the work for the ones you are not.

import React, { useEffect, useState } from "react";

export interface WorkspaceTab {
  key: string;
  label: string;
  hint: string;
  node: React.ReactNode;
  /** Where this stage sits in the episode's life. Omit for non-stage tabs. */
  state?: "done" | "current" | "todo";
  /** Older hashes that should open this tab (#promote opens Release). */
  aliases?: string[];
}

const STATE_WORD = { done: "Done", current: "Current step", todo: "Not started" } as const;

export default function EpisodeWorkspace({ tabs, initialKey }: { tabs: WorkspaceTab[]; initialKey?: string }) {
  const first = tabs.some((t) => t.key === initialKey) ? initialKey! : tabs[0]?.key ?? "";
  const [active, setActive] = useState(first);
  // Every tab that has ever been opened. Add-only: a panel is never torn down,
  // so nothing a user typed into one is lost by looking at another.
  const [seen, setSeen] = useState<Set<string>>(() => new Set(first ? [first] : []));
  const open = (key: string) => {
    setActive(key);
    setSeen((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  };

  // Tabs are addressable by hash (#transcript, #produce, …) so anything on the
  // page — notably the production console's "Read the draft" checkpoint CTA —
  // can send the user straight to the right panel instead of telling them to go
  // find a tab. Read on mount and follow subsequent hash changes.
  useEffect(() => {
    const applyHash = () => {
      const key = window.location.hash.replace(/^#/, "");
      const hit = key ? tabs.find((t) => t.key === key || t.aliases?.includes(key)) : null;
      if (hit) open(hit.key);
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
              data-state={t.state}
              onClick={() => open(t.key)}
            >
              <span className="epTabLabel">
                {t.state && <span className="epTabLamp" aria-hidden="true" />}
                {t.label}
                {t.state && <span className="srOnly"> ({STATE_WORD[t.state]})</span>}
              </span>
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
            {seen.has(t.key) ? t.node : null}
          </div>
        );
      })}
    </div>
  );
}
