"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Keep the operations table live without a full browser reload. */
export default function AutoRefresh({ intervalMs = 4000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, router]);

  return null;
}
