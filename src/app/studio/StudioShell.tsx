"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/lib/authActions";

/* ------------------------------------------------------------------ *
 * Page header channel.
 *
 * The topbar belongs to the shell but its title belongs to the page,
 * and RSC cannot pass data upward. Pages publish here through
 * <StudioPageHeader>; the shell renders whatever is current.
 * ------------------------------------------------------------------ */
export type StudioHeaderCrumb = { label: string; href: string };
/** Where "Back" goes, and what it says it is going to. */
export type StudioBack = { label: string; href: string };

/** Only PRIMITIVES travel through context. Elements (actions/status) portal
 *  into the slots below — see the note in StudioPageHeader for why mixing them
 *  here produced an infinite render loop. */
export interface StudioHeaderState {
  title?: string;
  subtitle?: string;
  breadcrumb?: StudioHeaderCrumb[];
  back?: StudioBack;
}

type HeaderPublish = StudioHeaderState & { id: string; clear?: boolean };

const StudioHeaderContext = createContext<{ setHeader: (next: HeaderPublish) => void }>({
  setHeader: () => {},
});

export function useStudioHeader() {
  return useContext(StudioHeaderContext);
}

/**
 * Fallback titles, so the topbar is never empty on first paint and never
 * empty for a route that has not adopted <StudioPageHeader> yet. Longest
 * prefix wins, so /studio/shows/new resolves before /studio/shows.
 */
const ROUTE_TITLES: { prefix: string; title: string; exact?: boolean }[] = [
  { prefix: "/studio", title: "The Board", exact: true },
  { prefix: "/studio/shows/new", title: "Build your show" },
  { prefix: "/studio/shows", title: "Shows" },
  { prefix: "/studio/create", title: "Create an episode" },
  { prefix: "/studio/episodes", title: "Episodes" },
  { prefix: "/studio/takes", title: "Takes" },
  { prefix: "/studio/hosts", title: "Hosts" },
  { prefix: "/studio/auditions", title: "Voice auditions" },
  { prefix: "/studio/audio", title: "Audio" },
  { prefix: "/studio/publish", title: "Publishing" },
  { prefix: "/studio/analytics", title: "Analytics" },
  { prefix: "/studio/plan", title: "Plan and usage" },
  { prefix: "/studio/settings", title: "Settings" },
];

function fallbackTitle(pathname: string): string {
  let best = "Studio";
  let bestLen = -1;
  for (const entry of ROUTE_TITLES) {
    const hit = entry.exact ? pathname === entry.prefix : pathname === entry.prefix || pathname.startsWith(entry.prefix + "/") || pathname === entry.prefix;
    if (hit && entry.prefix.length > bestLen) {
      best = entry.title;
      bestLen = entry.prefix.length;
    }
  }
  return best;
}

/**
 * Where Back goes when a page has not said.
 *
 * Hierarchical, not `history.back()`. History is whatever the visitor did last
 * — it can lead out of the app entirely, or bounce between two pages forever —
 * so a control labelled with a destination cannot honestly be driven by it.
 * Dropping the last path segment is predictable, right-clickable, and always
 * lands somewhere that exists.
 *
 * Returns null only for /studio itself, which is the top: a Back button there
 * would have nowhere to go, and a dead control is worse than no control.
 */
function derivedBack(pathname: string): StudioBack | null {
  const clean = pathname.replace(/\/+$/, "");
  if (clean === "/studio" || !clean.startsWith("/studio")) return null;
  const parent = clean.slice(0, clean.lastIndexOf("/")) || "/studio";
  return { href: parent, label: fallbackTitle(parent) };
}

/* ------------------------------------------------------------------ *
 * Navigation model. Studio owns the complete creator journey:
 * Board · Shows · Create · Episodes · Takes · Hosts · Publishing.
 * ------------------------------------------------------------------ */
type NavItem = { href: string; label: string; exact?: boolean; icon: React.ReactNode };

