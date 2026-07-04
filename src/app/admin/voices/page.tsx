import React from "react";
import { db } from "@/lib/db";
import VoicesConsole from "./VoicesConsole";

// Render on demand so host assignments always reflect the latest DB state.
export const dynamic = "force-dynamic";

export default async function VoicesPage() {
  const hosts = await db.aiHost.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      ttsProvider: true,
      ttsVoiceId: true,
      isActive: true,
    },
  });

  return <VoicesConsole hosts={hosts} />;
}
