import React from "react";
import Link from "next/link";

/**
 * Previous / next for a server-paginated list. Plain links, so the page is in
 * the URL: shareable, and the back button returns to where you were.
 */
export default function Pager({ page, pageCount, total, noun, hrefFor }: {
  page: number;
  pageCount: number;
  total: number;
  noun: string;
  hrefFor: (page: number) => string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav className="libPager" aria-label={`${noun} pages`}>
      {page > 1 ? <Link href={hrefFor(page - 1)} className="btnGhost btnSm" rel="prev">Previous</Link> : <span className="btnGhost btnSm" aria-disabled="true">Previous</span>}
      <span className="libPagerAt">Page {page} of {pageCount} · {total.toLocaleString()} {noun}</span>
      {page < pageCount ? <Link href={hrefFor(page + 1)} className="btnGhost btnSm" rel="next">Next</Link> : <span className="btnGhost btnSm" aria-disabled="true">Next</span>}
    </nav>
  );
}