const I = {
  board: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
    </svg>
  ),
  shows: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3.25" /><path d="M12 15.25V21" />
    </svg>
  ),
  create: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v18M3 12h18" />
    </svg>
  ),
  episodes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12v0M8 8v8M12 5v14M16 9v6M20 12v0" />
    </svg>
  ),
  takes: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3c1.5 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.2.4-2.2 1-3 .2 1 .8 1.6 1.5 1.8C10.6 7.7 10.5 5.2 12 3Z" />
    </svg>
  ),
  hosts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M8 21h8" />
    </svg>
  ),
  publishing: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  analytics: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="5" /><rect x="12" y="8" width="3" height="9" /><rect x="17" y="5" width="3" height="12" />
    </svg>
  ),
  plan: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2l2.4 5 5.6.8-4 3.9 1 5.6L12 20l-5 2.6 1-5.6-4-3.9 5.6-.8z" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  ),
};

const NAV: NavItem[] = [
  { href: "/studio", label: "The Board", exact: true, icon: I.board },
  { href: "/studio/shows", label: "Shows", icon: I.shows },
  { href: "/studio/create", label: "Create", icon: I.create },
  { href: "/studio/episodes", label: "Episodes", icon: I.episodes },
  { href: "/studio/takes", label: "Takes", icon: I.takes },
  { href: "/studio/hosts", label: "Hosts", icon: I.hosts },
  { href: "/studio/publish", label: "Publishing", icon: I.publishing },
  { href: "/studio/analytics", label: "Analytics", icon: I.analytics },
  { href: "/studio/plan", label: "Plan", icon: I.plan },
  { href: "/studio/settings", label: "Settings", icon: I.settings },
];

const RAIL_KEY = "tm.studio.rail.collapsed";

type ShellUser = { name: string | null; email: string | null };

function initialsFor(user?: ShellUser): string {
  const source = user?.name?.trim() || user?.email?.trim() || "";
  if (!source) return "TM";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[1]?.[0] ?? "" : "");
  return (letters || source[0]).toUpperCase();
}

