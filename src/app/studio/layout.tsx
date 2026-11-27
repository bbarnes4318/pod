import React from "react";
import { cookies, headers } from "next/headers";
import StudioShell, { type ShellShow } from "./StudioShell";
import "./studio.css";
import "./control-room.css";
import { requireUserPage } from "@/lib/currentUser";
import { db } from "@/lib/db";
import { ownerScope } from "@/lib/ownerScope";
import { isOwnerAccount } from "@/lib/services/entitlementService";

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  // Gate the whole /studio surface behind the NextAuth end-user session.
  // proxy.ts forwards the requested path in x-pathname so an unauthenticated
  // visitor is bounced to /app/login and returned here after signing in.
  // (/admin keeps its separate Basic Auth lock in proxy.ts — untouched.)
  const dest = (await headers()).get("x-pathname") || "/studio";
  const user = await requireUserPage(dest);

  // The viewer's shows ride in the sidebar on every page. A failed read costs
  // the list, never the page.
  let shows: ShellShow[] = [];
  try {
    const rows = await db.podcast.findMany({
      where: ownerScope(user),
      orderBy: { updatedAt: "desc" },
      take: 24,
      select: { id: true, name: true, intelligenceType: true },
    });
    shows = rows.map((p) => ({ id: p.id, name: p.name, kind: p.intelligenceType === "BUSINESS" ? "business" : "sports" }));
  } catch {
    shows = [];
  }

  const theme = (await cookies()).get("tm_theme")?.value === "light" ? "light" : "dark";

  return (
    <StudioShell user={{ name: user.name, email: user.email }} shows={shows} isOperator={isOwnerAccount(user)} initialTheme={theme}>
      {children}
    </StudioShell>
  );
}
