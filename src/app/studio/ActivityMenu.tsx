"use client";

// Production activity, visible from every page.
//
// Production takes minutes and the creator is rarely looking at the episode
// while it happens. This is the answer to "is it still going, and does it need
// me?" without opening anything: a lamp in the topbar and a list behind it.
//
// The list is the same read Studio Home renders (getStudioActivity), refreshed
// while the tab is visible. A failed refresh keeps the last good list and says
// so, rather than emptying the menu and implying nothing is running.

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "./StudioIcons";
import { getStudioActivity } from "./searchActions";
import type { ProductionItem, ProductionState, StudioProductions } from "./productions";

const POLL_MS = 30_000;

const STATE_LABEL: Record<ProductionState, string> = {
  failed: "Stopped",
  needs_you: "Needs you",
  stalled: "Stalled",
  running: "In production",
  ready: "Ready to release",
};

export function ProductionRow({ item, onNavigate }: { item: ProductionItem; onNavigate?: () => void }) {
  const pct = item.progress ? Math.round((item.progress.done / item.progress.total) * 100) : null;
  return (
    <Link href={item.href} className="prodRow" data-state={item.state} onClick={onNavigate}>
      <span className="prodRowLamp" aria-hidden="true" />
      <span className="prodRowBody">
        <span className="prodRowTitle">{item.title}</span>
        <span className="prodRowLine">
          <span className="prodRowState">{STATE_LABEL[item.state]}</span>
          <span className="prodRowHeadline">{item.headline}</span>
        </span>
        {item.progress && (
          <span className="prodRowMeter" role="img" aria-label={`${item.progress.done} of ${item.progress.total} lines voiced`}>
            <span className="prodRowMeterFill" style={{ "--fill": `${pct}%` } as React.CSSProperties} />
          </span>
        )}
      </span>
      <span className="prodRowShow">{item.showName ?? "Standalone"}</span>
    </Link>
  );
}

export default function ActivityMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<StudioProductions | null>(null);
  const [stale, setStale] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    getStudioActivity()
      .then((next) => {
        setData(next);
        setStale(false);
      })
      .catch(() => setStale(true));
  }, []);

  // Refresh on every navigation (an action elsewhere probably changed things),
  // then on a timer, and immediately when the tab comes back into view.
  useEffect(() => {
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, pathname]);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const items = data?.items ?? [];
  const attention = items.filter((i) => i.state === "failed" || i.state === "needs_you" || i.state === "stalled").length;
  const running = items.filter((i) => i.state === "running").length + (data?.more ?? 0);
  const tone = attention > 0 ? "attention" : running > 0 ? "running" : "idle";
  const summary =
    attention > 0
      ? `${attention} need${attention === 1 ? "s" : ""} you`
      : running > 0
        ? `${running} in production`
        : "Nothing in production";

  return (
    <div className="studioActivity" ref={ref}>
      <button
        type="button"
        className="studioActivityBtn"
        data-tone={tone}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Production activity: ${summary}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="studioActivityLamp" aria-hidden="true" />
        {Icon.activity}
        {attention + running > 0 && <span className="studioActivityCount">{attention > 0 ? attention : running}</span>}
      </button>

      {open && (
        <div className="studioActivityMenu" role="dialog" aria-label="Production activity">
          <div className="studioActivityHead">
            <span className="studioActivityTitle">Production activity</span>
            <span className="studioActivitySummary">{stale ? "Could not refresh. Showing the last update." : summary}</span>
          </div>
          {data === null ? (
            <div className="studioActivityEmpty">{stale ? "Activity is unavailable right now." : "Checking production…"}</div>
          ) : items.length === 0 ? (
            <div className="studioActivityEmpty">
              Nothing is in production. You can leave this page while an episode is being made: it carries on, and shows up here.
            </div>
          ) : (
            <div className="studioActivityList">
              {items.slice(0, 8).map((item) => (
                <ProductionRow key={item.episodeId} item={item} onNavigate={() => setOpen(false)} />
              ))}
            </div>
          )}
          <Link href="/studio/episodes?view=progress" className="studioActivityFoot" onClick={() => setOpen(false)}>
            All episodes in production
          </Link>
        </div>
      )}
    </div>
  );
}