export default function StudioShell({ user, children }: { user?: ShellUser; children: React.ReactNode }) {
  const pathname = usePathname() || "/studio";
  const displayName = user?.name?.trim() || user?.email?.trim() || "Your account";
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  // Whatever page is currently mounted owns the topbar. `ownerId` guards the
  // React unmount order: on navigation the incoming page's effect runs before
  // the outgoing page's cleanup, so a naive setState(null) on unmount would
  // wipe the title that just arrived.
  const [header, setHeaderState] = useState<StudioHeaderState & { ownerId?: string }>({});
  const setHeader = useCallback((next: HeaderPublish) => {
    setHeaderState((current) => {
      if (next.clear) return current.ownerId === next.id ? {} : current;
      const { id, clear: _clear, ...rest } = next;
      return { ...rest, ownerId: id };
    });
  }, []);
  const headerApi = useMemo(() => ({ setHeader }), [setHeader]);

  const pageTitle = header.title ?? fallbackTitle(pathname);
  // A page's own declaration wins; then the nearest breadcrumb, which is
  // already the parent by construction; then the path.
  const lastCrumb = header.breadcrumb?.length ? header.breadcrumb[header.breadcrumb.length - 1] : null;
  const back = header.back ?? lastCrumb ?? derivedBack(pathname);

  useEffect(() => {
    try {
      if (localStorage.getItem(RAIL_KEY) === "1") setCollapsed(true);
    } catch {}
  }, []);

  useEffect(() => {
    setMobileOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const toggleRail = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem(RAIL_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");

  return (
    <StudioHeaderContext.Provider value={headerApi}>
    <div className="studioShell" data-collapsed={collapsed ? "true" : "false"} data-mobile-open={mobileOpen ? "true" : "false"}>
      <aside className="studioSidebar" aria-label="Studio navigation">
        <Link href="/studio" className="studioBrand" aria-label="Take Machine — Studio home">
          <span className="onAirDot" aria-hidden="true" />
          <span className="studioBrandWord">Take<em>Machine</em></span>
        </Link>

        <nav className="studioNavList" aria-label="Primary">
          {NAV.map((item) => {
            const active = isActive(item);
            return (
              <Link key={item.href} href={item.href} className={`studioNavLink${active ? " active" : ""}`} aria-current={active ? "page" : undefined} title={item.label}>
                <span className="studioNavIcon">{item.icon}</span>
                <span className="studioNavLabel">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <button type="button" className="studioRailToggle" onClick={toggleRail} aria-pressed={collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
          <span className="studioRailToggleLabel">Collapse</span>
        </button>
      </aside>

      {mobileOpen && <button type="button" className="studioScrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}

      <div className="studioBody">
        <header className="studioTopbar">
          <div className="studioTopbarLeft">
            <button type="button" className="studioHamburger" aria-label="Open navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
            <Link href="/studio" className="studioTopbarBrand" aria-label="Take Machine — Studio home"><span className="onAirDot" aria-hidden="true" />Take<em>Machine</em></Link>
          </div>

          {/* The page's identity, in the bar that used to hold none of it. */}
          <div className="studioTopbarHead">
            {/* Back sits in the SAME PLACE on every page — the thing that makes
                it feel like a control rather than a link that happens to point
                upward. It names its destination, so nobody has to click it to
                find out where it goes.

                Resolution order, most specific first: a page that declares its
                own parent (the Board's drill-down, whose parent lives in the
                query string, not the path) beats the last breadcrumb, which
                beats dropping a path segment. */}
            {back && (
              <Link href={back.href} className="studioBack" aria-label={`Back to ${back.label}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
                <span className="studioBackLabel">{back.label}</span>
              </Link>
            )}
            {header.breadcrumb?.length ? (
              <nav className="studioCrumbs" aria-label="Breadcrumb">
                {header.breadcrumb.map((crumb) => (
                  <Link key={crumb.href} href={crumb.href} className="studioCrumb">
                    {crumb.label}
                  </Link>
                ))}
              </nav>
            ) : null}
            <div className="studioTopbarTitle" title={pageTitle}>{pageTitle}</div>
          </div>

          <div className="studioTopbarRight">
            <div className="studioTopbarActions" id="studio-topbar-actions" />
            {/* Below 720px .studioGenerateLabel is display:none and the icon is
                aria-hidden, which left this link with NO accessible name at all
                — axe reports it as a serious link-name violation on every
                mobile route. The label is explicit so it survives the media
                query. Same reason for the account button below. */}
            <Link href="/studio/create" className="studioGenerateBtn" aria-label="Generate an episode">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z" /></svg>
              <span className="studioGenerateLabel">Generate</span>
            </Link>

            <div className="studioAccount" ref={accountRef}>
              <button
                type="button"
                className="studioAccountBtn"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={`Account menu for ${displayName}`}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span className="studioAvatar" aria-hidden="true">{initialsFor(user)}</span>
                <span className="studioAccountName">{displayName}</span>
                <svg className="studioAccountCaret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>

              {menuOpen && (
                <div className="studioAccountMenu" role="menu">
                  <div className="studioAccountMenuHead">
                    <div className="studioAccountMenuName">{displayName}</div>
                    <div className="studioAccountMenuSub">{user?.email ? "Signed in" : "Studio"}</div>
                  </div>
                  <Link href="/studio/settings" className="studioAccountMenuItem" role="menuitem">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6 6l1.5 1.5M18 18l-1.5-1.5M18 6l-1.5 1.5M6 18l1.5-1.5" /></svg>
                    Settings
                  </Link>
                  <Link href="/admin" className="studioAccountMenuItem" role="menuitem">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 14h4" /></svg>
                    Ops Console
                  </Link>
                  <Link href="/app" className="studioAccountMenuItem" role="menuitem">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                    Listener view
                  </Link>
                  <form action={logoutAction}>
                    <button type="submit" className="studioAccountMenuItem" role="menuitem">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                      Sign out
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </header>

        {/* One line, always present so the layout never shifts as pages set
            or clear it. Subtitle left, page status (save state, counts) right. */}
        <div className="studioSubbar">
          <span className="studioSubbarText">{header.subtitle ?? ""}</span>
          <span className="studioSubbarStatus" id="studio-subbar-status" />
        </div>

        <main className="studioMain">{children}</main>
      </div>
    </div>
    </StudioHeaderContext.Provider>
  );
}
