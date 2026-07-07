import React from "react";
import StudioShell from "./StudioShell";
import "./studio.css";
import { requireAdminPage } from "@/lib/adminAuth";

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  // Second line of defense behind proxy.ts — 404s non-admin requests even if
  // the proxy matcher ever stops covering this segment.
  await requireAdminPage();

  return <StudioShell>{children}</StudioShell>;
}
