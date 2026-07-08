"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/lib/authActions";

/* ------------------------------------------------------------------ *
 * Navigation model. "The Board · Create · Episodes · Hosts ·
 * Publishing · Settings" are the required primary destinations;
 * "Takes" is kept so the existing live page stays reachable.
 * ------------------------------------------------------------------ */
type NavItem = { href: string; label: string; exact?: boolean; icon: React.ReactNode };

const I = {
  board: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" />
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
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  ),
};

const NAV: NavItem[] = [
  { href: "/studio", label: "The Board", exact: true, icon: I.board },
  { href: "/studio/create", label: "Create", icon: I.create },
  { href: "/studio/episodes", label: "Episodes", icon: I.episodes },
  { href: "/studio/takes", label: "Takes", icon: I.takes },
  { href: "/studio/hosts", label: "Hosts", icon: I.hosts },
  { href: "/studio/publish", label: "Publishing", icon: I.publishing },
  { href: "/studio/analytics", label: "Analytics", icon: I.analytics },
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

  // Restore the rail preference after mount (avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      if (localStorage.getItem(RAIL_KEY) === "1") setCollapsed(true);
    } catch {}
  }, []);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
    setMenuOpen(false);
  }, [pathname]);

  // Dismiss the account menu on outside-click and Escape.
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
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(RAIL_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  };

  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");

  return (
    <div
      className="studioShell"
      data-collapsed={collapsed ? "true" : "false"}
      data-mobile-open={mobileOpen ? "true" : "false"}
    >
      {/* ---------------- Left rail ---------------- */}
      <aside className="studioSidebar" aria-label="Studio navigation">
        <Link href="/studio" className="studioBrand" aria-label="Take Machine — Studio home">
          <span className="onAirDot" aria-hidden="true" />
          <span className="studioBrandWord">
            Take<em>Machine</em>
          </span>
        </Link>

        <nav className="studioNavList" aria-label="Primary">
          {NAV.map((item) => {
            const active = isActive(item);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`studioNavLink${active ? " active" : ""}`}
                aria-current={active ? "page" : undefined}
                title={item.label}
              >
                <span className="studioNavIcon">{item.icon}</span>
                <span className="studioNavLabel">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <button
          type="button"
          className="studioRailToggle"
          onClick={toggleRail}
          aria-pressed={collapsed}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 6l-6 6 6 6" />
          </svg>
          <span className="studioRailToggleLabel">Collapse</span>
        </button>
      </aside>

      {/* Mobile drawer scrim */}
      {mobileOpen && (
        <button
          type="button"
          className="studioScrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ---------------- Body ---------------- */}
      <div className="studioBody">
        <header className="studioTopbar">
          <div className="studioTopbarLeft">
            <button
              type="button"
              className="studioHamburger"
              aria-label="Open navigation"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <Link href="/studio" className="studioTopbarBrand" aria-label="Take Machine — Studio home">
              <span className="onAirDot" aria-hidden="true" />
              Take<em>Machine</em>
            </Link>
          </div>

          <div className="studioTopbarRight">
            <Link href="/studio/create" className="studioGenerateBtn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z" />
              </svg>
              <span className="studioGenerateLabel">Generate</span>
            </Link>

            <div className="studioAccount" ref={accountRef}>
              <button
                type="button"
                className="studioAccountBtn"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((o) => !o)}
              >
                <span className="studioAvatar" aria-hidden="true">{initialsFor(user)}</span>
                <span className="studioAccountName">{displayName}</span>
                <svg className="studioAccountCaret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {menuOpen && (
                <div className="studioAccountMenu" role="menu">
                  <div className="studioAccountMenuHead">
                    <div className="studioAccountMenuName">{displayName}</div>
                    <div className="studioAccountMenuSub">{user?.email ? "Signed in" : "Studio"}</div>
                  </div>
                  <Link href="/studio/settings" className="studioAccountMenuItem" role="menuitem">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6 6l1.5 1.5M18 18l-1.5-1.5M18 6l-1.5 1.5M6 18l1.5-1.5" />
                    </svg>
                    Settings
                  </Link>
                  <Link href="/admin" className="studioAccountMenuItem" role="menuitem">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 14h4" />
                    </svg>
                    Ops Console
                  </Link>
                  <Link href="/app" className="studioAccountMenuItem" role="menuitem">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
                    </svg>
                    Listener view
                  </Link>
                  <form action={logoutAction}>
                    <button type="submit" className="studioAccountMenuItem" role="menuitem">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
                      </svg>
                      Sign out
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="studioMain">{children}</main>
      </div>
    </div>
  );
}
