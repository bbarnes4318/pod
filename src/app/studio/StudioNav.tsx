"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/studio", label: "Home", exact: true },
  { href: "/studio/create", label: "Create" },
  { href: "/studio/episodes", label: "Episodes" },
  { href: "/studio/takes", label: "Takes" },
  { href: "/studio/hosts", label: "Hosts" },
  { href: "/studio/publish", label: "Publish" },
];

export default function StudioNav() {
  const pathname = usePathname();
  return (
    <nav className="studioNav" aria-label="Studio">
      {LINKS.map((l) => {
        const active = l.exact ? pathname === l.href : pathname.startsWith(l.href);
        return (
          <Link key={l.href} href={l.href} className={`studioNavLink ${active ? "active" : ""}`}>
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
