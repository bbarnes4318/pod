import React from "react";
import Link from "next/link";

/**
 * The sign-in / sign-up frame. A split screen: what the product is on the
 * left, the form on the right. The listener app's sidebar and player bar are
 * hidden on these routes (app.css, `:has(.uAuthWrap)`) — a visitor who has not
 * signed in has nothing to navigate to and nothing to play.
 */
export default function AuthFrame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="uAuthWrap">
      <aside className="uAuthAside">
        <Link href="/" className="uAuthBrand" aria-label="Take Machine home">
          <span className="uAuthBrandMark" aria-hidden="true">TM</span>
          <span>Take Machine</span>
        </Link>
        <div className="uAuthPitch">
          <h2 className="uAuthPitchTitle">Research-grade podcasts, produced on schedule.</h2>
          <ul className="uAuthPoints">
            <li><strong>Verified research.</strong> Every claim traces to a source you can open.</li>
            <li><strong>Editorial control.</strong> Nothing is voiced until a script clears fact-check and your review.</li>
            <li><strong>Your feed, your brand.</strong> Hosts, sound and publishing configured per show.</li>
          </ul>
        </div>
        <p className="uAuthLegal">© {new Date().getFullYear()} Take Machine</p>
      </aside>
      <main className="uAuthPanel">
        <div className="uAuthCard">
          <h1 className="uAuthTitle">{title}</h1>
          <p className="uAuthSub">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
