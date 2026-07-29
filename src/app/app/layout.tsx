import React from "react";
import Link from "next/link";
import AppNav from "./AppNav";
import SidebarAccount from "./SidebarAccount";
import { PlayerProvider } from "./PlayerBar";
import "./app.css";

export const metadata = {
  title: "Take Machine — Listen",
};

export default function UserAppLayout({ children }: { children: React.ReactNode }) {
  const sourceCommit = process.env.SOURCE_COMMIT || process.env.NEXT_PUBLIC_BUILD_SHA || "unknown";
  const shortCommit = sourceCommit === "unknown" ? "unknown" : sourceCommit.slice(0, 8);

  return (
    <div className="userSurface">
      <aside className="uSidebar">
        <Link href="/app" className="uBrand">
          <span className="uBrandMark">T</span>
          Take
          <br />
          Machine
        </Link>
        <AppNav />

        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <Link
            href="/studio"
            className="uCreateBtn"
            data-testid="sidebar-open-studio"
            style={{ textDecoration: "none", justifyContent: "center" }}
          >
            <span>✦</span>
            <span>Open Creator Studio</span>
          </Link>
          <Link
            href="/studio/create"
            data-testid="sidebar-create-episode"
            style={{
              textDecoration: "none",
              textAlign: "center",
              padding: "0.55rem 0.7rem",
              borderRadius: 10,
              border: "1px solid var(--u-hairline-2)",
              color: "var(--u-ink-2)",
              fontSize: "0.78rem",
              fontWeight: 750,
            }}
          >
            ＋ Create an episode
          </Link>
        </div>

        <div
          data-testid="live-web-build"
          title={`Live web commit: ${sourceCommit}`}
          style={{
            marginTop: "auto",
            padding: "0.55rem 0.65rem",
            borderRadius: 10,
            border: "1px solid var(--u-hairline-2)",
            color: "var(--u-ink-2)",
            fontSize: "0.68rem",
            lineHeight: 1.35,
            overflowWrap: "anywhere",
          }}
        >
          <strong style={{ color: "var(--u-ink)" }}>Listener build</strong>
          <br />
          {shortCommit}
        </div>
        <SidebarAccount />
      </aside>

      <PlayerProvider>
        <div className="uMain">{children}</div>
      </PlayerProvider>
    </div>
  );
}
