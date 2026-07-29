import React from "react";
import { headers } from "next/headers";
import StudioShell from "./StudioShell";
import "./studio.css";
import "./studio-production.css";
import "./production-routes.css";
import "./creation-production.css";
import "./loading-production.css";
import { requireUserPage } from "@/lib/currentUser";

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const dest = (await headers()).get("x-pathname") || "/studio";
  const user = await requireUserPage(dest);
  return <StudioShell user={{ name: user.name, email: user.email, role: user.role }}>{children}</StudioShell>;
}
