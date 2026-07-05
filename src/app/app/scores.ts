// Episode quality scores for the user surface. The stitcher writes a
// combined episode score (script rubric 70% + audio human-ness 30%) into
// the JobLog output when it completes — surface it without schema changes.

import { db } from "@/lib/db";

/** Map of episodeId -> 0-100 combined episode score (latest stitch wins). */
export async function getEpisodeScores(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const logs = await db.jobLog.findMany({
      where: { jobType: "audio:stitch-final", status: "completed" },
      orderBy: { createdAt: "desc" },
      take: 300,
      select: { output: true },
    });
    for (const l of logs) {
      const o = l.output as any;
      const id = o?.episodeId;
      const total = o?.episodeScore?.total;
      if (typeof id === "string" && typeof total === "number" && !map.has(id)) {
        map.set(id, Math.round(total));
      }
    }
  } catch {
    // Scores are decorative — never let them break a page.
  }
  return map;
}
