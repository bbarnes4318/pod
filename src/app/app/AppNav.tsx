"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  {
    href: "/app", label: "Discover", exact: true,
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="m15 9-2.2 5-4-1.5L11 8z" /></svg>,
  },
  {
    href: "/app/episodes", label: "My episodes",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3z" /></svg>,
  },
  {
    href: "/studio", label: "Creator Studio", externalSurface: true,
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 14h3M14 14h2M8 17h8" /></svg>,
  },
  {
    href: "/app/topics", label: "Hot topics",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3c1 3-2 4.5-2 7a4 4 0 0 0 8 .5C20 14 19 20 12 21c-5 .7-8-3-8-7 0-4.5 4-6 5-9 .4 1.2 1.6 2 3 2z" /></svg>,
  },
  {
    href: "/app/hosts", label: "Hosts",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  },
  {
    href: "/app/published", label: "Published",
    icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" /><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none" /></svg>,
  },
];

export default function AppNav() {
  const pathname = usePathname();
  return (
    <>
      {NAV.map((item) => {
        const active = item.externalSurface ? false : item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} className={`uNavItem ${active ? "active" : ""}`}>
            {item.icon}
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
