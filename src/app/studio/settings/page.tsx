import React from "react";
import Link from "next/link";

export const metadata = {
  title: "Settings — Take Machine Studio",
};

/* Settings is a shell page: it routes operators to the real
   configuration surfaces rather than duplicating them. No data-model
   changes, no secrets — just navigation into existing consoles. */
const GROUPS: { title: string; links: { href: string; label: string; sub: string }[] }[] = [
  {
    title: "Production",
    links: [
      { href: "/studio/hosts", label: "Hosts & casting", sub: "Personas voicing each episode" },
      { href: "/admin/voices", label: "Voices", sub: "TTS voice assignments" },
      { href: "/admin/sound-design", label: "Sound design", sub: "Mix styles & bed levels" },
      { href: "/admin/data-sources", label: "Data sources", sub: "Research & ingestion feeds" },
    ],
  },
  {
    title: "Distribution",
    links: [
      { href: "/studio/publish", label: "Publishing", sub: "Ship finished episodes" },
      { href: "/admin/rss", label: "RSS & feeds", sub: "Podcast feed output" },
    ],
  },
  {
    title: "System",
    links: [
      { href: "/admin/configuration", label: "Configuration", sub: "Pipeline & environment" },
      { href: "/admin/job-logs", label: "Job logs", sub: "Pipeline run diagnostics" },
      { href: "/admin", label: "Ops Console", sub: "Full operator dashboard" },
    ],
  },
];

export default function StudioSettingsPage() {
  return (
    <div className="fadeUp">
      <h1 className="pageTitle">Settings</h1>
      <p className="pageSub">
        Studio preferences and the operator consoles that power production, distribution, and the
        underlying pipeline.
      </p>

      {GROUPS.map((group) => (
        <section key={group.title}>
          <div className="sectionHead">
            <h2 className="sectionTitle">{group.title}</h2>
          </div>
          <div className="grid3">
            {group.links.map((link) => (
              <Link key={link.href} href={link.href} className="studioCard clickable" style={{ display: "block" }}>
                <div className="epTitle">{link.label}</div>
                <div className="epMeta" style={{ marginTop: "0.35rem" }}>{link.sub}</div>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
