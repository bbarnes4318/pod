"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { logoutAction } from "@/lib/authActions";
import { Icon } from "./StudioIcons";
import CommandPalette, { type PaletteItem } from "./CommandPalette";
import { StudioAudioProvider } from "./StudioAudio";
import ActivityMenu from "./ActivityMenu";
import { showHue, showInitials } from "./lib";

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
  { prefix: "/studio", title: "Home", exact: true },
  { prefix: "/studio/desk", title: "Editorial desk" },
  { prefix: "/studio/shows/new", title: "Build your show" },
  { prefix: "/studio/shows", title: "Shows" },
  { prefix: "/studio/create", title: "New episode" },
  { prefix: "/studio/episodes", title: "Episodes" },
  { prefix: "/studio/takes", title: "Takes" },
  { prefix: "/studio/hosts", title: "Talent" },
  { prefix: "/studio/auditions", title: "Voice auditions" },
  { prefix: "/studio/audio", title: "Audio library" },
  { prefix: "/studio/publish", title: "Publishing" },
  { prefix: "/studio/analytics", title: "Analytics" },
  { prefix: "/studio/plan", title: "Plan & usage" },
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
 * Returns null for /studio and for top-level sections, which the sidebar
 * already reaches: a Back there would point somewhere the visitor never was.
 */
function derivedBack(pathname: string): StudioBack | null {
  const clean = pathname.replace(/\/+$/, "");
  if (clean === "/studio" || !clean.startsWith("/studio")) return null;
  // A top-level section (/studio/hosts) is reached from the sidebar, which is
  // always on screen; a Back pointing at "The Board" from there is a lie about
  // where the visitor came from. Back only appears once you are inside one.
  if (clean.split("/").filter(Boolean).length <= 2) return null;
  const parent = clean.slice(0, clean.lastIndexOf("/")) || "/studio";
  return { href: parent, label: fallbackTitle(parent) };
}

/* ------------------------------------------------------------------ *
 * Navigation model.
 *
 * Eight destinations, each named for a job: where am I (Home), what do I
 * own (Shows), what should I make (Editorial desk), what have I made
 * (Episodes), who makes it (Talent), what does it sound like (Audio
 * library), how does it get out (Publishing), did it land (Analytics).
 *
 * Sports is not a navigation group any more. The Board and Takes are the
 * sports side of the Editorial desk, beside the business research side:
 * two verticals, one desk. `also` lists the routes that live under a
 * destination so it stays lit while you are inside them.
 * ------------------------------------------------------------------ */
type NavItem = { href: string; label: string; exact?: boolean; icon: React.ReactNode; keywords?: string; also?: string[]; chord?: string };

const NAV: NavItem[] = [
  { href: "/studio", label: "Home", exact: true, icon: Icon.home, keywords: "headquarters briefing dashboard", chord: "h" },
  { href: "/studio/shows", label: "Shows", icon: Icon.shows, keywords: "podcasts programs", chord: "s" },
  { href: "/studio/desk", label: "Editorial desk", icon: Icon.desk, keywords: "topics takes board research ideas opportunities", also: ["/studio/takes"], chord: "d" },
  { href: "/studio/episodes", label: "Episodes", icon: Icon.episodes, keywords: "library drafts", also: ["/studio/create"], chord: "e" },
  { href: "/studio/hosts", label: "Talent", icon: Icon.hosts, keywords: "hosts voices characters cast auditions", also: ["/studio/auditions"], chord: "t" },
  { href: "/studio/audio", label: "Audio library", icon: Icon.audio, keywords: "music sound beds stingers", chord: "a" },
  { href: "/studio/publish", label: "Publishing", icon: Icon.publishing, keywords: "rss feed release", chord: "p" },
  { href: "/studio/analytics", label: "Analytics", icon: Icon.analytics, keywords: "reports metrics listeners" },
];

/** Account, billing and preferences: out of the working list. */
const UTILITY_NAV: NavItem[] = [
  { href: "/studio/plan", label: "Plan & usage", icon: Icon.plan, keywords: "billing tier pricing" },
  { href: "/studio/settings", label: "Settings", icon: Icon.settings, keywords: "account preferences" },
];

