import React from "react";
import Link from "next/link";
import AppNav from "./AppNav";
import { PlayerProvider } from "./PlayerBar";
import "./app.css";

export const metadata = {
  title: "Take Machine — Listen",
};

export default function UserAppLayout({ children }: { children: React.ReactNode }) {
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
        <Link href="/app/create" className="uCreateBtn">
          <span>＋</span>
          <span>Create</span>
        </Link>
      </aside>

      <PlayerProvider>
        <div className="uMain">{children}</div>
      </PlayerProvider>
    </div>
  );
}
