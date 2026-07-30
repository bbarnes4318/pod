"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/lib/authActions";
import { StudioIcon } from "@/components/studio/StudioIcon";

type IconName = React.ComponentProps<typeof StudioIcon>["name"];
type NavItem = { href: string; label: string; exact?: boolean; icon: IconName };
type ShellUser = { name: string | null; email: string | null; role?: string | null };

const NAV: NavItem[] = [
  { href: "/studio", label: "The Board", exact: true, icon: "board" },
  { href: "/studio/shows", label: "Shows", icon: "shows" },
  { href: "/studio/create", label: "Create", icon: "plus" },
  { href: "/studio/episodes", label: "Episodes", icon: "episodes" },
  { href: "/studio/takes", label: "Takes", icon: "takes" },
  { href: "/studio/hosts", label: "Hosts", icon: "hosts" },
  { href: "/studio/publish", label: "Publishing", icon: "publish" },
  { href: "/studio/analytics", label: "Analytics", icon: "analytics" },
  { href: "/studio/plan", label: "Plan", icon: "plan" },
  { href: "/studio/settings", label: "Settings", icon: "settings" },
];

const RAIL_KEY = "tm.studio.rail.collapsed";

function initialsFor(user?: ShellUser): string {
  const source = user?.name?.trim() || user?.email?.trim() || "";
  if (!source) return "TM";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return (((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[1]?.[0] ?? "" : "")) || source[0]).toUpperCase();
}

function pageContext(pathname: string) {
  const matched = [...NAV].reverse().find(item => item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`));
  const segments = pathname.split("/").filter(Boolean);
  const detail = segments.length > 2 && !pathname.endsWith("/new") ? "Details" : pathname.endsWith("/new") ? "New" : null;
  return { section: matched?.label ?? "Studio", detail };
}

export default function StudioShell({ user, children }: { user?: ShellUser; children: React.ReactNode }) {
  const pathname = usePathname() || "/studio";
  const displayName = user?.name?.trim() || user?.email?.trim() || "Your account";
  const isAdmin = user?.role === "ADMIN";
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const context = useMemo(() => pageContext(pathname), [pathname]);

  useEffect(() => {
    try { if (localStorage.getItem(RAIL_KEY) === "1") setCollapsed(true); } catch {}
  }, []);

  useEffect(() => { setMobileOpen(false); setMenuOpen(false); }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (event: MouseEvent) => { if (accountRef.current && !accountRef.current.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setMenuOpen(false); menuButtonRef.current?.focus(); } };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onClick); document.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => Array.from(drawerRef.current?.querySelectorAll<HTMLElement>('a,button,[tabindex]:not([tabindex="-1"])') ?? []).filter(node => !node.hasAttribute("disabled"));
    focusables()[0]?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setMobileOpen(false); return; }
      if (event.key !== "Tab") return;
      const nodes = focusables();
      if (!nodes.length) return;
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = previous; document.removeEventListener("keydown", onKey); };
  }, [mobileOpen]);

  const toggleRail = () => setCollapsed(current => {
    const next = !current;
    try { localStorage.setItem(RAIL_KEY, next ? "1" : "0"); } catch {}
    return next;
  });
  const isActive = (item: NavItem) => item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <div className="studioShell" data-collapsed={collapsed ? "true" : "false"} data-mobile-open={mobileOpen ? "true" : "false"}>
      <aside ref={drawerRef} className="studioSidebar" aria-label="Studio navigation" data-scroll-allow>
        <Link href="/studio" className="studioBrand" aria-label="Take Machine Studio home"><span className="onAirDot" aria-hidden="true" /><span className="studioBrandWord">Take<em>Machine</em></span></Link>
        <nav className="studioNavList" aria-label="Primary" data-scroll-allow>
          {NAV.map(item => { const active = isActive(item); return <Link key={item.href} href={item.href} className={`studioNavLink${active ? " active" : ""}`} aria-current={active ? "page" : undefined} title={item.label}><span className="studioNavIcon"><StudioIcon name={item.icon} /></span><span className="studioNavLabel">{item.label}</span></Link>; })}
        </nav>
        <button type="button" className="studioRailToggle" onClick={toggleRail} aria-pressed={collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}><StudioIcon name="chevronLeft" /><span className="studioRailToggleLabel">Collapse</span></button>
      </aside>

      {mobileOpen && <button type="button" className="studioScrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}

      <div className="studioBody">
        <header className="studioTopbar">
          <div className="studioTopbarLeft">
            <button type="button" className="studioHamburger" aria-label="Open navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}><StudioIcon name="menu" /></button>
            <Link href="/studio" className="studioTopbarBrand" aria-label="Take Machine Studio home"><span className="onAirDot" aria-hidden="true" />Take<em>Machine</em></Link>
            <div className="studioPageContext" aria-label="Current location"><span>Studio</span><span aria-hidden="true">/</span><strong>{context.section}</strong>{context.detail && <><span aria-hidden="true">/</span><span>{context.detail}</span></>}</div>
          </div>

          <div className="studioTopbarRight">
            <Link href="/studio/create" className="studioGenerateBtn"><StudioIcon name="bolt" size={16} /><span className="studioGenerateLabel">Generate</span></Link>
            <div className="studioAccount" ref={accountRef}>
              <button ref={menuButtonRef} type="button" className="studioAccountBtn" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(open => !open)}><span className="studioAvatar" aria-hidden="true">{initialsFor(user)}</span><span className="studioAccountName">{displayName}</span><StudioIcon className="studioAccountCaret" name="chevronDown" size={14} /></button>
              {menuOpen && <div className="studioAccountMenu" role="menu"><div className="studioAccountMenuHead"><div className="studioAccountMenuName">{displayName}</div><div className="studioAccountMenuSub">{user?.email || "Studio account"}</div></div><Link href="/studio/settings" className="studioAccountMenuItem" role="menuitem"><StudioIcon name="settings" size={16} />Settings</Link>{isAdmin && <Link href="/admin" className="studioAccountMenuItem" role="menuitem"><StudioIcon name="admin" size={16} />Admin tools</Link>}<Link href="/app" className="studioAccountMenuItem" role="menuitem"><StudioIcon name="headphones" size={16} />Listener view</Link><form action={logoutAction}><button type="submit" className="studioAccountMenuItem" role="menuitem"><StudioIcon name="logout" size={16} />Sign out</button></form></div>}
            </div>
          </div>
        </header>
        <main className="studioMain">{children}</main>
      </div>
    </div>
  );
}
