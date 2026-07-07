import React from "react";
import { headers } from "next/headers";
import StudioShell from "./StudioShell";
import "./studio.css";
import { requireUserPage } from "@/lib/currentUser";

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  // Gate the whole /studio surface behind the NextAuth end-user session.
  // proxy.ts forwards the requested path in x-pathname so an unauthenticated
  // visitor is bounced to /app/login and returned here after signing in.
  // (/admin keeps its separate Basic Auth lock in proxy.ts — untouched.)
  const dest = (await headers()).get("x-pathname") || "/studio";
  const user = await requireUserPage(dest);

  return <StudioShell user={{ name: user.name, email: user.email }}>{children}</StudioShell>;
}
