// Data for the Discover screen. Production reads the real DB; in local
// development without a database we fall back to clearly-labeled sample
// content so the surface can be designed and reviewed. The fallback NEVER
// runs in production — a prod DB failure shows honest empty states instead.

import { db } from "@/lib/db";
import { getEpisodeScores } from "./scores";

export interface DiscoverEpisode {
  id: string;
  title: string;
  audioUrl: string | null;
  durationSeconds: number | null;
  updatedAt: string;
  status: string;
  description: string | null;
  score: number | null;
}

export interface DiscoverTake {
  id: string;
  title: string;
  sport: string;
  debateScore: number;
  controversyScore: number;
  starPowerScore: number;
  recencyScore: number;
  bettingRelevanceScore: number;
}

export interface DiscoverData {
  episodes: DiscoverEpisode[];
  takes: DiscoverTake[];
  isPreviewData: boolean;
}

const PREVIEW: DiscoverData = {
  isPreviewData: true,
  episodes: [
    { id: "p1", title: "Did the Lakers panic — or finally choose Luka over LeBron?", audioUrl: null, durationSeconds: 741, updatedAt: new Date().toISOString(), status: "published", score: 92, description: "Max says the front office blinked. Doc says the numbers back the shake-up — and one of them has the fourth-quarter data to prove it." },
    { id: "p2", title: "The two-seed is a fraud and Friday proved it", audioUrl: null, durationSeconds: 688, updatedAt: new Date().toISOString(), status: "publish_ready", score: 87, description: "A 19-point collapse, a silent locker room, and a coach who called it 'growth'." },
    { id: "p3", title: "Cape Verde exposed Messi's Argentina — now what?", audioUrl: null, durationSeconds: 712, updatedAt: new Date().toISOString(), status: "audio_ready", score: 90, description: "The champions looked mortal. Doc has receipts; Max has a theory nobody wants to hear." },
    { id: "p4", title: "Rosa Calderon traded down twice. Genius or coward?", audioUrl: null, durationSeconds: 655, updatedAt: new Date().toISOString(), status: "published", score: 84, description: "Two trade-downs, five picks, zero stars — yet the cap sheet has never looked better." },
    { id: "p5", title: "31 points in garbage time doesn't make you clutch", audioUrl: null, durationSeconds: 590, updatedAt: new Date().toISOString(), status: "published", score: 88, description: "Max drew the line at minute 41. Doc thinks the whole 'clutch' framework is broken." },
    { id: "p6", title: "The market moved to +700 — smart money or panic?", audioUrl: null, durationSeconds: 634, updatedAt: new Date().toISOString(), status: "audio_ready", score: 81, description: "A line doesn't move that fast without a reason. The hosts disagree on what the reason is." },
  ],
  takes: [
    { id: "t1", title: "Is LeBron chasing rings — or rewriting his ending?", sport: "Basketball", debateScore: 88, controversyScore: 92, starPowerScore: 98, recencyScore: 90, bettingRelevanceScore: 55 },
    { id: "t2", title: "Marsch called the exit 'progress'. Delusional or right?", sport: "Soccer", debateScore: 81, controversyScore: 84, starPowerScore: 66, recencyScore: 95, bettingRelevanceScore: 40 },
    { id: "t3", title: "The Comets' defense is real — the fourth quarter isn't", sport: "Basketball", debateScore: 78, controversyScore: 74, starPowerScore: 70, recencyScore: 82, bettingRelevanceScore: 77 },
    { id: "t4", title: "A future first from a bad team is a lottery ticket, not a plan", sport: "Football", debateScore: 74, controversyScore: 71, starPowerScore: 58, recencyScore: 76, bettingRelevanceScore: 62 },
  ],
};

export async function getDiscoverData(): Promise<DiscoverData> {
  try {
    const [episodes, takes, scores] = await Promise.all([
      db.episode.findMany({
        where: { audioUrl: { not: null } },
        orderBy: { updatedAt: "desc" },
        take: 9,
        select: { id: true, title: true, audioUrl: true, durationSeconds: true, updatedAt: true, status: true, description: true },
      }),
      db.topicCandidate.findMany({
        where: { status: { in: ["pending", "approved"] } },
        orderBy: { debateScore: "desc" },
        take: 4,
        select: {
          id: true, title: true, sport: true, debateScore: true,
          controversyScore: true, starPowerScore: true, recencyScore: true, bettingRelevanceScore: true,
        },
      }),
      getEpisodeScores(),
    ]);
    return {
      isPreviewData: false,
      episodes: episodes.map((e) => ({
        ...e,
        updatedAt: e.updatedAt.toISOString(),
        score: scores.get(e.id) ?? null,
      })),
      takes,
    };
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[app] DB unavailable in dev — using labeled preview data.", (err as Error).message?.slice(0, 80));
      return PREVIEW;
    }
    return { isPreviewData: false, episodes: [], takes: [] };
  }
}