const PALETTE_ITEMS: PaletteItem[] = [
  { id: "act-episode", group: "Actions", label: "New episode", href: "/studio/create", icon: Icon.plus, keywords: "create generate produce", hint: "N" },
  { id: "act-show", group: "Actions", label: "New show", href: "/studio/shows/new", icon: Icon.plus, keywords: "podcast create build" },
  { id: "act-host", group: "Actions", label: "Audition voices", href: "/studio/auditions", icon: Icon.auditions, keywords: "voice test talent" },
  ...NAV.map((item) => ({ id: `nav-${item.href}`, group: "Go to", label: item.label, href: item.href, icon: item.icon, keywords: item.keywords, hint: item.chord ? `G ${item.chord.toUpperCase()}` : undefined })),
  ...UTILITY_NAV.map((item) => ({ id: `nav-${item.href}`, group: "Go to", label: item.label, href: item.href, icon: item.icon, keywords: item.keywords })),
];

const RAIL_KEY = "tm.studio.rail.collapsed";
const RECENT_KEY = "tm.studio.recent";
const THEME_COOKIE = "tm_theme";

export type StudioTheme = "dark" | "light";
export type ShellShow = { id: string; name: string; kind: "business" | "sports" };
type RecentItem = { href: string; label: string };

/** Detail pages worth returning to. A list is not "work"; an episode or a show is. */
const RECENT_ROUTE = new RegExp("^/studio/(episodes|shows)/(?!new(?:/|$))[^/]+$");

function readRecent(): RecentItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.href === "string" && typeof r.label === "string").slice(0, 6) : [];
  } catch {
    return [];
  }
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
const noopSubscribe = () => () => {};

type ShellUser = { name: string | null; email: string | null };

function initialsFor(user?: ShellUser): string {
  const source = user?.name?.trim() || user?.email?.trim() || "";
  if (!source) return "TM";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = (parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[1]?.[0] ?? "" : "");
  return (letters || source[0]).toUpperCase();
}

