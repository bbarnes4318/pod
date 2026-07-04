import React from "react";
import Link from "next/link";
import StudioNav from "./StudioNav";
import "./studio.css";

export default function StudioLayout({ children }: { children: React.ReactNode }) {
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
