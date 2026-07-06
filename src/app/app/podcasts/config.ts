// Shared wizard/podcast constants — importable from both client components
// and server actions (a "use server" file may only export async functions).

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const WEEKDAY_LABELS: Record<string, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday",
  fri: "Friday", sat: "Saturday", sun: "Sunday",
};

export const SEGMENT_MIN = 1;
export const SEGMENT_MAX = 6;
export const SEGMENT_DEFAULT = 3;

export interface PodcastInput {
  name: string;
  cadence: "one_time" | "recurring";
  scheduleDays: string[];
  verticals: string[];
  teams: string[];
  segmentCount: number;
  hostIds: string[];
}
