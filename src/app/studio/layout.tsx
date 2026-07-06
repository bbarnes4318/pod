import React from "react";
import Link from "next/link";
import StudioNav from "./StudioNav";
import "./studio.css";
import { requireAdminPage } from "@/lib/adminAuth";

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  // Second line of defense behind proxy.ts — 404s non-admin requests even if
  // the proxy matcher ever stops covering this segment.
  await requireAdminPage();

  return (
    <div className="studioShell">
      <header className="studioTopbar">
        <Link href="/studio" className="studioBrand">
          <span className="onAirDot" aria-hidden="true" />
          Take<em>Machine</em>
        </Link>
        <StudioNav />
        <Link href="/admin" className="opsLink" title="Pipeline consoles, diagnostics, and configuration">
          Ops console →
        </Link>
      </header>
      <main className="studioMain">{children}</main>
    </div>
  );
}