export default function StudioShell({
  user,
  shows = [],
  isOperator = false,
  initialTheme = "dark",
  children,
}: {
  user?: ShellUser;
  /** The viewer's own shows, for the sidebar. Already owner-scoped by the layout. */
  shows?: ShellShow[];
  /** Operators get a link to the ops console; nobody else is shown one. */
  isOperator?: boolean;
  initialTheme?: StudioTheme;
  children: React.ReactNode;
}) {
  const pathname = usePathname() || "/studio";
  const router = useRouter();
  const [theme, setTheme] = useState<StudioTheme>(initialTheme);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const displayName = user?.name?.trim() || user?.email?.trim() || "Your account";
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Read once from the browser; the server render assumes Mac and the client
  // corrects it without an effect.
  const isMac = useSyncExternalStore(
    noopSubscribe,
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => true
  );
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
  // When a page names its ancestors, Back is redundant with the last crumb —
  // show the trail instead, and keep Back for pages that only have a parent.
  const showBack = Boolean(back) && !header.breadcrumb?.length;

  useEffect(() => {
    try {
      if (localStorage.getItem(RAIL_KEY) === "1") setCollapsed(true);
    } catch {}
    setRecent(readRecent());
  }, []);

  // Remember the episodes and shows you open, so the palette can offer them
  // back. Keyed on the title the page published, so the label is the real name.
  useEffect(() => {
    if (!header.title || !RECENT_ROUTE.test(pathname)) return;
    const entry = { href: pathname, label: header.title };
    setRecent((current) => {
      if (current[0]?.href === entry.href && current[0]?.label === entry.label) return current;
      const next = [entry, ...current.filter((r) => r.href !== entry.href)].slice(0, 6);
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [pathname, header.title]);

  const toggleTheme = () => {
    const next: StudioTheme = theme === "dark" ? "light" : "dark";
    // A cookie, not localStorage: the layout reads it on the server, so the
    // right theme is in the first byte of HTML and never flashes.
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    setTheme(next);
  };

  useEffect(() => {
    setMobileOpen(false);
    setMenuOpen(false);
    setPaletteOpen(false);
  }, [pathname]);

  // ⌘K / Ctrl+K opens search from anywhere. "G then a letter" jumps to a
  // section, "N" starts an episode, "/" searches: never while typing in a field.
  useEffect(() => {
    let chordAt = 0;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const key = e.key.toLowerCase();
      if (Date.now() - chordAt < 1200) {
        chordAt = 0;
        const dest = NAV.find((item) => item.chord === key);
        if (dest) {
          e.preventDefault();
          router.push(dest.href);
        }
        return;
      }
      if (key === "g") chordAt = Date.now();
      else if (key === "n") {
        e.preventDefault();
        router.push("/studio/create");
      } else if (key === "/") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [router]);

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

  const under = (prefix: string) => pathname === prefix || pathname.startsWith(prefix + "/");
  const isActive = (item: NavItem) =>
    item.exact ? pathname === item.href : under(item.href) || (item.also ?? []).some(under);

  // What the palette offers before you type: where you were, then your shows.
  const paletteItems = useMemo<PaletteItem[]>(
    () => [
      ...recent.map((r) => ({ id: `recent-${r.href}`, group: "Recent", label: r.label, href: r.href, icon: r.href.includes("/shows/") ? Icon.shows : Icon.episodes })),
      ...PALETTE_ITEMS,
      ...shows.map((show) => ({ id: `show-${show.id}`, group: "Your shows", label: show.name, href: `/studio/shows/${show.id}`, icon: Icon.shows, keywords: show.kind })),
      ...(isOperator ? [{ id: "nav-ops", group: "Operator", label: "Ops console", href: "/admin", icon: Icon.console, keywords: "admin" }] : []),
    ],
    [recent, shows, isOperator]
  );

  const navLink = (item: NavItem) => {
    const active = isActive(item);
    return (
      <Link key={item.href} href={item.href} className={`studioNavLink${active ? " active" : ""}`} aria-current={active ? "page" : undefined} title={collapsed ? item.label : undefined}>
        <span className="studioNavIcon">{item.icon}</span>
        <span className="studioNavLabel">{item.label}</span>
      </Link>
    );
  };

  return (
    <StudioHeaderContext.Provider value={headerApi}>
    <div className="studioShell" data-theme={theme} data-collapsed={collapsed ? "true" : "false"} data-mobile-open={mobileOpen ? "true" : "false"}>
    {/* Inside the shell element, so the player dock inherits the theme tokens. */}
    <StudioAudioProvider>
      <aside className="studioSidebar" aria-label="Studio navigation">
        <div className="studioSidebarHead">
          <Link href="/studio" className="studioBrand" aria-label="Take Machine — Studio home">
            <span className="studioBrandMark" aria-hidden="true">TM</span>
            <span className="studioBrandWord">
              <span className="studioBrandName">Take Machine</span>
              <span className="studioBrandSub">Studio</span>
            </span>
          </Link>
          <button type="button" className="studioRailToggle" onClick={toggleRail} aria-pressed={collapsed} aria-label={collapsed ? "Expand navigation" : "Collapse navigation"} title={collapsed ? "Expand navigation" : "Collapse navigation"}>
            {Icon.collapse}
          </button>
        </div>

        <button type="button" className="studioSearch" onClick={() => setPaletteOpen(true)} aria-label="Search the Studio" aria-keyshortcuts="Meta+K Control+K">
          <span className="studioSearchIcon">{Icon.search}</span>
          <span className="studioSearchLabel">Search</span>
          <kbd className="studioSearchKbd">{isMac ? "⌘K" : "Ctrl K"}</kbd>
        </button>

        <div className="studioNavList">
          <nav className="studioNavGroup" aria-label="Primary">
            {NAV.map(navLink)}
          </nav>

          {/* Your shows, one click from anywhere. The show you are inside is
              marked, so context survives a trip into one of its episodes. */}
          <nav className="studioNavGroup studioNavShows" aria-label="Your shows">
            <div className="studioNavGroupLabel">
              <span>Your shows</span>
              <Link href="/studio/shows/new" className="studioNavAdd" aria-label="New show" title="New show">{Icon.plus}</Link>
            </div>
            {shows.length === 0 ? (
              <Link href="/studio/shows/new" className="studioNavLink studioNavLink--ghost" title={collapsed ? "Create your first show" : undefined}>
                <span className="studioNavIcon">{Icon.plus}</span>
                <span className="studioNavLabel">Create your first show</span>
              </Link>
            ) : (
              shows.slice(0, 7).map((show) => {
                const href = `/studio/shows/${show.id}`;
                const active = under(href);
                return (
                  <Link key={show.id} href={href} className={`studioNavLink${active ? " active" : ""}`} aria-current={active ? "page" : undefined} title={collapsed ? show.name : undefined}>
                    <span className="showArt showArt--xs" data-hue={showHue(show.id)} aria-hidden="true">{showInitials(show.name)}</span>
                    <span className="studioNavLabel">{show.name}</span>
                  </Link>
                );
              })
            )}
            {shows.length > 7 && (
              <Link href="/studio/shows" className="studioNavLink studioNavLink--ghost">
                <span className="studioNavIcon">{Icon.chevronRight}</span>
                <span className="studioNavLabel">All {shows.length} shows</span>
              </Link>
            )}
          </nav>
        </div>

        <nav className="studioNavFoot" aria-label="Account and preferences">
          {UTILITY_NAV.map(navLink)}
          <button type="button" className="studioNavLink studioThemeToggle" onClick={toggleTheme} title={collapsed ? "Switch theme" : undefined}>
            <span className="studioNavIcon">{theme === "dark" ? Icon.sun : Icon.moon}</span>
            <span className="studioNavLabel">{theme === "dark" ? "Light theme" : "Dark theme"}</span>
          </button>
        </nav>
      </aside>

      {mobileOpen && <button type="button" className="studioScrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}

      <div className="studioBody">
        <header className="studioTopbar">
          <div className="studioTopbarLeft">
            <button type="button" className="studioHamburger" aria-label="Open navigation" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)}>
              {Icon.menu}
            </button>
          </div>

          {/* The page's identity. Back sits in the SAME PLACE on every page and
              names its destination. It is a PLAIN <a>, not <Link>: the Board
              keeps its level in the query string, so going up a level navigates
              between two URLs that share a pathname, and Next's client Router
              Cache can serve that from a stale entry — the page would not
              change. A full document navigation cannot be defeated by any cache. */}
          <div className="studioTopbarHead">
            {showBack && back && (
              <a href={back.href} className="studioBack" aria-label={`Back to ${back.label}`}>
                {Icon.chevronLeft}
                <span className="studioBackLabel">{back.label}</span>
              </a>
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
            <ActivityMenu />
            {/* Hidden on the create flow itself: a "New episode" button on the
                page that IS the new episode only offers to start over. */}
            {!pathname.startsWith("/studio/create") && (
              <Link href="/studio/create" className="studioGenerateBtn" aria-label="Create a new episode">
                {Icon.plus}
                <span className="studioGenerateLabel">New episode</span>
              </Link>
            )}

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
                <svg className="studioAccountCaret" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              </button>

              {menuOpen && (
                <div className="studioAccountMenu" role="menu">
                  <div className="studioAccountMenuHead">
                    <span className="studioAvatar studioAvatarLg" aria-hidden="true">{initialsFor(user)}</span>
                    <div className="studioAccountMenuWho">
                      <div className="studioAccountMenuName">{displayName}</div>
                      {user?.email && user.email !== displayName && <div className="studioAccountMenuSub">{user.email}</div>}
                    </div>
                  </div>
                  <Link href="/studio/settings" className="studioAccountMenuItem" role="menuitem">{Icon.settings}Settings</Link>
                  <Link href="/studio/plan" className="studioAccountMenuItem" role="menuitem">{Icon.plan}Plan &amp; usage</Link>
                  <div className="studioAccountMenuSep" role="separator" />
                  {isOperator && <Link href="/admin" className="studioAccountMenuItem" role="menuitem">{Icon.console}Ops console</Link>}
                  <Link href="/app" className="studioAccountMenuItem" role="menuitem">{Icon.listen}Public listening page</Link>
                  <div className="studioAccountMenuSep" role="separator" />
                  <form action={logoutAction}>
                    <button type="submit" className="studioAccountMenuItem" role="menuitem">{Icon.signOut}Sign out</button>
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

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} items={paletteItems} />}
    </StudioAudioProvider>
    </div>
    </StudioHeaderContext.Provider>
  );
}
