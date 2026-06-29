"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function SidebarNav() {
  const pathname = usePathname();

  const sections = [
    {
      title: "Overview",
      items: [
        { label: "Dashboard", href: "/admin" },
      ],
    },
    {
      title: "Data",
      items: [
        { label: "Data Sources", href: "/admin/data-sources" },
        { label: "Topics", href: "/admin/topics" },
        { label: "Research Briefs", href: "/admin/research-briefs" },
        { label: "AI Hosts", href: "/admin/personalities" },
      ],
    },
    {
      title: "Production Pipeline",
      items: [
        { label: "Episodes", href: "/admin/episodes" },
        { label: "Scripts", href: "/admin/scripts" },
        { label: "Fact Checks", href: "/admin/fact-checks" },
      ],
    },
    {
      title: "Audio",
      items: [
        { label: "Audio Segments", href: "/admin/audio-segments" },
        { label: "Final Audio", href: "/admin/final-audio" },
      ],
    },
    {
      title: "Publishing",
      items: [
        { label: "Content Assets", href: "/admin/content-assets" },
        { label: "RSS", href: "/admin/rss" },
      ],
    },
    {
      title: "System",
      items: [
        { label: "Configuration", href: "/admin/configuration" },
        { label: "Job Logs", href: "/admin/job-logs" },
      ],
    },
  ];

  const isActive = (href: string) => {
    if (href === "/admin") {
      return pathname === "/admin";
    }
    return pathname.startsWith(href);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {sections.map((section, idx) => (
        <div key={idx} style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
          <div
            style={{
              fontSize: "0.7rem",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: "#64748b",
              paddingLeft: "1rem",
              marginBottom: "0.15rem",
            }}
          >
            {section.title}
          </div>
          <ul className="navLinks" style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            {section.items.map((item, itemIdx) => (
              <li
                key={itemIdx}
                className={`navItem ${isActive(item.href) ? "navActive" : ""}`}
              >
                <Link href={item.href}>{item.label}</Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
